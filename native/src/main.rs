use std::io::{self, Read};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{Context, bail};
use ironrdp_pdu::nego::{ConnectionConfirm, ConnectionRequest, RequestFlags, SecurityProtocol};
use ironrdp_pdu::x224::X224;
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

mod listener;
mod session;

#[derive(Clone, Deserialize)]
struct Target {
    host: String,
    #[serde(default = "default_port")]
    port: u16,
    #[serde(default)]
    trusted_sha256: Option<String>,
}

fn default_port() -> u16 {
    3389
}

#[derive(Clone, Debug, Default, Serialize)]
struct CertificateObservation {
    sha256: String,
    trusted: bool,
}

#[derive(Debug)]
struct ObservingVerifier {
    inner: Arc<dyn ServerCertVerifier>,
    observation: Arc<Mutex<Option<CertificateObservation>>>,
    trusted_sha256: Option<String>,
}

impl ServerCertVerifier for ObservingVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        server_name: &ServerName<'_>,
        ocsp_response: &[u8],
        now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        let fingerprint = format!("{:x}", Sha256::digest(end_entity.as_ref()));
        let verified = if let Some(expected) = &self.trusted_sha256 {
            if expected == &fingerprint {
                Ok(ServerCertVerified::assertion())
            } else {
                Err(rustls::Error::InvalidCertificate(
                    rustls::CertificateError::ApplicationVerificationFailure,
                ))
            }
        } else {
            self.inner.verify_server_cert(
                end_entity,
                intermediates,
                server_name,
                ocsp_response,
                now,
            )
        };
        *self
            .observation
            .lock()
            .expect("certificate observation lock") = Some(CertificateObservation {
            sha256: fingerprint,
            trusted: verified.is_ok(),
        });
        verified
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        self.inner.verify_tls12_signature(message, cert, dss)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        self.inner.verify_tls13_signature(message, cert, dss)
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        self.inner.supported_verify_schemes()
    }
}

async fn read_confirm(
    stream: &mut (impl tokio::io::AsyncRead + Unpin),
) -> anyhow::Result<ConnectionConfirm> {
    Ok(read_confirm_packet(stream).await?.0)
}

async fn read_confirm_packet(
    stream: &mut (impl tokio::io::AsyncRead + Unpin),
) -> anyhow::Result<(ConnectionConfirm, Vec<u8>)> {
    // TPKT envelope bounds the allocation; IronRDP decodes X.224 and negotiation.
    let mut header = [0u8; 4];
    stream.read_exact(&mut header).await?;
    if header[0] != 3 || header[1] != 0 {
        bail!("invalid TPKT header");
    }
    let length = usize::from(u16::from_be_bytes([header[2], header[3]]));
    if !(7..=65535).contains(&length) {
        bail!("invalid TPKT length");
    }
    let mut packet = vec![0u8; length];
    packet[..4].copy_from_slice(&header);
    stream.read_exact(&mut packet[4..]).await?;
    Ok((
        ironrdp_core::decode::<X224<ConnectionConfirm>>(&packet)?.0,
        packet,
    ))
}

fn validate_target(target: &Target) -> anyhow::Result<()> {
    if target.host.trim().is_empty() || target.port == 0 {
        bail!("invalid target");
    }
    if target.trusted_sha256.as_ref().is_some_and(|value| {
        value.len() != 64
            || !value
                .bytes()
                .all(|ch| ch.is_ascii_hexdigit() && !ch.is_ascii_uppercase())
    }) {
        bail!("invalid certificate fingerprint");
    }
    Ok(())
}

async fn probe(
    target: Target,
    observation: Arc<Mutex<Option<CertificateObservation>>>,
) -> anyhow::Result<()> {
    validate_target(&target)?;
    let mut stream = TcpStream::connect((target.host.as_str(), target.port))
        .await
        .context("TCP connection failed")?;
    let request = X224(ConnectionRequest {
        nego_data: None,
        correlation_info: None,
        flags: RequestFlags::empty(),
        protocol: SecurityProtocol::SSL | SecurityProtocol::HYBRID | SecurityProtocol::HYBRID_EX,
    });
    stream
        .write_all(&ironrdp_core::encode_vec(&request)?)
        .await?;
    match read_confirm(&mut stream).await? {
        ConnectionConfirm::Response { protocol, .. }
            if [
                SecurityProtocol::SSL,
                SecurityProtocol::HYBRID,
                SecurityProtocol::HYBRID_EX,
            ]
            .contains(&protocol) => {}
        _ => bail!("server rejected supported TLS negotiation"),
    }
    let mut tls = connect_tls(&target, stream, observation).await?;
    tls.shutdown().await?;
    Ok(())
}

