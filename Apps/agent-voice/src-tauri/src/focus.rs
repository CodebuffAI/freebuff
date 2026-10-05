//! Foreground-window capture and restoration (Win32 on Windows, stubs elsewhere).
//!
//! Push-to-talk remembers the focused window *before* the overlay appears, so
//! the transcript can be pasted back into the app the user was working in.

#[cfg(windows)]
pub fn foreground_window() -> isize {
    use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;
    unsafe { GetForegroundWindow().0 as isize }
}

#[cfg(windows)]
pub fn window_title(hwnd: isize) -> String {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{GetWindowTextLengthW, GetWindowTextW};
    if hwnd == 0 {
        return String::new();
    }
    unsafe {
        let handle = HWND(hwnd as *mut std::ffi::c_void);
        let len = GetWindowTextLengthW(handle);
        if len <= 0 {
            return String::new();
        }
        let mut buf = vec![0u16; len as usize + 1];
        let written = GetWindowTextW(handle, &mut buf);
        if written == 0 {
            return String::new();
        }
        String::from_utf16_lossy(&buf[..written as usize])
    }
}

#[cfg(windows)]
pub fn focus_window(hwnd: isize) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::SetForegroundWindow;
    if hwnd == 0 {
        return;
    }
    unsafe {
        let _ = SetForegroundWindow(HWND(hwnd as *mut std::ffi::c_void));
    }
}

#[cfg(not(windows))]
pub fn foreground_window() -> isize {
    0
}

#[cfg(not(windows))]
pub fn window_title(_hwnd: isize) -> String {
    String::new()
}

#[cfg(not(windows))]
pub fn focus_window(_hwnd: isize) {}

#[cfg(test)]
mod tests {
    #[test]
    fn stubs_do_not_panic_off_windows() {
        // On Windows these hit Win32; on other targets they are no-ops.
        // Both paths must tolerate hwnd == 0 / invalid handles.
        let hwnd = super::foreground_window();
        let _ = super::window_title(hwnd);
        super::focus_window(hwnd);
    }
}
