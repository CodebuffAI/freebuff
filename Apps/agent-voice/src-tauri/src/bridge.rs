//! Loopback HTTP bridge: lets the `agent-voice mcp` companion (a separate
//! process) ask the running GUI to start a dictation session.
//!
//! Binds to 127.0.0.1 on an ephemeral port and publishes it in
//! `bridge.json` next to the rest of the app data.

use crate::state::AppState;
use serde_json::{json, Value};
use std::io::{Read, Write};
use tauri::Manager;

const MAX_BODY: usize = 64 * 1024;
const MAX_HEADER: usize = 16 * 1024;

pub fn start(app: tauri::AppHandle) -> Result<u16, String> {
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    crate::paths::ensure_home().map_err(|e| e.to_string())?;
    let meta = json!({ "port": port, "pid": std::process::id() });
    std::fs::write(
        crate::paths::bridge_path(),
        serde_json::to_vec(&meta).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    app.state::<AppState>()
        .bridge_port
        .store(port, std::sync::atomic::Ordering::SeqCst);

    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let app = app.clone();
            std::thread::spawn(move || {
                handle_connection(stream, app);
            });
        }
    });
    Ok(port)
}

/// Locate `\r\n\r\n`, parse Content-Length. Returns (header_end, body_len).
pub fn split_headers(buf: &[u8]) -> Option<(usize, usize)> {
    let header_end = buf.windows(4).position(|w| w == b"\r\n\r\n")?;
    let headers = std::str::from_utf8(&buf[..header_end]).ok()?;
    let mut content_length = 0usize;
    for line in headers.lines() {
        if let Some((key, value)) = line.split_once(':') {
            if key.trim().eq_ignore_ascii_case("content-length") {
                content_length = value.trim().parse().ok()?;
            }
        }
    }
    Some((header_end, content_length))
}

/// Read one HTTP request (headers + bounded body) and parse its JSON body.
pub fn read_request_from<R: Read>(reader: &mut R) -> Option<Value> {
    let mut buf = Vec::new();
    let mut tmp = [0u8; 1024];
    let (header_end, content_length) = loop {
        let n = reader.read(&mut tmp).ok()?;
        if n == 0 {
            return None;
        }
        buf.extend_from_slice(&tmp[..n]);
        if buf.len() > MAX_HEADER && buf.windows(4).all(|w| w != b"\r\n\r\n") {
            return None;
        }
        if let Some(found) = split_headers(&buf) {
            break found;
        }
    };
    if content_length > MAX_BODY {
        return None;
    }
    let mut body = buf[header_end + 4..].to_vec();
    while body.len() < content_length {
        let n = reader.read(&mut tmp).ok()?;
        if n == 0 {
            break;
        }
        body.extend_from_slice(&tmp[..n]);
        if body.len() > MAX_BODY {
            return None;
        }
    }
    if body.len() < content_length {
        return None;
    }
    serde_json::from_slice(&body[..content_length]).ok()
}

pub fn write_response<W: Write>(writer: &mut W, status: u16, body: &Value) -> std::io::Result<()> {
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        403 => "Forbidden",
        409 => "Conflict",
        422 => "Unprocessable Content",
        504 => "Gateway Timeout",
        _ => "Error",
    };
    let body = serde_json::to_vec(body).unwrap_or_else(|_| b"{}".to_vec());
    write!(
        writer,
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    )?;
    writer.write_all(&body)?;
    writer.flush()
}

fn handle_connection(mut stream: std::net::TcpStream, app: tauri::AppHandle) {
    let Some(request) = read_request_from(&mut stream) else {
        let _ = write_response(
            &mut stream,
            400,
            &json!({"ok": false, "error": "bad request"}),
        );
        return;
    };
    match request["type"].as_str() {
        Some("ping") => {
            let _ = write_response(&mut stream, 200, &json!({"ok": true}));
        }
        Some("ask") => {
            let prompt = request["prompt"]
                .as_str()
                .unwrap_or("The agent asked you a question")
                .to_string();
            let timeout_ms = request["timeout_ms"]
                .as_u64()
                .unwrap_or(30_000)
                .clamp(1_000, 300_000);
            let (tx, rx) = std::sync::mpsc::channel();
            match crate::hotkey::begin_ask(&app, prompt, timeout_ms, tx) {
                Err(e) => {
                    let _ = write_response(&mut stream, 409, &json!({"ok": false, "error": e}));
                }
                Ok(()) => {
                    let deadline = std::time::Duration::from_millis(timeout_ms + 15_000);
                    match rx.recv_timeout(deadline) {
                        Ok(Ok(text)) => {
                            let _ = write_response(
                                &mut stream,
                                200,
                                &json!({"ok": true, "text": text}),
                            );
                        }
                        Ok(Err(e)) => {
                            let _ =
                                write_response(&mut stream, 422, &json!({"ok": false, "error": e}));
                        }
                        Err(_) => {
                            let _ = write_response(
                                &mut stream,
                                504,
                                &json!({"ok": false, "error": "dictation timed out"}),
                            );
                        }
                    }
                }
            }
        }
        _ => {
            let _ = write_response(
                &mut stream,
                400,
                &json!({"ok": false, "error": "unknown request type"}),
            );
        }
    }
}

