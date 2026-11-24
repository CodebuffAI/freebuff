-- Client keys that opencode uses against this gateway.
-- The plaintext key is never stored: only its SHA-256 hash and a display prefix.
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  key_prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER,
  -- NULL means "no limit" for that key.
  rate_limit_rpm INTEGER,
  monthly_token_budget INTEGER
);

CREATE INDEX IF NOT EXISTS api_keys_hash_idx ON api_keys (key_hash);

-- One row per proxied request, used for the dashboard and for budgets.
CREATE TABLE IF NOT EXISTS usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key_id TEXT,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  status INTEGER NOT NULL,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS usage_created_idx ON usage (created_at);
CREATE INDEX IF NOT EXISTS usage_key_idx ON usage (key_id, created_at);
