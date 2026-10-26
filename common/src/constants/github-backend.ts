/**
 * Which store owns the GitHub domain (`github_connections`,
 * `github_sync_state`) — the checked-in switch for moving it off platform
 * Convex (COD-742 batch 6, track E3; docs/freebuff-github-postgres.md). Full
 * tier: shadow for 7 days with zero mismatches, then a 14-day zero-call soak.
 *
 * - `convex`   Convex is the writer and the reader. Nothing in the Postgres
 *              port runs.
 * - `shadow`   (2026-10-06 to the flip) Convex wrote and served while the
 *              runner's token read compared the Postgres copy. The comparison
 *              was removed after the flip (2026-10-26), so `shadow` now
 *              behaves as `convex`.
 * - `postgres` (current; Owen, 2026-10-25) Postgres writes and serves. Token
 *              reads go to the PRIMARY. Every Convex GitHub action goes
 *              through `githubStore`'s bridge; the cutover is
 *              docs/freebuff-github-postgres.md, "The cutover".
 *
 * It lives in `common` because both sides read it: Convex (which may import
 * only `@codebuff/common`) and the server/job code. A flip is a reviewed
 * one-line diff here, never an env var.
 */
export type GitHubBackendMode = 'convex' | 'shadow' | 'postgres'

export const GITHUB_BACKEND: GitHubBackendMode = 'postgres'

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
 * - `convex_proxy`: the Next route is a transparent proxy to the
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

export const GITHUB_WEBHOOK_RECEIVER: GitHubWebhookReceiverMode = 'next'
