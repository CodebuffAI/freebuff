//! Persisted settings, entitlement file, and the managed application state.

use crate::entitlement::{self, Claims};
use crate::paths;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU16, AtomicU32};
use std::sync::{Arc, Mutex, RwLock};

/// Unix seconds, shared by usage/entitlement logic.
pub fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Default worker base URL; override at build time with
/// `AGENT_VOICE_WORKER_URL` or at runtime via settings (`worker_url`).
pub const DEFAULT_WORKER_URL: &str = match option_env!("AGENT_VOICE_WORKER_URL") {
    Some(url) => url,
    None => "https://agent-voice.example.workers.dev",
};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ProviderKind {
    OpenAi,
    Anthropic,
    OpenAiCompatible,
}

/// Bring-your-own-key (or local Ollama) LLM used for Pro mode cleanup.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderCfg {
    pub kind: ProviderKind,
    pub base_url: String,
    pub api_key: String,
    pub model: String,
}

/// A dictation mode: a prompt template applied to the transcript.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Mode {
    pub id: String,
    pub name: String,
    /// Instructions sent to the LLM alongside the raw transcript.
    pub prompt: String,
    /// When set (and no explicit mode is selected), the mode activates if the
    /// focused window title contains this substring (case-insensitive).
    #[serde(default)]
    pub app_match: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Settings {
    /// Global push-to-talk accelerator, e.g. `CommandOrControl+Shift+Space`.
    pub hotkey: String,
    /// `None` → auto-detect language.
    #[serde(default)]
    pub language: Option<String>,
    /// Selected model id (`base` | `small` | `turbo`).
    pub selected_model: String,
    /// Explicitly selected mode id; `None` falls back to app-match / raw.
    #[serde(default)]
    pub mode_id: Option<String>,
    #[serde(default)]
    pub provider: Option<ProviderCfg>,
    #[serde(default)]
    pub modes: Vec<Mode>,
    #[serde(default)]
    pub snippets: Vec<crate::text::Snippet>,
    #[serde(default)]
    pub vocabulary: Vec<crate::text::VocabEntry>,
    /// License server base URL (defaults to `DEFAULT_WORKER_URL`).
    #[serde(default)]
    pub worker_url: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            hotkey: "CommandOrControl+Shift+Space".to_string(),
            language: None,
            selected_model: "base".to_string(),
            mode_id: None,
            provider: None,
            modes: Vec::new(),
            snippets: Vec::new(),
            vocabulary: Vec::new(),
            worker_url: String::new(),
        }
    }
}

impl Settings {
    pub fn worker_url(&self) -> &str {
        if self.worker_url.is_empty() {
            DEFAULT_WORKER_URL
        } else {
            &self.worker_url
        }
    }
}

/// Locally persisted activation state. The token itself carries the tier; the
/// raw license key is kept so the user can deactivate the device.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct EntitlementFile {
    #[serde(default)]
    pub token: String,
    #[serde(default)]
    pub license_key: String,
    #[serde(default)]
    pub device_id: String,
    #[serde(default)]
    pub activated_at: u64,
}

impl EntitlementFile {
    /// Cryptographically verified tier — never trusts serialized `tier` fields.
    pub fn tier(&self) -> &'static str {
        if self.token.is_empty() {
            return "free";
        }
        match entitlement::verify(&self.token, now_unix() as u64, None) {
            Ok(claims) if entitlement::is_pro(&claims) => "pro",
            _ => "free",
        }
    }

    pub fn claims(&self) -> Option<Claims> {
        entitlement::verify(&self.token, now_unix() as u64, None).ok()
    }
}

fn load_json<T: Default + for<'de> Deserialize<'de>>(path: &std::path::Path) -> T {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn save_json<T: Serialize>(path: &std::path::Path, value: &T) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let raw = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    std::fs::write(path, raw).map_err(|e| e.to_string())
}

/// Persistent, machine-unique device id used for license activation limits.
pub fn device_id() -> String {
    let path = paths::device_id_path();
    if let Ok(id) = std::fs::read_to_string(&path) {
        let id = id.trim().to_string();
        if !id.is_empty() {
            return id;
        }
    }
    let id = uuid::Uuid::new_v4().to_string();
    let _ = std::fs::create_dir_all(paths::home());
    let _ = std::fs::write(&path, &id);
    id
}

/// The window that was focused when push-to-talk started.
#[derive(Debug, Clone, Default)]
pub struct TargetInfo {
    pub hwnd: isize,
    pub title: String,
}

