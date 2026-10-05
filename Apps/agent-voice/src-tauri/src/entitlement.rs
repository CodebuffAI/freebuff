//! Offline verification of Paddle-issued entitlement tokens.
//!
//! The license backend (Cloudflare Worker) signs a compact token with an
//! Ed25519 private key; the app embeds only the public key and verifies
//! locally, so Pro features keep working without a network round-trip.
//!
//! Token format: `base64url(claims-json) "." base64url(ed25519-signature)`
//! Signature covers the raw claims-json bytes.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use ed25519_dalek::{Signature, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const TOKEN_VERSION: u32 = 1;
pub const PRO_ENTITLEMENT: &str = "pro";

/// Development signing public key (raw 32 bytes, standard base64).
/// Production builds should override it at compile time with
/// `AGENT_VOICE_ENTITLEMENT_PUBKEY=<base64>` — see `docs/entitlement.md`.
pub const DEV_PUBLIC_KEY_B64: &str = "ouHWrlcY5+OOry5d0fMknb4il4mIIHb4n+lOhP61+K8=";

/// Public key used to verify tokens: build-time override, else the dev key.
pub fn public_key_bytes() -> [u8; 32] {
    let raw = option_env!("AGENT_VOICE_ENTITLEMENT_PUBKEY").unwrap_or(DEV_PUBLIC_KEY_B64);
    decode_public_key(raw).expect("embedded entitlement public key must be valid base64(32)")
}

