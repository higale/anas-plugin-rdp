//! A session outlives every attached display page. RDP stays inside IronRDP.
use super::{CertificateObservation, Target};
use anyhow::{Context, bail};
use bytes::Bytes;
use futures_util::{SinkExt, StreamExt};
use ironrdp_client::{
    config::{ConfigBuilder, Destination},
    output_channel::output_channel,
    rdp::{RdpClient, RdpInputEvent, RdpInputSender, RdpOutputEvent},
};
use ironrdp_pdu::input::{
    MousePdu,
    fast_path::{FastPathInputEvent, KeyboardFlags},
    mouse::PointerFlags,
};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::io::{BufRead, Read, Write};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use subtle::ConstantTimeEq;
use tokio::net::TcpStream;
use tokio::sync::{mpsc, watch};
use tokio::time::{Instant, timeout};
use tokio_tungstenite::{
    accept_hdr_async_with_config,
    tungstenite::{
        Message,
        handshake::server::{Request, Response},
        protocol::WebSocketConfig,
    },
};

const MAX_PIXELS: usize = 16 * 1024 * 1024;
const IO_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Deserialize)]
struct Configuration {
    #[serde(flatten)]
    target: Target,
    username: String,
    password: String,
    #[serde(default)]
    domain: String,
    token: String,
    origin: String,
}
#[derive(Clone)]
struct Snapshot {
    revision: u64,
    state: String,
    image: Option<Bytes>,
    cursor: Value,
    owner: Option<String>,
    epoch: u64,
}
struct Controls {
    owner: Option<String>,
    epoch: u64,
    keys: HashSet<(u8, bool)>,
    buttons: HashSet<u16>,
    attached: HashSet<String>,
    ready: HashSet<String>,
}
impl Controls {
    fn release(&mut self, input: &RdpInputSender) -> anyhow::Result<()> {
        for (code, extended) in self.keys.clone() {
            let flags = KeyboardFlags::RELEASE
                | if extended {
                    KeyboardFlags::EXTENDED
                } else {
                    KeyboardFlags::empty()
                };
            send(input, FastPathInputEvent::KeyboardEvent(flags, code))?;
            self.keys.remove(&(code, extended));
        }
        for button in self.buttons.clone() {
            send(
                input,
                FastPathInputEvent::MouseEvent(MousePdu {
                    flags: PointerFlags::from_bits_retain(button),
                    x_position: 0,
                    y_position: 0,
                    number_of_wheel_rotation_units: 0,
                }),
            )?;
            self.buttons.remove(&button);
        }
        Ok(())
    }
}
fn emit(value: Value) {
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{value}");
    let _ = out.flush();
}
fn send(input: &RdpInputSender, event: FastPathInputEvent) -> anyhow::Result<()> {
    input
        .try_send(RdpInputEvent::FastPath(smallvec::smallvec![event]))
        .map_err(|_| anyhow::anyhow!("input unavailable"))
}
fn valid_page(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 80
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-')
}
fn frame(pixels: Vec<u32>, width: u16, height: u16) -> anyhow::Result<Bytes> {
    let count = usize::from(width) * usize::from(height);
    if count > MAX_PIXELS || pixels.len() != count {
        bail!("invalid desktop dimensions");
    }
    let mut bytes = Vec::with_capacity(8 + count * 4);
    bytes.extend_from_slice(&u32::from(width).to_le_bytes());
    bytes.extend_from_slice(&u32::from(height).to_le_bytes());
    for pixel in pixels {
        bytes.extend_from_slice(&[(pixel >> 16) as u8, (pixel >> 8) as u8, pixel as u8, 255]);
    }
    Ok(bytes.into())
}
fn publish(state: &watch::Sender<Snapshot>, change: impl FnOnce(&mut Snapshot)) {
    state.send_modify(|snapshot| {
        change(snapshot);
        snapshot.revision += 1;
    });
}
pub async fn run() -> anyhow::Result<()> {
    let mut stdin = std::io::BufReader::new(std::io::stdin());
    let mut line = String::new();
    (&mut stdin).take(16 * 1024 + 1).read_line(&mut line)?;
    if line.len() > 16 * 1024 || !line.ends_with('\n') {
        bail!("invalid session configuration");
    }
    let config: Configuration =
        serde_json::from_str(&line).context("invalid session configuration")?;
    super::validate_target(&config.target)?;
    if config.token.len() != 64
        || !config.token.bytes().all(|c| c.is_ascii_hexdigit())
        || config.origin.is_empty()
    {
        bail!("invalid authorization");
    }
    let observation = Arc::new(Mutex::new(None::<CertificateObservation>));
    let observed = observation.clone();
    let pin = config.target.trusted_sha256.clone();
    let destination = if config.target.host.contains(':') {
        format!("[{}]:{}", config.target.host, config.target.port)
    } else {
        format!("{}:{}", config.target.host, config.target.port)
    };
    let engine_config = ConfigBuilder::new()
        .with_client_build(0)
        .with_client_dir("Anas")
        .with_client_name("Anas")
        .with_platform(ironrdp_pdu::rdp::capability_sets::MajorPlatformType::UNSPECIFIED)
        .with_destination(Destination::new(destination)?)
        .with_username(config.username)
        .with_password(config.password)
        .with_domain(config.domain)
        .with_desktop_width(1280)
        .with_desktop_height(800)
        .with_tls(true)
        .with_credssp(true)
        .with_server_pointer(true)
        .with_pointer_software_rendering(false)
        .with_certificate_validation(ironrdp_tls::CertificateValidation::Strict)
        .with_certificate_validation_callback(Arc::new(move |der, _, error| {
            let fingerprint = format!("{:x}", Sha256::digest(der));
            let trusted = pin
                .as_ref()
                .map_or(error.is_empty(), |pin| pin == &fingerprint);
            *observed.lock().expect("certificate observation") = Some(CertificateObservation {
                sha256: fingerprint,
                trusted,
            });
            trusted
        }))
        .build()?;
    let (outputs, mut receiver) = output_channel(16);
    let client = RdpClient::new(engine_config, outputs).with_auto_reconnect(0);
    let input = client.input_sender();
    let controls = Arc::new(Mutex::new(Controls {
        owner: None,
        epoch: 0,
        keys: HashSet::new(),
        buttons: HashSet::new(),
        attached: HashSet::new(),
        ready: HashSet::new(),
    }));
    let (state, _) = watch::channel(Snapshot {
        revision: 0,
        state: "connecting".into(),
        image: None,
        cursor: json!({"kind":"default"}),
        owner: None,
        epoch: 0,
    });
    let state = Arc::new(state);
    let listener = super::listener::bind_browser_listener().await?;
    emit(json!({"status":"ready","port":listener.local_addr()?.port()}));
    // EOF, including a killed backend, ends the entire resource. Page sockets do not.
    let (commands, mut command_rx) = mpsc::channel::<Value>(16);
    std::thread::spawn(move || {
        loop {
            let mut line = String::new();
            match (&mut stdin).take(16 * 1024 + 1).read_line(&mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) if line.len() > 16 * 1024 || !line.ends_with('\n') => break,
                Ok(_) => {
                    if let Ok(value) = serde_json::from_str(&line) {
                        if commands.blocking_send(value).is_err() {
                            break;
                        }
                    } else {
                        break;
                    }
                }
            }
        }
    });
    let mut engine = Box::pin(client.run());
    let mut engine_done = false;
    let mut displays = tokio::task::JoinSet::new();
    let semaphore = Arc::new(tokio::sync::Semaphore::new(4));
    let connection_deadline = tokio::time::sleep(Duration::from_secs(30));
    tokio::pin!(connection_deadline);
    let mut established = false;
    let mut terminal = false;
    loop {
        tokio::select! {
            _ = &mut engine, if !engine_done => { engine_done = true; },
            command = command_rx.recv() => {
                let Some(command) = command else { break };
                let request = command.get("request").cloned().unwrap_or(Value::Null);
                let outcome = (|| -> anyhow::Result<Value> {
                    let method = command["method"].as_str().context("missing method")?;
                    let mut owner = controls.lock().expect("controls");
                    if method == "lease" { return Ok(json!({"owner":owner.owner,"epoch":owner.epoch})); }
                    let expected = command["expected"].as_str();
                    if owner.owner.as_deref() != expected || command["expectedEpoch"].as_u64() != Some(owner.epoch) { bail!("ownership changed"); }
                    if method != "claim" && method != "release" { bail!("unknown command"); }
                    let page = if method == "claim" {
                        let page = command["page"].as_str().context("missing page")?;
                        if !valid_page(page) || !owner.ready.contains(page) { bail!("page is not ready"); }
                        Some(page.to_owned())
                    } else { None };
                    owner.release(&input)?;
                    owner.epoch += 1;
                    owner.owner = page;
                    publish(&state, |snapshot| { snapshot.owner = owner.owner.clone(); snapshot.epoch = owner.epoch; });
                    Ok(json!({"owner":owner.owner,"epoch":owner.epoch}))
                })();
                match outcome {
                    Ok(result) => emit(json!({"request":request,"result":result})),
                    Err(_) => emit(json!({"request":request,"error":"RDP_OWNERSHIP_CHANGED"})),
                }
            },
            _ = &mut connection_deadline, if !established && !terminal => {
                terminal = true;
                input.request_close();
                publish(&state, |snapshot| snapshot.state = "connection_failed".into());
                emit(json!({"status":"connection_failed"}));
            },
            event = receiver.recv(), if !terminal => {
                let Some(event) = event else {
                    terminal = true;
                    let status = if established { "closed" } else { "connection_failed" };
                    publish(&state, |snapshot| snapshot.state = status.into());
                    emit(json!({"status":status}));
                    continue
                };
                match event {
                    RdpOutputEvent::Connected => { established = true; publish(&state, |snapshot| snapshot.state = "connected".into()); emit(json!({"status":"connected"})); },
                    RdpOutputEvent::Image { buffer, width, height } => match frame(buffer, width.get(), height.get()) {
                        Ok(image) => publish(&state, |snapshot| snapshot.image = Some(image)),
                        Err(_) => { input.request_close(); terminal = true; publish(&state, |snapshot| snapshot.state = "connection_failed".into()); emit(json!({"status":"connection_failed"})); }
                    },
                    RdpOutputEvent::PointerDefault => publish(&state, |snapshot| snapshot.cursor = json!({"kind":"default"})),
                    RdpOutputEvent::PointerHidden => publish(&state, |snapshot| snapshot.cursor = json!({"kind":"hidden"})),
                    RdpOutputEvent::PointerBitmap(pointer) => {
                        if pointer.bitmap_data.len() <= 1024 * 1024 {
                            publish(&state, |snapshot| snapshot.cursor = json!({"kind":"bitmap","width":pointer.width,"height":pointer.height,
                                "x":pointer.hotspot_x,"y":pointer.hotspot_y,"pixels":pointer.bitmap_data}));
                        }
                    },
                    RdpOutputEvent::ConnectionFailure(_) | RdpOutputEvent::Terminated(_) => {
                        terminal = true;
                        let certificate = observation.lock().expect("observation").clone();
                        let status = if certificate.as_ref().is_some_and(|c| !c.trusted) { "certificate_required" } else if established { "closed" } else { "connection_failed" };
                        publish(&state, |snapshot| snapshot.state = status.into());
                        emit(json!({"status":status,"certificate":certificate}));
                    },
                    _ => {},
                }
            },
            accepted = listener.accept() => {
                let (socket, _) = accepted?;
                if let Ok(permit) = semaphore.clone().try_acquire_owned() {
                    let token = config.token.clone(); let origin = config.origin.clone();
                    let state = state.clone(); let controls = controls.clone(); let input = input.clone();
                    displays.spawn(async move { let _permit = permit; let _ = display(socket, &token, &origin, state, controls, input).await; });
                }
            },
            Some(_) = displays.join_next(), if !displays.is_empty() => {},
        }
        // A terminal RDP result ends the resource; losing presentation pages does not.
        if terminal {
            break;
        }
    }
    input.request_close();
    displays.abort_all();
    while displays.join_next().await.is_some() {}
    if !engine_done {
        let _ = timeout(Duration::from_secs(2), &mut engine).await;
    }
    emit(json!({"status":"closed"}));
    Ok(())
}

