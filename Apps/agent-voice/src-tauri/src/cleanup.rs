//! Pro-tier AI cleanup: mode resolution and BYOK/Ollama rewrite calls.

use crate::state::{Mode, ProviderCfg, ProviderKind};
use serde_json::{json, Value};

/// Resolve which mode applies: an explicit selection wins; otherwise the
/// first mode whose `app_match` substring appears in the window title.
pub fn resolve_mode<'a>(
    modes: &'a [Mode],
    explicit: Option<&str>,
    window_title: &str,
) -> Option<&'a Mode> {
    if let Some(id) = explicit {
        return modes.iter().find(|m| m.id == id);
    }
    let title_lower = window_title.to_lowercase();
    modes.iter().find(|m| match &m.app_match {
        Some(pattern) if !pattern.is_empty() => title_lower.contains(&pattern.to_lowercase()),
        _ => false,
    })
}

/// OpenAI-compatible `/chat/completions` request body.
pub fn openai_body(model: &str, system: &str, user: &str) -> Value {
    json!({
        "model": model,
        "temperature": 0,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ]
    })
}

/// Anthropic `/v1/messages` request body.
pub fn anthropic_body(model: &str, system: &str, user: &str) -> Value {
    json!({
        "model": model,
        "max_tokens": 2048,
        "temperature": 0,
        "system": system,
        "messages": [{"role": "user", "content": user}]
    })
}

/// Endpoint for a provider config. OpenAI-compatible bases are expected to
/// include the version prefix (e.g. `https://api.openai.com/v1` or an Ollama
/// `http://localhost:11434/v1`).
pub fn endpoint_for(kind: &ProviderKind, base_url: &str) -> String {
    let base = base_url.trim_end_matches('/');
    match kind {
        ProviderKind::Anthropic => format!("{base}/v1/messages"),
        ProviderKind::OpenAi | ProviderKind::OpenAiCompatible => {
            format!("{base}/chat/completions")
        }
    }
}

/// Pull the assistant text out of a provider response.
pub fn extract_text(kind: &ProviderKind, body: &Value) -> Option<String> {
    match kind {
        ProviderKind::Anthropic => body["content"][0]["text"].as_str().map(|s| s.to_string()),
        ProviderKind::OpenAi | ProviderKind::OpenAiCompatible => body["choices"][0]["message"]
            ["content"]
            .as_str()
            .map(|s| s.to_string()),
    }
    .filter(|s| !s.trim().is_empty())
}

#[derive(Debug, thiserror::Error)]
pub enum CleanupError {
    #[error("cleanup request failed: {0}")]
    Http(String),
    #[error("provider returned an error: {0}")]
    Provider(String),
    #[error("provider response had no text")]
    Empty,
}

