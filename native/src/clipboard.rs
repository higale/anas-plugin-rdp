//! CLIPRDR bridge. Clipboard sharing belongs to a connection, never to a page or tool call.
use ironrdp_client::rdp::RdpInputSender;
use ironrdp_cliprdr::{
    backend::{ClipboardMessage, CliprdrBackend, CliprdrBackendFactory},
    pdu::*,
};
use ironrdp_core::IntoOwned;
use std::{
    collections::{HashMap, HashSet, VecDeque},
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc,
    },
    time::Duration,
};

#[cfg(windows)]
mod windows;
#[cfg(windows)]
use std::sync::atomic::AtomicU32;
const MAX_TEXT: usize = 16 * 1024 * 1024;
const CHUNK: u32 = 1024 * 1024;

type Reply = mpsc::Sender<Result<Vec<u8>, ()>>;
#[derive(Debug)]
pub struct Shared {
    input: RdpInputSender,
    enabled: AtomicBool,
    ready: AtomicBool,
    sync_active: AtomicBool,
    can_publish: AtomicBool,
    publication: AtomicU64,
    sync_gate: Mutex<()>,
    remote: Mutex<Option<RemoteCopy>>,
    status: tokio::sync::watch::Sender<&'static str>,
    closed: AtomicBool,
    #[cfg(windows)]
    streams: AtomicU32,
    pending: Mutex<HashMap<u32, Reply>>,
    local: Mutex<Local>,
    activity: Mutex<Activity>,
    generation: AtomicU64,
    formats: Mutex<VecDeque<(u64, u64, ClipboardFormatId)>>,
}
#[derive(Debug)]
struct RemoteCopy {
    formats: Vec<ClipboardFormat>,
    pending: bool,
    awaiting: bool,
}
#[derive(Debug, Default)]
struct Activity {
    readers: usize,
    uploads: HashMap<Option<u32>, HashSet<i32>>,
}
struct Reading(Arc<Shared>);
impl Drop for Reading {
    fn drop(&mut self) {
        self.0.activity.lock().unwrap().readers -= 1;
    }
}
#[derive(Debug, Default)]
struct Local {
    text: Option<String>,
    files: Arc<Vec<PathBuf>>,
    locked: HashMap<u32, Arc<Vec<PathBuf>>>,
}
impl Shared {
    fn update_status(&self) {
        let activity = self.activity.lock().unwrap();
        let value = if !self.enabled.load(Ordering::SeqCst) {
            "disabled"
        } else if self.sync_active.load(Ordering::SeqCst) {
            "syncing"
        } else if activity.readers > 0 || !activity.uploads.is_empty() {
            "draining"
        } else {
            "paused"
        };
        self.status.send_if_modified(|previous| {
            let changed = *previous != value;
            *previous = value;
            changed
        });
    }
    fn send(&self, message: ClipboardMessage) {
        if self.input.send_clipboard(message).is_err() {
            self.cancel();
        }
    }
    fn request(&self, format: ClipboardFormatId) {
        self.formats.lock().unwrap().push_back((
            self.generation.load(Ordering::SeqCst),
            self.publication.load(Ordering::SeqCst),
            format,
        ));
        self.send(ClipboardMessage::SendInitiatePaste(format));
    }
    fn reading(self: &Arc<Self>) -> Result<Reading, ()> {
        let mut activity = self.activity.lock().unwrap();
        if !self.enabled.load(Ordering::SeqCst) || self.closed.load(Ordering::SeqCst) {
            return Err(());
        }
        activity.readers += 1;
        Ok(Reading(self.clone()))
    }
    fn cancel(&self) {
        self.pending.lock().unwrap().clear();
    }
    #[cfg(windows)]
    fn read(
        &self,
        index: usize,
        offset: u64,
        size: u32,
        data_id: Option<u32>,
    ) -> Result<Vec<u8>, ()> {
        if !self.enabled.load(Ordering::SeqCst) || self.closed.load(Ordering::SeqCst) {
            return Err(());
        }
        let id = self.streams.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = mpsc::channel();
        self.pending.lock().unwrap().insert(id, tx);
        if self
            .input
            .send_clipboard(ClipboardMessage::SendFileContentsRequest(
                FileContentsRequest {
                    stream_id: id,
                    index: index as i32,
                    flags: if size == 0 {
                        FileContentsFlags::SIZE
                    } else {
                        FileContentsFlags::RANGE
                    },
                    position: offset,
                    requested_size: if size == 0 { 8 } else { size.min(CHUNK) },
                    data_id,
                },
            ))
            .is_err()
        {
            self.pending.lock().unwrap().remove(&id);
            return Err(());
        }
        // A stalled individual read fails the paste, never the RDP connection or plugin.
        let result = rx
            .recv_timeout(Duration::from_secs(120))
            .map_err(|_| ())
            .and_then(|x| x);
        self.pending.lock().unwrap().remove(&id);
        result
    }
}
#[derive(Debug)]
enum Event {
    Poll,
    Text(String, u64, u64),
    Files(Vec<FileDescriptor>, Option<u32>, u64, u64),
    Stop,
}
#[derive(Debug, Clone)]
pub struct Clipboard {
    shared: Arc<Shared>,
    tx: mpsc::Sender<Event>,
    temporary_directory: String,
}
impl Clipboard {
    pub fn new(input: RdpInputSender) -> anyhow::Result<Self> {
        let shared = Arc::new(Shared {
            input,
            enabled: AtomicBool::new(false),
            ready: AtomicBool::new(false),
            sync_active: AtomicBool::new(false),
            can_publish: AtomicBool::new(false),
            publication: AtomicU64::new(0),
            sync_gate: Mutex::new(()),
            remote: Mutex::new(None),
            status: tokio::sync::watch::channel("disabled").0,
            closed: AtomicBool::new(false),
            #[cfg(windows)]
            streams: AtomicU32::new(1),
            pending: Mutex::new(HashMap::new()),
            local: Mutex::new(Local::default()),
            activity: Mutex::new(Activity::default()),
            generation: AtomicU64::new(0),
            formats: Mutex::new(VecDeque::new()),
        });
        let (tx, rx) = mpsc::channel();
        let (ready_tx, ready_rx) = mpsc::channel();
        let worker = shared.clone();
        std::thread::Builder::new()
            .name("rdp-clipboard".into())
            .spawn(move || {
                #[cfg(windows)]
                let _ole = match windows::Apartment::new() {
                    Ok(value) => value,
                    Err(_) => {
                        let _ = ready_tx.send(false);
                        return;
                    }
                };
                let mut os = match arboard::Clipboard::new() {
                    Ok(os) => os,
                    Err(_) => {
                        let _ = ready_tx.send(false);
                        return;
                    }
                };
                let _ = ready_tx.send(true);
                let mut sequence = None;
                let mut enabled = false;
                // Own the OLE offer; dropping it revokes our current virtual-file clipboard.
                #[cfg(windows)]
                let mut remote_files: Option<windows::Offer> = None;
                while !worker.closed.load(Ordering::SeqCst) {
                    #[cfg(windows)]
                    windows::pump();
                    let event = rx.recv_timeout(Duration::from_millis(60));
                    if matches!(event, Ok(Event::Stop)) {
                        break;
                    }
                    // Revoking publication waits for an OS write already in progress.
                    // A new connection cannot acquire publication until this gate is released.
                    let _gate = worker.sync_gate.lock().unwrap();
                    let sharing = worker.enabled.load(Ordering::SeqCst);
                    if sharing != enabled {
                        enabled = sharing;
                        sequence = None;
                        if !sharing {
                            worker.send(ClipboardMessage::SendInitiateCopy(vec![]));
                            #[cfg(windows)]
                            {
                                drop(remote_files.take());
                            }
                        }
                    }
                    worker.update_status();
                    if !sharing {
                        continue;
                    }
                    let current = os_sequence();
                    let unchanged = sequence == Some(current);
                    let valid = |generation, publication| {
                        worker.can_publish.load(Ordering::SeqCst)
                            && unchanged
                            && generation == worker.generation.load(Ordering::SeqCst)
                            && publication == worker.publication.load(Ordering::SeqCst)
                    };
                    match event {
                        Ok(Event::Text(text, generation, publication))
                            if valid(generation, publication) =>
                        {
                            if os.set_text(text).is_ok() {
                                sequence = Some(os_sequence());
                                if let Some(remote) = worker.remote.lock().unwrap().as_mut() {
                                    remote.awaiting = false;
                                }
                                #[cfg(windows)]
                                {
                                    drop(remote_files.take());
                                }
                            } else {
                                report_error();
                            }
                        }
                        Ok(Event::Files(files, data_id, generation, publication))
                            if valid(generation, publication) =>
                        {
                            #[cfg(windows)]
                            match windows::Offer::new(files, data_id, worker.clone(), generation) {
                                Ok(offer) => {
                                    drop(remote_files.replace(offer));
                                    sequence = Some(os_sequence());
                                    if let Some(remote) = worker.remote.lock().unwrap().as_mut() {
                                        remote.awaiting = false;
                                    }
                                }
                                Err(_) => report_error(),
                            }
                            #[cfg(not(windows))]
                            let _ = (files, data_id, generation);
                        }
                        _ => {}
                    }
                    // Suspension retains offers and requests already accepted, but does
                    // not poll clipboard contents, announce new copies or fetch remote data.
                    if !worker.sync_active.load(Ordering::SeqCst) {
                        continue;
                    }
                    {
                        let activity = worker.activity.lock().unwrap();
                        if activity.readers > 0 || !activity.uploads.is_empty() {
                            continue;
                        }
                    }
                    if sequence != Some(os_sequence()) {
                        // Local changes made while away win over stale remote notifications.
                        let before = os_sequence();
                        let Ok(content) = content(&mut os) else {
                            continue;
                        };
                        if before != os_sequence() {
                            continue;
                        }
                        sequence = Some(before);
                        worker.remote.lock().unwrap().take();
                        worker.publication.fetch_add(1, Ordering::SeqCst);
                        match content {
                            Some(Content::Text(text)) => {
                                let mut local = worker.local.lock().unwrap();
                                local.text = Some(text);
                                local.files = Arc::default();
                                worker.send(ClipboardMessage::SendInitiateCopy(vec![
                                    ClipboardFormat::new(ClipboardFormatId::CF_UNICODETEXT),
                                ]));
                            }
                            Some(Content::Files(paths)) => match local_files(&paths) {
                                Ok((descriptors, paths)) => {
                                    let mut local = worker.local.lock().unwrap();
                                    local.text = None;
                                    local.files = Arc::new(paths);
                                    worker
                                        .send(ClipboardMessage::SendInitiateFileCopy(descriptors));
                                }
                                Err(_) => {
                                    worker.send(ClipboardMessage::SendInitiateCopy(vec![]));
                                    report_error();
                                }
                            },
                            None => {
                                worker.send(ClipboardMessage::SendInitiateCopy(vec![]));
                                let mut local = worker.local.lock().unwrap();
                                local.text = None;
                                local.files = Arc::default();
                            }
                        }
                    } else {
                        let remote = {
                            let mut copy = worker.remote.lock().unwrap();
                            copy.as_mut().filter(|copy| copy.pending).map(|copy| {
                                copy.pending = false;
                                copy.awaiting = true;
                                copy.formats.clone()
                            })
                        };
                        if let Some(formats) = remote {
                            #[cfg(windows)]
                            if let Some(format) = formats
                                .iter()
                                .find(|f| f.name.as_ref() == Some(&ClipboardFormatName::FILE_LIST))
                            {
                                worker.request(format.id);
                                continue;
                            }
                            if formats
                                .iter()
                                .any(|f| f.id == ClipboardFormatId::CF_UNICODETEXT)
                            {
                                worker.request(ClipboardFormatId::CF_UNICODETEXT);
                            }
                        }
                    }
                }
            })?;
        if ready_rx.recv_timeout(Duration::from_secs(5)) != Ok(true) {
            shared.closed.store(true, Ordering::SeqCst);
            anyhow::bail!("RDP_CLIPBOARD_UNAVAILABLE");
        }
        Ok(Self {
            shared,
            tx,
            temporary_directory: std::env::temp_dir().to_string_lossy().into_owned(),
        })
    }
    pub fn set_enabled(&self, enabled: bool) -> anyhow::Result<()> {
        if enabled && !self.shared.ready.load(Ordering::SeqCst) {
            anyhow::bail!("RDP_CLIPBOARD_UNAVAILABLE");
        }
        let _gate = self.shared.sync_gate.lock().unwrap();
        let activity = self.shared.activity.lock().unwrap();
        if self.shared.closed.load(Ordering::SeqCst) {
            anyhow::bail!("RDP_CLIPBOARD_UNAVAILABLE");
        }
        if enabled == self.shared.enabled.load(Ordering::SeqCst) {
            return Ok(());
        }
        if !enabled && (activity.readers > 0 || !activity.uploads.is_empty()) {
            anyhow::bail!("RDP_CLIPBOARD_BUSY");
        }
        self.shared.generation.fetch_add(1, Ordering::SeqCst);
        self.shared.enabled.store(enabled, Ordering::SeqCst);
        if !enabled {
            self.shared.cancel();
            self.shared.remote.lock().unwrap().take();
        }
        drop(activity);
        self.shared.update_status();
        self.tx
            .send(Event::Poll)
            .map_err(|_| anyhow::anyhow!("RDP_CLIPBOARD_UNAVAILABLE"))
    }
    pub fn set_activity(&self, active: bool, publish: bool) -> anyhow::Result<()> {
        anyhow::ensure!(!active || publish, "RDP_CLIPBOARD_UNAVAILABLE");
        let _gate = self.shared.sync_gate.lock().unwrap();
        anyhow::ensure!(
            !self.shared.closed.load(Ordering::SeqCst),
            "RDP_CLIPBOARD_UNAVAILABLE"
        );
        if self.shared.can_publish.swap(publish, Ordering::SeqCst) && !publish {
            self.shared.publication.fetch_add(1, Ordering::SeqCst);
            // Keep the newest interrupted copy available when this page is activated again.
            if let Some(remote) = self.shared.remote.lock().unwrap().as_mut()
                && remote.awaiting
            {
                remote.pending = true;
                remote.awaiting = false;
            }
        }
        self.shared.sync_active.store(active, Ordering::SeqCst);
        self.shared.update_status();
        let _ = self.tx.send(Event::Poll);
        Ok(())
    }
    pub fn subscribe(&self) -> tokio::sync::watch::Receiver<&'static str> {
        self.shared.status.subscribe()
    }
    pub fn close(&self) {
        self.shared.closed.store(true, Ordering::SeqCst);
        self.shared.enabled.store(false, Ordering::SeqCst);
        self.shared.cancel();
        let _ = self.tx.send(Event::Stop);
    }
}
#[cfg(windows)]
fn os_sequence() -> u64 {
    windows::sequence() as u64
}
#[cfg(target_os = "macos")]
fn os_sequence() -> u64 {
    objc2_app_kit::NSPasteboard::generalPasteboard().changeCount() as u64
}

