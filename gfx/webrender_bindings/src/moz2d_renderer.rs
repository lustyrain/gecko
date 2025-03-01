use webrender::api::*;
use bindings::{ByteSlice, MutByteSlice, wr_moz2d_render_cb, ArcVecU8};
use rayon::ThreadPool;

use std::collections::hash_map::{HashMap, Entry};
use std::mem;
use std::os::raw::c_void;
use std::ptr;
use std::sync::mpsc::{channel, Sender, Receiver};
use std::sync::Arc;

#[cfg(target_os = "windows")]
use dwrote;

#[cfg(target_os = "macos")]
use foreign_types::ForeignType;

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
use std::ffi::CString;

macro_rules! dlog {
    ($($e:expr),*) => { {$(let _ = $e;)*} }
    //($($t:tt)*) => { println!($($t)*) }
}

pub struct Moz2dImageRenderer {
    blob_commands: HashMap<ImageKey, (Arc<BlobImageData>, Option<TileSize>)>,

    // The images rendered in the current frame (not kept here between frames)
    rendered_images: HashMap<BlobImageRequest, Option<BlobImageResult>>,

    tx: Sender<(BlobImageRequest, BlobImageResult)>,
    rx: Receiver<(BlobImageRequest, BlobImageResult)>,

    workers: Arc<ThreadPool>,
}

fn option_to_nullable<T>(option: &Option<T>) -> *const T {
    match option {
        &Some(ref x) => { x as *const T }
        &None => { ptr::null() }
    }
}

fn to_usize(slice: &[u8]) -> usize {
    convert_from_bytes(slice)
}

fn convert_from_bytes<T>(slice: &[u8]) -> T {
    assert!(mem::size_of::<T>() <= slice.len());
    let mut ret: T;
    unsafe {
        ret = mem::uninitialized();
        ptr::copy_nonoverlapping(slice.as_ptr(),
                                 &mut ret as *mut T as *mut u8,
                                 mem::size_of::<T>());
    }
    ret
}

use std::slice;

fn convert_to_bytes<T>(x: &T) -> &[u8] {
    unsafe {
        let ip: *const T = x;
        let bp: *const u8 = ip as * const _;
        slice::from_raw_parts(bp, mem::size_of::<T>())
    }
}


struct BufReader<'a> {
    buf: &'a[u8],
    pos: usize,
}

impl<'a> BufReader<'a> {
    fn new(buf: &'a[u8]) -> BufReader<'a> {
        BufReader { buf: buf, pos: 0 }
    }

    fn read<T>(&mut self) -> T {
        let ret = convert_from_bytes(&self.buf[self.pos..]);
        self.pos += mem::size_of::<T>();
        ret
    }

    fn read_font_key(&mut self) -> FontKey {
        self.read()
    }

    fn read_usize(&mut self) -> usize {
        self.read()
    }

    fn has_more(&self) -> bool {
        self.pos < self.buf.len()
    }
}

/* Blob stream format:
 * { data[..], index[..], offset in the stream of the index array }
 *
 * An 'item' has 'data' and 'extra_data'
 *  - In our case the 'data' is the stream produced by DrawTargetRecording
 *    and the 'extra_data' includes things like webrender font keys
 *
 * The index is an array of entries of the following form:
 * { end, extra_end, bounds }
 *
 * - end is the offset of the end of an item's data
 *   an item's data goes from the begining of the stream or
 *   the begining of the last item til end
 * - extra_end is the offset of the end of an item's extra data
 *   an item's extra data goes from 'end' until 'extra_end'
 * - bounds is a set of 4 ints {x1, y1, x2, y2 }
 *
 * The offsets in the index should be monotonically increasing.
 *
 * Design rationale:
 *  - the index is smaller so we append it to the end of the data array
 *  during construction. This makes it more likely that we'll fit inside
 *  the data Vec
 *  - we use indices/offsets instead of sizes to avoid having to deal with any
 *  arithmetic that might overflow.
 */


struct BlobReader<'a> {
    reader: BufReader<'a>,
    begin: usize,
}

