//! Microphone capture (cpal), level metering, and resampling for whisper.
//!
//! Capture runs while push-to-talk is held (or during an MCP ask with
//! silence-based auto-stop). Audio is stored in a shared buffer as f32 mono
//! at the device's native rate; `resample_to_16k` feeds whisper.

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{SampleFormat, Stream, StreamConfig};
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

/// Primitives → f32 in [-1, 1]. Implemented locally so the conversion rules
/// are explicit and independent of cpal's trait surface.
trait PcmSample {
    fn to_f32_sample(self) -> f32;
}

impl PcmSample for f32 {
    fn to_f32_sample(self) -> f32 {
        self
    }
}
impl PcmSample for i16 {
    fn to_f32_sample(self) -> f32 {
        self as f32 / 32_768.0
    }
}
impl PcmSample for u16 {
    fn to_f32_sample(self) -> f32 {
        self as f32 / 32_768.0 - 1.0
    }
}
impl PcmSample for i32 {
    fn to_f32_sample(self) -> f32 {
        self as f32 / 2_147_483_648.0
    }
}
impl PcmSample for u8 {
    fn to_f32_sample(self) -> f32 {
        (self as f32 - 128.0) / 128.0
    }
}

/// RMS-ish peak threshold treated as "speech" for auto-stop bookkeeping.
pub const SPEECH_THRESHOLD: f32 = 0.012;

pub struct CaptureSession {
    /// Held so the input stream stays alive for the whole utterance;
    /// dropping the session stops capture.
    pub _stream: Option<Stream>,
    pub samples: Arc<Mutex<Vec<f32>>>,
    pub source_rate: u32,
    pub channels: u16,
    pub started: std::time::Instant,
    /// Sample index of the last sample above the speech threshold.
    pub last_loud: Arc<AtomicU64>,
    /// Total samples captured so far.
    pub captured: Arc<AtomicU64>,
    pub target: crate::state::TargetInfo,
    pub delivery: crate::state::Delivery,
}

impl CaptureSession {
    pub fn take_samples(&self) -> Vec<f32> {
        let mut buf = self.samples.lock().unwrap();
        std::mem::take(&mut *buf)
    }

    /// Milliseconds since the last sample above the speech threshold.
    pub fn ms_since_speech(&self) -> u64 {
        let captured = self.captured.load(Ordering::Relaxed);
        let loud = self.last_loud.load(Ordering::Relaxed);
        let behind = captured.saturating_sub(loud);
        behind.saturating_mul(1000) / self.source_rate.max(1) as u64
    }

    pub fn elapsed_ms(&self) -> u64 {
        self.started.elapsed().as_millis() as u64
    }

    pub fn has_speech(&self) -> bool {
        self.last_loud.load(Ordering::Relaxed) > 0
    }
}

/// Auto-stop decision for MCP asks: stop after a short warm-up with no
/// speech, or once speech has ended and `silence_ms` passed; always stop at
/// `max_ms`. Pure and unit-tested.
pub fn should_auto_stop(
    elapsed_ms: u64,
    ms_since_speech: u64,
    has_speech: bool,
    silence_ms: u64,
    min_ms: u64,
    max_ms: u64,
) -> bool {
    if elapsed_ms >= max_ms {
        return true;
    }
    if elapsed_ms < min_ms {
        return false;
    }
    if !has_speech {
        // No speech yet: keep waiting until the hard deadline.
        return false;
    }
    ms_since_speech >= silence_ms
}

/// Linear resampler to the 16 kHz mono input whisper expects.
pub fn resample_to_16k(samples: &[f32], source_rate: u32) -> Vec<f32> {
    const TARGET: u32 = 16_000;
    if samples.is_empty() {
        return Vec::new();
    }
    if source_rate == TARGET {
        return samples.to_vec();
    }
    let ratio = source_rate as f64 / TARGET as f64;
    let out_len = ((samples.len() as f64) / ratio).floor().max(1.0) as usize;
    let mut out = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let pos = i as f64 * ratio;
        let idx = pos.floor() as usize;
        if idx >= samples.len() {
            break;
        }
        let frac = (pos - idx as f64) as f32;
        let a = samples[idx];
        let b = samples.get(idx + 1).copied().unwrap_or(a);
        out.push(a + (b - a) * frac);
    }
    out
}

/// Downmix interleaved multi-channel audio to mono.
pub fn downmix(interleaved: &[f32], channels: u16) -> Vec<f32> {
    if channels <= 1 {
        return interleaved.to_vec();
    }
    let ch = channels as usize;
    interleaved
        .chunks_exact(ch)
        .map(|frame| frame.iter().sum::<f32>() / ch as f32)
        .collect()
}

/// Start capturing from the default input device at its native rate.
pub fn start_capture(
    level_bits: Arc<AtomicU32>,
    target: crate::state::TargetInfo,
    delivery: crate::state::Delivery,
) -> Result<CaptureSession, String> {
    let host = cpal::default_host();
    let device = host
        .default_input_device()
        .ok_or_else(|| "no input device available".to_string())?;
    let supported = device.default_input_config().map_err(|e| e.to_string())?;
    let sample_format = supported.sample_format();
    let config: StreamConfig = supported.into();
    let source_rate = config.sample_rate;
    let channels = config.channels;

    let samples: Arc<Mutex<Vec<f32>>> = Arc::new(Mutex::new(Vec::new()));
    let last_loud: Arc<AtomicU64> = Arc::new(AtomicU64::new(0));
    let captured: Arc<AtomicU64> = Arc::new(AtomicU64::new(0));

    let stream = build_typed_stream(
        &device,
        config,
        sample_format,
        samples.clone(),
        level_bits,
        last_loud.clone(),
        captured.clone(),
    )?;
    stream.play().map_err(|e| e.to_string())?;

    Ok(CaptureSession {
        _stream: Some(stream),
        samples,
        source_rate,
        channels,
        started: std::time::Instant::now(),
        last_loud,
        captured,
        target,
        delivery,
    })
}

