//! Tauri commands — the only surface the webview can reach.

use crate::license::{self, LicenseError};
use crate::state::{AppState, EntitlementFile, Settings};
use crate::{asr, hotkey, models};
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(serde::Serialize)]
pub struct UsageView {
    pub used_seconds: u32,
    pub limit_seconds: Option<u32>,
    pub day: String,
}

#[derive(serde::Serialize)]
pub struct ModelView {
    pub id: String,
    pub name: String,
    pub size_bytes: u64,
    pub tier: String,
    pub downloaded: bool,
    pub progress: Option<f32>,
}

#[derive(serde::Serialize)]
pub struct EntitlementView {
    pub tier: String,
    pub activated: bool,
    /// Masked for casual display: `txn_01m4…038q`.
    pub code_masked: Option<String>,
    /// The full license code, so the customer can move the license to another
    /// machine without digging out the receipt.
    pub license_code: Option<String>,
    pub expires_at: Option<u64>,
}

#[derive(serde::Serialize)]
pub struct StateView {
    pub settings: Settings,
    pub entitlement: EntitlementView,
    pub usage: UsageView,
    pub device_id: String,
    pub models: Vec<ModelView>,
    pub bridge_port: u16,
}

/// Mask a license code for display: `txn_01m4…038q`.
pub fn mask_code(code: &str) -> Option<String> {
    let code = code.trim();
    if code.is_empty() {
        return None;
    }
    if code.len() <= 8 {
        return Some("*".repeat(code.len()));
    }
    Some(format!("{}…{}", &code[..8], &code[code.len() - 4..]))
}

pub fn snapshot(state: &AppState) -> StateView {
    let settings = state.settings.read().unwrap().clone();
    let ent = state.entitlement.read().unwrap().clone();
    let tier = ent.tier().to_string();
    let limit = crate::usage::daily_limit_seconds(&tier);
    let usage = {
        let mut u = state.usage.lock().unwrap();
        u.roll(crate::state::now_unix());
        UsageView {
            used_seconds: u.used_seconds,
            limit_seconds: limit,
            day: u.day.clone(),
        }
    };
    let downloads = state.downloads.lock().unwrap().clone();
    let models = asr::MODELS
        .iter()
        .map(|m| {
            let path = crate::paths::models_dir().join(m.file);
            ModelView {
                id: m.id.to_string(),
                name: m.name.to_string(),
                size_bytes: m.size_bytes,
                tier: m.tier.to_string(),
                downloaded: asr::model_file_ok(&path),
                progress: downloads.get(m.id).copied(),
            }
        })
        .collect();
    StateView {
        settings,
        entitlement: EntitlementView {
            tier,
            activated: !ent.token.is_empty(),
            code_masked: mask_code(&ent.license_code),
            license_code: Some(ent.license_code.clone()).filter(|c| !c.trim().is_empty()),
            expires_at: ent.claims().map(|c| c.exp),
        },
        usage,
        device_id: crate::state::device_id(),
        models,
        bridge_port: state.bridge_port.load(std::sync::atomic::Ordering::SeqCst),
    }
}

#[tauri::command]
pub fn get_state(state: State<'_, AppState>) -> StateView {
    snapshot(&state)
}

/// Validate + persist settings. The hotkey is registered *before* the old
/// one is dropped, so an invalid combo leaves the previous hotkey working.
#[tauri::command]
pub fn save_settings(
    app: AppHandle,
    state: State<'_, AppState>,
    settings: Settings,
) -> Result<StateView, String> {
    let old_hotkey = state.settings.read().unwrap().hotkey.clone();
    hotkey::re_register(&app, &old_hotkey, &settings.hotkey)?;
    *state.settings.write().unwrap() = settings;
    state.persist_settings()?;
    Ok(snapshot(&state))
}

fn license_error(e: LicenseError) -> String {
    e.to_string()
}

#[tauri::command]
pub async fn activate_license(
    state: State<'_, AppState>,
    license_code: String,
) -> Result<StateView, String> {
    let worker = state.settings.read().unwrap().worker_url().to_string();
    let device = crate::state::device_id();
    let token = license::activate(&worker, &license_code, &device)
        .await
        .map_err(license_error)?;
    {
        let mut ent = state.entitlement.write().unwrap();
        *ent = EntitlementFile {
            token,
            license_code: license_code.trim().to_string(),
            device_id: device,
            activated_at: crate::state::now_unix() as u64,
        };
    }
    state.persist_entitlement()?;
    Ok(snapshot(&state))
}

