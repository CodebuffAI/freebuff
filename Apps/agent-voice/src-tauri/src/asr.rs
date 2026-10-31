//! whisper.cpp engine: model catalog, lazy loading, transcription.

use crate::paths;
use std::path::Path;
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

/// A downloadable local model.
pub struct ModelDef {
    pub id: &'static str,
    pub name: &'static str,
    pub file: &'static str,
    pub url: &'static str,
    /// Approximate size for display; real progress uses Content-Length.
    pub size_bytes: u64,
    /// `"free"` or `"pro"`.
    pub tier: &'static str,
}

pub const MODELS: &[ModelDef] = &[
    ModelDef {
        id: "base",
        name: "Whisper Base",
        file: "ggml-base.bin",
        url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin",
        size_bytes: 142_000_000,
        tier: "free",
    },
    ModelDef {
        id: "small",
        name: "Whisper Small",
        file: "ggml-small.bin",
        url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin",
        size_bytes: 466_000_000,
        tier: "free",
    },
    ModelDef {
        id: "turbo",
        name: "Whisper Large V3 Turbo",
        file: "ggml-large-v3-turbo.bin",
        url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin",
        size_bytes: 1_620_000_000,
        tier: "pro",
    },
];

pub fn model(id: &str) -> Option<&'static ModelDef> {
    MODELS.iter().find(|m| m.id == id)
}

#[derive(Debug, thiserror::Error)]
pub enum AsrError {
    #[error("unknown model '{0}'")]
    UnknownModel(String),
    #[error("model '{0}' is not downloaded yet")]
    ModelMissing(String),
    #[error("failed to load model: {0}")]
    Load(String),
    #[error("transcription failed: {0}")]
    Transcribe(String),
}

/// Lazily-loaded whisper context. Keeps at most one model resident so the
/// large Pro model never coexists with a free model in RAM.
#[derive(Default)]
pub struct AsrEngine {
    loaded: Option<(String, WhisperContext)>,
}

impl AsrEngine {
    pub fn loaded_model(&self) -> Option<&str> {
        self.loaded.as_ref().map(|(id, _)| id.as_str())
    }

    pub fn transcribe(
        &mut self,
        model_id: &str,
        audio_16k: &[f32],
        language: Option<&str>,
    ) -> Result<String, AsrError> {
        let def = model(model_id).ok_or_else(|| AsrError::UnknownModel(model_id.to_string()))?;
        let path = paths::models_dir().join(def.file);
        if !path.exists() {
            return Err(AsrError::ModelMissing(model_id.to_string()));
        }
        let needs_load = self
            .loaded
            .as_ref()
            .map(|(id, _)| id != model_id)
            .unwrap_or(true);
        if needs_load {
            let ctx = WhisperContext::new_with_params(
                path.to_string_lossy().as_ref(),
                WhisperContextParameters::default(),
            )
            .map_err(|e| AsrError::Load(e.to_string()))?;
            self.loaded = Some((model_id.to_string(), ctx));
        }
        if audio_16k.is_empty() {
            return Ok(String::new());
        }
        let (_, ctx) = self.loaded.as_ref().expect("context loaded above");
        let mut state = ctx
            .create_state()
            .map_err(|e| AsrError::Load(e.to_string()))?;
        let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
        // `None` → auto-detect; otherwise pin to the configured language.
        params.set_language(language);
        params.set_no_timestamps(true);
        params.set_print_progress(false);
        params.set_print_special(false);
        params.set_print_realtime(false);
        params.set_translate(false);
        state
            .full(params, audio_16k)
            .map_err(|e| AsrError::Transcribe(e.to_string()))?;
        let n_segments = state.full_n_segments();
        let mut out = String::new();
        for i in 0..n_segments {
            if let Some(segment) = state.get_segment(i) {
                out.push_str(segment.to_str().unwrap_or_default());
            }
        }
        Ok(out.trim().to_string())
    }
}

/// GGML/whisper model files start with the four ASCII bytes `ggml`.
pub const GGML_MAGIC: [u8; 4] = *b"ggml";

/// Minimum plausible model size; anything smaller is a truncated download.
const MIN_MODEL_BYTES: u64 = 1_000_000;

/// Does a path look like a usable downloaded model?
pub fn model_file_ok(path: &Path) -> bool {
    use std::io::{Read, Seek};
    let Ok(mut f) = std::fs::File::open(path) else {
        return false;
    };
    let len = f.seek(std::io::SeekFrom::End(0)).unwrap_or(0);
    if len < MIN_MODEL_BYTES {
        return false;
    }
    if f.seek(std::io::SeekFrom::Start(0)).is_err() {
        return false;
    }
    let mut magic = [0u8; 4];
    f.read_exact(&mut magic).is_ok() && magic == GGML_MAGIC
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_has_expected_shape() {
        assert_eq!(MODELS.len(), 3);
        let base = model("base").unwrap();
        assert_eq!(base.tier, "free");
        assert_eq!(base.file, "ggml-base.bin");
        let turbo = model("turbo").unwrap();
        assert_eq!(turbo.tier, "pro");
        assert!(model("gpt-4o").is_none());
    }

    #[test]
    fn magic_check() {
        assert_eq!(GGML_MAGIC, *b"ggml");
    }

    #[test]
    fn model_file_ok_rejects_missing_and_tiny_files() {
        let dir = std::env::temp_dir().join(format!("av-model-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let missing = dir.join("nope.bin");
        assert!(!model_file_ok(&missing));
        // Tiny file with correct magic is still rejected (size guard).
        let tiny = dir.join("tiny.bin");
        std::fs::write(&tiny, b"ggml").unwrap();
        assert!(!model_file_ok(&tiny));
        // Large-enough file with magic passes.
        let ok = dir.join("ok.bin");
        let mut bytes = b"ggml".to_vec();
        bytes.extend(std::iter::repeat_n(0u8, 1_000_001));
        std::fs::write(&ok, &bytes).unwrap();
        assert!(model_file_ok(&ok));
        std::fs::remove_dir_all(&dir).ok();
    }
}