fn build_typed_stream(
    device: &cpal::Device,
    config: StreamConfig,
    sample_format: SampleFormat,
    samples: Arc<Mutex<Vec<f32>>>,
    level_bits: Arc<AtomicU32>,
    last_loud: Arc<AtomicU64>,
    captured: Arc<AtomicU64>,
) -> Result<Stream, String> {
    let channels = config.channels as usize;
    macro_rules! for_format {
        ($t:ty) => {{
            let samples = samples.clone();
            let last_loud = last_loud.clone();
            let captured = captured.clone();
            device
                .build_input_stream::<$t, _, _>(
                    config,
                    move |data: &[$t], _: &cpal::InputCallbackInfo| {
                        let mut peak = 0f32;
                        let mut acc = 0f64;
                        let mut n = 0u64;
                        {
                            let mut buf = samples.lock().unwrap();
                            for frame in data.chunks_exact(channels) {
                                let mut sum = 0f32;
                                for &s in frame {
                                    sum += s.to_f32_sample();
                                }
                                let mono = sum / channels as f32;
                                buf.push(mono);
                                let a = mono.abs();
                                if a > peak {
                                    peak = a;
                                }
                                acc += (mono * mono) as f64;
                                n += 1;
                            }
                        }
                        let total = captured.fetch_add(n, Ordering::Relaxed) + n;
                        if peak > crate::audio::SPEECH_THRESHOLD {
                            last_loud.store(total, Ordering::Relaxed);
                        }
                        // Smoothed level for the overlay meter.
                        let rms = if n > 0 {
                            (acc / n as f64).sqrt() as f32
                        } else {
                            0.0
                        };
                        let prev = f32::from_bits(level_bits.load(Ordering::Relaxed));
                        let smoothed = prev * 0.7 + rms * 0.3;
                        level_bits.store(smoothed.to_bits(), Ordering::Relaxed);
                    },
                    |err| eprintln!("audio stream error: {err}"),
                    None,
                )
                .map_err(|e| e.to_string())
        }};
    }

    match sample_format {
        SampleFormat::F32 => for_format!(f32),
        SampleFormat::I16 => for_format!(i16),
        SampleFormat::U16 => for_format!(u16),
        SampleFormat::I32 => for_format!(i32),
        SampleFormat::U8 => for_format!(u8),
        other => Err(format!("unsupported input sample format: {other:?}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resample_48k_to_16k_halves_third_length() {
        // One second of 48 kHz audio → ~16 000 samples.
        let input = (0..48_000)
            .map(|i| (i as f32 / 100.0).sin())
            .collect::<Vec<_>>();
        let out = resample_to_16k(&input, 48_000);
        assert!((out.len() as i64 - 16_000).abs() <= 2, "got {}", out.len());
    }

    #[test]
    fn resample_constant_signal_stays_constant() {
        let input = vec![0.5f32; 9_600];
        let out = resample_to_16k(&input, 48_000);
        assert_eq!(out.len(), 3_200);
        assert!(out.iter().all(|&v| (v - 0.5).abs() < 1e-6));
    }

    #[test]
    fn resample_is_identity_at_16k() {
        let input = vec![0.1, -0.2, 0.3];
        assert_eq!(resample_to_16k(&input, 16_000), input);
    }

    #[test]
    fn resample_empty_input() {
        assert!(resample_to_16k(&[], 48_000).is_empty());
    }

    #[test]
    fn downmix_averages_channels() {
        let stereo = vec![1.0, -1.0, 0.5, 0.5];
        let mono = downmix(&stereo, 2);
        assert_eq!(mono.len(), 2);
        assert_eq!(mono[0], 0.0);
        assert_eq!(mono[1], 0.5);
        // Mono passthrough.
        assert_eq!(downmix(&[0.3], 1), vec![0.3]);
    }

    #[test]
    fn auto_stop_never_fires_before_min() {
        assert!(!should_auto_stop(100, 0, false, 1_500, 600, 30_000));
        // Even with max exceeded? No: max still wins.
        assert!(should_auto_stop(30_001, 0, false, 1_500, 600, 30_000));
    }

    #[test]
    fn auto_stop_waits_for_speech_then_silence() {
        // Speech started, still talking → keep going.
        assert!(!should_auto_stop(1_000, 200, true, 1_500, 600, 30_000));
        // Speech ended long enough → stop.
        assert!(should_auto_stop(4_000, 1_600, true, 1_500, 600, 30_000));
        // Just short of the silence window → keep going.
        assert!(!should_auto_stop(4_000, 1_499, true, 1_500, 600, 30_000));
    }

    #[test]
    fn auto_stop_keeps_waiting_when_no_speech_yet() {
        assert!(!should_auto_stop(2_000, 2_000, false, 1_500, 600, 30_000));
        // Hard deadline still applies.
        assert!(should_auto_stop(30_000, 30_000, false, 1_500, 600, 30_000));
    }
}