async fn connect_tls(
    target: &Target,
    stream: TcpStream,
    observation: Arc<Mutex<Option<CertificateObservation>>>,
) -> anyhow::Result<tokio_rustls::client::TlsStream<TcpStream>> {
    let server_name = ServerName::try_from(target.host.clone()).context("invalid server name")?;
    let mut roots = rustls::RootCertStore::empty();
    for cert in rustls_native_certs::load_native_certs().certs {
        roots.add(cert)?;
    }
    let verifier = rustls::client::WebPkiServerVerifier::builder(Arc::new(roots)).build()?;
    let mut config = rustls::ClientConfig::builder()
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(ObservingVerifier {
            inner: verifier,
            observation,
            trusted_sha256: target.trusted_sha256.clone(),
        }))
        .with_no_client_auth();
    config.resumption = rustls::client::Resumption::disabled();
    let tls = tokio_rustls::TlsConnector::from(Arc::new(config))
        .connect(server_name, stream)
        .await
        .context("TLS certificate or handshake rejected")?;
    Ok(tls)
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    rustls::crypto::ring::default_provider()
        .install_default()
        .map_err(|_| anyhow::anyhow!("TLS provider initialization failed"))?;
    if std::env::args().nth(1).as_deref() == Some("--session") {
        return session::run().await;
    }
    // Input arrives through a private pipe, never process arguments or logs.
    let mut input = String::new();
    io::stdin().take(16 * 1024).read_to_string(&mut input)?;
    let target: Target =
        serde_json::from_str(&input).map_err(|_| anyhow::anyhow!("invalid probe input"))?;
    let observation = Arc::new(Mutex::new(None));
    let result = tokio::time::timeout(
        Duration::from_secs(15),
        probe(target, Arc::clone(&observation)),
    )
    .await;
    let certificate = observation
        .lock()
        .expect("certificate observation lock")
        .clone();
    let status = match result {
        Ok(Ok(())) => "tls_ready",
        _ if certificate.as_ref().is_some_and(|cert| !cert.trusted) => "certificate_required",
        Err(_) => "timeout",
        _ => "connection_failed",
    };
    println!(
        "{}",
        serde_json::json!({ "status": status, "certificate": certificate })
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn reads_fragmented_confirm() {
        let packet = ironrdp_core::encode_vec(&X224(ConnectionConfirm::Response {
            flags: ironrdp_pdu::nego::ResponseFlags::empty(),
            protocol: SecurityProtocol::HYBRID_EX,
        }))
        .unwrap();
        let (mut writer, mut reader) = tokio::io::duplex(4);
        tokio::spawn(async move {
            for byte in packet {
                writer.write_all(&[byte]).await.unwrap();
            }
        });
        assert!(matches!(
            read_confirm(&mut reader).await.unwrap(),
            ConnectionConfirm::Response {
                protocol: SecurityProtocol::HYBRID_EX,
                ..
            }
        ));
    }

    #[tokio::test]
    async fn rejects_invalid_and_truncated_packets() {
        for bytes in [&[2, 0, 0, 7][..], &[3, 0, 0, 3], &[3, 0, 0, 7, 0]] {
            assert!(read_confirm(&mut &bytes[..]).await.is_err());
        }
    }

    #[test]
    fn observes_certificate_without_bypassing_trust_or_name_checks() {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let certificate = rcgen::generate_simple_self_signed(vec!["localhost".into()]).unwrap();
        let unrelated =
            rcgen::generate_simple_self_signed(vec!["unrelated.invalid".into()]).unwrap();
        for (root, name, accepted) in [
            (certificate.cert.der(), "localhost", true),
            (certificate.cert.der(), "wrong.invalid", false),
            (unrelated.cert.der(), "localhost", false),
        ] {
            let mut roots = rustls::RootCertStore::empty();
            roots.add(root.clone()).unwrap();
            let observation = Arc::new(Mutex::new(None));
            let verifier = ObservingVerifier {
                inner: rustls::client::WebPkiServerVerifier::builder(Arc::new(roots))
                    .build()
                    .unwrap(),
                observation: Arc::clone(&observation),
                trusted_sha256: None,
            };
            let result = verifier.verify_server_cert(
                certificate.cert.der(),
                &[],
                &ServerName::try_from(name).unwrap(),
                &[],
                UnixTime::now(),
            );
            assert_eq!(result.is_ok(), accepted);
            let observed = observation.lock().unwrap().clone().unwrap();
            assert_eq!(observed.trusted, accepted);
            assert_eq!(
                observed.sha256,
                format!("{:x}", Sha256::digest(certificate.cert.der()))
            );
        }
    }

    #[test]
    fn explicit_pin_accepts_only_the_approved_certificate() {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let certificate = rcgen::generate_simple_self_signed(vec!["localhost".into()]).unwrap();
        let replacement = rcgen::generate_simple_self_signed(vec!["localhost".into()]).unwrap();
        let mut roots = rustls::RootCertStore::empty();
        // Even a replacement that passes normal trust must not override a pin.
        roots.add(replacement.cert.der().clone()).unwrap();
        let verifier = ObservingVerifier {
            inner: rustls::client::WebPkiServerVerifier::builder(Arc::new(roots))
                .build()
                .unwrap(),
            observation: Arc::new(Mutex::new(None)),
            trusted_sha256: Some(format!("{:x}", Sha256::digest(certificate.cert.der()))),
        };
        let name = ServerName::try_from("localhost").unwrap();
        assert!(
            verifier
                .verify_server_cert(certificate.cert.der(), &[], &name, &[], UnixTime::now())
                .is_ok()
        );
        assert!(
            verifier
                .verify_server_cert(replacement.cert.der(), &[], &name, &[], UnixTime::now())
                .is_err()
        );
    }
}
