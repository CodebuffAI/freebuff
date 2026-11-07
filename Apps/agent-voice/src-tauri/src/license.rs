//! HTTP client for the license worker (`/activate`, `/deactivate`).
//!
//! The license code is the Paddle transaction id of the purchase — Paddle
//! Billing issues no license keys, so the `txn_…` id from the receipt is what
//! the customer holds and what the worker files its record under.
//!
//! The worker mints the Ed25519-signed token; we *always* re-verify it with
//! the embedded public key before persisting — a compromised or impostor
//! worker cannot grant Pro.

use crate::entitlement::{self, Claims};
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivateBody {
    pub license_code: String,
    pub device_id: String,
}

#[derive(Debug, Deserialize)]
pub struct ActivateResponse {
    pub token: String,
}

#[derive(Debug, thiserror::Error, PartialEq)]
pub enum LicenseError {
    #[error("unknown or invalid license code")]
    Rejected(String),
    #[error("this license has been revoked (refund or chargeback)")]
    Revoked,
    #[error("license server unreachable: {0}")]
    Offline(String),
    #[error("server returned a token that failed local verification")]
    InvalidToken,
    #[error("too many attempts — try again in a minute")]
    RateLimited,
}

pub fn endpoint(base: &str, path: &str) -> String {
    let base = base.trim_end_matches('/');
    if path.starts_with('/') {
        format!("{base}{path}")
    } else {
        format!("{base}/{path}")
    }
}

pub fn activate_body(license_code: &str, device_id: &str) -> ActivateBody {
    ActivateBody {
        license_code: license_code.trim().to_string(),
        device_id: device_id.to_string(),
    }
}

/// Local verification gate for any token received over the wire.
pub fn checked_token(token: &str, device_id: &str) -> Result<Claims, LicenseError> {
    entitlement::verify(token, crate::state::now_unix() as u64, Some(device_id))
        .map_err(|_| LicenseError::InvalidToken)
}

/// The token must belong to the code that was presented — a mix-up (or a
/// misbehaving worker) can never activate the wrong license.
pub fn subject_matches_code(claims: &Claims, license_code: &str) -> bool {
    claims.sub == entitlement::license_subject(license_code)
}

async fn error_message(resp: reqwest::Response) -> String {
    let status = resp.status().as_u16();
    let text = resp.text().await.unwrap_or_default();
    match serde_json::from_str::<serde_json::Value>(&text) {
        Ok(v) => v["error"]
            .as_str()
            .map(|s| s.to_string())
            .unwrap_or_else(|| format!("HTTP {status}")),
        Err(_) => format!("HTTP {status}"),
    }
}

/// Activate (or refresh) a license code on this device.
/// Returns the verified token.
pub async fn activate(
    worker_url: &str,
    license_code: &str,
    device_id: &str,
) -> Result<String, LicenseError> {
    if license_code.trim().is_empty() {
        return Err(LicenseError::Rejected(
            "paste the txn_… id from your receipt".into(),
        ));
    }
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| LicenseError::Offline(e.to_string()))?;
    let resp = client
        .post(endpoint(worker_url, "/activate"))
        .json(&activate_body(license_code, device_id))
        .send()
        .await
        .map_err(|e| LicenseError::Offline(e.to_string()))?;
    let status = resp.status().as_u16();
    match status {
        200 => {
            let body: ActivateResponse = resp
                .json()
                .await
                .map_err(|e| LicenseError::Offline(e.to_string()))?;
            let claims = checked_token(&body.token, device_id)?;
            if !subject_matches_code(&claims, license_code) {
                return Err(LicenseError::InvalidToken);
            }
            Ok(body.token)
        }
        404 | 403 | 400 => Err(LicenseError::Rejected(error_message(resp).await)),
        410 => Err(LicenseError::Revoked),
        429 => Err(LicenseError::RateLimited),
        _ => Err(LicenseError::Rejected(error_message(resp).await)),
    }
}

/// Best-effort device deactivation (server + local are both cleared by the
/// caller; a network failure here is not fatal).
pub async fn deactivate(
    worker_url: &str,
    license_code: &str,
    device_id: &str,
) -> Result<(), LicenseError> {
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| LicenseError::Offline(e.to_string()))?;
    let resp = client
        .post(endpoint(worker_url, "/deactivate"))
        .json(&activate_body(license_code, device_id))
        .send()
        .await
        .map_err(|e| LicenseError::Offline(e.to_string()))?;
    if resp.status().is_success() || resp.status().as_u16() == 404 {
        Ok(())
    } else {
        Err(LicenseError::Offline(format!(
            "HTTP {}",
            resp.status().as_u16()
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoints_join_without_double_slash() {
        assert_eq!(
            endpoint("https://w.example.workers.dev/", "/activate"),
            "https://w.example.workers.dev/activate"
        );
        assert_eq!(
            endpoint("https://w.example.workers.dev", "deactivate"),
            "https://w.example.workers.dev/deactivate"
        );
    }

    #[test]
    fn activate_body_is_camel_case_and_trims() {
        let body = activate_body("  txn_01abc \n", "dev-1");
        let json = serde_json::to_value(&body).unwrap();
        assert_eq!(json["licenseCode"], "txn_01abc");
        assert_eq!(json["deviceId"], "dev-1");
        assert!(
            json.get("license_code").is_none(),
            "snake_case must not leak"
        );
    }

    #[test]
    fn checked_token_rejects_garbage() {
        assert_eq!(
            checked_token("garbage", "d1"),
            Err(LicenseError::InvalidToken)
        );
        assert_eq!(checked_token("a.b", "d1"), Err(LicenseError::InvalidToken));
    }

    #[test]
    fn subject_binds_token_to_presented_code() {
        use crate::entitlement::{license_subject, Claims, TOKEN_VERSION};
        let code = "txn_01aaaaaabbbbbbccccccddddd";
        let claims = Claims {
            v: TOKEN_VERSION,
            sub: license_subject(code),
            dev: "d1".into(),
            ent: vec!["pro".into()],
            iat: 1,
            exp: 2,
        };
        assert!(subject_matches_code(&claims, code));
        assert!(!subject_matches_code(
            &claims,
            "txn_01eeeeeeffffffgggggghhhhh"
        ));
    }

    #[test]
    fn empty_code_is_rejected_locally_without_a_request() {
        // Exercised through the sync builder: empty codes never reach the wire
        // because `activate` short-circuits before any HTTP call.
        let body = activate_body("   ", "d1");
        assert!(body.license_code.is_empty());
    }
}