impl<'a> BlobReader<'a> {
    fn new(buf: &'a[u8]) -> BlobReader<'a> {
        // The offset of the index is at the end of the buffer.
        let index_offset_pos = buf.len()-mem::size_of::<usize>();
        let index_offset = to_usize(&buf[index_offset_pos..]);

        BlobReader { reader: BufReader::new(&buf[index_offset..index_offset_pos]), begin: 0 }
    }

    fn read_entry(&mut self) -> (usize, usize, usize, Box2d) {
        let end = self.reader.read();
        let extra_end = self.reader.read();
        let bounds = self.reader.read();
        let ret = (self.begin, end, extra_end, bounds);
        self.begin = extra_end;
        ret
    }
}

// This is used for writing new blob images.
// In our case this is the result of merging an old one and a new one
struct BlobWriter {
    data: Vec<u8>,
    index: Vec<u8>
}

impl BlobWriter {
    fn new() -> BlobWriter {
        BlobWriter { data: Vec::new(), index: Vec::new() }
    }

    fn new_entry(&mut self, extra_size: usize, bounds: Box2d, data: &[u8]) {
        self.data.extend_from_slice(data);
        // Write 'end' to the index: the offset where the regular data ends and the extra data starts.
        self.index.extend_from_slice(convert_to_bytes(&(self.data.len() - extra_size)));
        // Write 'extra_end' to the index: the offset where the extra data ends.
        self.index.extend_from_slice(convert_to_bytes(&self.data.len()));
        // XXX: we can aggregate these writes
        // Write the bounds to the index.
        self.index.extend_from_slice(convert_to_bytes(&bounds.x1));
        self.index.extend_from_slice(convert_to_bytes(&bounds.y1));
        self.index.extend_from_slice(convert_to_bytes(&bounds.x2));
        self.index.extend_from_slice(convert_to_bytes(&bounds.y2));
    }

