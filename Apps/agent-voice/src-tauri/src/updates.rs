//! App updates: check the release feed, download a signed update, install it.
//!
//! The signature is verified by the Tauri updater plugin against the minisign
//! public key baked into `tauri.conf.json`, so a compromised release endpoint
//! cannot install anything.

use tauri::AppHandle;
use tauri_plugin_updater::UpdaterExt;

#[derive(serde::Serialize)]
pub struct UpdateView {
    pub available: bool,
    /// Version string of the newest release, or the running version.
    pub version: String,
    pub notes: Option<String>,
}

/// Is `candidate` strictly newer than `current`?
///
/// Both may carry a pre-release suffix, which sorts *below* the release
/// (`1.2.0-beta` < `1.2.0`). The updater plugin does its own check; this exists
/// so the comparison rule is testable and identical in both places.
pub fn version_is_newer(candidate: &str, current: &str) -> bool {
    /// Split into numeric core components and the pre-release tail.
    fn split(v: &str) -> (Vec<u64>, Option<&str>) {
        let v = v.trim().trim_start_matches(['v', 'V']);
        let (core, rest) = match v.split_once('-') {
            Some((core, rest)) => (core, Some(rest)),
            None => (v.split_once('+').map_or(v, |(core, _)| core), None),
        };
        let core = core
            .split('.')
            .map(|part| part.parse::<u64>().unwrap_or(0))
            .collect();
        (core, rest.filter(|r| !r.is_empty()))
    }

    /// Semver precedence: numeric identifiers compare numerically and always
    /// rank below alphanumeric ones.
    fn pre_greater(a: &str, b: &str) -> bool {
        let mut left = a.split('.');
        let mut right = b.split('.');
        loop {
            match (left.next(), right.next()) {
                (None, None) => return false,
                (None, Some(_)) => return false,
                (Some(_), None) => return true,
                (Some(x), Some(y)) => {
                    if x == y {
                        continue;
                    }
                    return match (x.parse::<u64>(), y.parse::<u64>()) {
                        (Ok(nx), Ok(ny)) => nx > ny,
                        (Ok(_), Err(_)) => true,
                        (Err(_), Ok(_)) => false,
                        (Err(_), Err(_)) => x > y,
                    };
                }
            }
        }
    }

    let (candidate_core, candidate_pre) = split(candidate);
    let (current_core, current_pre) = split(current);
    for i in 0..candidate_core.len().max(current_core.len()) {
        let a = candidate_core.get(i).copied().unwrap_or(0);
        let b = current_core.get(i).copied().unwrap_or(0);
        if a != b {
            return a > b;
        }
    }
    match (candidate_pre, current_pre) {
        (None, None) => false,
        // A release outranks any of its own pre-releases.
        (None, Some(_)) => true,
        (Some(_), None) => false,
        (Some(a), Some(b)) => pre_greater(a, b),
    }
}

#[tauri::command]
pub async fn check_for_update(app: AppHandle) -> Result<UpdateView, String> {
    let updater = app.updater().map_err(|e| e.to_string())?;
    match updater.check().await {
        Ok(Some(update)) => {
            let current = app.package_info().version.to_string();
            // Guard against a feed that advertises an older build: never offer
            // a downgrade as an "update".
            let available = version_is_newer(&update.version, &current);
            Ok(UpdateView {
                available,
                version: update.version.clone(),
                notes: update.body.clone(),
            })
        }
        Ok(None) => Ok(UpdateView {
            available: false,
            version: app.package_info().version.to_string(),
            notes: None,
        }),
        Err(e) => Err(format!("could not check for updates: {e}")),
    }
}

#[tauri::command]
pub async fn install_update(app: AppHandle) -> Result<(), String> {
    let updater = app.updater().map_err(|e| e.to_string())?;
    let update = updater
        .check()
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "no update is available".to_string())?;
    let mut downloaded = 0;
    update
        .download_and_install(
            |chunk, total| {
                downloaded += chunk;
                if let Some(total) = total {
                    eprintln!("update: {downloaded}/{total} bytes");
                }
            },
            || {},
        )
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_versions_compare_numerically() {
        assert!(version_is_newer("1.2.0", "1.1.9"));
        assert!(version_is_newer("1.10.0", "1.9.0"));
        assert!(version_is_newer("2.0.0", "1.99.99"));
        assert!(!version_is_newer("1.1.9", "1.2.0"));
        assert!(!version_is_newer("1.2.0", "1.2.0"));
    }

    #[test]
    fn prefixes_and_metadata_are_tolerated() {
        assert!(version_is_newer("v1.3.0", "1.2.0"));
        assert!(version_is_newer("1.2.1+build7", "1.2.0"));
        assert!(!version_is_newer("1.2.0+build7", "1.2.0"));
    }

    #[test]
    fn prereleases_sort_below_releases() {
        assert!(version_is_newer("1.2.0", "1.2.0-beta.1"));
        assert!(!version_is_newer("1.2.0-beta.1", "1.2.0"));
        assert!(version_is_newer("1.2.0-beta.2", "1.2.0-beta.1"));
    }

    #[test]
    fn missing_components_are_zero() {
        assert!(version_is_newer("1.2", "1.1.9"));
        assert!(!version_is_newer("1.2", "1.2.0"));
    }
}
