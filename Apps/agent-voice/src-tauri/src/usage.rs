//! Free-tier usage accounting: a rolling daily allowance of transcribed seconds.
//!
//! The counter is persisted to disk and reset whenever the UTC day changes.
//! Enforcement lives on the Rust side so the webview cannot bypass it.

use serde::{Deserialize, Serialize};

/// Free tier: 30 minutes transcribed per day.
pub const FREE_DAILY_SECONDS: u32 = 30 * 60;
/// Minimum remaining allowance required to *start* an utterance (avoids
/// starting a recording that cannot be billed against the quota).
pub const MIN_START_SECONDS: u32 = 10;

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct Usage {
    /// UTC day key (`YYYY-MM-DD`) the counter belongs to.
    pub day: String,
    pub used_seconds: u32,
}

/// `YYYY-MM-DD` (UTC) for a unix timestamp.
///
/// Uses Howard Hinnant's `civil_from_days` algorithm — no chrono dependency.
pub fn day_key(unix_seconds: i64) -> String {
    let days = unix_seconds.div_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    format!("{y:04}-{m:02}-{d:02}")
}

fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365; // [0, 399]
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32; // [1, 12]
    (if m <= 2 { y + 1 } else { y }, m, d)
}

impl Usage {
    /// Reset the counter when the UTC day has changed.
    pub fn roll(&mut self, now_unix: i64) {
        let key = day_key(now_unix);
        if self.day != key {
            self.day = key;
            self.used_seconds = 0;
        }
    }

    pub fn remaining(&self, limit: u32) -> u32 {
        limit.saturating_sub(self.used_seconds)
    }

    /// Whether a new utterance may start right now.
    pub fn can_start(&self, limit: u32) -> bool {
        self.remaining(limit) >= MIN_START_SECONDS
    }

    /// Consume `seconds` against today's allowance. Returns `false` (and caps
    /// the counter at the limit) when the allowance is exhausted.
    pub fn consume(&mut self, now_unix: i64, seconds: u32, limit: u32) -> bool {
        self.roll(now_unix);
        if self.used_seconds >= limit {
            return false;
        }
        self.used_seconds = (self.used_seconds + seconds).min(limit);
        true
    }
}

/// Effective daily limit for a tier (`pro` → unlimited, modeled as `None`).
pub fn daily_limit_seconds(tier: &str) -> Option<u32> {
    match tier {
        "pro" => None,
        _ => Some(FREE_DAILY_SECONDS),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn day_key_known_timestamps() {
        assert_eq!(day_key(0), "1970-01-01");
        assert_eq!(day_key(86_399), "1970-01-01");
        assert_eq!(day_key(86_400), "1970-01-02");
        // 2026-01-01T00:00:00Z
        assert_eq!(day_key(1_767_225_600), "2026-01-01");
        // 2026-10-05T12:34:56Z = 1767225600 + 277 days * 86400 + 45296
        assert_eq!(day_key(1_767_225_600 + 277 * 86_400 + 45_296), "2026-10-05");
        // Leap-year boundary: 2024-02-29
        assert_eq!(day_key(1_709_164_800), "2024-02-29");
    }

    #[test]
    fn rolls_on_day_change_only() {
        let mut u = Usage::default();
        u.consume(1_000_000_000, 60, FREE_DAILY_SECONDS);
        assert_eq!(u.used_seconds, 60);
        // Same UTC day: counter persists.
        u.roll(1_000_000_000 + 3_600);
        assert_eq!(u.used_seconds, 60);
        // Next UTC day: resets.
        u.roll(1_000_000_000 + 86_400);
        assert_eq!(u.used_seconds, 0);
        assert_eq!(u.day, day_key(1_000_000_000 + 86_400));
    }

    #[test]
    fn consume_caps_at_limit() {
        let mut u = Usage::default();
        let now = 1_000_000_000;
        assert!(u.consume(now, 1_700, FREE_DAILY_SECONDS));
        assert!(u.consume(now, 200, FREE_DAILY_SECONDS));
        assert_eq!(u.used_seconds, FREE_DAILY_SECONDS);
        // Exhausted: further consumption refused.
        assert!(!u.consume(now, 10, FREE_DAILY_SECONDS));
        assert_eq!(u.used_seconds, FREE_DAILY_SECONDS);
    }

    #[test]
    fn start_gate_respects_minimum() {
        let mut u = Usage::default();
        let now = 1_000_000_000;
        u.consume(now, FREE_DAILY_SECONDS - 5, FREE_DAILY_SECONDS);
        assert!(!u.can_start(FREE_DAILY_SECONDS));
        assert_eq!(u.remaining(FREE_DAILY_SECONDS), 5);
        assert!(!u.can_start(FREE_DAILY_SECONDS));
    }

    #[test]
    fn pro_tier_has_no_limit() {
        assert_eq!(daily_limit_seconds("pro"), None);
        assert_eq!(daily_limit_seconds("free"), Some(FREE_DAILY_SECONDS));
    }
}
