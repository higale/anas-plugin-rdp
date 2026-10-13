//! Windows virtual-file clipboard: Explorer requests IStream bytes only on paste.
use super::{CHUNK, Shared};
use ironrdp_cliprdr::pdu::{FileDescriptor, FormatDataResponse, PackedFileList};
use std::{
    ffi::c_void,
    mem::ManuallyDrop,
    ptr,
    sync::{
        Arc, Mutex, Weak,
        atomic::{AtomicBool, Ordering},
    },
};
use windows::{
    Win32::{
        Foundation::*,
        System::{Com::*, DataExchange::*, Memory::*, Ole::*},
        UI::{
            Shell::{
                IDataObjectAsyncCapability, IDataObjectAsyncCapability_Impl, SHCreateStdEnumFmtEtc,
            },
            WindowsAndMessaging::*,
        },
    },
    core::*,
};

pub fn sequence() -> u32 {
    unsafe { GetClipboardSequenceNumber() }
}

pub struct Apartment;
impl Apartment {
    pub fn new() -> Result<Self> {
        unsafe {
            OleInitialize(None)?;
        }
        Ok(Self)
    }
}
impl Drop for Apartment {
    fn drop(&mut self) {
        unsafe {
            OleUninitialize();
        }
    }
}
pub fn pump() {
    unsafe {
        let mut msg = MSG::default();
        while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
}

// windows-rs converts S_FALSE into Ok(()); retain the HRESULT for this predicate.
#[link(name = "ole32")]
unsafe extern "system" {
    #[link_name = "OleIsCurrentClipboard"]
    fn is_current_clipboard(data: *mut c_void) -> HRESULT;
}
pub struct Offer(IDataObject);
impl Offer {
    pub fn new(
        files: Vec<FileDescriptor>,
        id: Option<u32>,
        shared: Arc<Shared>,
        generation: u64,
    ) -> Result<Self> {
        let data = data_object(files, id, shared, generation)?;
        unsafe {
            OleSetClipboard(&data)?;
        }
        Ok(Self(data))
    }
    pub fn is_current(&self) -> bool {
        unsafe { is_current_clipboard(self.0.as_raw()) == S_OK }
    }
}
fn data_object(
    files: Vec<FileDescriptor>,
    id: Option<u32>,
    shared: Arc<Shared>,
    generation: u64,
) -> Result<IDataObject> {
    let bytes = FormatDataResponse::new_file_list(&PackedFileList {
        files: files.clone(),
    })
    .map_err(|_| Error::from(E_FAIL))?
    .data()
    .to_vec();
    let descriptor = unsafe { RegisterClipboardFormatW(w!("FileGroupDescriptorW")) } as u16;
    let contents = unsafe { RegisterClipboardFormatW(w!("FileContents")) } as u16;
    let effect = unsafe { RegisterClipboardFormatW(w!("Preferred DropEffect")) } as u16;
    let data: IDataObject = Data {
        files,
        bytes,
        id,
        shared,
        descriptor,
        contents,
        effect,
        asynchronous: AtomicBool::new(true),
        operation: Mutex::new(None),
        streams: Arc::default(),
        generation,
    }
    .into();
    Ok(data)
}
impl Drop for Offer {
    fn drop(&mut self) {
        if self.is_current() {
            unsafe {
                let _ = OleSetClipboard(None);
            }
        }
    }
}
fn format(id: u16, medium: TYMED, index: i32) -> FORMATETC {
    FORMATETC {
        cfFormat: id,
        ptd: ptr::null_mut(),
        dwAspect: DVASPECT_CONTENT.0,
        lindex: index,
        tymed: medium.0 as u32,
    }
}
fn global(bytes: &[u8]) -> Result<STGMEDIUM> {
    unsafe {
        let handle = GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, bytes.len())?;
        let memory = GlobalLock(handle);
        if memory.is_null() {
            let _ = GlobalFree(Some(handle));
            return Err(Error::from(E_OUTOFMEMORY));
        }
        ptr::copy_nonoverlapping(bytes.as_ptr(), memory.cast(), bytes.len());
        let _ = GlobalUnlock(handle);
        Ok(STGMEDIUM {
            tymed: TYMED_HGLOBAL.0 as u32,
            u: STGMEDIUM_0 { hGlobal: handle },
            pUnkForRelease: ManuallyDrop::new(None),
        })
    }
}
#[implement(IDataObject, IDataObjectAsyncCapability)]
struct Data {
    files: Vec<FileDescriptor>,
    bytes: Vec<u8>,
    id: Option<u32>,
    shared: Arc<Shared>,
    descriptor: u16,
    contents: u16,
    effect: u16,
    asynchronous: AtomicBool,
    operation: Mutex<Option<super::Reading>>,
    streams: Streams,
    generation: u64,
}
type StreamReading = Arc<Mutex<Option<super::Reading>>>;
type Streams = Arc<Mutex<Vec<Weak<Mutex<Option<super::Reading>>>>>>;
fn stream_reading(streams: &Streams, reading: Option<super::Reading>) -> StreamReading {
    let reading = Arc::new(Mutex::new(reading));
    let mut streams = streams.lock().unwrap();
    streams.retain(|stream| stream.strong_count() > 0);
    streams.push(Arc::downgrade(&reading));
    reading
}
impl Data_Impl {
    fn formats(&self) -> [FORMATETC; 3] {
        [
            format(self.descriptor, TYMED_HGLOBAL, -1),
            format(self.contents, TYMED_ISTREAM, -1),
            format(self.effect, TYMED_HGLOBAL, -1),
        ]
    }
}
impl IDataObjectAsyncCapability_Impl for Data_Impl {
    fn SetAsyncMode(&self, value: BOOL) -> Result<()> {
        self.asynchronous.store(value.as_bool(), Ordering::SeqCst);
        Ok(())
    }
    fn GetAsyncMode(&self) -> Result<BOOL> {
        Ok(self.asynchronous.load(Ordering::SeqCst).into())
    }
    fn StartOperation(&self, _: Ref<IBindCtx>) -> Result<()> {
        if self.generation != self.shared.generation.load(Ordering::SeqCst) {
            return Err(STG_E_READFAULT.into());
        }
        let mut operation = self.operation.lock().unwrap();
        if operation.is_none() {
            *operation = Some(
                self.shared
                    .reading()
                    .map_err(|_| Error::from(STG_E_READFAULT))?,
            );
        }
        Ok(())
    }
    fn InOperation(&self) -> Result<BOOL> {
        Ok(self.operation.lock().unwrap().is_some().into())
    }
    fn EndOperation(&self, _: HRESULT, _: Ref<IBindCtx>, _: u32) -> Result<()> {
        self.operation.lock().unwrap().take();
        // Explorer may cache an IStream after cancel; EndOperation ends its transfer.
        for stream in self
            .streams
            .lock()
            .unwrap()
            .iter()
            .filter_map(Weak::upgrade)
        {
            stream.lock().unwrap().take();
        }
        Ok(())
    }
}
impl IDataObject_Impl for Data_Impl {
    fn GetData(&self, value: *const FORMATETC) -> Result<STGMEDIUM> {
        self.QueryGetData(value).ok()?;
        let value = unsafe { &*value };
        if value.cfFormat == self.descriptor {
            return global(&self.bytes);
        }
        if value.cfFormat == self.effect {
            return global(&1u32.to_le_bytes());
        }
        if value.lindex < 0 || value.lindex as usize >= self.files.len() {
            return Err(DV_E_LINDEX.into());
        }
        if self.generation != self.shared.generation.load(Ordering::SeqCst) {
            return Err(STG_E_READFAULT.into());
        }
        let file = &self.files[value.lindex as usize];
        let reading = self
            .shared
            .reading()
            .map_err(|_| Error::from(STG_E_READFAULT))?;
        let size = if let Some(size) = file.file_size {
            size
        } else {
            let bytes = self
                .shared
                .read(value.lindex as usize, 0, 0, self.id)
                .map_err(|_| Error::from(STG_E_READFAULT))?;
            u64::from_le_bytes(bytes.try_into().map_err(|_| Error::from(STG_E_READFAULT))?)
        };
        let stream: IStream = RemoteStream {
            reading: stream_reading(&self.streams, if size == 0 { None } else { Some(reading) }),
            streams: self.streams.clone(),
            generation: self.generation,
            shared: self.shared.clone(),
            id: self.id,
            index: value.lindex as usize,
            size,
            position: Mutex::new(0),
        }
        .into();
        Ok(STGMEDIUM {
            tymed: TYMED_ISTREAM.0 as u32,
            u: STGMEDIUM_0 {
                pstm: ManuallyDrop::new(Some(stream)),
            },
            pUnkForRelease: ManuallyDrop::new(None),
        })
    }
    fn QueryGetData(&self, value: *const FORMATETC) -> HRESULT {
        let Some(value) = (unsafe { value.as_ref() }) else {
            return E_POINTER;
        };
        if value.dwAspect != DVASPECT_CONTENT.0 {
            return DV_E_DVASPECT;
        }
        if value.cfFormat == self.contents {
            if value.lindex < -1 || value.lindex >= 0 && value.lindex as usize >= self.files.len() {
                return DV_E_LINDEX;
            }
            if value.tymed & TYMED_ISTREAM.0 as u32 == 0 {
                return DV_E_TYMED;
            }
            return S_OK;
        }
        if [self.descriptor, self.effect].contains(&value.cfFormat)
            && value.tymed & TYMED_HGLOBAL.0 as u32 != 0
        {
            S_OK
        } else {
            DV_E_FORMATETC
        }
    }
    fn GetDataHere(&self, _: *const FORMATETC, _: *mut STGMEDIUM) -> Result<()> {
        Err(E_NOTIMPL.into())
    }
    fn GetCanonicalFormatEtc(&self, _: *const FORMATETC, output: *mut FORMATETC) -> HRESULT {
        if !output.is_null() {
            unsafe {
                (*output).ptd = ptr::null_mut();
            }
        }
        E_NOTIMPL
    }
    fn SetData(&self, _: *const FORMATETC, _: *const STGMEDIUM, _: BOOL) -> Result<()> {
        Err(E_NOTIMPL.into())
    }
    fn EnumFormatEtc(&self, direction: u32) -> Result<IEnumFORMATETC> {
        if direction != DATADIR_GET.0 as u32 {
            return Err(E_NOTIMPL.into());
        }
        unsafe { SHCreateStdEnumFmtEtc(&self.formats()) }
    }
    fn DAdvise(&self, _: *const FORMATETC, _: u32, _: Ref<IAdviseSink>) -> Result<u32> {
        Err(OLE_E_ADVISENOTSUPPORTED.into())
    }
    fn DUnadvise(&self, _: u32) -> Result<()> {
        Err(OLE_E_ADVISENOTSUPPORTED.into())
    }
    fn EnumDAdvise(&self) -> Result<IEnumSTATDATA> {
        Err(OLE_E_ADVISENOTSUPPORTED.into())
    }
}
#[implement(IStream)]
struct RemoteStream {
    reading: StreamReading,
    streams: Streams,
    generation: u64,
    shared: Arc<Shared>,
    id: Option<u32>,
    index: usize,
    size: u64,
    position: Mutex<u64>,
}
impl ISequentialStream_Impl for RemoteStream_Impl {
    fn Read(&self, output: *mut c_void, count: u32, read: *mut u32) -> HRESULT {
        if !read.is_null() {
            unsafe {
                *read = 0;
            }
        }
        if self.generation != self.shared.generation.load(Ordering::SeqCst) {
            return STG_E_READFAULT;
        }
        if count == 0 {
            return S_OK;
        }
        if output.is_null() {
            return E_POINTER;
        }
        let mut position = self.position.lock().unwrap();
        let mut reading = self.reading.lock().unwrap();
        if *position < self.size && reading.is_none() {
            match self.shared.reading() {
                Ok(guard) => *reading = Some(guard),
                Err(_) => return STG_E_READFAULT,
            }
        }
        let mut total = 0u32;
        while total < count && *position < self.size {
            let length = (count - total)
                .min(CHUNK)
                .min((self.size - *position).min(u32::MAX as u64) as u32);
            let Ok(bytes) = self.shared.read(self.index, *position, length, self.id) else {
                reading.take();
                return STG_E_READFAULT;
            };
            if bytes.is_empty() || bytes.len() > length as usize {
                reading.take();
                return STG_E_READFAULT;
            }
            unsafe {
                ptr::copy_nonoverlapping(
                    bytes.as_ptr(),
                    output.cast::<u8>().add(total as usize),
                    bytes.len(),
                );
            }
            *position += bytes.len() as u64;
            total += bytes.len() as u32;
            if !read.is_null() {
                unsafe {
                    *read = total;
                }
            }
        }
        if *position >= self.size {
            reading.take();
        }
        if total == count { S_OK } else { S_FALSE }
    }
    fn Write(&self, _: *const c_void, _: u32, written: *mut u32) -> HRESULT {
        if !written.is_null() {
            unsafe {
                *written = 0;
            }
        }
        STG_E_ACCESSDENIED
    }
}
impl IStream_Impl for RemoteStream_Impl {
    fn Seek(&self, offset: i64, origin: STREAM_SEEK, new: *mut u64) -> Result<()> {
        let mut position = self.position.lock().unwrap();
        let base = match origin {
            STREAM_SEEK_SET => 0,
            STREAM_SEEK_CUR => *position,
            STREAM_SEEK_END => self.size,
            _ => return Err(STG_E_INVALIDFUNCTION.into()),
        };
        *position = base
            .checked_add_signed(offset)
            .ok_or_else(|| Error::from(STG_E_INVALIDFUNCTION))?;
        if !new.is_null() {
            unsafe {
                *new = *position;
            }
        }
        Ok(())
    }
    fn SetSize(&self, _: u64) -> Result<()> {
        Err(STG_E_ACCESSDENIED.into())
    }
    fn CopyTo(
        &self,
        destination: Ref<IStream>,
        count: u64,
        read: *mut u64,
        written: *mut u64,
    ) -> Result<()> {
        let destination = destination.ok()?;
        if !read.is_null() {
            unsafe {
                *read = 0;
            }
        }
        if !written.is_null() {
            unsafe {
                *written = 0;
            }
        }
        let mut total = 0u64;
        let mut bytes = vec![0; CHUNK as usize];
        while total < count {
            let mut received = 0;
            self.Read(
                bytes.as_mut_ptr().cast(),
                (count - total).min(CHUNK as u64) as u32,
                &mut received,
            )
            .ok()?;
            if received == 0 {
                break;
            }
            let mut sent = 0;
            unsafe {
                destination
                    .Write(bytes.as_ptr().cast(), received, Some(&mut sent))
                    .ok()?;
            }
            if sent != received {
                return Err(STG_E_WRITEFAULT.into());
            }
            total += sent as u64;
            if !read.is_null() {
                unsafe {
                    *read = total;
                }
            }
            if !written.is_null() {
                unsafe {
                    *written = total;
                }
            }
        }
        Ok(())
    }
    fn Commit(&self, _: &STGC) -> Result<()> {
        Ok(())
    }
    fn Revert(&self) -> Result<()> {
        Err(E_NOTIMPL.into())
    }
    fn LockRegion(&self, _: u64, _: u64, _: &LOCKTYPE) -> Result<()> {
        Err(STG_E_INVALIDFUNCTION.into())
    }
    fn UnlockRegion(&self, _: u64, _: u64, _: u32) -> Result<()> {
        Err(STG_E_INVALIDFUNCTION.into())
    }
    fn Stat(&self, stat: *mut STATSTG, _: &STATFLAG) -> Result<()> {
        if stat.is_null() {
            return Err(E_POINTER.into());
        }
        unsafe {
            *stat = STATSTG {
                r#type: STGTY_STREAM.0 as u32,
                cbSize: self.size,
                grfMode: STGM_READ,
                ..Default::default()
            };
        }
        Ok(())
    }
    fn Clone(&self) -> Result<IStream> {
        Ok(RemoteStream {
            reading: stream_reading(&self.streams, None),
            streams: self.streams.clone(),
            generation: self.generation,
            shared: self.shared.clone(),
            id: self.id,
            index: self.index,
            size: self.size,
            position: Mutex::new(*self.position.lock().unwrap()),
        }
        .into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cancel_releases_cached_streams_and_reenable_invalidates_the_old_offer() {
        let _apartment = Apartment::new().unwrap();
        let (clipboard, _events, _network) = super::super::tests::bridge();
        let data = data_object(
            vec![FileDescriptor::new("test.bin").with_file_size(100)],
            Some(1),
            clipboard.shared.clone(),
            0,
        )
        .unwrap();
        unsafe {
            let operation: IDataObjectAsyncCapability = data.cast().unwrap();
            operation.StartOperation(None).unwrap();
            let contents = RegisterClipboardFormatW(w!("FileContents")) as u16;
            let mut medium = data.GetData(&format(contents, TYMED_ISTREAM, 0)).unwrap();
            assert!(clipboard.set_enabled(false).is_err());
            operation.EndOperation(E_ABORT, None, 0).unwrap();
            clipboard.set_enabled(false).unwrap();
            clipboard.set_enabled(true).unwrap();
            assert!(data.GetData(&format(contents, TYMED_ISTREAM, 0)).is_err());
            let stream = medium.u.pstm.as_ref().unwrap();
            let mut byte = 0u8;
            assert!(stream.Read((&mut byte as *mut u8).cast(), 1, None).is_err());
            ReleaseStgMedium(&mut medium);
        }
    }
}