#[allow(clippy::result_large_err)]
async fn display(
    socket: TcpStream,
    token: &str,
    origin: &str,
    state: Arc<watch::Sender<Snapshot>>,
    controls: Arc<Mutex<Controls>>,
    input: RdpInputSender,
) -> anyhow::Result<()> {
    let mut page = String::new();
    let mut ws = timeout(
        IO_TIMEOUT,
        accept_hdr_async_with_config(
            socket,
            |request: &Request, mut response: Response| {
                let protocols: Vec<_> = request
                    .headers()
                    .get("sec-websocket-protocol")
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or("")
                    .split(',')
                    .map(str::trim)
                    .collect();
                let allowed = protocols.len() == 3
                    && protocols[0] == "anas-rdp"
                    && bool::from(protocols[1].as_bytes().ct_eq(token.as_bytes()))
                    && valid_page(protocols[2])
                    && request.uri().path() == "/display"
                    && request.uri().query().is_none()
                    && request
                        .headers()
                        .get("origin")
                        .and_then(|v| v.to_str().ok())
                        == Some(origin);
                if !allowed {
                    return Err(tokio_tungstenite::tungstenite::http::Response::builder()
                        .status(403)
                        .body(Some("Forbidden".into()))
                        .expect("static response"));
                }
                page = protocols[2].to_owned();
                response.headers_mut().insert(
                    "sec-websocket-protocol",
                    "anas-rdp".parse().expect("static protocol"),
                );
                Ok(response)
            },
            Some(
                WebSocketConfig::default()
                    .max_message_size(Some(8192))
                    .max_frame_size(Some(8192))
                    .write_buffer_size(0)
                    .max_write_buffer_size(MAX_PIXELS * 4 + 1024),
            ),
        ),
    )
    .await??;
    if !controls
        .lock()
        .expect("controls")
        .attached
        .insert(page.clone())
    {
        bail!("page already attached");
    }
    let _lease = DisplayLease {
        page: page.clone(),
        controls: controls.clone(),
        input: input.clone(),
        state: state.clone(),
    };
    let mut updates = state.subscribe();
    let mut pending: Option<(u64, Instant, bool)> = None;
    let mut sent_revision = None;
    let mut tick = tokio::time::interval(Duration::from_millis(33));
    loop {
        tokio::select! {
            _ = tick.tick() => {
                if pending.as_ref().is_some_and(|(_, time, _)| time.elapsed() > Duration::from_secs(10)) { break; }
                if pending.is_some() { continue; }
                let snapshot = updates.borrow_and_update().clone();
                if sent_revision == Some(snapshot.revision) { continue; }
                timeout(IO_TIMEOUT, ws.send(Message::Text(json!({"type":"snapshot","revision":snapshot.revision,"state":snapshot.state,
                    "cursor":snapshot.cursor,"owner":snapshot.owner,"epoch":snapshot.epoch,"image":snapshot.image.is_some()}).to_string().into()))).await??;
                let complete_image = snapshot.state == "connected" && snapshot.image.is_some();
                if let Some(image) = snapshot.image { timeout(IO_TIMEOUT, ws.send(Message::Binary(image))).await??; }
                pending = Some((snapshot.revision, Instant::now(), complete_image));
                sent_revision = Some(snapshot.revision);
            },
            message = ws.next() => match message {
                Some(Ok(Message::Text(text))) => {
                    let message: Value = serde_json::from_str(&text)?;
                    if message["type"] == "ack" {
                        if pending.as_ref().map(|(revision, _, _)| *revision) == message["revision"].as_u64() {
                            let ready = pending.take().is_some_and(|(_, _, image)| image);
                            if ready {
                                let first = controls.lock().expect("controls").ready.insert(page.clone());
                                if first { timeout(IO_TIMEOUT, ws.send(Message::Text(json!({"type":"ready"}).to_string().into()))).await??; }
                            }
                        }
                    } else {
                        let mut owner = controls.lock().expect("controls");
                        if owner.owner.as_deref() != Some(&page) || message["epoch"].as_u64() != Some(owner.epoch) { continue; }
                        handle_input(&message, &mut owner, &input)?;
                    }
                },
                Some(Ok(Message::Ping(_))) => { timeout(IO_TIMEOUT, ws.flush()).await??; },
                Some(Ok(Message::Pong(_))) => {},
                _ => break,
            },
        }
    }

    Ok(())
}

