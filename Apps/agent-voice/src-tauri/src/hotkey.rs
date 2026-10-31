//! Push-to-talk orchestration: hotkey registration, overlay lifecycle, and
//! the capture → transcribe → (cleanup) → deliver pipeline.

use crate::state::{AppState, Delivery, TargetInfo};
use std::sync::mpsc;
use tauri::{Emitter, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutEvent, ShortcutState};

/// The silence window that ends an MCP ask after speech has stopped.
const ASK_SILENCE_MS: u64 = 1_500;
/// Minimum recording length before an MCP ask may auto-stop.
const ASK_MIN_MS: u64 = 600;

#[derive(Clone, serde::Serialize)]
struct DictationPayload {
    phase: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    prompt: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    used_seconds: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    remaining_seconds: Option<u32>,
}

impl DictationPayload {
    fn phase(phase: &str) -> Self {
        Self {
            phase: phase.to_string(),
            text: None,
            error: None,
            prompt: None,
            used_seconds: None,
            remaining_seconds: None,
        }
    }

    fn error(phase: &str, error: impl Into<String>) -> Self {
        Self {
            error: Some(error.into()),
            ..Self::phase(phase)
        }
    }
}

fn emit(app: &tauri::AppHandle, payload: DictationPayload) {
    let _ = app.emit("dictation", payload);
}

// ---------------------------------------------------------------- hotkeys --

/// Validate + register an accelerator. Fails without touching the old one.
pub fn register(app: &tauri::AppHandle, accel: &str) -> Result<(), String> {
    app.global_shortcut()
        .register(accel)
        .map_err(|e| e.to_string())
}

pub fn unregister(app: &tauri::AppHandle, accel: &str) {
    let _ = app.global_shortcut().unregister(accel);
}

/// Swap the hotkey: register the new accelerator first so a bad combo never
/// leaves the user without a working hotkey.
pub fn re_register(app: &tauri::AppHandle, old: &str, new: &str) -> Result<(), String> {
    if old == new {
        return Ok(());
    }
    register(app, new)?;
    unregister(app, old);
    Ok(())
}

pub fn handle_event(app: &tauri::AppHandle, _shortcut: &Shortcut, event: ShortcutEvent) {
    match event.state {
        ShortcutState::Pressed => begin(app),
        ShortcutState::Released => end(app),
    }
}

// --------------------------------------------------------------- overlay ---

fn overlay_window(app: &tauri::AppHandle) -> Option<tauri::WebviewWindow> {
    app.get_webview_window("overlay")
}

fn show_overlay(app: &tauri::AppHandle, prompt: Option<&str>) {
    if let Some(win) = overlay_window(app) {
        if let Ok(Some(monitor)) = win.primary_monitor() {
            let size = monitor.size();
            if let Ok(outer) = win.outer_size() {
                let x = monitor.position().x + (size.width as i32 - outer.width as i32) / 2;
                let y = monitor.position().y + size.height as i32 - outer.height as i32 - 96;
                let _ = win.set_position(tauri::PhysicalPosition::new(x, y));
            }
        }
        let _ = win.show();
    }
    let mut payload = DictationPayload::phase("listening");
    payload.prompt = prompt.map(|p| p.to_string());
    emit(app, payload);
}

fn hide_overlay(app: &tauri::AppHandle) {
    if let Some(win) = overlay_window(app) {
        let _ = win.hide();
    }
}

/// Resolve a pending MCP ask (if any) and clear the prompt.
fn resolve_ask(app: &tauri::AppHandle, result: Result<String, String>) {
    let state = app.state::<AppState>();
    let tx = state.ask_tx.lock().unwrap().take();
    *state.ask_prompt.lock().unwrap() = None;
    if let Some(tx) = tx {
        let _ = tx.send(result);
    }
}

// ------------------------------------------------------------------ begin --

