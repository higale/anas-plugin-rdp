use std::io::{BufRead, Read, Write};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{Context, bail};
use futures_util::{SinkExt, StreamExt};
use ironrdp_pdu::nego::{ConnectionConfirm, ConnectionRequest, SecurityProtocol};
use ironrdp_pdu::x224::X224;
use ironrdp_rdcleanpath::{DetectionResult, RDCleanPathMessage, RDCleanPathPdu};
use serde::Deserialize;
use subtle::ConstantTimeEq;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::time::{Instant, timeout};
use tokio_tungstenite::tungstenite::handshake::server::{Request, Response};
use tokio_tungstenite::tungstenite::{Message, protocol::WebSocketConfig};
use tokio_tungstenite::{WebSocketStream, accept_hdr_async_with_config};

use super::{CertificateObservation, Target, connect_tls, read_confirm_packet, validate_target};

const HANDSHAKE_LIMIT: usize = 64 * 1024;
const STREAM_LIMIT: usize = 1024 * 1024;
const WRITE_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Deserialize)]
struct Config {
    #[serde(flatten)]
    target: Target,
    origin: String,
    token: String,
}

fn emit(value: serde_json::Value) {
    let mut stdout = std::io::stdout().lock();
    let _ = writeln!(stdout, "{value}");
    let _ = stdout.flush();
}

pub async fn run() -> anyhow::Result<()> {
    let mut stdin = std::io::BufReader::new(std::io::stdin());
    let mut line = String::new();
    (&mut stdin).take(16 * 1024 + 1).read_line(&mut line)?;
    if line.len() > 16 * 1024 || !line.ends_with('\n') {
        bail!("invalid bridge configuration size");
    }
    let config: Config = serde_json::from_str(&line).context("invalid bridge configuration")?;
    validate_target(&config.target)?;
    if config.token.len() != 64
        || !config.token.bytes().all(|c| c.is_ascii_hexdigit())
        || config.origin.is_empty()
    {
        bail!("invalid bridge authorization");
    }
    // The private control pipe is the owner's lease, including forced host exit.
    let (owner_closed, closed) = tokio::sync::oneshot::channel();
    std::thread::spawn(move || {
        let mut byte = [0];
        let _ = std::io::Read::read(&mut stdin, &mut byte);
        let _ = owner_closed.send(());
    });
    let observation = Arc::new(Mutex::new(None));
    let result = tokio::select! {
        _ = closed => Ok(()),
        result = serve(config, Arc::clone(&observation)) => result,
    };
    if result.is_err() {
        let certificate = observation
            .lock()
            .expect("certificate observation lock")
            .clone();
        let status = if certificate
            .as_ref()
            .is_some_and(|c: &CertificateObservation| !c.trusted)
        {
            "certificate_required"
        } else {
            "connection_failed"
        };
        emit(serde_json::json!({"status":status,"certificate":certificate}));
    }
    emit(serde_json::json!({"status":"closed"}));
    // No raw network errors, targets, tokens or protocol payloads are logged.
    Ok(())
}

// tungstenite's callback requires this concrete HTTP response error type.
#[allow(clippy::result_large_err)]
async fn serve(
    config: Config,
    observation: Arc<Mutex<Option<CertificateObservation>>>,
) -> anyhow::Result<()> {
    let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).await?;
    emit(serde_json::json!({"status":"ready","port":listener.local_addr()?.port()}));
    let mut ws = timeout(Duration::from_secs(30), async {
        loop {
            let (socket, _) = listener.accept().await?;
            let accepted = timeout(
                Duration::from_secs(3),
                accept_hdr_async_with_config(
                    socket,
                    |request: &Request, response: Response| {
                        if request.uri().path() != "/rdp"
                            || request.uri().query().is_some()
                            || request
                                .headers()
                                .get("origin")
                                .and_then(|h| h.to_str().ok())
                                != Some(config.origin.as_str())
                        {
                            return Err(tokio_tungstenite::tungstenite::http::Response::builder()
                                .status(403)
                                .body(Some("Forbidden".into()))
                                .expect("static HTTP response"));
                        }
                        Ok(response)
                    },
                    Some(
                        WebSocketConfig::default()
                            .max_message_size(Some(STREAM_LIMIT))
                            .max_frame_size(Some(STREAM_LIMIT))
                            .write_buffer_size(0)
                            .max_write_buffer_size(STREAM_LIMIT + 1024),
                    ),
                ),
            )
            .await;
            if let Ok(Ok(ws)) = accepted {
                break Ok::<_, anyhow::Error>(ws);
            }
        }
    })
    .await??;
    drop(listener);
    let (mut tls, response) = timeout(Duration::from_secs(15), async {
        let request = read_request(&mut ws).await?;
        let x224 = authorize(request, &config)?;
        emit(serde_json::json!({"status":"connecting"}));
        let mut tcp = TcpStream::connect((config.target.host.as_str(), config.target.port)).await?;
        tcp.set_nodelay(true)?;
        let address = tcp.peer_addr()?.to_string();
        tcp.write_all(&x224).await?;
        let (confirm, raw) = read_confirm_packet(&mut tcp).await?;
        match confirm {
            ConnectionConfirm::Response { protocol, .. }
                if [
                    SecurityProtocol::SSL,
                    SecurityProtocol::HYBRID,
                    SecurityProtocol::HYBRID_EX,
                ]
                .contains(&protocol) => {}
            _ => {
                ws.send(Message::Binary(
                    RDCleanPathPdu::new_negotiation_error(raw)?.to_der()?.into(),
                ))
                .await?;
                bail!("negotiation rejected");
            }
        }
        let tls = connect_tls(&config.target, tcp, observation).await?;
        let chain = tls
            .get_ref()
            .1
            .peer_certificates()
            .context("missing TLS certificate")?
            .iter()
            .map(|c| c.as_ref().to_vec());
        let response = RDCleanPathPdu::new_response(address, raw, chain)?.to_der()?;
        Ok::<_, anyhow::Error>((tls, response))
    })
    .await??;
    timeout(WRITE_TIMEOUT, ws.send(Message::Binary(response.into()))).await??;
    emit(serde_json::json!({"status":"streaming"}));
    let mut buffer = vec![0; 64 * 1024];
    let mut heartbeat = tokio::time::interval(Duration::from_secs(10));
    let mut last_pong = Instant::now();
    loop {
        tokio::select! {
            received = ws.next() => match received {
                Some(Ok(Message::Binary(bytes))) => { timeout(WRITE_TIMEOUT, async { tls.write_all(&bytes).await?; tls.flush().await }).await??; }
                Some(Ok(Message::Pong(_))) => last_pong = Instant::now(),
                Some(Ok(Message::Ping(_))) => { timeout(WRITE_TIMEOUT, ws.flush()).await??; }
                Some(Ok(Message::Close(_))) | None => break,
                Some(Err(tokio_tungstenite::tungstenite::Error::ConnectionClosed | tokio_tungstenite::tungstenite::Error::AlreadyClosed)) => break,
                _ => bail!("invalid WebSocket stream"),
            },
            received = tls.read(&mut buffer) => {
                let length = match received {
                    Ok(length) => length,
                    // Windows RDP can end its TLS transport without close_notify.
                    Err(error) if [std::io::ErrorKind::UnexpectedEof, std::io::ErrorKind::ConnectionReset, std::io::ErrorKind::ConnectionAborted].contains(&error.kind()) => break,
                    Err(error) => return Err(error.into()),
                };
                if length == 0 { break; }
                timeout(WRITE_TIMEOUT, ws.send(Message::Binary(buffer[..length].to_vec().into()))).await??;
            },
            _ = heartbeat.tick() => {
                if last_pong.elapsed() > Duration::from_secs(30) { bail!("page lease expired"); }
                timeout(WRITE_TIMEOUT, ws.send(Message::Ping(Vec::new().into()))).await??;
            },
        }
    }
    Ok(())
}