/// Refresh the cached token against the worker. Offline failures keep the
/// cached entitlement; a revoked license (refund) clears it.
#[tauri::command]
pub async fn revalidate_license(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<StateView, String> {
    revalidate_inner(&app, &state).await;
    Ok(snapshot(&state))
}

pub async fn revalidate_inner(app: &AppHandle, state: &AppState) {
    let (worker, code, device) = {
        let ent = state.entitlement.read().unwrap();
        if ent.token.is_empty() || ent.license_code.is_empty() {
            return;
        }
        (
            state.settings.read().unwrap().worker_url().to_string(),
            ent.license_code.clone(),
            ent.device_id.clone(),
        )
    };
    match license::activate(&worker, &code, &device).await {
        Ok(token) => {
            let mut ent = state.entitlement.write().unwrap();
            if ent.token != token {
                ent.token = token;
                drop(ent);
                let _ = state.persist_entitlement();
            }
        }
        Err(LicenseError::Revoked) | Err(LicenseError::Rejected(_)) => {
            let had_token = !state.entitlement.read().unwrap().token.is_empty();
            if had_token {
                *state.entitlement.write().unwrap() = EntitlementFile::default();
                let _ = state.persist_entitlement();
                let _ = app.emit(
                    "dictation",
                    serde_json::json!({"phase": "error", "error": "license no longer active"}),
                );
            }
        }
        Err(LicenseError::InvalidToken) => {
            // Do not silently trust a bad refresh — drop to free.
            *state.entitlement.write().unwrap() = EntitlementFile::default();
            let _ = state.persist_entitlement();
        }
        Err(_) => {
            // Offline / rate-limited: keep the cached (locally verified) token.
        }
    }
}

#[tauri::command]
pub async fn deactivate_license(state: State<'_, AppState>) -> Result<StateView, String> {
    let (worker, code, device, had_token) = {
        let ent = state.entitlement.read().unwrap();
        (
            state.settings.read().unwrap().worker_url().to_string(),
            ent.license_code.clone(),
            ent.device_id.clone(),
            !ent.token.is_empty(),
        )
    };
    if had_token {
        // Clear locally even if the server call fails — deactivating is a
        // user decision, and the worker keeps its own device bookkeeping.
        if let Err(e) = license::deactivate(&worker, &code, &device).await {
            eprintln!("deactivate: server call failed ({e}); clearing local state anyway");
        }
        *state.entitlement.write().unwrap() = EntitlementFile::default();
        state.persist_entitlement()?;
    }
    Ok(snapshot(&state))
}

#[tauri::command]
pub async fn download_model(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    let def = asr::model(&id).ok_or_else(|| format!("unknown model '{id}'"))?;
    let tier = state.entitlement.read().unwrap().tier().to_string();
    if def.tier == "pro" && tier != "pro" {
        return Err("Large models are a Pro feature — upgrade to download them".into());
    }
    {
        let mut downloads = state.downloads.lock().unwrap();
        if downloads.contains_key(&id) {
            return Err("already downloading".into());
        }
        downloads.insert(id.clone(), 0.0);
    }
    let spawn_app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(err) = models::download(spawn_app.clone(), id.clone()).await {
            let state = spawn_app.state::<AppState>();
            {
                let mut downloads = state.downloads.lock().unwrap();
                downloads.remove(&id);
            }
            let _ = spawn_app.emit(
                "model-progress",
                serde_json::json!({"id": id, "progress": 0.0, "done": false, "error": err}),
            );
        }
    });
    Ok(())
}

#[tauri::command]
pub fn delete_model(state: State<'_, AppState>, id: String) -> Result<StateView, String> {
    let def = asr::model(&id).ok_or_else(|| format!("unknown model '{id}'"))?;
    let path = crate::paths::models_dir().join(def.file);
    // Never delete the resident model out from under whisper.
    let asr = state.asr.lock().unwrap();
    if asr.loaded_model() == Some(def.id) {
        return Err("model is in use — select a different model first".into());
    }
    drop(asr);
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(snapshot(&state))
}

#[tauri::command]
pub fn get_audio_level(state: State<'_, AppState>) -> f32 {
    f32::from_bits(state.level_bits.load(std::sync::atomic::Ordering::Relaxed))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mask_code_shapes() {
        assert_eq!(mask_code(""), None);
        assert_eq!(mask_code("   "), None);
        assert_eq!(mask_code("short").as_deref(), Some("*****"));
        assert_eq!(
            mask_code("txn_01m45q62gzqns1n98dwp38038q").as_deref(),
            Some("txn_01m4…038q")
        );
    }
}
