//! Opt-in Windows OS clipboard interoperability check; never runs in the ordinary test suite.
#[cfg(windows)]
#[test]
#[ignore = "requires a live RDP file offer and ANAS_RDP_CLIPBOARD_TEST_DEST"]
fn paste_virtual_files() {
    use ironrdp_cliprdr::pdu::{ClipboardFileAttributes, FormatDataResponse};
    use windows::{
        Win32::{
            Foundation::S_OK,
            System::{Com::*, DataExchange::*, Memory::*, Ole::*},
            UI::Shell::IDataObjectAsyncCapability,
        },
        core::{Interface, w},
    };
    let destination = std::path::PathBuf::from(
        std::env::var_os("ANAS_RDP_CLIPBOARD_TEST_DEST").expect("explicit test destination"),
    );
    assert!(destination.is_dir());
    unsafe {
        OleInitialize(None).unwrap();
        let descriptor = RegisterClipboardFormatW(w!("FileGroupDescriptorW")) as u16;
        let contents = RegisterClipboardFormatW(w!("FileContents")) as u16;
        let format = |id, medium: TYMED, index| FORMATETC {
            cfFormat: id,
            ptd: std::ptr::null_mut(),
            dwAspect: DVASPECT_CONTENT.0,
            lindex: index,
            tymed: medium.0 as u32,
        };
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
        let object = loop {
            let object = OleGetClipboard().unwrap();
            if object
                .QueryGetData(&format(descriptor, TYMED_HGLOBAL, -1))
                .is_ok()
            {
                break object;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "No Windows virtual-file clipboard offer"
            );
            std::thread::sleep(std::time::Duration::from_millis(100));
        };
        let mut medium = object
            .GetData(&format(descriptor, TYMED_HGLOBAL, -1))
            .unwrap();
        let handle = medium.u.hGlobal;
        let size = GlobalSize(handle);
        assert!(size <= 16 * 1024 * 1024);
        let pointer = GlobalLock(handle);
        assert!(!pointer.is_null());
        let files =
            FormatDataResponse::new_data(std::slice::from_raw_parts(pointer.cast::<u8>(), size))
                .to_file_list()
                .unwrap();
        let _ = GlobalUnlock(handle);
        ReleaseStgMedium(&mut medium);
        assert!(!files.files.is_empty());
        let operation = object.cast::<IDataObjectAsyncCapability>().unwrap();
        operation.StartOperation(None).unwrap();
        assert!(operation.InOperation().unwrap().as_bool());
        for (index, file) in files.files.iter().enumerate() {
            let name = file
                .relative_path
                .as_ref()
                .map(|p| format!("{}\\{}", p, file.name))
                .unwrap_or_else(|| file.name.clone());
            assert!(
                !name.contains(':')
                    && !name.starts_with(['\\', '/'])
                    && name
                        .split(['\\', '/'])
                        .all(|p| !p.is_empty() && p != "." && p != "..")
            );
            let path = destination.join(name);
            if file
                .attributes
                .is_some_and(|a| a.contains(ClipboardFileAttributes::DIRECTORY))
            {
                std::fs::create_dir_all(path).unwrap();
                continue;
            }
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).unwrap();
            }
            let mut medium = object
                .GetData(&format(contents, TYMED_ISTREAM, index as i32))
                .unwrap();
            let stream = medium.u.pstm.as_ref().unwrap();
            println!("paste-started");
            std::thread::sleep(std::time::Duration::from_millis(600));
            let mut output = std::fs::File::create(path).unwrap();
            let mut buffer = vec![0; 64 * 1024];
            let mut total = 0u64;
            loop {
                let mut read = 0;
                stream
                    .Read(
                        buffer.as_mut_ptr().cast(),
                        buffer.len() as u32,
                        Some(&mut read),
                    )
                    .ok()
                    .unwrap();
                if read == 0 {
                    break;
                }
                std::io::Write::write_all(&mut output, &buffer[..read as usize]).unwrap();
                total += read as u64;
            }
            if let Some(size) = file.file_size {
                assert_eq!(total, size);
            }
            ReleaseStgMedium(&mut medium);
        }
        // Keep the operation active after the final stream has reached EOF.
        println!("paste-finishing");
        std::thread::sleep(std::time::Duration::from_millis(600));
        operation.EndOperation(S_OK, None, 1).unwrap();
        assert!(!operation.InOperation().unwrap().as_bool());
        drop(operation);
        drop(object);
        OleUninitialize();
    }
}