pub fn decode_public_key(b64: &str) -> Option<[u8; 32]> {
    let bytes = base64::engine::general_purpose::STANDARD.decode(b64).ok()?;
    <[u8; 32]>::try_from(bytes.as_slice()).ok()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Claims {
    /// Token format version.
    pub v: u32,
    /// Stable license identity: first 32 hex chars of sha256(license code).
    pub sub: String,
    /// Device this token was minted for.
    pub dev: String,
    /// Entitlements, e.g. `["pro"]`.
    pub ent: Vec<String>,
    /// Issued-at (unix seconds).
    pub iat: u64,
    /// Expiry (unix seconds).
    pub exp: u64,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum VerifyError {
    #[error("malformed token")]
    Malformed,
    #[error("unsupported token version")]
    Version,
    #[error("invalid signature")]
    Signature,
    #[error("token expired")]
    Expired,
    #[error("token issued for a different device")]
    WrongDevice,
}

/// Verify signature + version + expiry (and optionally device binding).
pub fn verify(token: &str, now_unix: u64, device_id: Option<&str>) -> Result<Claims, VerifyError> {
    verify_with_key(token, now_unix, device_id, &public_key_bytes())
}

pub fn verify_with_key(
    token: &str,
    now_unix: u64,
    device_id: Option<&str>,
    pubkey: &[u8; 32],
) -> Result<Claims, VerifyError> {
    let (payload_b64, sig_b64) = token.split_once('.').ok_or(VerifyError::Malformed)?;
    let payload = URL_SAFE_NO_PAD
        .decode(payload_b64)
        .map_err(|_| VerifyError::Malformed)?;
    let sig_bytes = URL_SAFE_NO_PAD
        .decode(sig_b64)
        .map_err(|_| VerifyError::Malformed)?;
    let signature = Signature::from_slice(&sig_bytes).map_err(|_| VerifyError::Signature)?;
    let key = VerifyingKey::from_bytes(pubkey).map_err(|_| VerifyError::Signature)?;
    key.verify_strict(&payload, &signature)
        .map_err(|_| VerifyError::Signature)?;
    let claims: Claims = serde_json::from_slice(&payload).map_err(|_| VerifyError::Malformed)?;
    if claims.v != TOKEN_VERSION {
        return Err(VerifyError::Version);
    }
    if claims.exp <= now_unix {
        return Err(VerifyError::Expired);
    }
    if let Some(dev) = device_id {
        if claims.dev != dev {
            return Err(VerifyError::WrongDevice);
        }
    }
    Ok(claims)
}

pub fn is_pro(claims: &Claims) -> bool {
    claims.ent.iter().any(|e| e == PRO_ENTITLEMENT)
}

/// Stable, non-reversible license identity used as the token subject.
pub fn license_subject(license_code: &str) -> String {
    let digest = Sha256::digest(license_code.as_bytes());
    hex_encode(&digest)[..32].to_string()
}

pub fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::engine::general_purpose::STANDARD;
    use base64::Engine;
    use ed25519_dalek::{Signer, SigningKey};

    /// Deterministic test keypair — never used outside tests.
    fn test_keypair() -> (SigningKey, [u8; 32]) {
        let mut seed = [7u8; 32];
        seed[0] = 42;
        let signing = SigningKey::from_bytes(&seed);
        let verifying = signing.verifying_key().to_bytes();
        (signing, verifying)
    }

    fn make_token(signing: &SigningKey, claims: &Claims) -> String {
        let payload = serde_json::to_vec(claims).unwrap();
        let sig = signing.sign(&payload);
        format!(
            "{}.{}",
            URL_SAFE_NO_PAD.encode(&payload),
            URL_SAFE_NO_PAD.encode(sig.to_bytes())
        )
    }

    fn sample_claims(now: u64) -> Claims {
        Claims {
            v: TOKEN_VERSION,
            sub: license_subject("txn_01aaaaaabbbbbbccccccddddd"),
            dev: "device-1".into(),
            ent: vec![PRO_ENTITLEMENT.into()],
            iat: now,
            exp: now + 1000,
        }
    }

    #[test]
    fn valid_token_verifies_and_is_pro() {
        let (signing, pubk) = test_keypair();
        let now = 1_700_000_000;
        let token = make_token(&signing, &sample_claims(now));
        let claims = verify_with_key(&token, now + 10, Some("device-1"), &pubk).unwrap();
        assert!(is_pro(&claims));
        assert_eq!(claims.sub.len(), 32);
    }

    #[test]
    fn tampered_payload_fails() {
        let (signing, pubk) = test_keypair();
        let now = 1_700_000_000;
        let token = make_token(&signing, &sample_claims(now));
        let (payload, sig) = token.split_once('.').unwrap();
        let mut claims: Claims =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(payload).unwrap()).unwrap();
        claims.ent = vec!["free".into()];
        let forged = format!(
            "{}.{}",
            URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims).unwrap()),
            sig
        );
        assert_eq!(
            verify_with_key(&forged, now + 1, None, &pubk),
            Err(VerifyError::Signature)
        );
    }

    #[test]
    fn expired_token_rejected() {
        let (signing, pubk) = test_keypair();
        let now = 1_700_000_000;
        let token = make_token(&signing, &sample_claims(now));
        assert_eq!(
            verify_with_key(&token, now + 1001, None, &pubk),
            Err(VerifyError::Expired)
        );
    }

    #[test]
    fn wrong_device_rejected() {
        let (signing, pubk) = test_keypair();
        let now = 1_700_000_000;
        let token = make_token(&signing, &sample_claims(now));
        assert_eq!(
            verify_with_key(&token, now + 1, Some("other-device"), &pubk),
            Err(VerifyError::WrongDevice)
        );
    }

    #[test]
    fn wrong_key_and_garbage_rejected() {
        let (signing, _pubk) = test_keypair();
        let (_other_signing, other_pubk) = {
            let mut seed = [9u8; 32];
            seed[0] = 1;
            let s = SigningKey::from_bytes(&seed);
            let p = s.verifying_key().to_bytes();
            (s, p)
        };
        let now = 1_700_000_000;
        let token = make_token(&signing, &sample_claims(now));
        assert_eq!(
            verify_with_key(&token, now + 1, None, &other_pubk),
            Err(VerifyError::Signature)
        );
        assert_eq!(
            verify_with_key("garbage", now, None, &other_pubk),
            Err(VerifyError::Malformed)
        );
        // "a" is not valid base64url at all → malformed, not a signature failure.
        assert_eq!(
            verify_with_key("a.b", now, None, &other_pubk),
            Err(VerifyError::Malformed)
        );
    }

    #[test]
    fn wrong_version_rejected() {
        let (signing, pubk) = test_keypair();
        let now = 1_700_000_000;
        let mut claims = sample_claims(now);
        claims.v = 99;
        let token = make_token(&signing, &claims);
        assert_eq!(
            verify_with_key(&token, now + 1, None, &pubk),
            Err(VerifyError::Version)
        );
    }

    #[test]
    fn embedded_dev_key_is_decodable() {
        let bytes = decode_public_key(DEV_PUBLIC_KEY_B64).expect("dev key decodes");
        assert_eq!(bytes.len(), 32);
        // Standard base64 of 32 bytes.
        assert_eq!(STANDARD.encode(bytes), DEV_PUBLIC_KEY_B64);
    }

    /// Golden vector: minted by the license worker's TypeScript implementation
    /// (`worker/src/tokens.ts`) with the dev signing key. If either side
    /// changes the token format, one of the two tests named in the comment
    /// fails and the mismatch is impossible to miss.
    pub const WORKER_VECTOR: &str = "eyJ2IjoxLCJzdWIiOiJjMDdiMWYzN2I5MGU4MmJhOTU5Mzg1NDVhMDIzNTFhYiIsImRldiI6ImRldmljZS0xIiwiZW50IjpbInBybyJdLCJpYXQiOjE3MDAwMDAwMDAsImV4cCI6NDEwMjQ0NDgwMH0.BxbtMOe73PIdz74DJNhzVCA1ovovbWHa9HQKMPOmlzbCdeLKmjEdQkHKZZzoPOTlrVMnMIYFx-pS_n6PEJ0BCg";

    #[test]
    fn worker_minted_token_verifies_offline() {
        let claims = verify_with_key(
            WORKER_VECTOR,
            1_700_000_001,
            Some("device-1"),
            &public_key_bytes(),
        )
        .expect("a token minted by the worker must verify in the app");
        assert_eq!(
            claims.sub,
            license_subject("txn_01vect0rvect0rvect0rvect01")
        );
        assert_eq!(claims.dev, "device-1");
        assert_eq!(claims.iat, 1_700_000_000);
        assert_eq!(claims.exp, 4_102_444_800);
        assert!(is_pro(&claims));
        // Still rejected for a different device and after expiry.
        assert_eq!(
            verify_with_key(
                WORKER_VECTOR,
                1_700_000_001,
                Some("device-2"),
                &public_key_bytes()
            ),
            Err(VerifyError::WrongDevice)
        );
        assert_eq!(
            verify_with_key(
                WORKER_VECTOR,
                4_102_444_801,
                Some("device-1"),
                &public_key_bytes()
            ),
            Err(VerifyError::Expired)
        );
    }

    #[test]
    fn subject_is_stable_and_hashed() {
        let a = license_subject("txn_01aaaaaabbbbbbccccccddddd");
        let b = license_subject("txn_01aaaaaabbbbbbccccccddddd");
        let c = license_subject("txn_01eeeeeeffffffgggggghhhhh");
        assert_eq!(a, b);
        assert_ne!(a, c);
        assert_eq!(a.len(), 32);
        assert!(
            !a.contains("txn_"),
            "subject must not leak the raw license code"
        );
    }
}
