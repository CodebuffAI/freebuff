/**
 * Minimal in-memory fixed-window rate limiter, shared by the unauthenticated
 * `/api/logs` ingest endpoints (browser + anonymous CLI). Per-instance and
 * best-effort — good enough to blunt abuse/cost on a single Render instance,
 * not a distributed guarantee. Kept dependency-free and `now`-injectable so the
 * window logic is unit-testable.
 */
export interface FixedWindowRateLimiter {
  /** Returns true if `key` has exceeded the window's request budget. */
  limited(key: string, now: number): boolean
}

export function createFixedWindowRateLimiter(opts: {
  windowMs: number
  max: number
  /** Prune expired entries once the map grows past this. Defaults to 10k. */
  maxKeys?: number
}): FixedWindowRateLimiter {
  const { windowMs, max, maxKeys = 10_000 } = opts
  const hits = new Map<string, { count: number; resetAt: number }>()
  let lastPruneAt = 0

  return {
    limited(key: string, now: number): boolean {
      const entry = hits.get(key)
      if (!entry || now >= entry.resetAt) {
        hits.set(key, { count: 1, resetAt: now + windowMs })
        // Bound map growth: prune expired entries, but at most once per window
        // so a steady stream of live keys can't trigger an O(n) scan per call.
        if (hits.size > maxKeys && now - lastPruneAt >= windowMs) {
          lastPruneAt = now
          for (const [k, v] of hits) if (now >= v.resetAt) hits.delete(k)
        }
        return false
      }
      entry.count++
      return entry.count > max
    },
  }
}