async fn read_request(ws: &mut WebSocketStream<TcpStream>) -> anyhow::Result<RDCleanPathPdu> {
    let mut bytes = Vec::new();
    loop {
        let Some(Ok(Message::Binary(chunk))) = ws.next().await else {
            bail!("expected RDCleanPath binary request");
        };
        if bytes.len() + chunk.len() > HANDSHAKE_LIMIT {
            bail!("RDCleanPath request too large");
        }
        bytes.extend_from_slice(&chunk);
        match RDCleanPathPdu::detect(&bytes) {
            DetectionResult::Detected { total_length, .. } if total_length > HANDSHAKE_LIMIT => {
                bail!("RDCleanPath request too large")
            }
            DetectionResult::Detected { total_length, .. } if bytes.len() >= total_length => {
                if bytes.len() != total_length {
                    bail!("trailing request data");
                }
                return Ok(RDCleanPathPdu::from_der(&bytes)?);
            }
            DetectionResult::Failed => bail!("invalid RDCleanPath request"),
            _ => (),
        }
    }
}

fn authorize(request: RDCleanPathPdu, config: &Config) -> anyhow::Result<Vec<u8>> {
    let RDCleanPathMessage::Request {
        destination,
        proxy_auth,
        server_auth,
        preconnection_blob,
        x224_connection_request,
    } = request.into_message()?
    else {
        bail!("ordinary RDP request required");
    };
    let expected = if config.target.host.contains(':') {
        format!("[{}]:{}", config.target.host, config.target.port)
    } else {
        format!("{}:{}", config.target.host, config.target.port)
    };
    if destination != expected
        || !bool::from(proxy_auth.as_bytes().ct_eq(config.token.as_bytes()))
        || server_auth.is_some()
        || preconnection_blob.is_some()
    {
        bail!("unauthorized request");
    }
    let _ = ironrdp_core::decode::<X224<ConnectionRequest>>(x224_connection_request.as_bytes())?;
    Ok(x224_connection_request.as_bytes().to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ticket_is_bound_to_destination_and_rejects_alternate_protocols() {
        let config = Config {
            target: Target {
                host: "test.invalid".into(),
                port: 3389,
                trusted_sha256: None,
            },
            origin: "anas-plugin://rdp".into(),
            token: "a".repeat(64),
        };
        let x224 = ironrdp_core::encode_vec(&X224(ConnectionRequest {
            nego_data: None,
            correlation_info: None,
            flags: ironrdp_pdu::nego::RequestFlags::empty(),
            protocol: SecurityProtocol::HYBRID,
        }))
        .unwrap();
        for (destination, token, accepted) in [
            ("test.invalid:3389", "a".repeat(64), true),
            ("other.invalid:3389", "a".repeat(64), false),
            ("test.invalid:3389", "b".repeat(64), false),
        ] {
            let request =
                RDCleanPathPdu::new_request(x224.clone(), destination.into(), token, None).unwrap();
            assert_eq!(authorize(request, &config).is_ok(), accepted);
        }
        assert!(
            authorize(
                RDCleanPathPdu::new_vmconnect_request(
                    "test.invalid:3389".into(),
                    config.token.clone(),
                    "vm".into()
                )
                .unwrap(),
                &config
            )
            .is_err()
        );
    }
}
