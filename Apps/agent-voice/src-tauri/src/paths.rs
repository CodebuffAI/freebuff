//! Deterministic app-data paths shared by the GUI and the `agent-voice mcp` CLI.
//!
//! The MCP server may run without Tauri's `AppHandle`, so we resolve the same
//! directory Tauri would use (`data_dir/<identifier>`) ourselves. The
//! `AGENT_VOICE_HOME` environment variable overrides everything, which keeps
//! tests hermetic.

use std::path::PathBuf;

pub const IDENTIFIER: &str = "com.agentvoice.app";

/// Root directory for all persisted state (settings, usage, entitlement, models).
pub fn home() -> PathBuf {
    if let Ok(dir) = std::env::var("AGENT_VOICE_HOME") {
        if !dir.is_empty() {
            return PathBuf::from(dir);
        }
    }
    let base = dirs::data_dir().unwrap_or_else(|| PathBuf::from("."));
    base.join(IDENTIFIER)
}

pub fn ensure_home() -> std::io::Result<()> {
    std::fs::create_dir_all(home())
}

pub fn models_dir() -> PathBuf {
    home().join("models")
}

pub fn settings_path() -> PathBuf {
    home().join("settings.json")
}

pub fn usage_path() -> PathBuf {
    home().join("usage.json")
}

pub fn entitlement_path() -> PathBuf {
    home().join("entitlement.json")
}

pub fn device_id_path() -> PathBuf {
    home().join("device_id")
}

pub fn bridge_path() -> PathBuf {
    home().join("bridge.json")
}