/// Where a completed utterance should go.
#[derive(Clone, Debug)]
pub enum Delivery {
    /// Paste into the previously focused window.
    Paste,
    /// Reply to a pending MCP `ask_user_by_voice` call instead.
    Ask,
}

/// Managed application state shared by commands, hotkeys, and the bridge.
pub struct AppState {
    pub settings: RwLock<Settings>,
    pub usage: Mutex<crate::usage::Usage>,
    pub entitlement: RwLock<EntitlementFile>,
    /// Active capture session (push-to-talk or MCP ask).
    pub capture: Mutex<Option<crate::audio::CaptureSession>>,
    pub asr: Mutex<crate::asr::AsrEngine>,
    /// Prompt shown in the overlay for MCP asks.
    pub ask_prompt: Mutex<Option<String>>,
    /// Sender resolving a pending MCP ask with its transcript.
    pub ask_tx: Mutex<Option<std::sync::mpsc::Sender<Result<String, String>>>>,
    /// Latest mic level (f32 bits) for the overlay meter.
    pub level_bits: Arc<AtomicU32>,
    /// Loopback port for the MCP companion (`bridge.json`).
    pub bridge_port: AtomicU16,
    /// In-flight model downloads: id → 0..1 progress.
    pub downloads: Mutex<HashMap<String, f32>>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            settings: RwLock::new(Settings::default()),
            usage: Mutex::new(crate::usage::Usage::default()),
            entitlement: RwLock::new(EntitlementFile::default()),
            capture: Mutex::new(None),
            asr: Mutex::new(crate::asr::AsrEngine::default()),
            ask_prompt: Mutex::new(None),
            ask_tx: Mutex::new(None),
            level_bits: Arc::new(AtomicU32::new(0f32.to_bits())),
            bridge_port: AtomicU16::new(0),
            downloads: Mutex::new(HashMap::new()),
        }
    }

    /// Load persisted settings/usage/entitlement from disk (best effort).
    pub fn load_from_disk(&self) {
        if let Ok(s) = std::fs::read_to_string(paths::settings_path()) {
            if let Ok(settings) = serde_json::from_str::<Settings>(&s) {
                *self.settings.write().unwrap() = settings;
            }
        }
        let mut usage: crate::usage::Usage = load_json(&paths::usage_path());
        usage.roll(now_unix());
        *self.usage.lock().unwrap() = usage;
        let ent: EntitlementFile = load_json(&paths::entitlement_path());
        *self.entitlement.write().unwrap() = ent;
    }

    pub fn persist_settings(&self) -> Result<(), String> {
        save_json(&paths::settings_path(), &*self.settings.read().unwrap())
    }

    pub fn persist_usage(&self) -> Result<(), String> {
        save_json(&paths::usage_path(), &*self.usage.lock().unwrap())
    }

    pub fn persist_entitlement(&self) -> Result<(), String> {
        save_json(
            &paths::entitlement_path(),
            &*self.entitlement.read().unwrap(),
        )
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_settings_have_stable_hotkey() {
        let s = Settings::default();
        assert_eq!(s.hotkey, "CommandOrControl+Shift+Space");
        assert_eq!(s.selected_model, "base");
        assert!(s.modes.is_empty());
    }

    #[test]
    fn worker_url_falls_back_to_default() {
        let mut s = Settings::default();
        assert_eq!(s.worker_url(), DEFAULT_WORKER_URL);
        s.worker_url = "https://custom.example.workers.dev".into();
        assert_eq!(s.worker_url(), "https://custom.example.workers.dev");
    }

    #[test]
    fn empty_entitlement_is_free() {
        assert_eq!(EntitlementFile::default().tier(), "free");
    }

    #[test]
    fn garbage_token_is_free_not_panic() {
        let ent = EntitlementFile {
            token: "not-a-token".into(),
            ..Default::default()
        };
        assert_eq!(ent.tier(), "free");
        assert!(ent.claims().is_none());
    }

    #[test]
    fn settings_roundtrip_through_json() {
        let s = Settings::default();
        let raw = serde_json::to_string(&s).unwrap();
        let back: Settings = serde_json::from_str(&raw).unwrap();
        assert_eq!(back.hotkey, s.hotkey);
        assert_eq!(back.worker_url, s.worker_url);
    }

    #[test]
    fn expired_or_wrong_sig_token_reads_as_free() {
        // A structurally valid but unsigned token must not grant Pro.
        let ent = EntitlementFile {
            token: "eyJ2IjoxfQ.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".into(),
            ..Default::default()
        };
        assert_eq!(ent.tier(), "free");
    }
}