pub fn begin(app: &tauri::AppHandle) {
    let state = app.state::<AppState>();
    if state.capture.lock().unwrap().is_some() {
        return; // already recording
    }

    let tier = state.entitlement.read().unwrap().tier().to_string();
    let limit_opt = crate::usage::daily_limit_seconds(&tier);
    let gate = {
        let mut usage = state.usage.lock().unwrap();
        usage.roll(crate::state::now_unix());
        match limit_opt {
            Some(limit) if !usage.can_start(limit) => Err(usage.remaining(limit)),
            _ => Ok(()),
        }
    };
    if let Err(remaining) = gate {
        emit(
            app,
            DictationPayload {
                remaining_seconds: Some(remaining),
                ..DictationPayload::error("blocked", "daily-limit")
            },
        );
        resolve_ask(
            app,
            Err("daily transcription limit reached — upgrade to Pro".into()),
        );
        return;
    }

    let is_ask = state.ask_tx.lock().unwrap().is_some();
    let delivery = if is_ask {
        Delivery::Ask
    } else {
        Delivery::Paste
    };
    let prompt = state.ask_prompt.lock().unwrap().clone();

    let target = TargetInfo {
        hwnd: crate::focus::foreground_window(),
        title: crate::focus::window_title(crate::focus::foreground_window()),
    };
    let level_bits = state.level_bits.clone();
    match crate::audio::start_capture(level_bits, target, delivery) {
        Ok(session) => {
            *state.capture.lock().unwrap() = Some(session);
            show_overlay(app, prompt.as_deref());
        }
        Err(err) => {
            emit(app, DictationPayload::error("error", err.clone()));
            resolve_ask(app, Err(format!("could not start capture: {err}")));
        }
    }
}

// -------------------------------------------------------------------- end --

pub fn end(app: &tauri::AppHandle) {
    let session = {
        let state = app.state::<AppState>();
        let mut capture = state.capture.lock().unwrap();
        capture.take()
    };
    let Some(session) = session else { return };

    let samples = session.take_samples();
    let source_rate = session.source_rate;
    let channels = session.channels;
    let target = session.target.clone();
    let delivery = session.delivery.clone();

    emit(app, DictationPayload::phase("processing"));
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        run_pipeline(app, samples, source_rate, channels, target, delivery).await;
    });
}

fn fail(app: &tauri::AppHandle, delivery: &Delivery, error: &str) {
    emit(app, DictationPayload::error("error", error));
    if matches!(delivery, Delivery::Ask) {
        resolve_ask(app, Err(error.to_string()));
    }
    hide_overlay(app);
}

