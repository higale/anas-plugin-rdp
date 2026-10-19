//! Explicit macOS downloads. Metadata is offered first; disk/content access starts only on request.
use super::{CHUNK, Shared};
use anyhow::{Context, Result, ensure};
use ironrdp_cliprdr::pdu::{ClipboardFileAttributes, FileDescriptor, LockDataId};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    fs::{self, OpenOptions},
    io::Write,
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    thread::JoinHandle,
};

static NEXT_ID: AtomicU64 = AtomicU64::new(1);
fn next_id() -> String {
    format!(
        "{}-{}-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis(),
        std::process::id(),
        NEXT_ID.fetch_add(1, Ordering::Relaxed)
    )
}

#[derive(Debug, Clone)]
struct Offer {
    files: Vec<FileDescriptor>,
    data_id: Option<u32>,
    revision: u64,
}
#[derive(Debug, Default)]
struct State {
    offer: Option<Offer>,
    transfer: Option<Value>,
    data_id: Option<u32>,
    worker: Option<JoinHandle<()>>,
}
#[derive(Debug, Default)]
pub(super) struct Downloads {
    state: Mutex<State>,
    cancel: AtomicBool,
}
impl Downloads {
    pub fn offer(&self, files: Vec<FileDescriptor>, data_id: Option<u32>, revision: u64) {
        if paths(&files).is_err() {
            super::report_error();
            return;
        }
        self.state.lock().unwrap().offer = Some(Offer {
            files,
            data_id,
            revision,
        });
    }
    pub fn clear_offer(&self) {
        let mut state = self.state.lock().unwrap();
        state.offer = None;
        // Without a protocol lock, continuing would read bytes from a different copy.
        if running(&state) && state.data_id.is_none() {
            self.cancel.store(true, Ordering::SeqCst);
        }
    }
    pub fn expire(&self, ids: &[LockDataId]) {
        let mut state = self.state.lock().unwrap();
        if state.offer.as_ref().is_some_and(|offer| {
            offer
                .data_id
                .is_some_and(|id| ids.contains(&LockDataId(id)))
        }) {
            state.offer = None;
        }
        if running(&state)
            && state
                .data_id
                .is_some_and(|id| ids.contains(&LockDataId(id)))
        {
            self.cancel.store(true, Ordering::SeqCst);
        }
    }
    pub fn cancelled(&self) -> bool {
        self.cancel.load(Ordering::SeqCst)
    }
    pub fn snapshot(&self) -> Value {
        let state = self.state.lock().unwrap();
        json!({"offer":state.offer.as_ref().map(|offer| json!({"revision":offer.revision,"count":offer.files.len()})), "transfer":state.transfer})
    }
    pub fn start(&self, shared: Arc<Shared>, command: &Value) -> Result<()> {
        let directory = PathBuf::from(
            command["directory"]
                .as_str()
                .context("RDP_DOWNLOAD_DIRECTORY")?,
        );
        ensure!(directory.is_absolute(), "RDP_DOWNLOAD_DIRECTORY");
        let _gate = shared.sync_gate.lock().unwrap();
        let reading = shared
            .reading()
            .map_err(|_| anyhow::anyhow!("RDP_CLIPBOARD_UNAVAILABLE"))?;
        let mut state = self.state.lock().unwrap();
        ensure!(!running(&state), "RDP_DOWNLOAD_BUSY");
        let offer = state.offer.clone().context("RDP_DOWNLOAD_CHANGED")?;
        ensure!(
            command["revision"].as_u64() == Some(offer.revision),
            "RDP_DOWNLOAD_CHANGED"
        );
        paths(&offer.files)?;
        self.cancel.store(false, Ordering::SeqCst);
        let id = next_id();
        state.data_id = offer.data_id;
        state.transfer = Some(
            json!({"id":id,"state":"running","bytes":0,"total":null,"completed":0,"count":offer.files.len()}),
        );
        let task_shared = shared.clone();
        match std::thread::Builder::new()
            .name("rdp-download".into())
            .spawn(move || {
                let _reading = reading;
                let mut created = Created::default();
                let result = transfer(
                    &task_shared,
                    &offer,
                    &directory,
                    &mut created,
                    |index, offset, size, id| task_shared.read(index, offset, size, id),
                );
                let cancelled =
                    task_shared.downloads.cancelled() || task_shared.closed.load(Ordering::SeqCst);
                let cleanup_failed = result.is_err() && !created.cleanup();
                let mut state = task_shared.downloads.state.lock().unwrap();
                let value = state.transfer.as_mut().unwrap();
                value["state"] = json!(if result.is_ok() {
                    "completed"
                } else if cancelled {
                    "cancelled"
                } else {
                    "failed"
                });
                if result.is_ok() || cleanup_failed {
                    value["path"] = json!(directory);
                }
                if let Err(error) = result {
                    value["error"] = json!(if cleanup_failed {
                        "RDP_DOWNLOAD_CLEANUP".into()
                    } else {
                        error.to_string()
                    });
                }
            }) {
            Ok(worker) => state.worker = Some(worker),
            Err(_) => {
                state.transfer = None;
                anyhow::bail!("RDP_DOWNLOAD_FAILED");
            }
        }
        Ok(())
    }
    pub fn cancel(&self, command: &Value) -> Result<()> {
        let state = self.state.lock().unwrap();
        ensure!(
            state
                .transfer
                .as_ref()
                .is_some_and(|task| task["id"] == command["id"]),
            "RDP_DOWNLOAD_CHANGED"
        );
        if running(&state) {
            self.cancel.store(true, Ordering::SeqCst);
        }
        Ok(())
    }
    pub fn close(&self) {
        self.cancel.store(true, Ordering::SeqCst);
        let worker = self.state.lock().unwrap().worker.take();
        if let Some(worker) = worker {
            let _ = worker.join();
        }
        self.state.lock().unwrap().offer = None;
    }
}
fn running(state: &State) -> bool {
    state
        .transfer
        .as_ref()
        .is_some_and(|task| task["state"] == "running")
}
fn is_directory(file: &FileDescriptor) -> bool {
    file.attributes
        .is_some_and(|attributes| attributes.contains(ClipboardFileAttributes::DIRECTORY))
}
fn paths(files: &[FileDescriptor]) -> Result<Vec<PathBuf>> {
    ensure!(
        !files.is_empty() && files.len() <= 10000,
        "RDP_DOWNLOAD_FILES"
    );
    let mut seen = HashSet::new();
    files
        .iter()
        .map(|file| {
            let name = match &file.relative_path {
                Some(parent) if !parent.is_empty() => format!("{}\\{}", parent, file.name),
                _ => file.name.clone(),
            };
            ensure!(name.encode_utf16().count() < 260, "RDP_DOWNLOAD_FILES");
            let parts: Vec<_> = name.split(['\\', '/']).collect();
            ensure!(
                parts.iter().all(|part| !part.is_empty()
                    && !matches!(*part, "." | "..")
                    && !part.contains([':', '\0'])),
                "RDP_DOWNLOAD_FILES"
            );
            let path = parts.iter().collect::<PathBuf>();
            ensure!(
                seen.insert(path.to_string_lossy().to_lowercase()),
                "RDP_DOWNLOAD_FILES"
            );
            Ok(path)
        })
        .collect()
}
fn check(shared: &Shared) -> Result<()> {
    ensure!(
        !shared.closed.load(Ordering::SeqCst) && !shared.downloads.cancelled(),
        "RDP_DOWNLOAD_CANCELLED"
    );
    Ok(())
}
// Journal only entries created by this transfer. Never recursively remove a destination:
// even a newly created directory may acquire unrelated files while downloading.
#[derive(Default)]
struct Created {
    entries: Vec<(PathBuf, bool, (u64, u64))>,
    directories: HashMap<PathBuf, (u64, u64)>,
}
fn identity(metadata: &fs::Metadata) -> (u64, u64) {
    (metadata.dev(), metadata.ino())
}
fn unchanged(path: &Path, expected: (u64, u64), directory: bool) -> bool {
    fs::symlink_metadata(path).is_ok_and(|metadata| {
        identity(&metadata) == expected
            && if directory {
                metadata.is_dir()
            } else {
                metadata.is_file()
            }
    })
}
impl Created {
    fn directory(&mut self, root: &Path, relative: &Path) -> Result<()> {
        let mut path = root.to_path_buf();
        for part in relative.components() {
            path.push(part);
            if let Some(expected) = self.directories.get(&path) {
                ensure!(unchanged(&path, *expected, true), "RDP_DOWNLOAD_WRITE");
                continue;
            }
            fs::create_dir(&path).map_err(write_error)?;
            let metadata = fs::symlink_metadata(&path).context("RDP_DOWNLOAD_WRITE")?;
            ensure!(metadata.is_dir(), "RDP_DOWNLOAD_WRITE");
            let expected = identity(&metadata);
            self.entries.push((path.clone(), true, expected));
            self.directories.insert(path.clone(), expected);
        }
        Ok(())
    }
    fn cleanup(&self) -> bool {
        let mut clean = true;
        for (path, directory, expected) in self.entries.iter().rev() {
            if fs::symlink_metadata(path)
                .is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound)
            {
                continue;
            }
            // A user may rename or replace a partial file or its parent while downloading.
            // Never unlink the replacement, or traverse a replaced parent during cleanup.
            if !unchanged(path, *expected, *directory)
                || path.ancestors().skip(1).any(|parent| {
                    self.directories
                        .get(parent)
                        .is_some_and(|expected| !unchanged(parent, *expected, true))
                })
            {
                clean = false;
                continue;
            }
            let result = if *directory {
                fs::remove_dir(path)
            } else {
                fs::remove_file(path)
            };
            if result.is_err_and(|error| error.kind() != std::io::ErrorKind::NotFound) {
                clean = false;
            }
        }
        clean
    }
}
fn write_error(error: std::io::Error) -> anyhow::Error {
    let code = if error.kind() == std::io::ErrorKind::AlreadyExists {
        "RDP_DOWNLOAD_EXISTS"
    } else {
        "RDP_DOWNLOAD_WRITE"
    };
    anyhow::Error::new(error).context(code)
}
fn transfer(
    shared: &Shared,
    offer: &Offer,
    directory: &Path,
    created: &mut Created,
    mut read: impl FnMut(usize, u64, u32, Option<u32>) -> Result<Vec<u8>, ()>,
) -> Result<()> {
    ensure!(directory.is_dir(), "RDP_DOWNLOAD_DIRECTORY");
    let paths = paths(&offer.files)?;
    // Check all top-level names before requesting content or creating anything.
    // Existing directories are not merged; symlinks (including broken ones) also conflict.
    for path in &paths {
        let target = directory.join(path.components().next().unwrap());
        match fs::symlink_metadata(target) {
            Ok(_) => anyhow::bail!("RDP_DOWNLOAD_EXISTS"),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(write_error(error)),
        }
    }
    let mut sizes = Vec::new();
    let mut total = 0u64;
    for (index, file) in offer.files.iter().enumerate() {
        check(shared)?;
        let size = if is_directory(file) {
            0
        } else if let Some(size) = file.file_size {
            size
        } else {
            let bytes = read(index, 0, 0, offer.data_id)
                .map_err(|_| anyhow::anyhow!("RDP_DOWNLOAD_READ"))?;
            u64::from_le_bytes(
                bytes
                    .try_into()
                    .map_err(|_| anyhow::anyhow!("RDP_DOWNLOAD_READ"))?,
            )
        };
        total = total.checked_add(size).context("RDP_DOWNLOAD_FILES")?;
        sizes.push(size);
    }
    shared
        .downloads
        .state
        .lock()
        .unwrap()
        .transfer
        .as_mut()
        .unwrap()["total"] = json!(total);
    let mut downloaded = 0u64;
    for (index, ((file, path), size)) in offer.files.iter().zip(paths).zip(sizes).enumerate() {
        check(shared)?;
        let target = directory.join(&path);
        if is_directory(file) {
            created.directory(directory, &path)?;
        } else {
            created.directory(directory, path.parent().unwrap())?;
            let mut disk = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&target)
                .map_err(write_error)?;
            let expected = identity(&disk.metadata().context("RDP_DOWNLOAD_WRITE")?);
            created.entries.push((target, false, expected));
            let mut offset = 0;
            while offset < size {
                check(shared)?;
                let requested = (size - offset).min(CHUNK as u64) as u32;
                let bytes = read(index, offset, requested, offer.data_id)
                    .map_err(|_| anyhow::anyhow!("RDP_DOWNLOAD_READ"))?;
                check(shared)?;
                ensure!(
                    !bytes.is_empty() && bytes.len() <= requested as usize,
                    "RDP_DOWNLOAD_READ"
                );
                disk.write_all(&bytes).context("RDP_DOWNLOAD_WRITE")?;
                offset += bytes.len() as u64;
                downloaded += bytes.len() as u64;
                shared
                    .downloads
                    .state
                    .lock()
                    .unwrap()
                    .transfer
                    .as_mut()
                    .unwrap()["bytes"] = json!(downloaded);
            }
            disk.sync_all().context("RDP_DOWNLOAD_WRITE")?;
        }
        shared
            .downloads
            .state
            .lock()
            .unwrap()
            .transfer
            .as_mut()
            .unwrap()["completed"] = json!(index + 1);
    }
    check(shared)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_relative_names_and_duplicate_destinations() {
        assert_eq!(
            paths(&[FileDescriptor::new("你好🐟.txt").with_relative_path("folder\\子目录")])
                .unwrap(),
            vec![PathBuf::from("folder/子目录/你好🐟.txt")]
        );
        for name in ["../a", "a/../b", "/absolute", "C:\\a", "a\\\\b", "a\0b"] {
            assert!(paths(&[FileDescriptor::new(name)]).is_err());
        }
        assert!(paths(&[FileDescriptor::new("A"), FileDescriptor::new("a")]).is_err());
    }
    fn temp() -> PathBuf {
        let path = std::env::temp_dir().join(format!("rdp-download-test-{}", next_id()));
        fs::create_dir(&path).unwrap();
        path
    }
    #[test]
    fn writes_multiple_files_directories_unknown_sizes_and_short_chunks_exactly() {
        let (clipboard, _events, _network) = super::super::tests::bridge();
        let shared = &clipboard.shared;
        shared.downloads.state.lock().unwrap().transfer = Some(json!({}));
        let directory = temp();
        let bytes = vec![123; CHUNK as usize + 50];
        let files = vec![
            FileDescriptor::new("子目录").with_attributes(ClipboardFileAttributes::DIRECTORY),
            FileDescriptor::new("你好🐟.bin").with_relative_path("子目录"),
            FileDescriptor::new("empty").with_file_size(0),
            FileDescriptor::new("another.txt").with_file_size(2),
        ];
        let offer = Offer {
            files,
            data_id: Some(12),
            revision: 5,
        };
        let mut created = Created::default();
        transfer(
            shared,
            &offer,
            &directory,
            &mut created,
            |index, offset, size, id| {
                assert_eq!(id, Some(12));
                if size == 0 {
                    return Ok((bytes.len() as u64).to_le_bytes().to_vec());
                }
                let data = if index == 1 { bytes.as_slice() } else { b"ok" };
                let start = offset as usize;
                Ok(data[start..(start + size.min(512000) as usize).min(data.len())].to_vec())
            },
        )
        .unwrap();
        let root = &directory;
        assert_eq!(fs::read_dir(root).unwrap().count(), 3);
        assert_eq!(fs::read(root.join("子目录/你好🐟.bin")).unwrap(), bytes);
        assert_eq!(fs::metadata(root.join("empty")).unwrap().len(), 0);
        assert_eq!(fs::read(root.join("another.txt")).unwrap(), b"ok");
        assert_eq!(
            shared.downloads.snapshot()["transfer"]["bytes"],
            bytes.len() + 2
        );
        fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn existing_files_directories_and_symlinks_conflict_before_any_writes() {
        let (clipboard, _events, _network) = super::super::tests::bridge();
        let directory = temp();
        fs::write(directory.join("existing"), b"keep").unwrap();
        fs::create_dir(directory.join("folder")).unwrap();
        fs::write(directory.join("folder/user.txt"), b"keep too").unwrap();
        std::os::unix::fs::symlink("missing", directory.join("link")).unwrap();
        for name in ["existing", "folder/new.txt", "link/new.txt"] {
            let offer = Offer {
                files: vec![
                    FileDescriptor::new("fresh").with_file_size(0),
                    FileDescriptor::new(name),
                ],
                data_id: Some(1),
                revision: 1,
            };
            let mut created = Created::default();
            let error = transfer(
                &clipboard.shared,
                &offer,
                &directory,
                &mut created,
                |_, _, _, _| panic!("Must not request contents on collision"),
            )
            .unwrap_err();
            assert_eq!(error.to_string(), "RDP_DOWNLOAD_EXISTS");
            assert!(created.cleanup());
            assert!(!directory.join("fresh").exists());
        }
        assert_eq!(fs::read(directory.join("existing")).unwrap(), b"keep");
        assert_eq!(
            fs::read(directory.join("folder/user.txt")).unwrap(),
            b"keep too"
        );
        fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn cancellation_cleans_owned_entries_but_preserves_unrelated_new_files() {
        let (clipboard, _events, _network) = super::super::tests::bridge();
        let shared = &clipboard.shared;
        for add_unrelated in [false, true] {
            let directory = temp();
            fs::write(directory.join("existing"), b"keep").unwrap();
            shared.downloads.state.lock().unwrap().transfer = Some(json!({}));
            shared.downloads.cancel.store(false, Ordering::SeqCst);
            let offer = Offer {
                files: vec![
                    FileDescriptor::new("first").with_file_size(0),
                    FileDescriptor::new("nested/partial").with_file_size(1),
                ],
                data_id: Some(1),
                revision: 1,
            };
            let mut created = Created::default();
            let error = transfer(shared, &offer, &directory, &mut created, |_, _, _, _| {
                if add_unrelated {
                    fs::write(directory.join("nested/user.txt"), b"new user file").unwrap();
                }
                shared.downloads.cancel.store(true, Ordering::SeqCst);
                Ok(vec![1])
            })
            .unwrap_err();
            assert_eq!(error.to_string(), "RDP_DOWNLOAD_CANCELLED");
            assert_eq!(created.cleanup(), !add_unrelated);
            assert!(!directory.join("first").exists());
            assert!(!directory.join("nested/partial").exists());
            assert_eq!(fs::read(directory.join("existing")).unwrap(), b"keep");
            if add_unrelated {
                assert_eq!(
                    fs::read(directory.join("nested/user.txt")).unwrap(),
                    b"new user file"
                );
            } else {
                assert!(!directory.join("nested").exists());
            }
            fs::remove_dir_all(directory).unwrap();
        }
    }
    #[test]
    fn cleanup_preserves_replacements_at_recorded_paths() {
        let (clipboard, _events, _network) = super::super::tests::bridge();
        let shared = &clipboard.shared;
        for replace_parent in [false, true] {
            let directory = temp();
            shared.downloads.state.lock().unwrap().transfer = Some(json!({}));
            let offer = Offer {
                files: vec![FileDescriptor::new("folder/file").with_file_size(0)],
                data_id: Some(1),
                revision: 1,
            };
            let mut created = Created::default();
            transfer(
                shared,
                &offer,
                &directory,
                &mut created,
                |_, _, _, _| unreachable!(),
            )
            .unwrap();
            if replace_parent {
                fs::rename(directory.join("folder"), directory.join("moved")).unwrap();
                std::os::unix::fs::symlink("moved", directory.join("folder")).unwrap();
                assert!(!created.cleanup());
                assert!(directory.join("moved/file").exists());
            } else {
                fs::rename(directory.join("folder/file"), directory.join("moved-file")).unwrap();
                fs::write(directory.join("folder/file"), b"replacement").unwrap();
                assert!(!created.cleanup());
                assert_eq!(
                    fs::read(directory.join("folder/file")).unwrap(),
                    b"replacement"
                );
            }
            fs::remove_dir_all(directory).unwrap();
        }
    }
    #[test]
    fn failed_reads_clean_only_the_current_download_and_allow_retry() {
        let (clipboard, _events, _network) = super::super::tests::bridge();
        let directory = temp();
        fs::write(directory.join("existing"), b"keep").unwrap();
        let downloads = &clipboard.shared.downloads;
        downloads.offer(vec![FileDescriptor::new("a").with_file_size(1)], Some(9), 4);
        assert!(
            downloads
                .start(
                    clipboard.shared.clone(),
                    &json!({"directory":directory,"revision":3})
                )
                .is_err()
        );
        assert_eq!(fs::read_dir(&directory).unwrap().count(), 1);
        downloads
            .start(
                clipboard.shared.clone(),
                &json!({"directory":directory,"revision":4}),
            )
            .unwrap();
        // This bridge has no network receiver, so the first file read fails.
        let worker = downloads.state.lock().unwrap().worker.take().unwrap();
        worker.join().unwrap();
        assert_eq!(downloads.snapshot()["transfer"]["state"], "failed");
        assert_eq!(fs::read_dir(&directory).unwrap().count(), 1);
        assert_eq!(fs::read(directory.join("existing")).unwrap(), b"keep");
        downloads.offer(
            vec![FileDescriptor::new("empty").with_file_size(0)],
            Some(10),
            5,
        );
        downloads
            .start(
                clipboard.shared.clone(),
                &json!({"directory":directory,"revision":5}),
            )
            .unwrap();
        let worker = downloads.state.lock().unwrap().worker.take().unwrap();
        worker.join().unwrap();
        assert_eq!(downloads.snapshot()["transfer"]["state"], "completed");
        assert_eq!(clipboard.shared.activity.lock().unwrap().readers, 0);
        fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn clipboard_replacement_preserves_locked_transfer_but_invalidates_unlocked_reads() {
        let downloads = Downloads::default();
        {
            let mut state = downloads.state.lock().unwrap();
            state.transfer = Some(json!({"id":"one","state":"running"}));
            state.data_id = Some(1);
        }
        downloads.clear_offer();
        assert!(!downloads.cancelled());
        downloads.expire(&[LockDataId(2)]);
        assert!(!downloads.cancelled());
        downloads.expire(&[LockDataId(1)]);
        assert!(downloads.cancelled());
        downloads.cancel.store(false, Ordering::SeqCst);
        downloads.state.lock().unwrap().data_id = None;
        downloads.clear_offer();
        assert!(downloads.cancelled());
        assert!(downloads.cancel(&json!({"id":"other"})).is_err());
    }
}