fn handle_input(value: &Value, owner: &mut Controls, input: &RdpInputSender) -> anyhow::Result<()> {
    match value["type"].as_str() {
        Some("release") => owner.release(input)?,
        Some("key") => {
            let code = u8::try_from(value["code"].as_u64().context("invalid key")?)?;
            let extended = value["extended"].as_bool().unwrap_or(false);
            let down = value["down"].as_bool().context("invalid key")?;
            if down && owner.keys.len() >= 100 && !owner.keys.contains(&(code, extended)) {
                bail!("too many keys");
            }
            let mut flags = if down {
                KeyboardFlags::empty()
            } else {
                KeyboardFlags::RELEASE
            };
            if extended {
                flags |= KeyboardFlags::EXTENDED;
            }
            send(input, FastPathInputEvent::KeyboardEvent(flags, code))?;
            if down {
                owner.keys.insert((code, extended));
            } else {
                owner.keys.remove(&(code, extended));
            }
        }
        Some("mouse") => {
            let x = u16::try_from(value["x"].as_u64().context("invalid position")?)?;
            let y = u16::try_from(value["y"].as_u64().context("invalid position")?)?;
            let bits = u16::try_from(value["flags"].as_u64().context("invalid flags")?)?;
            if bits & !0xfa00 != 0 {
                bail!("invalid mouse flags");
            }
            let wheel = value["wheel"].as_i64().unwrap_or(0).clamp(-256, 255) as i16;
            send(
                input,
                FastPathInputEvent::MouseEvent(MousePdu {
                    flags: PointerFlags::from_bits_retain(bits),
                    x_position: x,
                    y_position: y,
                    number_of_wheel_rotation_units: wheel,
                }),
            )?;
            for button in [0x1000, 0x2000, 0x4000] {
                if bits & button != 0 {
                    if bits & 0x8000 != 0 {
                        owner.buttons.insert(button);
                    } else {
                        owner.buttons.remove(&button);
                    }
                }
            }
        }
        _ => bail!("invalid input"),
    }
    Ok(())
}

// Runs for ordinary close, parse errors, timeouts, task cancellation and unwinding.
struct DisplayLease {
    page: String,
    controls: Arc<Mutex<Controls>>,
    input: RdpInputSender,
    state: Arc<watch::Sender<Snapshot>>,
}
impl Drop for DisplayLease {
    fn drop(&mut self) {
        let Ok(mut owner) = self.controls.lock() else {
            return;
        };
        owner.attached.remove(&self.page);
        owner.ready.remove(&self.page);
        if owner.owner.as_deref() != Some(&self.page) {
            return;
        }
        if owner.release(&self.input).is_err() {
            self.input.request_close();
            publish(&self.state, |snapshot| {
                snapshot.state = "connection_failed".into()
            });
            emit(json!({"status":"connection_failed"}));
        }
        owner.owner = None;
        owner.epoch += 1;
        publish(&self.state, |snapshot| {
            snapshot.owner = None;
            snapshot.epoch = owner.epoch;
        });
    }
}
