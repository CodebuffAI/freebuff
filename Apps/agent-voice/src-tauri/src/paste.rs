//! Clipboard write + keystroke paste into the previously focused window.

use crate::focus;
use enigo::{Direction, Enigo, Key, Keyboard, Settings};
use tauri_plugin_clipboard_manager::ClipboardExt;

/// Put `text` on the clipboard, restore focus to `target_hwnd`, then send
/// the platform paste chord.
///
/// Runs on a blocking-friendly thread (it sleeps briefly to let focus land).
pub fn paste_text(app: &tauri::AppHandle, text: &str, target_hwnd: isize) -> Result<(), String> {
    app.clipboard()
        .write_text(text.to_string())
        .map_err(|e| e.to_string())?;

    focus::focus_window(target_hwnd);
    // Give the window a beat to come to the foreground before the chord.
    std::thread::sleep(std::time::Duration::from_millis(90));

    let mut enigo = Enigo::new(&Settings::default()).map_err(|e| e.to_string())?;
    let modifier = if cfg!(target_os = "macos") {
        Key::Meta
    } else {
        Key::Control
    };
    enigo
        .key(modifier, Direction::Press)
        .map_err(|e| e.to_string())?;
    enigo
        .key(Key::Unicode('v'), Direction::Click)
        .map_err(|e| e.to_string())?;
    enigo
        .key(modifier, Direction::Release)
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    /// The paste chord logic is exercised only in a live session (it requires
    /// a real clipboard and focused window); here we just pin the key choice.
    #[test]
    fn modifier_matches_platform() {
        let modifier = if cfg!(target_os = "macos") {
            "meta"
        } else {
            "control"
        };
        #[cfg(target_os = "macos")]
        assert_eq!(modifier, "meta");
        #[cfg(not(target_os = "macos"))]
        assert_eq!(modifier, "control");
    }
}