#[allow(clippy::too_many_arguments)]
async fn run_pipeline(
    app: tauri::AppHandle,
    samples: Vec<f32>,
    source_rate: u32,
    channels: u16,
    target: TargetInfo,
    delivery: Delivery,
) {
    let state = app.state::<AppState>();
    let (settings, tier) = {
        let settings = state.settings.read().unwrap().clone();
        let tier = state.entitlement.read().unwrap().tier().to_string();
        (settings, tier)
    };

    let mono = crate::audio::downmix(&samples, channels);
    let audio = crate::audio::resample_to_16k(&mono, source_rate);
    let secs = (audio.len() / 16_000) as u32;
    if secs == 0 {
        fail(
            &app,
            &delivery,
            "nothing was recorded — hold the hotkey while speaking",
        );
        return;
    }

    // Transcribe on a blocking thread: whisper monopolizes CPU otherwise.
    let model = settings.selected_model.clone();
    let language = settings.language.clone();
    let transcribe_app = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let st = transcribe_app.state::<AppState>();
        let mut engine = st.asr.lock().unwrap();
        let outcome = engine.transcribe(&model, &audio, language.as_deref());
        drop(engine);
        outcome
    })
    .await;
    let transcript = match result {
        Ok(Ok(t)) => t,
        Ok(Err(e)) => {
            fail(&app, &delivery, &e.to_string());
            return;
        }
        Err(e) => {
            fail(&app, &delivery, &format!("transcription task failed: {e}"));
            return;
        }
    };
    if transcript.trim().is_empty() {
        fail(&app, &delivery, "no speech detected");
        return;
    }

    let mut text = crate::text::postprocess(&transcript, &settings.snippets, &settings.vocabulary);

    // Pro-only AI cleanup: modes need both a Pro tier and a configured
    // provider; the free tier always ships the raw transcript.
    if tier == "pro" {
        if let (Some(provider), Some(mode)) = (
            settings.provider.as_ref(),
            crate::cleanup::resolve_mode(
                &settings.modes,
                settings.mode_id.as_deref(),
                &target.title,
            ),
        ) {
            match crate::cleanup::cleanup(provider, &mode.prompt, &text).await {
                Ok(cleaned) => text = cleaned,
                Err(err) => eprintln!("mode cleanup failed, using raw transcript: {err}"),
            }
        }
    }

    // Usage accounting (free tier only).
    let limit_opt = crate::usage::daily_limit_seconds(&tier);
    let (used, remaining) = {
        let mut usage = state.usage.lock().unwrap();
        usage.roll(crate::state::now_unix());
        if let Some(limit) = limit_opt {
            usage.consume(crate::state::now_unix(), secs, limit);
            let used = usage.used_seconds;
            let remaining = usage.remaining(limit);
            let _ = state.persist_usage();
            (used, Some(remaining))
        } else {
            (usage.used_seconds, None)
        }
    };

    match &delivery {
        Delivery::Paste => {
            let paste_app = app.clone();
            let text_for_paste = text.clone();
            let hwnd = target.hwnd;
            let paste_result = tauri::async_runtime::spawn_blocking(move || {
                crate::paste::paste_text(&paste_app, &text_for_paste, hwnd)
            })
            .await;
            if let Ok(Err(e)) = paste_result {
                // Clipboard still holds the text — tell the user.
                emit(
                    &app,
                    DictationPayload::error(
                        "done",
                        format!("copied to clipboard (paste failed: {e}) — press Ctrl+V"),
                    ),
                );
            }
            emit(
                &app,
                DictationPayload {
                    text: Some(text),
                    used_seconds: Some(used),
                    remaining_seconds: remaining,
                    ..DictationPayload::phase("done")
                },
            );
        }
        Delivery::Ask => {
            resolve_ask(&app, Ok(text));
        }
    }
    hide_overlay(&app);
}

// ------------------------------------------------------------- MCP asking --

/// Start a Pro-gated ask session: overlay shows the agent's question, the
/// watchdog stops recording on silence or at `timeout_ms`.
pub fn begin_ask(
    app: &tauri::AppHandle,
    prompt: String,
    timeout_ms: u64,
    tx: mpsc::Sender<Result<String, String>>,
) -> Result<(), String> {
    let state = app.state::<AppState>();
    if state.entitlement.read().unwrap().tier() != "pro" {
        return Err("ask_user_by_voice requires an active Pro license".into());
    }
    if state.capture.lock().unwrap().is_some() {
        return Err("already recording — finish the current dictation first".into());
    }
    *state.ask_tx.lock().unwrap() = Some(tx);
    *state.ask_prompt.lock().unwrap() = Some(prompt);
    begin(app);
    if state.capture.lock().unwrap().is_none() {
        resolve_ask(app, Err("could not start audio capture".into()));
        return Err("could not start audio capture".into());
    }
    let watchdog_app = app.clone();
    std::thread::spawn(move || watchdog(watchdog_app, timeout_ms));
    Ok(())
}

fn watchdog(app: tauri::AppHandle, timeout_ms: u64) {
    loop {
        std::thread::sleep(std::time::Duration::from_millis(150));
        let state = app.state::<AppState>();
        let capture = state.capture.lock().unwrap();
        match capture.as_ref() {
            None => return, // session already ended
            Some(session) => {
                let stop = crate::audio::should_auto_stop(
                    session.elapsed_ms(),
                    session.ms_since_speech(),
                    session.has_speech(),
                    ASK_SILENCE_MS,
                    ASK_MIN_MS,
                    timeout_ms.max(ASK_MIN_MS + 1),
                );
                drop(capture);
                if stop {
                    end(&app);
                    return;
                }
            }
        }
    }
}
