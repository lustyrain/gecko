// Copyright © 2017-2018 Mozilla Foundation
//
// This program is made available under an ISC-style license.  See the
// accompanying file LICENSE for details.

use {ChannelLayout, DeviceRef, Result, SampleFormat};
use ffi;
use std::os::raw::c_void;
use std::ptr;

/// Stream states signaled via `state_callback`.
#[derive(PartialEq, Eq, Clone, Debug, Copy)]
pub enum State {
    /// Stream started.
    Started,
    /// Stream stopped.
    Stopped,
    /// Stream drained.
    Drained,
    /// Stream disabled due to error.
    Error,
}

impl From<ffi::cubeb_state> for State {
    fn from(x: ffi::cubeb_state) -> Self {
        use State::*;
        match x {
            ffi::CUBEB_STATE_STARTED => Started,
            ffi::CUBEB_STATE_STOPPED => Stopped,
            ffi::CUBEB_STATE_DRAINED => Drained,
            _ => Error,
        }
    }
}

impl Into<ffi::cubeb_state> for State {
    fn into(self) -> ffi::cubeb_state {
        use State::*;
        match self {
            Started => ffi::CUBEB_STATE_STARTED,
            Stopped => ffi::CUBEB_STATE_STOPPED,
            Drained => ffi::CUBEB_STATE_DRAINED,
            Error => ffi::CUBEB_STATE_ERROR,
        }
    }
}

/// Miscellaneous stream preferences.
bitflags! {
    pub struct StreamPrefs: ffi::cubeb_stream_prefs {
        const NONE = ffi::CUBEB_STREAM_PREF_NONE;
        const LOOPBACK = ffi::CUBEB_STREAM_PREF_LOOPBACK;
    }
}

/// Stream format initialization parameters.
ffi_type_stack!{
    type CType = ffi::cubeb_stream_params;
    #[derive(Debug)]
    pub struct StreamParams;
    pub struct StreamParamsRef;
}

impl StreamParamsRef {
    fn get_ref(&self) -> &ffi::cubeb_stream_params {
        unsafe { &*self.as_ptr() }
    }

    pub fn format(&self) -> SampleFormat {
        use SampleFormat::*;
        match self.get_ref().format {
            ffi::CUBEB_SAMPLE_S16LE => S16LE,
            ffi::CUBEB_SAMPLE_S16BE => S16BE,
            ffi::CUBEB_SAMPLE_FLOAT32LE => Float32LE,
            ffi::CUBEB_SAMPLE_FLOAT32BE => Float32BE,
            x => panic!("unknown sample format: {}", x),
        }
    }

    pub fn rate(&self) -> u32 {
        self.get_ref().rate
    }
    pub fn channels(&self) -> u32 {
        self.get_ref().channels
    }

    pub fn layout(&self) -> ChannelLayout {
        ChannelLayout::from(self.get_ref().layout)
    }

    pub fn prefs(&self) -> StreamPrefs {
        StreamPrefs::from_bits_truncate(self.get_ref().prefs)
    }
}

ffi_type_heap! {
    type CType = ffi::cubeb_stream;
    fn drop = ffi::cubeb_stream_destroy;
    pub struct Stream;
    pub struct StreamRef;
}

impl StreamRef {
    /// Start playback.
    pub fn start(&self) -> Result<()> {
        unsafe { call!(ffi::cubeb_stream_start(self.as_ptr())) }
    }

    /// Stop playback.
    pub fn stop(&self) -> Result<()> {
        unsafe { call!(ffi::cubeb_stream_stop(self.as_ptr())) }
    }

    /// Reset stream to the default device.
    pub fn reset_default_device(&self) -> Result<()> {
        unsafe { call!(ffi::cubeb_stream_reset_default_device(self.as_ptr())) }
    }

    /// Get the current stream playback position.
    pub fn position(&self) -> Result<u64> {
        let mut position = 0u64;
        unsafe {
            let _ = try_call!(ffi::cubeb_stream_get_position(self.as_ptr(), &mut position));
        }
        Ok(position)
    }

    /// Get the latency for this stream, in frames. This is the number
    /// of frames between the time cubeb acquires the data in the
    /// callback and the listener can hear the sound.
    pub fn latency(&self) -> Result<u32> {
        let mut latency = 0u32;
        unsafe {
            let _ = try_call!(ffi::cubeb_stream_get_latency(self.as_ptr(), &mut latency));
        }
        Ok(latency)
    }

    /// Set the volume for a stream.
    pub fn set_volume(&self, volume: f32) -> Result<()> {
        unsafe { call!(ffi::cubeb_stream_set_volume(self.as_ptr(), volume)) }
    }

    /// If the stream is stereo, set the left/right panning. If the stream is mono,
    /// this has no effect.
    ///
    /// panning a number from -1.0 to 1.0. -1.0 means that the stream is
    /// fully mixed in the left channel, 1.0 means the stream is fully
    /// mixed in the right channel. 0.0 is equal power in the right
    /// and left channel (default).
    pub fn set_panning(&self, panning: f32) -> Result<()> {
        unsafe { call!(ffi::cubeb_stream_set_panning(self.as_ptr(), panning)) }
    }

    /// Get the current output device for this stream.
    pub fn current_device(&self) -> Result<&DeviceRef> {
        let mut device: *mut ffi::cubeb_device = ptr::null_mut();
        unsafe {
            let _ = try_call!(ffi::cubeb_stream_get_current_device(
                self.as_ptr(),
                &mut device
            ));
            Ok(DeviceRef::from_ptr(device))
        }
    }

    /// Destroy a cubeb_device structure.
    pub fn device_destroy(&self, device: DeviceRef) -> Result<()> {
        unsafe {
            call!(ffi::cubeb_stream_device_destroy(
                self.as_ptr(),
                device.as_ptr()
            ))
        }
    }

