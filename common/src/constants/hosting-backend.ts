/**
 * Which store owns Freebuff hosting (the `deployments`, `domain` and
 * `project_domain` tables) — the checked-in switch for moving hosting off
 * platform Convex (COD-742 batch 5, track E4; docs/freebuff-hosting-postgres.md).
 *
 * - `convex`   (default): Convex is the writer and the reader. Nothing in the
 *              Postgres port runs: no job is enqueued, the graphile cron for
 *              stale deploys no-ops, and the Convex cron keeps sweeping.
 * - `shadow`   Convex still writes and serves. Server paths that read a
 *              deployment also read the Postgres copy (kept current by the
 *              catch-up/repair script) and log `convex_pg_shadow_row_mismatch`
 *              with ids and column NAMES only, never values.
 * - `postgres` Postgres writes and serves; the deploy runs as the
 *              `hosting.deploy_on_freestyle` job; the Convex stale-deploy cron
 *              no-ops so exactly one sweeper ever runs.
 *
 * It lives in `common` because both sides read it: the Convex cron (which may
 * import only `@codebuff/common`) and the server/job code. A flip is a
 * reviewed one-line diff here, never an env var.
 */
export type HostingBackendMode = 'convex' | 'shadow' | 'postgres'

export const HOSTING_BACKEND: HostingBackendMode = 'convex'

/** Who serves hosting READS in `mode`. Shadow still serves Convex. */
export function hostingReadBackend(
  mode: HostingBackendMode = HOSTING_BACKEND,
): 'convex' | 'postgres' {
  return mode === 'postgres' ? 'postgres' : 'convex'
}

/** Who performs hosting WRITES in `mode`: exactly one store, never both. */
export function hostingWriteBackend(
  mode: HostingBackendMode = HOSTING_BACKEND,
): 'convex' | 'postgres' {
  return mode === 'postgres' ? 'postgres' : 'convex'
}

/** Whether `mode` also reads Postgres to compare against Convex. */
export function hostingShadowEnabled(
  mode: HostingBackendMode = HOSTING_BACKEND,
): boolean {
  return mode === 'shadow'
}
