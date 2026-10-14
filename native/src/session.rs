//! A session outlives every attached display page. RDP stays inside IronRDP.
use super::{CertificateObservation, Target};
use anyhow::{Context, bail};
use bytes::Bytes;
use futures_util::{SinkExt, StreamExt};
use ironrdp_client::{
    config::{ClipboardType, ConfigBuilder, Destination},
    output_channel::output_channel,
    rdp::{DisplayResizeFallbackReason, RdpClient, RdpInputEvent, RdpInputSender, RdpOutputEvent},
};
use ironrdp_displaycontrol::client::DisplayControlClient;
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
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use subtle::ConstantTimeEq;
use tokio::net::TcpStream;
use tokio::sync::{Notify, mpsc, watch};
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
    #[serde(default = "default_desktop_width")]
    desktop_width: u16,
    #[serde(default = "default_desktop_height")]
    desktop_height: u16,
    #[serde(default)]
    clipboard_support: bool,
    token: String,
    origin: String,
}
fn default_desktop_width() -> u16 {
    1280
}
fn default_desktop_height() -> u16 {
    800
}

fn validate_resolution(width: u16, height: u16) -> anyhow::Result<()> {
    if !(200..=8192).contains(&width)
        || !(200..=8192).contains(&height)
        || !width.is_multiple_of(2)
        || usize::from(width) * usize::from(height) > MAX_PIXELS
    {
        bail!("RDP_INVALID_RESOLUTION");
    }
    Ok(())
}
#[derive(Clone)]
struct Snapshot {
    revision: u64,
    state: String,
    image: Option<Bytes>,
    cursor: Value,
    owner: Option<String>,
    epoch: u64,
    ui_locked: bool,
    clipboard_enabled: bool,
    clipboard_state: String,
    resize_error: Option<String>,
    resize_supported: bool,
    ui_revision: u64,
    frame_revision: u64,
    frame_time: u64,
    cursor_revision: u64,
    cursor_time: u64,
    position: Option<(u16, u16)>,
    cursor_animate: bool,
    input_revision: u64,
    input_time: u64,
}
#[derive(Default)]
struct Controls {
    owner: Option<String>,
    epoch: u64,
    ui_locked: bool,
    ui_revision: u64,
    keys: HashSet<(u8, bool)>,
    buttons: HashSet<u16>,
    attached: HashSet<String>,
    ready: HashSet<String>,
    position: (u16, u16),
    release_wakeup: Arc<Notify>,
}
impl Controls {
    fn releases(&self) -> super::input::Events {
        self.keys
            .iter()
            .map(|&(code, extended)| super::input::key(code, extended, false))
            .chain(
                self.buttons.iter().map(|&button| {
                    super::input::mouse(self.position.0, self.position.1, button, 0)
                }),
            )
            .collect()
    }
    fn release(&mut self, input: &RdpInputSender) -> anyhow::Result<()> {
        let events = self.releases();
        if !events.is_empty() {
            input
                .try_send(RdpInputEvent::FastPath(events))
                .map_err(|_| anyhow::anyhow!("RDP_INPUT_UNAVAILABLE"))?;
        }
        self.keys.clear();
        self.buttons.clear();
        Ok(())
    }
    fn reset_input(&mut self, input: &RdpInputSender, position: (u16, u16)) -> anyhow::Result<()> {
        use ironrdp_pdu::input::fast_path::SynchronizeFlags;
        // Queue the whole reset together, including buttons not tracked by the UI.
        // Ordinary tool input intentionally does not track held keys or buttons.
        let mut events = super::input::Events::new();
        events.push(FastPathInputEvent::SyncEvent(SynchronizeFlags::empty()));
        events.extend(
            [0x1000, 0x2000, 0x4000]
                .map(|button| super::input::mouse(position.0, position.1, button, 0)),
        );
        input
            .try_send(RdpInputEvent::FastPath(events))
            .map_err(|_| anyhow::anyhow!("RDP_INPUT_UNAVAILABLE"))?;
        self.keys.clear();
        self.buttons.clear();
        self.position = position;
        Ok(())
    }
    fn release_detached(&mut self, input: &RdpInputSender) -> anyhow::Result<()> {
        if self.owner.is_none() {
            self.release(input)?;
        }
        Ok(())
    }
    fn accepts_ui(&self, revision: Option<u64>) -> bool {
        !self.ui_locked && revision == Some(self.ui_revision)
    }
    fn set_ui_locked(&mut self, locked: bool, input: &RdpInputSender) -> anyhow::Result<()> {
        if self.ui_locked != locked {
            self.release(input)?;
            self.ui_locked = locked;
            self.ui_revision += 1;
        }
        Ok(())
    }
    fn set_owner(&mut self, next: Option<String>) {
        if self.owner != next {
            self.owner = next;
            self.epoch += 1;
        }
    }
}
// Retry only local UI releases after presentation disappears. The connection
// keeps running and tools never acquire a held-key database through this path.
async fn release_detached_inputs(controls: Arc<Mutex<Controls>>, input: RdpInputSender) {
    let wakeup = controls.lock().expect("controls").release_wakeup.clone();
    loop {
        wakeup.notified().await;
        loop {
            if controls
                .lock()
                .expect("controls")
                .release_detached(&input)
                .is_ok()
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }
}
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn emit(value: Value) {
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{value}");
    let _ = out.flush();
}
fn send(input: &RdpInputSender, event: FastPathInputEvent) -> anyhow::Result<()> {
    input
        .try_send(RdpInputEvent::FastPath(smallvec::smallvec![event]))
        .map_err(|_| anyhow::anyhow!("RDP_INPUT_UNAVAILABLE"))
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

#[derive(Default)]
struct DisplayUpdates {
    revision: Option<u64>,
    frame_revision: Option<u64>,
    cursor_revision: Option<u64>,
    cursor: Option<Value>,
}
impl DisplayUpdates {
    fn next(
        &mut self,
        snapshot: &Snapshot,
        mouse_sequence: u64,
    ) -> anyhow::Result<Option<(Value, Option<Bytes>)>> {
        if self.revision == Some(snapshot.revision)
            && self.cursor_revision == Some(snapshot.cursor_revision)
        {
            return Ok(None);
        }
        let image = snapshot
            .image
            .clone()
            .filter(|_| self.frame_revision != Some(snapshot.frame_revision));
        let mut metadata = json!({"type":"snapshot","revision":snapshot.revision,"state":snapshot.state,
            "cursorPosition":snapshot.position.map(|(x,y)| json!({"x":x,"y":y})),"cursorAnimate":snapshot.cursor_animate,"mouseSequence":mouse_sequence,
            "owner":snapshot.owner,"epoch":snapshot.epoch,"clipboardEnabled":snapshot.clipboard_enabled,
            "clipboardState":snapshot.clipboard_state,"resizeError":snapshot.resize_error,"resizeSupported":snapshot.resize_supported,"uiLocked":snapshot.ui_locked,"uiRevision":snapshot.ui_revision,"image":image.is_some()});
        if self.cursor_revision != Some(snapshot.cursor_revision)
            && self.cursor.as_ref() != Some(&snapshot.cursor)
        {
            metadata["cursor"] = if snapshot.cursor["kind"] == "hidden" {
                snapshot.cursor.clone()
            } else {
                let (width, height, x, y, pixels) =
                    super::screenshot::cursor_pixels(&snapshot.cursor)?;
                json!({"kind":snapshot.cursor["kind"],"width":width,"height":height,"x":x,"y":y,"pixels":pixels})
            };
            self.cursor = Some(snapshot.cursor.clone());
        }
        self.revision = Some(snapshot.revision);
        self.cursor_revision = Some(snapshot.cursor_revision);
        if image.is_some() {
            self.frame_revision = Some(snapshot.frame_revision);
        }
        Ok(Some((metadata, image)))
    }
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
    validate_resolution(config.desktop_width, config.desktop_height)?;
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
    let (display_control, mut display_control_ready) = watch::channel(false);
    let engine_config = ConfigBuilder::new()
        .with_dvc(move |_| {
            let ready = display_control.clone();
            Some(DisplayControlClient::new(move |_| {
                ready.send_replace(true);
                Ok(Vec::new())
            }))
        })
        .with_client_build(0)
        .with_client_dir("Anas")
        .with_client_name("Anas")
        .with_platform(ironrdp_pdu::rdp::capability_sets::MajorPlatformType::UNSPECIFIED)
        .with_destination(Destination::new(destination)?)
        .with_username(config.username)
        .with_password(config.password)
        .with_domain(config.domain)
        .with_desktop_width(config.desktop_width)
        .with_desktop_height(config.desktop_height)
        .with_clipboard(if config.clipboard_support {
            ClipboardType::Enable
        } else {
            ClipboardType::Disable
        })
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
    let mut client = RdpClient::new(engine_config, outputs)
        .with_auto_reconnect(0)
        .with_resize_reconnect(false);
    let input = client.input_sender();
    let clipboard = if config.clipboard_support {
        let bridge = super::clipboard::Clipboard::new(input.clone())?;
        client = client.with_cliprdr_backend_factory(Box::new(bridge.clone()));
        Some(bridge)
    } else {
        None
    };
    let mut clipboard_status = clipboard.as_ref().map(|value| value.subscribe());
    let controls = Arc::new(Mutex::new(Controls::default()));
    let (state, _) = watch::channel(Snapshot {
        revision: 0,
        state: "connecting".into(),
        image: None,
        cursor: json!({"kind":"default"}),
        owner: None,
        epoch: 0,
        ui_locked: false,
        clipboard_enabled: false,
        clipboard_state: clipboard_status
            .as_ref()
            .map(|status| *status.borrow())
            .unwrap_or("disabled")
            .into(),
        resize_error: None,
        resize_supported: false,
        ui_revision: 0,
        frame_revision: 0,
        frame_time: 0,
        cursor_revision: 0,
        cursor_time: 0,
        position: None,
        cursor_animate: false,
        input_revision: 0,
        input_time: 0,
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
    let mut captures = tokio::task::JoinSet::new();
    let semaphore = Arc::new(tokio::sync::Semaphore::new(4));
    let connection_deadline = tokio::time::sleep(Duration::from_secs(30));
    tokio::pin!(connection_deadline);
    let mut established = false;
    let mut terminal = false;
    let mut timed_input: Option<(Value, super::input::TimedInput)> = None;
    let releases = release_detached_inputs(controls.clone(), input.clone());
    tokio::pin!(releases);
    loop {
        let next_input_at = timed_input
            .as_ref()
            .map_or_else(Instant::now, |(_, gesture)| {
                gesture.next_at.min(gesture.deadline)
            });
        tokio::select! {
            _ = &mut engine, if !engine_done => { engine_done = true; },
            _ = &mut releases => {},
            Ok(()) = display_control_ready.changed(), if !terminal => {
                let supported = *display_control_ready.borrow_and_update();
                publish(&state, |snapshot| snapshot.resize_supported = supported);
            },
            _ = tokio::time::sleep_until(next_input_at), if timed_input.is_some() => {
                let mut owner = controls.lock().expect("controls");
                let (_, gesture) = timed_input.as_mut().expect("pending input");
                // Old UI releases must enter the queue before subsequent tool input.
                let outcome = owner.release_detached(&input).and_then(|()| gesture.advance(&input, Instant::now()));
                if outcome.is_ok() {
                    let position = gesture.position();
                    if let Some(position) = position { owner.position = position; }
                    publish(&state, |snapshot| {
                        snapshot.input_revision += 1; snapshot.input_time = now_ms();
                        if let Some(position) = position {
                            snapshot.position = Some(position); snapshot.cursor_revision += 1; snapshot.cursor_time = snapshot.input_time;
                            snapshot.cursor_animate = gesture.animate_cursor();
                        }
                    });
                }
                match outcome {
                    Ok(false) => {},
                    Ok(true) => {
                        let (request, _) = timed_input.take().expect("completed input");
                        let epoch = owner.epoch;
                        emit(json!({"request":request,"result":{"accepted":true,"epoch":epoch,"input_revision":state.borrow().input_revision}}));
                    },
                    Err(error) => {
                        let (request, _) = timed_input.take().expect("failed input");
                        // Report partial dispatch without inventing releases or changing the connection.
                        emit(json!({"request":request,"error":error.to_string()}));
                    }
                }
            },
            changed = async {
                match &mut clipboard_status {
                    Some(status) => status.changed().await.ok(),
                    None => std::future::pending().await,
                }
            } => {
                if changed.is_none() { clipboard_status = None; continue; }
                let value = *clipboard_status.as_ref().unwrap().borrow();
                publish(&state, |snapshot| snapshot.clipboard_state = value.into());
                emit(json!({"clipboardState":value}));
            },
            command = command_rx.recv() => {
                let Some(command) = command else { break };
                let request = command.get("request").cloned().unwrap_or(Value::Null);
                if command["method"] == "screenshot" {
                    let snapshot = state.borrow().clone();
                    while captures.try_join_next().is_some() {}
                    if !captures.is_empty() { emit(json!({"request":request,"error":"RDP_SCREENSHOT_BUSY"})); continue; }
                    let Some(image) = snapshot.image else { emit(json!({"request":request,"error":"RDP_FRAME_UNAVAILABLE"})); continue; };
                    let include_cursor = command["includeCursor"].as_bool().unwrap_or(true);
                    let captured_at = now_ms();
                    captures.spawn_blocking(move || {
                        match super::screenshot::capture(&image, &snapshot.cursor, snapshot.position, include_cursor) {
                            Ok(shot) => {
                                let metadata = json!({"width":shot.width,"height":shot.height,"coordinate_system":"desktop_pixels",
                                    "captured_at":captured_at,"state":snapshot.state,"stale":snapshot.state != "connected",
                                    "frame_revision":snapshot.frame_revision,"frame_time":snapshot.frame_time,
                                    "cursor_revision":snapshot.cursor_revision,"cursor_time":snapshot.cursor_time,
                                    "cursor_position":snapshot.position.map(|(x,y)| json!({"x":x,"y":y})),
                                    "cursor_kind":snapshot.cursor["kind"],"cursor_drawn":shot.cursor_drawn,
                                    "input_revision":snapshot.input_revision,"input_time":snapshot.input_time,"ui_locked":snapshot.ui_locked});
                                emit(json!({"request":request,"result":[{"type":"text","text":metadata.to_string()},
                                    {"type":"image","mimeType":"image/png","data":shot.data}]}));
                            },
                            Err(_) => emit(json!({"request":request,"error":"RDP_SCREENSHOT_FAILED"})),
                        }
                    });
                    continue;
                }
                let outcome = (|| -> anyhow::Result<Option<Value>> {
                    let method = command["method"].as_str().context("missing method")?;
                    let mut owner = controls.lock().expect("controls");
                    if method == "lease" { return Ok(Some(json!({"owner":owner.owner,"epoch":owner.epoch}))); }
                    if method == "resize" {
                        if state.borrow().state != "connected" { bail!("RDP_NOT_CONNECTED"); }
                        if let Some(error) = &state.borrow().resize_error { bail!("{error}"); }
                        if timed_input.is_some() || !owner.keys.is_empty() || !owner.buttons.is_empty() { bail!("RDP_INPUT_BUSY"); }
                        let width = u16::try_from(command["width"].as_u64().context("RDP_INVALID_RESOLUTION")?)?;
                        let height = u16::try_from(command["height"].as_u64().context("RDP_INVALID_RESOLUTION")?)?;
                        resize_display(&owner, &input, command["page"].as_str(), command["expectedEpoch"].as_u64(), width, height)?;
                        return Ok(Some(json!({"accepted":true})));
                    }
                    if method == "setClipboardActivity" {
                        let active = command["active"].as_bool().context("RDP_CLIPBOARD_UNAVAILABLE")?;
                        let can_publish = command["publish"].as_bool().context("RDP_CLIPBOARD_UNAVAILABLE")?;
                        clipboard.as_ref().context("RDP_CLIPBOARD_UNAVAILABLE")?.set_activity(active, can_publish)?;
                        return Ok(Some(json!({"active":active,"publish":can_publish})));
                    }
                    if method == "setClipboardEnabled" {
                        if state.borrow().state != "connected" { bail!("RDP_NOT_CONNECTED"); }
                        let enabled = command["enabled"].as_bool().context("RDP_CLIPBOARD_UNAVAILABLE")?;
                        clipboard.as_ref().context("RDP_CLIPBOARD_UNAVAILABLE")?.set_enabled(enabled)?;
                        publish(&state, |snapshot| snapshot.clipboard_enabled = enabled);
                        emit(json!({"clipboardEnabled":enabled}));
                        return Ok(Some(json!({"enabled":enabled,"revision":state.borrow().revision})));
                    }
                    if method == "setUiLocked" {
                        let locked = command["locked"].as_bool().context("RDP_INVALID_LOCK")?;
                        if state.borrow().state != "connected" { bail!("RDP_NOT_CONNECTED"); }
                        owner.set_ui_locked(locked, &input)?;
                        publish(&state, |snapshot| { snapshot.ui_locked = owner.ui_locked; snapshot.ui_revision = owner.ui_revision; });
                        emit(json!({"uiLocked":owner.ui_locked}));
                        return Ok(Some(json!({"ui_locked":owner.ui_locked,"uiRevision":owner.ui_revision})));
                    }
                    if method == "resetInput" {
                        if state.borrow().state != "connected" { bail!("RDP_NOT_CONNECTED"); }
                        let position = state.borrow().position.unwrap_or(owner.position);
                        owner.reset_input(&input, position)?;
                        // No old sequence step can run between enqueueing the reset and cancelling it.
                        if let Some((interrupted, _)) = timed_input.take() {
                            emit(json!({"request":interrupted,"error":"RDP_INPUT_RESET"}));
                        }
                        publish(&state, |snapshot| {
                            snapshot.input_revision += 1; snapshot.input_time = now_ms();
                        });
                        return Ok(Some(json!({"accepted":true,"toggle_flags":0,"input_revision":state.borrow().input_revision})));
                    }
                    if method == "input" {
                        if timed_input.is_some() { bail!("RDP_INPUT_BUSY"); }
                        let snapshot = state.borrow().clone();
                        if snapshot.state != "connected" { bail!("RDP_NOT_CONNECTED"); }
                        let image = snapshot.image.context("RDP_FRAME_UNAVAILABLE")?;
                        let width = u32::from_le_bytes(image[0..4].try_into()?);
                        let height = u32::from_le_bytes(image[4..8].try_into()?);
                        let batch = super::input::batch(&command["actions"], width, height)
                            .map_err(|error| anyhow::anyhow!("RDP_INVALID_INPUT: {error}"))?;
                        let interval = batch.interval(command.get("interval_ms")).map_err(|error| anyhow::anyhow!("RDP_INVALID_INPUT: {error}"))?;
                        let remaining_ms = match command.get("deadline_ms") {
                            Some(value) => value.as_u64().context("RDP_INVALID_INPUT: invalid deadline")?.saturating_sub(now_ms()),
                            None => super::input::INPUT_TIMEOUT_MS,
                        };
                        let remaining = Duration::from_millis(remaining_ms.min(super::input::INPUT_TIMEOUT_MS));
                        if remaining.is_zero() || batch.duration(interval) >= remaining { bail!("RDP_INPUT_TIMEOUT"); }
                        if !batch.duration(interval).is_zero() {
                            let now = Instant::now();
                            timed_input = Some((request.clone(), super::input::TimedInput::new(batch, interval, now, now + remaining)));
                            return Ok(None);
                        }
                        // Flush an earlier page's releases first; never track tool-held keys.
                        owner.release_detached(&input)?;
                        input.try_send(RdpInputEvent::FastPath(batch.events)).map_err(|_| anyhow::anyhow!("RDP_INPUT_UNAVAILABLE"))?;
                        if let Some(position) = batch.position { owner.position = position; }
                        publish(&state, |snapshot| {
                            snapshot.input_revision += 1; snapshot.input_time = now_ms();
                            if let Some(position) = batch.position {
                                snapshot.position = Some(position); snapshot.cursor_revision += 1; snapshot.cursor_time = snapshot.input_time;
                                snapshot.cursor_animate = batch.animate_cursor;
                            }
                        });
                        return Ok(Some(json!({"accepted":true,"epoch":owner.epoch,"input_revision":state.borrow().input_revision})));
                    }
                    let expected = command["expected"].as_str();
                    if owner.owner.as_deref() != expected || command["expectedEpoch"].as_u64() != Some(owner.epoch) { bail!("ownership changed"); }
                    if method != "claim" && method != "release" { bail!("unknown command"); }
                    let page = if method == "claim" {
                        let page = command["page"].as_str().context("missing page")?;
                        if !valid_page(page) || !owner.ready.contains(page) { bail!("page is not ready"); }
                        Some(page.to_owned())
                    } else { None };
                    owner.release(&input)?;
                    owner.set_owner(page);
                    publish(&state, |snapshot| { snapshot.owner = owner.owner.clone(); snapshot.epoch = owner.epoch; });
                    Ok(Some(json!({"owner":owner.owner,"epoch":owner.epoch})))
                })();
                match outcome {
                    Ok(None) => {},
                    Ok(Some(result)) => emit(json!({"request":request,"result":result})),
                    Err(error) => { let message = error.to_string(); emit(json!({"request":request,"error":if message.starts_with("RDP_") { &message } else { "RDP_OWNERSHIP_CHANGED" }})); },
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
                    RdpOutputEvent::DisplayResizeRejected(reason) => {
                        let error = match reason {
                            DisplayResizeFallbackReason::DisplayControlUnavailable => "RDP_RESIZE_UNSUPPORTED",
                            DisplayResizeFallbackReason::CapabilitiesTimedOut | DisplayResizeFallbackReason::ReactivationTimedOut => "RDP_RESIZE_TIMEOUT",
                        };
                        publish(&state, |snapshot| snapshot.resize_error = Some(error.into()));
                    },
                    RdpOutputEvent::Connected => { established = true; publish(&state, |snapshot| snapshot.state = "connected".into()); emit(json!({"status":"connected"})); },
                    RdpOutputEvent::Image { buffer, width, height } => match frame(buffer, width.get(), height.get()) {
                        Ok(image) => publish(&state, |snapshot| { snapshot.image = Some(image); snapshot.frame_revision += 1; snapshot.frame_time = now_ms(); }),
                        Err(_) => { input.request_close(); terminal = true; publish(&state, |snapshot| snapshot.state = "connection_failed".into()); emit(json!({"status":"connection_failed"})); }
                    },
                    RdpOutputEvent::PointerDefault => publish(&state, |snapshot| { snapshot.cursor = json!({"kind":"default"}); snapshot.cursor_revision += 1; snapshot.cursor_time = now_ms(); }),
                    RdpOutputEvent::PointerHidden => publish(&state, |snapshot| { snapshot.cursor = json!({"kind":"hidden"}); snapshot.cursor_revision += 1; snapshot.cursor_time = now_ms(); }),
                    RdpOutputEvent::PointerPosition { x, y } => state.send_modify(|snapshot| {
                        if snapshot.position != Some((x, y)) { snapshot.cursor_animate = false; }
                        snapshot.position = Some((x, y)); snapshot.cursor_revision += 1; snapshot.cursor_time = now_ms();
                    }),
                    RdpOutputEvent::PointerBitmap(pointer) => {
                        if pointer.bitmap_data.len() <= 1024 * 1024 {
                            publish(&state, |snapshot| { snapshot.cursor = json!({"kind":"bitmap","width":pointer.width,"height":pointer.height,
                                "x":pointer.hotspot_x,"y":pointer.hotspot_y,"pixels":pointer.bitmap_data}); snapshot.cursor_revision += 1; snapshot.cursor_time = now_ms(); });
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
            Some(_) = captures.join_next(), if !captures.is_empty() => {},
        }
        // A terminal RDP result ends the resource; losing presentation pages does not.
        if terminal {
            break;
        }
    }
    if let Some((request, _)) = timed_input.take() {
        emit(json!({"request":request,"error":"RDP_SESSION_CLOSED"}));
    }
    if let Some(clipboard) = &clipboard {
        clipboard.close();
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
    let mut sent = DisplayUpdates::default();
    let mut mouse_sequence = 0;
    let mut tick = tokio::time::interval(Duration::from_millis(33));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            _ = tick.tick() => {
                if pending.as_ref().is_some_and(|(_, time, _)| time.elapsed() > Duration::from_secs(10)) { break; }
                if pending.is_some() { continue; }
                let snapshot = updates.borrow_and_update().clone();
                let Some((metadata, image)) = sent.next(&snapshot, mouse_sequence)? else { continue; };
                timeout(IO_TIMEOUT, ws.send(Message::Text(metadata.to_string().into()))).await??;
                let complete_image = snapshot.state == "connected" && image.is_some();
                if let Some(image) = image { timeout(IO_TIMEOUT, ws.send(Message::Binary(image))).await??; }
                pending = Some((snapshot.revision, Instant::now(), complete_image));
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
                        // Both transitions invalidate old UI events, including events queued while locked.
                        if !owner.accepts_ui(message["uiRevision"].as_u64()) { continue; }
                        if message["type"] == "takeover" {
                            if message["epoch"].as_u64() == Some(owner.epoch) && owner.ready.contains(&page) {
                                owner.release(&input)?;
                                owner.set_owner(Some(page.clone()));
                                publish(&state, |snapshot| { snapshot.owner = owner.owner.clone(); snapshot.epoch = owner.epoch; });
                            }
                            continue;
                        }
                        if owner.owner.as_deref() != Some(&page) || message["epoch"].as_u64() != Some(owner.epoch) { continue; }
                        let sequence = if message["type"] == "mouse" {
                            let sequence = message["mouseSequence"].as_u64().context("invalid mouse sequence")?;
                            if sequence <= mouse_sequence || sequence > 9_007_199_254_740_991 { bail!("invalid mouse sequence"); }
                            sequence
                        } else { mouse_sequence };
                        handle_input(&message, &mut owner, &input)?;
                        mouse_sequence = sequence;
                        // Position updates share the bounded display stream, never resend the frame.
                        state.send_modify(|snapshot| {
                            snapshot.input_revision += 1; snapshot.input_time = now_ms();
                            if message["type"] == "mouse" {
                                snapshot.position = Some((message["x"].as_u64().unwrap_or(0) as u16, message["y"].as_u64().unwrap_or(0) as u16));
                                snapshot.cursor_animate = false;
                                snapshot.cursor_revision += 1; snapshot.cursor_time = snapshot.input_time;
                            }
                        });
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

fn resize_display(
    owner: &Controls,
    input: &RdpInputSender,
    page: Option<&str>,
    epoch: Option<u64>,
    width: u16,
    height: u16,
) -> anyhow::Result<()> {
    if page.is_none()
        || owner.owner.as_deref() != page
        || epoch != Some(owner.epoch)
        || !owner.ready.contains(page.unwrap())
    {
        bail!("RDP_OWNERSHIP_CHANGED");
    }
    validate_resolution(width, height)?;
    input
        .try_send(RdpInputEvent::Resize {
            width,
            height,
            scale_factor: 100,
            physical_size: None,
        })
        .map_err(|_| anyhow::anyhow!("RDP_INPUT_UNAVAILABLE"))?;
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
            owner.position = (x, y);
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
            // A full input queue is temporary backpressure, not a failed session.
            // Retain the local UI keys/buttons until their releases can be queued.
            owner.release_wakeup.notify_one();
        }
        owner.owner = None;
        owner.epoch += 1;
        publish(&self.state, |snapshot| {
            snapshot.owner = None;
            snapshot.epoch = owner.epoch;
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ironrdp_pdu::input::fast_path::SynchronizeFlags;

    #[test]
    fn fixed_resolution_defaults_and_limits() {
        let mut value = json!({"host":"test.invalid","username":"fixture","password":"","token":"test","origin":"test"});
        let default: Configuration = serde_json::from_value(value.clone()).unwrap();
        assert_eq!((default.desktop_width, default.desktop_height), (1280, 800));
        value["desktop_width"] = json!(1024);
        value["desktop_height"] = json!(768);
        let custom: Configuration = serde_json::from_value(value).unwrap();
        assert_eq!((custom.desktop_width, custom.desktop_height), (1024, 768));
        for (width, height) in [(1024, 768), (200, 200), (8192, 2048), (3840, 2160)] {
            validate_resolution(width, height).unwrap();
        }
        for (width, height) in [
            (0, 800),
            (1280, 0),
            (199, 800),
            (1281, 800),
            (8194, 800),
            (1280, 8193),
            (8192, 8192),
        ] {
            assert!(validate_resolution(width, height).is_err());
        }
    }

    fn connected_state() -> Arc<watch::Sender<Snapshot>> {
        Arc::new(
            watch::channel(Snapshot {
                revision: 0,
                state: "connected".into(),
                image: None,
                cursor: json!({"kind":"default"}),
                owner: Some("page".into()),
                epoch: 0,
                ui_locked: false,
                clipboard_enabled: false,
                clipboard_state: "disabled".into(),
                resize_error: None,
                resize_supported: false,
                ui_revision: 0,
                frame_revision: 0,
                frame_time: 0,
                cursor_revision: 0,
                cursor_time: 0,
                position: None,
                cursor_animate: false,
                input_revision: 0,
                input_time: 0,
            })
            .0,
        )
    }

    #[test]
    fn display_sends_cursor_updates_without_retransmitting_frames_or_shapes() {
        let state = connected_state();
        state.send_modify(|snapshot| {
            snapshot.image = Some(frame(vec![0xff123456; 4], 2, 2).unwrap());
        });
        let mut display = DisplayUpdates::default();
        let (initial, image) = display.next(&state.borrow(), 0).unwrap().unwrap();
        assert!(image.is_some());
        assert_eq!(initial["cursorPosition"], Value::Null);
        assert_eq!(initial["cursorAnimate"], false);
        assert_eq!(initial["cursor"]["kind"], "default");
        assert_eq!(
            initial["cursor"]["pixels"].as_array().unwrap().len(),
            12 * 16 * 4
        );
        assert!(display.next(&state.borrow(), 0).unwrap().is_none());

        // Several accepted moves within a display tick coalesce into the last position.
        for position in [(0, 0), (1, 0), (1, 1)] {
            state.send_modify(|snapshot| {
                snapshot.position = Some(position);
                snapshot.cursor_animate = true;
                snapshot.cursor_revision += 1;
            });
        }
        let (moved, image) = display.next(&state.borrow(), 3).unwrap().unwrap();
        assert!(image.is_none());
        assert_eq!(moved["image"], false);
        assert!(moved.get("cursor").is_none());
        assert_eq!(moved["cursorPosition"], json!({"x":1,"y":1}));
        assert_eq!(moved["mouseSequence"], 3);
        assert_eq!(moved["cursorAnimate"], true);
        assert!(display.next(&state.borrow(), 3).unwrap().is_none());

        // A click at the same coordinates must still cancel a local animation.
        publish(&state, |snapshot| snapshot.cursor_animate = false);
        let (clicked, image) = display.next(&state.borrow(), 3).unwrap().unwrap();
        assert_eq!(clicked["cursorPosition"], moved["cursorPosition"]);
        assert_eq!(clicked["cursorAnimate"], false);
        assert!(image.is_none());

        publish(&state, |snapshot| {
            snapshot.cursor = json!({"kind":"hidden"});
            snapshot.cursor_revision += 1;
        });
        let (hidden, image) = display.next(&state.borrow(), 3).unwrap().unwrap();
        assert!(image.is_none());
        assert_eq!(hidden["cursor"]["kind"], "hidden");
        publish(&state, |snapshot| snapshot.ui_locked = true);
        let (locked, image) = display.next(&state.borrow(), 3).unwrap().unwrap();
        assert!(image.is_none());
        assert!(locked.get("cursor").is_none());

        publish(&state, |snapshot| snapshot.frame_revision += 1);
        assert!(
            display
                .next(&state.borrow(), 3)
                .unwrap()
                .unwrap()
                .1
                .is_some()
        );
        // A new page receives a complete frame and the latest cursor even without a new RDP frame.
        let (restored, image) = DisplayUpdates::default()
            .next(&state.borrow(), 0)
            .unwrap()
            .unwrap();
        assert!(image.is_some());
        assert_eq!(restored["cursorPosition"], json!({"x":1,"y":1}));
        assert_eq!(restored["cursor"]["kind"], "hidden");
    }

    #[tokio::test]
    async fn closing_a_page_retries_full_queue_releases_without_closing_the_session() {
        let (input, mut receiver) = RdpInputSender::channel(1);
        send(&input, super::super::input::key(30, false, true)).unwrap();
        let controls = Arc::new(Mutex::new(Controls::default()));
        {
            let mut owner = controls.lock().unwrap();
            owner.owner = Some("page".into());
            owner.keys.insert((30, false));
            owner.buttons.insert(0x1000);
        }
        let state = connected_state();
        let retry = tokio::spawn(release_detached_inputs(controls.clone(), input.clone()));
        drop(DisplayLease {
            page: "page".into(),
            controls: controls.clone(),
            input: input.clone(),
            state: state.clone(),
        });
        assert_eq!(state.borrow().state, "connected");
        assert_eq!(state.borrow().owner, None);
        assert!(controls.lock().unwrap().keys.contains(&(30, false)));
        receiver.recv().await.unwrap();
        let RdpInputEvent::FastPath(events) = timeout(Duration::from_secs(1), receiver.recv())
            .await
            .unwrap()
            .unwrap()
        else {
            panic!("expected releases")
        };
        assert_eq!(
            &events[..],
            &[
                super::super::input::key(30, false, false),
                super::super::input::mouse(0, 0, 0x1000, 0),
            ]
        );
        assert!(controls.lock().unwrap().keys.is_empty());
        assert!(controls.lock().unwrap().buttons.is_empty());
        assert_eq!(state.borrow().state, "connected");
        send(&input, super::super::input::key(29, false, true)).unwrap();
        assert!(receiver.try_recv().is_ok());
        retry.abort();
    }

    #[tokio::test]
    async fn delayed_page_cleanup_does_not_release_later_tool_or_new_page_keys() {
        let (input, mut receiver) = RdpInputSender::channel(1);
        send(&input, super::super::input::key(29, false, true)).unwrap();
        let controls = Arc::new(Mutex::new(Controls::default()));
        {
            let mut owner = controls.lock().unwrap();
            owner.owner = Some("page".into());
            owner.keys.insert((29, false));
        }
        drop(DisplayLease {
            page: "page".into(),
            controls: controls.clone(),
            input: input.clone(),
            state: connected_state(),
        });
        receiver.recv().await.unwrap();
        // Tool dispatch flushes the old UI release before its own down, without
        // registering the tool's held key for future UI cleanup.
        controls.lock().unwrap().release_detached(&input).unwrap();
        let RdpInputEvent::FastPath(events) = receiver.recv().await.unwrap() else {
            panic!("expected release")
        };
        assert_eq!(&events[..], &[super::super::input::key(29, false, false)]);
        send(&input, super::super::input::key(29, false, true)).unwrap();
        receiver.recv().await.unwrap();
        let retry = tokio::spawn(release_detached_inputs(controls.clone(), input.clone()));
        assert!(
            timeout(Duration::from_millis(30), receiver.recv())
                .await
                .is_err()
        );
        {
            let mut owner = controls.lock().unwrap();
            owner.owner = Some("new-page".into());
            owner.keys.insert((30, false));
            owner.release_wakeup.notify_one();
        }
        assert!(
            timeout(Duration::from_millis(30), receiver.recv())
                .await
                .is_err()
        );
        assert!(controls.lock().unwrap().keys.contains(&(30, false)));
        retry.abort();
    }

    #[test]
    fn explicit_reset_releases_keyboard_and_all_mouse_buttons_together() {
        let (input, mut receiver) = RdpInputSender::channel(1);
        let mut controls = Controls {
            owner: Some("page".into()),
            epoch: 7,
            ui_locked: true,
            ui_revision: 9,
            ..Default::default()
        };
        controls.keys.extend([(30, false), (29, false), (56, true)]);
        controls.buttons.insert(0x1000);
        controls.position = (2, 3);
        controls.reset_input(&input, (73, 91)).unwrap();
        let RdpInputEvent::FastPath(events) = receiver.try_recv().unwrap() else {
            panic!("expected input");
        };
        assert_eq!(
            &events[..],
            &[
                FastPathInputEvent::SyncEvent(SynchronizeFlags::empty()),
                super::super::input::mouse(73, 91, 0x1000, 0),
                super::super::input::mouse(73, 91, 0x2000, 0),
                super::super::input::mouse(73, 91, 0x4000, 0),
            ]
        );
        assert!(controls.keys.is_empty());
        assert!(controls.buttons.is_empty());
        assert_eq!(controls.position, (73, 91));
        assert_eq!(controls.owner.as_deref(), Some("page"));
        assert_eq!(controls.epoch, 7);
        assert!(controls.ui_locked);
        assert_eq!(controls.ui_revision, 9);
        controls.release(&input).unwrap();
        assert!(receiver.try_recv().is_err());
    }

    #[test]
    fn rejected_reset_preserves_local_input_tracking_and_can_be_retried() {
        let (input, mut receiver) = RdpInputSender::channel(1);
        let mut controls = Controls::default();
        controls.keys.insert((30, false));
        controls.buttons.insert(0x2000);
        controls.position = (2, 3);
        send(&input, super::super::input::key(30, false, true)).unwrap();
        assert_eq!(
            controls
                .reset_input(&input, (73, 91))
                .unwrap_err()
                .to_string(),
            "RDP_INPUT_UNAVAILABLE"
        );
        assert!(controls.keys.contains(&(30, false)));
        assert!(controls.buttons.contains(&0x2000));
        assert_eq!(controls.position, (2, 3));
        receiver.try_recv().unwrap();
        assert!(receiver.try_recv().is_err());
        controls.reset_input(&input, (73, 91)).unwrap();
        assert!(controls.keys.is_empty());
        assert!(controls.buttons.is_empty());
        let RdpInputEvent::FastPath(events) = receiver.try_recv().unwrap() else {
            panic!("expected input");
        };
        assert_eq!(events.len(), 4);
    }

    #[test]
    fn explicit_reset_releases_untracked_tool_buttons_without_a_display() {
        let (input, mut receiver) = RdpInputSender::channel(1);
        let mut controls = Controls::default();
        // Tool input does not populate UI tracking, and may remain held after a page closes.
        controls.reset_input(&input, (41, 59)).unwrap();
        let RdpInputEvent::FastPath(events) = receiver.try_recv().unwrap() else {
            panic!("expected input");
        };
        let buttons: Vec<_> = events
            .iter()
            .filter_map(|event| match event {
                FastPathInputEvent::MouseEvent(mouse) => {
                    assert!(!mouse.flags.contains(PointerFlags::DOWN));
                    assert!(!mouse.flags.contains(PointerFlags::MOVE));
                    assert_eq!((mouse.x_position, mouse.y_position), (41, 59));
                    Some(mouse.flags.bits())
                }
                _ => None,
            })
            .collect();
        assert_eq!(buttons, [0x1000, 0x2000, 0x4000]);
        assert_eq!(controls.owner, None);
    }
    #[test]
    fn resize_requires_the_ready_display_lease_and_valid_dimensions() {
        let (input, mut receiver) = RdpInputSender::channel(4);
        let mut owner = Controls {
            owner: Some("page".into()),
            epoch: 3,
            ..Controls::default()
        };
        assert!(resize_display(&owner, &input, Some("page"), Some(3), 1024, 768).is_err());
        owner.ready.insert("page".into());
        assert!(resize_display(&owner, &input, Some("old"), Some(3), 1024, 768).is_err());
        assert!(resize_display(&owner, &input, Some("page"), Some(2), 1024, 768).is_err());
        assert!(resize_display(&owner, &input, Some("page"), Some(3), 401, 768).is_err());
        assert!(receiver.try_recv().is_err());
        owner.ui_locked = true;
        resize_display(&owner, &input, Some("page"), Some(3), 400, 700).unwrap();
        assert!(matches!(
            receiver.try_recv().unwrap(),
            RdpInputEvent::Resize {
                width: 400,
                height: 700,
                scale_factor: 100,
                ..
            }
        ));
    }
}