    /// Set a callback to be notified when the output device changes.
    pub fn register_device_changed_callback(
        &self,
        callback: ffi::cubeb_device_changed_callback,
    ) -> Result<()> {
        unsafe {
            call!(ffi::cubeb_stream_register_device_changed_callback(
                self.as_ptr(),
                callback
            ))
        }
    }

    pub fn user_ptr(&self) -> *mut c_void {
        unsafe { ffi::cubeb_stream_user_ptr(self.as_ptr()) }
    }
}

#[cfg(test)]
mod tests {
    use {StreamParams, StreamParamsRef, StreamPrefs};
    use std::mem;

    #[test]
    fn stream_params_default() {
        let params = StreamParams::default();
        assert_eq!(params.channels(), 0);
    }

    #[test]
    fn stream_params_raw_channels() {
        let mut raw: super::ffi::cubeb_stream_params = unsafe { mem::zeroed() };
        raw.channels = 2;
        let params = unsafe { StreamParamsRef::from_ptr(&mut raw) };
        assert_eq!(params.channels(), 2);
    }

    #[test]
    fn stream_params_raw_format() {
        let mut raw: super::ffi::cubeb_stream_params = unsafe { mem::zeroed() };
        macro_rules! check(
            ($($raw:ident => $real:ident),*) => (
                $(raw.format = super::ffi::$raw;
                  let params = unsafe {
                      StreamParamsRef::from_ptr(&mut raw)
                  };
                  assert_eq!(params.format(), super::SampleFormat::$real);
                )*
            ) );

        check!(CUBEB_SAMPLE_S16LE => S16LE,
               CUBEB_SAMPLE_S16BE => S16BE,
               CUBEB_SAMPLE_FLOAT32LE => Float32LE,
               CUBEB_SAMPLE_FLOAT32BE => Float32BE);
    }

    #[test]
    fn stream_params_raw_format_native_endian() {
        let mut raw: super::ffi::cubeb_stream_params = unsafe { mem::zeroed() };
        raw.format = super::ffi::CUBEB_SAMPLE_S16NE;
        let params = unsafe { StreamParamsRef::from_ptr(&mut raw) };
        assert_eq!(
            params.format(),
            if cfg!(target_endian = "little") {
                super::SampleFormat::S16LE
            } else {
                super::SampleFormat::S16BE
            }
        );

        raw.format = super::ffi::CUBEB_SAMPLE_FLOAT32NE;
        let params = unsafe { StreamParamsRef::from_ptr(&mut raw) };
        assert_eq!(
            params.format(),
            if cfg!(target_endian = "little") {
                super::SampleFormat::Float32LE
            } else {
                super::SampleFormat::Float32BE
            }
        );
    }

    #[test]
    fn stream_params_raw_layout() {
        let mut raw: super::ffi::cubeb_stream_params = unsafe { mem::zeroed() };
        macro_rules! check(
            ($($raw:ident => $real:ident),*) => (
                $(raw.layout = super::ffi::$raw;
                  let params = unsafe {
                      StreamParamsRef::from_ptr(&mut raw)
                  };
                  assert_eq!(params.layout(), super::ChannelLayout::$real);
                )*
            ) );

        check!(CUBEB_LAYOUT_UNDEFINED => UNDEFINED,
               CUBEB_LAYOUT_MONO => MONO,
               CUBEB_LAYOUT_MONO_LFE => MONO_LFE,
               CUBEB_LAYOUT_STEREO => STEREO,
               CUBEB_LAYOUT_STEREO_LFE => STEREO_LFE,
               CUBEB_LAYOUT_3F => _3F,
               CUBEB_LAYOUT_3F_LFE => _3F_LFE,
               CUBEB_LAYOUT_2F1 => _2F1,
               CUBEB_LAYOUT_2F1_LFE => _2F1_LFE,
               CUBEB_LAYOUT_3F1 => _3F1,
               CUBEB_LAYOUT_3F1_LFE => _3F1_LFE,
               CUBEB_LAYOUT_2F2 => _2F2,
               CUBEB_LAYOUT_2F2_LFE => _2F2_LFE,
               CUBEB_LAYOUT_QUAD => QUAD,
               CUBEB_LAYOUT_QUAD_LFE => QUAD_LFE,
               CUBEB_LAYOUT_3F2 => _3F2,
               CUBEB_LAYOUT_3F2_LFE => _3F2_LFE,
               CUBEB_LAYOUT_3F2_BACK => _3F2_BACK,
               CUBEB_LAYOUT_3F2_LFE_BACK => _3F2_LFE_BACK,
               CUBEB_LAYOUT_3F3R_LFE => _3F3R_LFE,
               CUBEB_LAYOUT_3F4_LFE => _3F4_LFE);
    }

    #[test]
    fn stream_params_raw_rate() {
        let mut raw: super::ffi::cubeb_stream_params = unsafe { mem::zeroed() };
        raw.rate = 44_100;
        let params = unsafe { StreamParamsRef::from_ptr(&mut raw) };
        assert_eq!(params.rate(), 44_100);
    }

    #[test]
    fn stream_params_raw_prefs() {
        let mut raw: super::ffi::cubeb_stream_params = unsafe { mem::zeroed() };
        raw.prefs = super::ffi::CUBEB_STREAM_PREF_LOOPBACK;
        let params = unsafe { StreamParamsRef::from_ptr(&mut raw) };
        assert_eq!(params.prefs(), StreamPrefs::LOOPBACK);
    }

    #[test]
    fn stream_params_stream_params_ref_ptr_match() {
        let params = StreamParams::default();
        assert_eq!(params.as_ptr(), params.as_ref().as_ptr());
    }
}