/// Rewrite `text` with the user's configured provider. Falls back to the
/// raw transcript on any failure (caller decides; this returns the error).
pub async fn cleanup(
    cfg: &ProviderCfg,
    system_prompt: &str,
    text: &str,
) -> Result<String, CleanupError> {
    let endpoint = endpoint_for(&cfg.kind, &cfg.base_url);
    let body = match cfg.kind {
        ProviderKind::Anthropic => anthropic_body(&cfg.model, system_prompt, text),
        _ => openai_body(&cfg.model, system_prompt, text),
    };
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| CleanupError::Http(e.to_string()))?;
    let req = client
        .post(&endpoint)
        .timeout(std::time::Duration::from_secs(60))
        .json(&body);
    let req = match cfg.kind {
        ProviderKind::Anthropic => req
            .header("x-api-key", &cfg.api_key)
            .header("anthropic-version", "2023-06-01"),
        _ => req.header(
            reqwest::header::AUTHORIZATION,
            format!("Bearer {}", cfg.api_key),
        ),
    };
    let resp = req
        .send()
        .await
        .map_err(|e| CleanupError::Http(e.to_string()))?;
    let status = resp.status();
    let payload: Value = resp
        .json()
        .await
        .map_err(|e| CleanupError::Http(e.to_string()))?;
    if !status.is_success() {
        let msg = payload["error"]["message"]
            .as_str()
            .or_else(|| payload["message"].as_str())
            .unwrap_or("unknown error");
        return Err(CleanupError::Provider(format!("{status}: {msg}")));
    }
    extract_text(&cfg.kind, &payload).ok_or(CleanupError::Empty)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::Mode;

    fn mode(id: &str, app_match: Option<&str>) -> Mode {
        Mode {
            id: id.into(),
            name: id.into(),
            prompt: format!("prompt for {id}"),
            app_match: app_match.map(|s| s.to_string()),
        }
    }

    #[test]
    fn explicit_mode_wins_over_app_match() {
        let modes = vec![
            mode("commit", Some("terminal")),
            mode("slack", Some("slack")),
        ];
        let resolved = resolve_mode(&modes, Some("slack"), "Windows Terminal").unwrap();
        assert_eq!(resolved.id, "slack");
    }

    #[test]
    fn app_match_falls_back_case_insensitively() {
        let modes = vec![
            mode("commit", Some("TERMINAL")),
            mode("slack", Some("slack")),
        ];
        let resolved = resolve_mode(&modes, None, "Cargo — Windows Terminal").unwrap();
        assert_eq!(resolved.id, "commit");
        // No match → no mode (raw output).
        assert!(resolve_mode(&modes, None, "Notepad").is_none());
        // Explicit id that does not exist → None, not a panic.
        assert!(resolve_mode(&modes, Some("nope"), "x").is_none());
    }

    #[test]
    fn empty_app_match_never_matches() {
        let modes = vec![mode("m", Some(""))];
        assert!(resolve_mode(&modes, None, "anything").is_none());
    }

    #[test]
    fn endpoints_are_joined_without_double_slash() {
        assert_eq!(
            endpoint_for(&ProviderKind::OpenAi, "https://api.openai.com/v1/"),
            "https://api.openai.com/v1/chat/completions"
        );
        assert_eq!(
            endpoint_for(&ProviderKind::OpenAiCompatible, "http://localhost:11434/v1"),
            "http://localhost:11434/v1/chat/completions"
        );
        assert_eq!(
            endpoint_for(&ProviderKind::Anthropic, "https://api.anthropic.com"),
            "https://api.anthropic.com/v1/messages"
        );
    }

    #[test]
    fn openai_body_shape() {
        let body = openai_body("gpt-4o-mini", "sys", "user text");
        assert_eq!(body["model"], "gpt-4o-mini");
        assert_eq!(body["temperature"], 0);
        assert_eq!(body["messages"][0]["role"], "system");
        assert_eq!(body["messages"][1]["content"], "user text");
    }

    #[test]
    fn anthropic_body_shape() {
        let body = anthropic_body("claude-sonnet-4-5", "sys", "user text");
        assert_eq!(body["system"], "sys");
        assert_eq!(body["messages"][0]["content"], "user text");
        assert!(body["max_tokens"].is_number());
    }

    #[test]
    fn extract_text_from_both_providers() {
        let openai = json!({"choices": [{"message": {"content": "cleaned"}}]});
        assert_eq!(
            extract_text(&ProviderKind::OpenAi, &openai).as_deref(),
            Some("cleaned")
        );
        let anthropic = json!({"content": [{"type": "text", "text": "cleaned"}]});
        assert_eq!(
            extract_text(&ProviderKind::Anthropic, &anthropic).as_deref(),
            Some("cleaned")
        );
        // Empty content is treated as missing.
        let empty = json!({"choices": [{"message": {"content": "  "}}]});
        assert!(extract_text(&ProviderKind::OpenAi, &empty).is_none());
        let error_shape = json!({"error": {"message": "boom"}});
        assert!(extract_text(&ProviderKind::OpenAi, &error_shape).is_none());
    }
}