    fn finish(mut self) -> Vec<u8> {
        // Append the index to the end of the buffer
        // and then append the offset to the beginning of the index.
        let index_begin = self.data.len();
        self.data.extend_from_slice(&self.index);
        self.data.extend_from_slice(convert_to_bytes(&index_begin));
        self.data
    }
}


// XXX: Do we want to allow negative values here or clamp to the image bounds?
#[derive(Debug, Eq, PartialEq, Clone, Copy)]
struct Box2d {
    x1: u32,
    y1: u32,
    x2: u32,
    y2: u32
}

impl Box2d {
    fn contained_by(&self, other: &Box2d) -> bool {
        self.x1 >= other.x1 &&
        self.x2 <= other.x2 &&
        self.y1 >= other.y1 &&
        self.y2 <= other.y2
    }
}

impl From<DeviceUintRect> for Box2d {
    fn from(rect: DeviceUintRect) -> Self {
        Box2d{ x1: rect.min_x(), y1: rect.min_y(), x2: rect.max_x(), y2: rect.max_y() }
    }
}

fn dump_blob_index(blob: &[u8], dirty_rect: Box2d) {
    let mut index = BlobReader::new(blob);
    while index.reader.has_more() {
        let (_, _, _, bounds) = index.read_entry();
        dlog!("  {:?} {}", bounds,
                 if bounds.contained_by(&dirty_rect) {
                    "*"
                 } else {
                    ""
                 }
        );
    }
}

fn check_result(result: &[u8]) -> () {
    let mut index = BlobReader::new(result);
    assert!(index.reader.has_more(), "Unexpectedly empty result. This blob should just have been deleted");
    while index.reader.has_more() {
        let (_, end, extra, bounds) = index.read_entry();
        dlog!("result bounds: {} {} {:?}", end, extra, bounds);
    }
}

/* Merge a new partial blob image into an existing complete blob image.
   All of the items not fully contained in the dirty_rect should match
   in both new and old lists.
   We continue to use the old content for these items.
   Old items contained in the dirty_rect are dropped and new items
   are retained.
*/
fn merge_blob_images(old: &[u8], new: &[u8], dirty_rect: Box2d) -> Vec<u8> {

    let mut result = BlobWriter::new();
    dlog!("dirty rect: {:?}", dirty_rect);
    dlog!("old:");
    dump_blob_index(old, dirty_rect);
    dlog!("new:");
    dump_blob_index(new, dirty_rect);

    let mut old_reader = BlobReader::new(old);
    let mut new_reader = BlobReader::new(new);

    // Loop over both new and old entries merging them.
    // Both new and old must have the same number of entries that
    // overlap but are not contained by the dirty rect, and they
    // must be in the same order.
    while new_reader.reader.has_more() {
        let (new_begin, new_end, new_extra, new_bounds) = new_reader.read_entry();
        dlog!("bounds: {} {} {:?}", new_end, new_extra, new_bounds);
        if new_bounds.contained_by(&dirty_rect) {
            result.new_entry(new_extra - new_end, new_bounds, &new[new_begin..new_extra]);
        } else {
            loop {
                assert!(old_reader.reader.has_more());
                let (old_begin, old_end, old_extra, old_bounds) = old_reader.read_entry();
                dlog!("new bounds: {} {} {:?}", old_end, old_extra, old_bounds);
                if old_bounds.contained_by(&dirty_rect) {
                    // fully contained items will be discarded or replaced
                } else {
                    assert_eq!(old_bounds, new_bounds);
                    // we found a matching item use the old data
                    result.new_entry(old_extra - old_end, old_bounds, &old[old_begin..old_extra]);
                    break;
                }
            }
        }
    }

    // Include any remaining old items.
    while old_reader.reader.has_more() {
        let (_, old_end, old_extra, old_bounds) = old_reader.read_entry();
        dlog!("new bounds: {} {} {:?}", old_end, old_extra, old_bounds);
        assert!(old_bounds.contained_by(&dirty_rect));
    }

    let result = result.finish();
    check_result(&result);
    result
}

impl BlobImageRenderer for Moz2dImageRenderer {
    fn add(&mut self, key: ImageKey, data: BlobImageData, tiling: Option<TileSize>) {
        {
            let index = BlobReader::new(&data);
            assert!(index.reader.has_more());
        }
        self.blob_commands.insert(key, (Arc::new(data), tiling));
    }

    fn update(&mut self, key: ImageKey, data: BlobImageData, dirty_rect: Option<DeviceUintRect>) {
        match self.blob_commands.entry(key) {
            Entry::Occupied(mut e) => {
                let old_data = &mut e.get_mut().0;
                *old_data = Arc::new(merge_blob_images(&old_data, &data,
                                                       dirty_rect.unwrap().into()));
            }
            _ => { panic!("missing image key"); }
        }
    }

    fn delete(&mut self, key: ImageKey) {
        self.blob_commands.remove(&key);
    }

