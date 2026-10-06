/**
 * Which store owns the GitHub domain (`github_connections`,
 * `github_sync_state`) — the checked-in switch for moving it off platform
 * Convex (COD-742 batch 6, track E3; docs/freebuff-github-postgres.md). Full
 * tier: shadow for 7 days with zero mismatches, then a 14-day zero-call soak.
 *
 * - `convex`   Convex is the writer and the reader. Nothing in the Postgres
 *              port runs.
 * - `shadow`   (current; Owen, 2026-10-06) Convex still writes and serves. Server paths that read a
 *              connection or a sync state also read the Postgres copy (a
 *              connection that lags Convex is refreshed from Convex's
 *              current document before it is compared) and log
 *              `convex_pg_shadow_row_mismatch` with ids and column NAMES only:
 *              never a value, and never a token.
 * - `postgres` Postgres writes and serves. Token reads go to the PRIMARY.
 *
 * It lives in `common` because both sides read it: Convex (which may import
 * only `@codebuff/common`) and the server/job code. A flip is a reviewed
 * one-line diff here, never an env var.
 */
export type GitHubBackendMode = 'convex' | 'shadow' | 'postgres'

export const GITHUB_BACKEND: GitHubBackendMode = 'shadow'

/** Who serves GitHub READS in `mode`. Shadow still serves Convex. */
export function githubReadBackend(
  mode: GitHubBackendMode = GITHUB_BACKEND,
): 'convex' | 'postgres' {
  return mode === 'postgres' ? 'postgres' : 'convex'
}

/** Who performs GitHub WRITES in `mode`: exactly one store, never both. */
export function githubWriteBackend(
  mode: GitHubBackendMode = GITHUB_BACKEND,
): 'convex' | 'postgres' {
  return mode === 'postgres' ? 'postgres' : 'convex'
}

/** Whether `mode` also reads Postgres to compare against Convex. */
export function githubShadowEnabled(
  mode: GitHubBackendMode = GITHUB_BACKEND,
): boolean {
  return mode === 'shadow'
}

/**
 * Who answers `POST /github/webhook` once GitHub is pointed at freebuff.com
 * (`/api/edge/github/webhook`).
 *
 * - `convex_proxy` (default): the Next route is a transparent proxy to the
 *              Convex httpAction, byte for byte (signature included).
 * - `next`     the Next route verifies the HMAC on the raw body itself, drops
 *              what Convex would drop, and enqueues ONE freebuff-jobs job per
 *              event it owns (push, installation, pull_request). Everything
 *              else Convex still acts on (feedback hub events, CI signals) is
 *              forwarded raw, so Convex re-verifies the same signature.
 *
 * Independent of {@link GITHUB_BACKEND}: the receiver can move first, with
 * every job still executing against Convex.
 */
export type GitHubWebhookReceiverMode = 'convex_proxy' | 'next'

export const GITHUB_WEBHOOK_RECEIVER: GitHubWebhookReceiverMode =
  'convex_proxy'