fn report_error() {
    println!("{{\"clipboardError\":true}}");
}
#[derive(Debug, PartialEq)]
enum Content {
    Text(String),
    Files(Vec<PathBuf>),
}
fn content(os: &mut arboard::Clipboard) -> Result<Option<Content>, arboard::Error> {
    match os.get().file_list() {
        Ok(files) if !files.is_empty() => return Ok(Some(Content::Files(files))),
        Err(arboard::Error::ContentNotAvailable) | Ok(_) => {}
        Err(error) => return Err(error),
    }
    match os.get_text() {
        Ok(text) if text.len() <= MAX_TEXT => Ok(Some(Content::Text(text))),
        Ok(_) | Err(arboard::Error::ContentNotAvailable) => Ok(None),
        Err(error) => Err(error),
    }
}
fn local_files(roots: &[PathBuf]) -> anyhow::Result<(Vec<FileDescriptor>, Vec<PathBuf>)> {
    fn add(
        path: &std::path::Path,
        name: String,
        list: &mut Vec<FileDescriptor>,
        paths: &mut Vec<PathBuf>,
    ) -> anyhow::Result<()> {
        anyhow::ensure!(
            list.len() < 10000 && name.encode_utf16().count() < 260,
            "clipboard file list too large"
        );
        let metadata = path.symlink_metadata()?;
        anyhow::ensure!(
            !metadata.file_type().is_symlink() && (metadata.is_file() || metadata.is_dir()),
            "unsupported file type"
        );
        list.push(
            FileDescriptor::new(&name)
                .with_attributes(if metadata.is_dir() {
                    ClipboardFileAttributes::DIRECTORY
                } else {
                    ClipboardFileAttributes::NORMAL
                })
                .with_file_size(if metadata.is_dir() { 0 } else { metadata.len() }),
        );
        paths.push(path.to_owned());
        if metadata.is_dir() {
            for entry in std::fs::read_dir(path)? {
                let entry = entry?;
                add(
                    &entry.path(),
                    format!(
                        "{}\\{}",
                        name,
                        entry
                            .file_name()
                            .to_str()
                            .ok_or_else(|| anyhow::anyhow!("invalid file name"))?
                    ),
                    list,
                    paths,
                )?;
            }
        }
        Ok(())
    }
    let mut list = vec![];
    let mut paths = vec![];
    for path in roots {
        add(
            path,
            path.file_name()
                .and_then(|s| s.to_str())
                .ok_or_else(|| anyhow::anyhow!("invalid file name"))?
                .into(),
            &mut list,
            &mut paths,
        )?;
    }
    Ok((list, paths))
}
ironrdp_core::impl_as_any!(Clipboard);
impl CliprdrBackendFactory for Clipboard {
    fn build_cliprdr_backend(&self) -> Box<dyn CliprdrBackend> {
        Box::new(self.clone())
    }
}
impl CliprdrBackend for Clipboard {
    fn temporary_directory(&self) -> &str {
        &self.temporary_directory
    }
    fn client_capabilities(&self) -> ClipboardGeneralCapabilityFlags {
        ClipboardGeneralCapabilityFlags::USE_LONG_FORMAT_NAMES
            | ClipboardGeneralCapabilityFlags::STREAM_FILECLIP_ENABLED
            | ClipboardGeneralCapabilityFlags::FILECLIP_NO_FILE_PATHS
            | ClipboardGeneralCapabilityFlags::CAN_LOCK_CLIPDATA
    }
    fn on_ready(&mut self) {
        self.shared.ready.store(true, Ordering::SeqCst);
    }
    fn on_request_format_list(&mut self) {
        self.shared.send(ClipboardMessage::SendInitiateCopy(vec![]));
    }
    fn on_process_negotiated_capabilities(&mut self, _: ClipboardGeneralCapabilityFlags) {}
    fn on_remote_copy(&mut self, formats: &[ClipboardFormat]) {
        let _gate = self.shared.sync_gate.lock().unwrap();
        // Without protocol locking a clipboard replacement also ends the old upload.
        self.shared.activity.lock().unwrap().uploads.remove(&None);
        if self.shared.enabled.load(Ordering::SeqCst) {
            self.shared.publication.fetch_add(1, Ordering::SeqCst);
            *self.shared.remote.lock().unwrap() = Some(RemoteCopy {
                formats: formats.to_vec(),
                pending: true,
                awaiting: false,
            });
            let _ = self.tx.send(Event::Poll);
        }
    }
    fn on_format_data_request(&mut self, request: FormatDataRequest) {
        let local = self.shared.local.lock().unwrap();
        let response = if self.shared.enabled.load(Ordering::SeqCst)
            && request.format == ClipboardFormatId::CF_UNICODETEXT
        {
            local
                .text
                .as_ref()
                .map(|s| FormatDataResponse::new_unicode_string(s))
                .unwrap_or_else(FormatDataResponse::new_error)
        } else {
            FormatDataResponse::new_error()
        };
        self.shared
            .send(ClipboardMessage::SendFormatData(response.into_owned()));
    }
    fn on_format_data_response(&mut self, response: FormatDataResponse<'_>) {
        let Some((generation, publication, format)) =
            self.shared.formats.lock().unwrap().pop_front()
        else {
            return;
        };
        if format == ClipboardFormatId::CF_UNICODETEXT
            && self.shared.enabled.load(Ordering::SeqCst)
            && generation == self.shared.generation.load(Ordering::SeqCst)
            && publication == self.shared.publication.load(Ordering::SeqCst)
            && self.shared.can_publish.load(Ordering::SeqCst)
            && !response.is_error()
            && response.data().len() <= MAX_TEXT
            && let Ok(text) = response.to_unicode_string()
        {
            let _ = self.tx.send(Event::Text(text, generation, publication));
        }
    }
    fn on_remote_file_list(&mut self, files: &[FileDescriptor], id: Option<u32>) {
        let Some((generation, publication, _)) = self.shared.formats.lock().unwrap().pop_front()
        else {
            return;
        };
        if self.shared.enabled.load(Ordering::SeqCst)
            && generation == self.shared.generation.load(Ordering::SeqCst)
            && publication == self.shared.publication.load(Ordering::SeqCst)
            && self.shared.can_publish.load(Ordering::SeqCst)
        {
            let _ = self
                .tx
                .send(Event::Files(files.to_vec(), id, generation, publication));
        }
    }
    fn on_file_contents_response(&mut self, response: FileContentsResponse<'_>) {
        if let Some(reply) = self
            .shared
            .pending
            .lock()
            .unwrap()
            .remove(&response.stream_id())
        {
            let _ = reply.send(
                if response.is_error() || response.data().len() > CHUNK as usize {
                    Err(())
                } else {
                    Ok(response.data().to_vec())
                },
            );
        }
    }
    fn on_file_contents_request(&mut self, request: FileContentsRequest) {
        let shared = self.shared.clone();
        if !shared.enabled.load(Ordering::SeqCst) {
            shared.send(ClipboardMessage::SendFileContentsResponse(
                FileContentsResponse::new_error(request.stream_id),
            ));
            return;
        }
        let Ok(reading) = shared.reading() else {
            shared.send(ClipboardMessage::SendFileContentsResponse(
                FileContentsResponse::new_error(request.stream_id),
            ));
            return;
        };
        if shared.activity.lock().unwrap().readers > 8 {
            shared.send(ClipboardMessage::SendFileContentsResponse(
                FileContentsResponse::new_error(request.stream_id),
            ));
            return;
        }
        let files = {
            let local = shared.local.lock().unwrap();
            match request.data_id {
                Some(id) => local.locked.get(&id).cloned(),
                None => Some(local.files.clone()),
            }
        };
        // Disk access cannot block the protocol loop (including simultaneous incoming transfers).
        std::thread::spawn(move || {
            let _reading = reading;
            use std::io::{Read, Seek};
            let result = (|| -> anyhow::Result<FileContentsResponse<'static>> {
                let files = files.ok_or_else(|| anyhow::anyhow!("unknown file list"))?;
                let index = usize::try_from(request.index)?;
                let mut file = std::fs::File::open(
                    files
                        .get(index)
                        .ok_or_else(|| anyhow::anyhow!("unknown file"))?,
                )?;
                if request.flags == FileContentsFlags::SIZE {
                    return Ok(FileContentsResponse::new_size_response(
                        request.stream_id,
                        file.metadata()?.len(),
                    ));
                }
                anyhow::ensure!(
                    request.flags == FileContentsFlags::RANGE
                        && request.requested_size <= 16 * CHUNK,
                    "invalid range"
                );
                let size = file.metadata()?.len();
                if request.position < size && request.requested_size > 0 {
                    // A lock retains metadata even after a paste has completed. Track the
                    // advertised batch separately so that its final byte releases switching.
                    shared
                        .activity
                        .lock()
                        .unwrap()
                        .uploads
                        .entry(request.data_id)
                        .or_insert_with(|| {
                            files
                                .iter()
                                .enumerate()
                                .filter_map(|(index, path)| {
                                    path.metadata()
                                        .ok()
                                        .filter(|m| m.is_file() && m.len() > 0)
                                        .map(|_| index as i32)
                                })
                                .collect()
                        });
                }
                file.seek(std::io::SeekFrom::Start(request.position))?;
                let mut data = vec![0; request.requested_size as usize];
                let count = file.read(&mut data)?;
                data.truncate(count);
                if request.position.saturating_add(count as u64) >= size {
                    let mut activity = shared.activity.lock().unwrap();
                    if let Some(remaining) = activity.uploads.get_mut(&request.data_id) {
                        remaining.remove(&request.index);
                        if remaining.is_empty() {
                            activity.uploads.remove(&request.data_id);
                        }
                    }
                }
                Ok(FileContentsResponse::new_data_response(
                    request.stream_id,
                    data,
                ))
            })();
            if result.is_err() {
                shared
                    .activity
                    .lock()
                    .unwrap()
                    .uploads
                    .remove(&request.data_id);
            }
            shared.send(ClipboardMessage::SendFileContentsResponse(
                result.unwrap_or_else(|_| FileContentsResponse::new_error(request.stream_id)),
            ));
        });
    }
    fn on_lock(&mut self, id: LockDataId) {
        let mut local = self.shared.local.lock().unwrap();
        let files = local.files.clone();
        local.locked.insert(id.0, files);
    }
    fn on_unlock(&mut self, id: LockDataId) {
        self.shared.local.lock().unwrap().locked.remove(&id.0);
        self.shared
            .activity
            .lock()
            .unwrap()
            .uploads
            .remove(&Some(id.0));
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    pub(super) fn bridge() -> (
        Clipboard,
        mpsc::Receiver<Event>,
        tokio::sync::mpsc::Receiver<ironrdp_client::rdp::RdpInputEvent>,
    ) {
        let (input, receiver) = RdpInputSender::channel(16);
        let shared = Arc::new(Shared {
            input,
            enabled: AtomicBool::new(true),
            ready: AtomicBool::new(true),
            sync_active: AtomicBool::new(true),
            can_publish: AtomicBool::new(true),
            publication: AtomicU64::new(0),
            sync_gate: Mutex::new(()),
            remote: Mutex::new(None),
            status: tokio::sync::watch::channel("syncing").0,
            closed: AtomicBool::new(false),
            #[cfg(windows)]
            streams: AtomicU32::new(1),
            pending: Mutex::default(),
            local: Mutex::default(),
            activity: Mutex::default(),
            generation: AtomicU64::new(0),
            formats: Mutex::default(),
        });
        let (tx, rx) = mpsc::channel();
        (
            Clipboard {
                shared,
                tx,
                temporary_directory: ".".into(),
            },
            rx,
            receiver,
        )
    }
    #[test]
    fn active_paste_prevents_switching_but_metadata_does_not() {
        let (clipboard, _events, _network) = bridge();
        let reading = clipboard.shared.reading().unwrap();
        assert_eq!(
            clipboard.set_enabled(false).unwrap_err().to_string(),
            "RDP_CLIPBOARD_BUSY"
        );
        assert!(clipboard.shared.enabled.load(Ordering::SeqCst));
        drop(reading);
        clipboard.set_enabled(false).unwrap();
        assert!(clipboard.shared.reading().is_err());
    }
    #[test]
    fn delayed_text_response_cannot_cross_a_disable_enable_boundary() {
        let (mut clipboard, events, _network) = bridge();
        clipboard.shared.request(ClipboardFormatId::CF_UNICODETEXT);
        clipboard.set_enabled(false).unwrap();
        clipboard.set_enabled(true).unwrap();
        clipboard.on_format_data_response(FormatDataResponse::new_unicode_string("old"));
        assert!(events.try_iter().all(|event| matches!(event, Event::Poll)));
        clipboard.shared.request(ClipboardFormatId::CF_UNICODETEXT);
        clipboard.on_format_data_response(FormatDataResponse::new_unicode_string("你好 🐟"));
        assert!(matches!(events.try_recv(), Ok(Event::Text(text, _, _)) if text == "你好 🐟"));
    }
    #[test]
    fn suspension_preserves_an_accepted_copy_but_new_publisher_rejects_its_late_response() {
        let (mut clipboard, events, _network) = bridge();
        clipboard.shared.request(ClipboardFormatId::CF_UNICODETEXT);
        clipboard.set_activity(false, true).unwrap();
        clipboard
            .on_format_data_response(FormatDataResponse::new_unicode_string("copied before blur"));
        assert!(
            events.try_iter().any(
                |event| matches!(event, Event::Text(text, _, _) if text == "copied before blur")
            )
        );
        clipboard.shared.request(ClipboardFormatId::CF_UNICODETEXT);
        clipboard.set_activity(false, false).unwrap();
        clipboard.on_format_data_response(FormatDataResponse::new_unicode_string(
            "late previous window",
        ));
        assert!(events.try_iter().all(|event| matches!(event, Event::Poll)));
        assert!(clipboard.shared.enabled.load(Ordering::SeqCst));
    }
    #[test]
    fn inactive_paste_retains_its_snapshot_and_drains_without_disabling_sharing() {
        let (clipboard, _events, _network) = bridge();
        let generation = clipboard.shared.generation.load(Ordering::SeqCst);
        let reading = clipboard.shared.reading().unwrap();
        clipboard.set_activity(false, false).unwrap();
        assert_eq!(*clipboard.subscribe().borrow(), "draining");
        assert_eq!(
            clipboard.shared.generation.load(Ordering::SeqCst),
            generation
        );
        drop(reading);
        clipboard.shared.update_status();
        assert_eq!(*clipboard.subscribe().borrow(), "paused");
        // A published file offer can still be pasted after switching to Explorer.
        assert!(clipboard.shared.reading().is_ok());
    }
    #[test]
    fn connection_close_cancels_waiters_without_waiting_for_timeout() {
        let (clipboard, _events, _network) = bridge();
        let (tx, rx) = mpsc::channel();
        clipboard.shared.pending.lock().unwrap().insert(3, tx);
        clipboard.close();
        assert!(rx.recv_timeout(Duration::from_millis(20)).is_err());
        assert!(clipboard.shared.closed.load(Ordering::SeqCst));
    }
    #[tokio::test]
    async fn local_files_are_announced_by_metadata_then_read_in_ranges_and_unlocked() {
        let (mut clipboard, _events, _network) = bridge();
        let path = std::env::temp_dir().join(format!(
            "anas-clipboard-unit-{}-{}.bin",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::write(&path, b"abcdef").unwrap();
        let (files, paths) = local_files(std::slice::from_ref(&path)).unwrap();
        assert_eq!(files[0].file_size, Some(6));
        clipboard.shared.local.lock().unwrap().files = Arc::new(paths);
        clipboard.on_lock(LockDataId(12));
        clipboard.on_file_contents_request(FileContentsRequest {
            stream_id: 8,
            index: 0,
            flags: FileContentsFlags::RANGE,
            position: 2,
            requested_size: 3,
            data_id: Some(12),
        });
        for _ in 0..100 {
            if clipboard.shared.activity.lock().unwrap().readers == 0 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
        assert!(clipboard.set_enabled(false).is_err());
        clipboard.on_unlock(LockDataId(12));
        // Let the completed file read release its guard.
        for _ in 0..100 {
            if clipboard.set_enabled(false).is_ok() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
        assert!(!clipboard.shared.enabled.load(Ordering::SeqCst));
        std::fs::remove_file(path).unwrap();
    }
    #[tokio::test]
    async fn upload_batch_finishes_without_waiting_for_metadata_unlock() {
        let (mut clipboard, _events, _network) = bridge();
        let root = std::env::temp_dir().join(format!(
            "anas-clipboard-batch-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&root).unwrap();
        for name in ["a", "b"] {
            std::fs::write(root.join(name), b"abcdef").unwrap();
        }
        clipboard.shared.local.lock().unwrap().files =
            Arc::new(vec![root.join("a"), root.join("b")]);
        clipboard.on_lock(LockDataId(8));
        for index in 0..2 {
            clipboard.on_file_contents_request(FileContentsRequest {
                stream_id: index as u32,
                index,
                flags: FileContentsFlags::RANGE,
                position: 0,
                requested_size: 6,
                data_id: Some(8),
            });
            for _ in 0..100 {
                if clipboard.shared.activity.lock().unwrap().readers == 0 {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
            if index == 0 {
                assert!(
                    clipboard.set_enabled(false).is_err(),
                    "second file is still pending"
                );
            }
        }
        clipboard.set_enabled(false).unwrap();
        // Merely retaining the server's clipboard snapshot does not keep a completed paste busy.
        assert!(
            clipboard
                .shared
                .local
                .lock()
                .unwrap()
                .locked
                .contains_key(&8)
        );
        for name in ["a", "b"] {
            std::fs::remove_file(root.join(name)).unwrap();
        }
        std::fs::remove_dir(root).unwrap();
    }
}
