export type ApiKeyRow = {
  id: string
  name: string
  key_prefix: string
  created_at: number
  last_used_at: number | null
  revoked_at: number | null
  rate_limit_rpm: number | null
  monthly_token_budget: number | null
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS api_keys (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    key_prefix TEXT NOT NULL,
    key_hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER,
    revoked_at INTEGER,
    rate_limit_rpm INTEGER,
    monthly_token_budget INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS api_keys_hash_idx ON api_keys (key_hash)`,
  `CREATE TABLE IF NOT EXISTS usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key_id TEXT,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    prompt_tokens INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    status INTEGER NOT NULL,
    latency_ms INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS usage_created_idx ON usage (created_at)`,
  `CREATE INDEX IF NOT EXISTS usage_key_idx ON usage (key_id, created_at)`,
]

let schemaReady: Promise<void> | null = null

/** Idempotent, cached per isolate so local dev needs no migration step. */
export function ensureSchema(db: D1Database): Promise<void> {
  schemaReady ??= (async () => {
    for (const statement of SCHEMA) {
      await db.prepare(statement).run()
    }
  })().catch((error: unknown) => {
    schemaReady = null
    throw error
  })
  return schemaReady
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function randomId(): string {
  return hex(crypto.getRandomValues(new Uint8Array(8)))
}

export function randomKey(): string {
  return `sk-oc-${hex(crypto.getRandomValues(new Uint8Array(24)))}`
}

export async function hashKey(key: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key))
  return hex(new Uint8Array(digest))
}

export function parseBearer(request: Request): string | null {
  const header = request.headers.get('authorization')
  if (!header) return null
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  return match?.[1]?.trim() ?? null
}

export async function createKey(
  db: D1Database,
  input: { name: string; rateLimitRpm: number | null; monthlyTokenBudget: number | null },
): Promise<{ key: string; row: ApiKeyRow }> {
  const key = randomKey()
  const row: ApiKeyRow = {
    id: randomId(),
    name: input.name,
    key_prefix: key.slice(0, 12),
    created_at: Date.now(),
    last_used_at: null,
    revoked_at: null,
    rate_limit_rpm: input.rateLimitRpm,
    monthly_token_budget: input.monthlyTokenBudget,
  }
  await db
    .prepare(
      `INSERT INTO api_keys (id, name, key_prefix, key_hash, created_at, revoked_at, rate_limit_rpm, monthly_token_budget)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
    )
    .bind(
      row.id,
      row.name,
      row.key_prefix,
      await hashKey(key),
      row.created_at,
      row.rate_limit_rpm,
      row.monthly_token_budget,
    )
    .run()
  return { key, row }
}

export async function listKeys(db: D1Database): Promise<ApiKeyRow[]> {
  const result = await db
    .prepare(
      `SELECT id, name, key_prefix, created_at, last_used_at, revoked_at, rate_limit_rpm, monthly_token_budget
       FROM api_keys ORDER BY created_at DESC`,
    )
    .all<ApiKeyRow>()
  return result.results ?? []
}