    fn request(&mut self,
               resources: &BlobImageResources,
               request: BlobImageRequest,
               descriptor: &BlobImageDescriptor,
               _dirty_rect: Option<DeviceUintRect>) {
        debug_assert!(!self.rendered_images.contains_key(&request), "{:?}", request);
        // TODO: implement tiling.

        // Add None in the map of rendered images. This makes it possible to differentiate
        // between commands that aren't finished yet (entry in the map is equal to None) and
        // keys that have never been requested (entry not in the map), which would cause deadlocks
        // if we were to block upon receving their result in resolve!
        self.rendered_images.insert(request, None);

        let tx = self.tx.clone();
        let descriptor = descriptor.clone();
        let blob = &self.blob_commands[&request.key];
        let tile_size = blob.1;
        let commands = Arc::clone(&blob.0);

        #[cfg(target_os = "windows")]
        fn process_native_font_handle(key: FontKey, handle: &NativeFontHandle) {
            let system_fc = dwrote::FontCollection::system();
            let font = system_fc.get_font_from_descriptor(handle).unwrap();
            let face = font.create_font_face();
            unsafe { AddNativeFontHandle(key, face.as_ptr() as *mut c_void, 0) };
        }

        #[cfg(target_os = "macos")]
        fn process_native_font_handle(key: FontKey, handle: &NativeFontHandle) {
            unsafe { AddNativeFontHandle(key, handle.0.as_ptr() as *mut c_void, 0) };
        }

        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        fn process_native_font_handle(key: FontKey, handle: &NativeFontHandle) {
            let cstr = CString::new(handle.pathname.clone()).unwrap();
            unsafe { AddNativeFontHandle(key, cstr.as_ptr() as *mut c_void, handle.index) };
        }

        fn process_fonts(mut extra_data: BufReader, resources: &BlobImageResources) {
            let font_count = extra_data.read_usize();
            for _ in 0..font_count {
                let key = extra_data.read_font_key();
                let template = resources.get_font_data(key);
                match template {
                    &FontTemplate::Raw(ref data, ref index) => {
                        unsafe { AddFontData(key, data.as_ptr(), data.len(), *index, data); }
                    }
                    &FontTemplate::Native(ref handle) => {
                        process_native_font_handle(key, handle);
                    }
                }
                resources.get_font_data(key);
            }
        }
        {
            let mut index = BlobReader::new(&commands);
            assert!(index.reader.pos < index.reader.buf.len());
            while index.reader.pos < index.reader.buf.len() {
                let (_, end, extra_end, _)  = index.read_entry();
                process_fonts(BufReader::new(&commands[end..extra_end]), resources);
            }
        }

        self.workers.spawn(move || {
            let buf_size = (descriptor.width
                * descriptor.height
                * descriptor.format.bytes_per_pixel()) as usize;
            let mut output = vec![0u8; buf_size];

            let result = unsafe {
                if wr_moz2d_render_cb(
                    ByteSlice::new(&commands[..]),
                    descriptor.width,
                    descriptor.height,
                    descriptor.format,
                    option_to_nullable(&tile_size),
                    option_to_nullable(&request.tile),
                    MutByteSlice::new(output.as_mut_slice())
                ) {

                    Ok(RasterizedBlobImage {
                        width: descriptor.width,
                        height: descriptor.height,
                        data: output,
                    })
                } else {
                    panic!("Moz2D replay problem");
                }
            };

            tx.send((request, result)).unwrap();
        });
    }

    fn resolve(&mut self, request: BlobImageRequest) -> BlobImageResult {

        match self.rendered_images.entry(request) {
            Entry::Vacant(_) => {
                return Err(BlobImageError::InvalidKey);
            }
            Entry::Occupied(entry) => {
                // None means we haven't yet received the result.
                if entry.get().is_some() {
                    let result = entry.remove();
                    return result.unwrap();
                }
            }
        }

        // We haven't received it yet, pull from the channel until we receive it.
        while let Ok((req, result)) = self.rx.recv() {
            if req == request {
                // There it is!
                self.rendered_images.remove(&request);
                return result
            }
            self.rendered_images.insert(req, Some(result));
        }

        // If we break out of the loop above it means the channel closed unexpectedly.
        Err(BlobImageError::Other("Channel closed".into()))
    }
    fn delete_font(&mut self, font: FontKey) {
        unsafe { DeleteFontData(font); }
    }

    fn delete_font_instance(&mut self, _key: FontInstanceKey) {
    }
}

use bindings::WrFontKey;

#[allow(improper_ctypes)] // this is needed so that rustc doesn't complain about passing the &Arc<Vec> to an extern function
extern "C" {
    fn AddFontData(key: WrFontKey, data: *const u8, size: usize, index: u32, vec: &ArcVecU8);
    fn AddNativeFontHandle(key: WrFontKey, handle: *mut c_void, index: u32);
    fn DeleteFontData(key: WrFontKey);
}

impl Moz2dImageRenderer {
    pub fn new(workers: Arc<ThreadPool>) -> Self {
        let (tx, rx) = channel();
        Moz2dImageRenderer {
            blob_commands: HashMap::new(),
            rendered_images: HashMap::new(),
            workers: workers,
            tx: tx,
            rx: rx,
        }
    }
}