/// Minimal JSON-over-HTTP POST used by the MCP companion.
pub fn http_post_json(port: u16, body: &Value) -> Result<(u16, Value), String> {
    let payload = serde_json::to_vec(body).map_err(|e| e.to_string())?;
    let mut stream =
        std::net::TcpStream::connect(("127.0.0.1", port)).map_err(|e| e.to_string())?;
    stream
        .set_read_timeout(Some(std::time::Duration::from_secs(310)))
        .map_err(|e| e.to_string())?;
    write!(
        stream,
        "POST / HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        payload.len()
    )
    .map_err(|e| e.to_string())?;
    stream.write_all(&payload).map_err(|e| e.to_string())?;

    let mut response = Vec::new();
    stream
        .read_to_end(&mut response)
        .map_err(|e| e.to_string())?;
    let (header_end, _) = split_headers(&response).ok_or("malformed response")?;
    let headers = std::str::from_utf8(&response[..header_end]).map_err(|e| e.to_string())?;
    let status: u16 = headers
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|code| code.parse().ok())
        .ok_or("malformed status line")?;
    let value: Value =
        serde_json::from_slice(&response[header_end + 4..]).unwrap_or_else(|_| json!({}));
    Ok((status, value))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn split_headers_finds_content_length() {
        let raw = b"POST / HTTP/1.1\r\nHost: x\r\nContent-Length: 17\r\n\r\n{\"type\":\"ping\"}";
        let (end, len) = split_headers(raw).unwrap();
        assert_eq!(len, 17);
        assert_eq!(&raw[end..end + 4], b"\r\n\r\n");
        // No header terminator yet.
        assert!(split_headers(b"GET / HTTP/1.1\r\n").is_none());
        // Missing Content-Length defaults to 0 (no body expected).
        let (end, len) = split_headers(b"GET / HTTP/1.1\r\nHost: x\r\n\r\n").unwrap();
        // "GET / HTTP/1.1" + CRLF + "Host: x" + CRLF
        assert_eq!((end, len), (23, 0));
    }

    #[test]
    fn read_request_parses_json_body() {
        let body = br#"{"type":"ask","prompt":"hi?"}"#;
        let raw = format!(
            "POST / HTTP/1.1\r\nContent-Length: {}\r\n\r\n{}",
            body.len(),
            String::from_utf8(body.to_vec()).unwrap()
        );
        let mut cursor = Cursor::new(raw.as_bytes());
        let value = read_request_from(&mut cursor).unwrap();
        assert_eq!(value["type"], "ask");
        assert_eq!(value["prompt"], "hi?");
    }

    #[test]
    fn read_request_rejects_garbage_and_truncation() {
        assert!(read_request_from(&mut Cursor::new(b"not http at all")).is_none());
        // Content-Length promises more bytes than arrive.
        let raw = b"POST / HTTP/1.1\r\nContent-Length: 100\r\n\r\n{}";
        assert!(read_request_from(&mut Cursor::new(&raw[..])).is_none());
        // Oversized body is refused.
        let big = format!(
            "POST / HTTP/1.1\r\nContent-Length: {}\r\n\r\n",
            MAX_BODY + 1
        );
        assert!(read_request_from(&mut Cursor::new(big.as_bytes())).is_none());
    }

    #[test]
    fn write_response_is_well_formed() {
        let mut out: Vec<u8> = Vec::new();
        write_response(&mut out, 200, &json!({"ok": true})).unwrap();
        let text = String::from_utf8(out).unwrap();
        let (head, body) = text.split_once("\r\n\r\n").unwrap();
        assert!(head.starts_with("HTTP/1.1 200 OK"));
        let parsed: Value = serde_json::from_str(body).unwrap();
        assert_eq!(parsed["ok"], true);
        // Content-Length matches the actual body bytes.
        let declared: usize = head
            .lines()
            .find(|l| l.to_lowercase().starts_with("content-length"))
            .and_then(|l| l.split(':').nth(1))
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        assert_eq!(declared, body.len());
    }

    #[test]
    fn http_post_json_roundtrip_against_test_server() {
        // Spin up a fake bridge that always answers {"ok":true}.
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let request = read_request_from(&mut stream).unwrap();
            assert_eq!(request["type"], "ping");
            write_response(&mut stream, 200, &json!({"ok": true})).unwrap();
        });
        let (status, body) = http_post_json(port, &json!({"type": "ping"})).unwrap();
        server.join().unwrap();
        assert_eq!(status, 200);
        assert_eq!(body["ok"], true);
    }
}
