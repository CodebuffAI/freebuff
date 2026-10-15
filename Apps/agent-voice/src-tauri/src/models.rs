//! Model downloads (streamed, resumable-free, verified) with progress events.

use crate::asr;
use tauri::{Emitter, Manager};

#[derive(Clone, serde::Serialize)]
struct ProgressPayload {
    id: String,
    received: u64,
    total: u64,
    progress: f32,
    done: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

/// Extract a sha256 from an HTTP `ETag`/`X-Linked-Etag` header when the
/// server provides one (Hugging Face serves LFS hashes this way).
pub fn sha256_from_etag(etag: Option<&str>) -> Option<String> {
    let raw = etag?.trim().trim_matches('"');
    if raw.len() == 64 && raw.bytes().all(|b| b.is_ascii_hexdigit()) {
        Some(raw.to_lowercase())
    } else {
        None
    }
}

/// Download `id` into the models directory, emitting `model-progress`.
pub async fn download(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let def = asr::model(&id).ok_or_else(|| format!("unknown model '{id}'"))?;
    let state = app.state::<crate::state::AppState>();
    let dir = crate::paths::models_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let dest = dir.join(def.file);
    if asr::model_file_ok(&dest) {
        return Ok(());
    }
    let tmp = dir.join(format!("{}.part", def.file));

    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let mut resp = client
        .get(def.url)
        .send()
        .await
        .map_err(|e| format!("download failed: {e}"))?
        .error_for_status()
        .map_err(|e| format!("download failed: {e}"))?;
    let etag = resp
        .headers()
        .get(reqwest::header::ETAG)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    let expected_sha = sha256_from_etag(etag.as_deref());
    let total = resp.content_length().unwrap_or(def.size_bytes);

    {
        let mut downloads = state.downloads.lock().unwrap();
        downloads.insert(id.clone(), 0.0);
    }

    let mut file = tokio::fs::File::create(&tmp)
        .await
        .map_err(|e| e.to_string())?;
    let mut received: u64 = 0;
    let mut last_emit = std::time::Instant::now() - std::time::Duration::from_secs(1);
    // Hash incrementally so a 1.6 GB model never sits in memory.
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    let mut first_bytes: Vec<u8> = Vec::new();

    loop {
        let chunk = resp
            .chunk()
            .await
            .map_err(|e| format!("download failed: {e}"))?;
        let Some(chunk) = chunk else { break };
        tokio::io::AsyncWriteExt::write_all(&mut file, &chunk)
            .await
            .map_err(|e| e.to_string())?;
        hasher.update(&chunk);
        if first_bytes.len() < 4 {
            let need = 4 - first_bytes.len();
            first_bytes.extend_from_slice(&chunk[..chunk.len().min(need)]);
        }
        received += chunk.len() as u64;
        if last_emit.elapsed() >= std::time::Duration::from_millis(120) {
            let progress = if total > 0 {
                (received as f32 / total as f32).min(1.0)
            } else {
                0.0
            };
            {
                let mut downloads = state.downloads.lock().unwrap();
                downloads.insert(id.clone(), progress);
            }
            let _ = app.emit(
                "model-progress",
                ProgressPayload {
                    id: id.clone(),
                    received,
                    total,
                    progress,
                    done: false,
                    error: None,
                },
            );
            last_emit = std::time::Instant::now();
        }
    }
    tokio::io::AsyncWriteExt::flush(&mut file)
        .await
        .map_err(|e| e.to_string())?;
    drop(file);

    // Integrity: sha256 when the server provided one, else GGML magic.
    if let Some(expected) = expected_sha {
        let actual = {
            use std::fmt::Write as _;
            let digest = hasher.finalize();
            let mut out = String::with_capacity(64);
            for b in digest {
                let _ = write!(out, "{b:02x}");
            }
            out
        };
        if actual != expected {
            let _ = tokio::fs::remove_file(&tmp).await;
            return Err(format!(
                "checksum mismatch for {id} (expected {expected}, got {actual})"
            ));
        }
    } else if first_bytes.as_slice() != asr::GGML_MAGIC || !asr::model_file_ok(&tmp) {
        let _ = tokio::fs::remove_file(&tmp).await;
        return Err(format!(
            "downloaded file for {id} is not a valid GGML model"
        ));
    }

    tokio::fs::rename(&tmp, &dest)
        .await
        .map_err(|e| e.to_string())?;
    {
        let mut downloads = state.downloads.lock().unwrap();
        downloads.remove(&id);
    }
    let _ = app.emit(
        "model-progress",
        ProgressPayload {
            id,
            received,
            total,
            progress: 1.0,
            done: true,
            error: None,
        },
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn etag_sha_extraction() {
        assert_eq!(
            sha256_from_etag(Some(
                "\"abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789\""
            )),
            Some("abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789".to_string())
        );
        // W/ prefix or non-sha etags are rejected.
        assert_eq!(sha256_from_etag(Some("W/\"1234\"")), None);
        assert_eq!(sha256_from_etag(Some("\"deadbeef\"")), None);
        assert_eq!(sha256_from_etag(None), None);
    }

    #[test]
    fn streaming_hash_matches_known_vector() {
        use sha2::{Digest, Sha256};
        let mut h = Sha256::new();
        h.update(b"a");
        h.update(b"bc");
        use std::fmt::Write as _;
        let mut out = String::new();
        for b in h.finalize() {
            let _ = write!(out, "{b:02x}");
        }
        assert_eq!(
            out,
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }
}