export async function revokeKey(db: D1Database, id: string): Promise<boolean> {
  const result = await db
    .prepare('UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
    .bind(Date.now(), id)
    .run()
  return (result.meta.changes ?? 0) > 0
}

export async function keyFromRequest(db: D1Database, request: Request): Promise<ApiKeyRow | null> {
  const token = parseBearer(request)
  if (!token) return null
  const row = await db
    .prepare(
      `SELECT id, name, key_prefix, created_at, last_used_at, revoked_at, rate_limit_rpm, monthly_token_budget
       FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL`,
    )
    .bind(await hashKey(token))
    .first<ApiKeyRow>()
  return row ?? null
}

export type LimitCheck = { ok: true } | { ok: false; status: number; message: string }

function monthStart(): number {
  const now = new Date()
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
}

/**
 * Per-key limits are opt-in: a key with NULL limits has none, which is the
 * default. They exist so an owner can cap a key they hand out, not to hide
 * the upstream provider's own quotas.
 */
export async function checkLimits(db: D1Database, key: ApiKeyRow): Promise<LimitCheck> {
  if (key.rate_limit_rpm !== null) {
    const since = Date.now() - 60_000
    const row = await db
      .prepare('SELECT COUNT(*) AS count FROM usage WHERE key_id = ? AND created_at > ?')
      .bind(key.id, since)
      .first<{ count: number }>()
    if ((row?.count ?? 0) >= key.rate_limit_rpm) {
      return {
        ok: false,
        status: 429,
        message: `Key rate limit reached (${key.rate_limit_rpm} requests/minute).`,
      }
    }
  }

  if (key.monthly_token_budget !== null) {
    const row = await db
      .prepare(
        `SELECT COALESCE(SUM(prompt_tokens + completion_tokens), 0) AS tokens
         FROM usage WHERE key_id = ? AND created_at >= ?`,
      )
      .bind(key.id, monthStart())
      .first<{ tokens: number }>()
    if ((row?.tokens ?? 0) >= key.monthly_token_budget) {
      return {
        ok: false,
        status: 429,
        message: `Key monthly token budget reached (${key.monthly_token_budget} tokens).`,
      }
    }
  }

  return { ok: true }
}

export async function recordUsage(
  db: D1Database,
  entry: {
    keyId: string | null
    provider: string
    model: string
    promptTokens: number
    completionTokens: number
    status: number
    latencyMs: number
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO usage (key_id, provider, model, prompt_tokens, completion_tokens, status, latency_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      entry.keyId,
      entry.provider,
      entry.model,
      entry.promptTokens,
      entry.completionTokens,
      entry.status,
      entry.latencyMs,
      Date.now(),
    )
    .run()
  if (entry.keyId) {
    await db
      .prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?')
      .bind(Date.now(), entry.keyId)
      .run()
  }
}

export type UsageSummary = {
  days: number
  totals: { requests: number; promptTokens: number; completionTokens: number }
  byKey: Array<{ keyId: string | null; name: string; requests: number; tokens: number }>
  byDay: Array<{ day: string; requests: number; tokens: number }>
  byModel: Array<{ model: string; requests: number; tokens: number }>
}

export async function summarizeUsage(db: D1Database, days: number): Promise<UsageSummary> {
  const since = Date.now() - Math.max(1, Math.min(days, 365)) * 86_400_000

  const totalRow = await db
    .prepare(
      `SELECT COUNT(*) AS requests,
              COALESCE(SUM(prompt_tokens), 0) AS promptTokens,
              COALESCE(SUM(completion_tokens), 0) AS completionTokens
       FROM usage WHERE created_at >= ?`,
    )
    .bind(since)
    .first<{ requests: number; promptTokens: number; completionTokens: number }>()

  const byKey = await db
    .prepare(
      `SELECT u.key_id AS keyId, COALESCE(k.name, 'unknown key') AS name,
              COUNT(*) AS requests,
              COALESCE(SUM(u.prompt_tokens + u.completion_tokens), 0) AS tokens
       FROM usage u LEFT JOIN api_keys k ON k.id = u.key_id
       WHERE u.created_at >= ? GROUP BY u.key_id ORDER BY tokens DESC LIMIT 50`,
    )
    .bind(since)
    .all<{ keyId: string | null; name: string; requests: number; tokens: number }>()

  const byDay = await db
    .prepare(
      `SELECT date(created_at / 1000, 'unixepoch') AS day,
              COUNT(*) AS requests,
              COALESCE(SUM(prompt_tokens + completion_tokens), 0) AS tokens
       FROM usage WHERE created_at >= ? GROUP BY day ORDER BY day`,
    )
    .bind(since)
    .all<{ day: string; requests: number; tokens: number }>()

  const byModel = await db
    .prepare(
      `SELECT model, COUNT(*) AS requests,
              COALESCE(SUM(prompt_tokens + completion_tokens), 0) AS tokens
       FROM usage WHERE created_at >= ? GROUP BY model ORDER BY tokens DESC LIMIT 20`,
    )
    .bind(since)
    .all<{ model: string; requests: number; tokens: number }>()

  return {
    days,
    totals: totalRow ?? { requests: 0, promptTokens: 0, completionTokens: 0 },
    byKey: byKey.results ?? [],
    byDay: byDay.results ?? [],
    byModel: byModel.results ?? [],
  }
}
