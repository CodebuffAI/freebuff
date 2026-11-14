/**
 * Which store owns a project's runtime and build errors (Convex
 * `runtime_error` and `build_error`; Postgres tables of the same names) — the
 * checked-in switch for the first part of the sandboxes domain to leave
 * platform Convex (COD-742; runbook in docs/freebuff-sandbox-errors-postgres.md).
 *
 * - `convex`   Convex writes and serves, exactly as before. The
 *              registry entries answer `unknown_function`, nothing reads the
 *              Postgres tables, and the projection chain ends at its next link.
 * - `shadow`   Convex still writes and serves. The `sandbox_errors.projection`
 *              chains copy every Convex change (insert, patch, delete) into
 *              Postgres, and the browser reads both and compares
 *              (`convex_pg_shadow_mismatch`). Writes stay on Convex.
 * - `postgres` (current, Owen 2026-10-19) the web's error panels read and write Postgres, and the
 *              `/runtime-error` intake on freebuff.com writes Postgres. The
 *              chains keep running INSERT-ONLY, for the writers still on
 *              Convex (the Convex deploy pipeline's build errors, apps that
 *              report straight to `*.convex.site`): a new Convex row is added,
 *              a Convex delete is applied, and a Convex patch never overwrites
 *              a status Postgres decided.
 *
 * Every mode but `convex` authorizes through the project spine's Postgres
 * JOIN, so it refuses to serve until the spine reads are on Postgres.
 *
 * Imported by the browser bundle (the backend map), the Next servers and the
 * jobs worker, so it must stay a leaf. A flip is a reviewed one-line diff
 * here, never an env var; the revert is the same diff while the Convex
 * functions still exist.
 */
export type SandboxErrorsBackend = 'convex' | 'shadow' | 'postgres'

export const SANDBOX_ERRORS_BACKEND: SandboxErrorsBackend = 'postgres'

/** Whether the registry serves the error reads (for the browser to compare, in `shadow`). */
export function sandboxErrorsReadsServed(
  backend: SandboxErrorsBackend = SANDBOX_ERRORS_BACKEND,
): boolean {
  return backend !== 'convex'
}

/** Whether Postgres takes the error writes (the panels and the intake). */
export function sandboxErrorsWritesOnPostgres(
  backend: SandboxErrorsBackend = SANDBOX_ERRORS_BACKEND,
): boolean {
  return backend === 'postgres'
}

/**
 * What the Convex → Postgres projection does: nothing at `convex`, mirror
 * Convex exactly at `shadow`, and add only what Postgres lacks at `postgres`.
 */
export type SandboxErrorsProjectionMode = 'off' | 'mirror' | 'insert_only'

export function sandboxErrorsProjectionMode(
  backend: SandboxErrorsBackend = SANDBOX_ERRORS_BACKEND,
): SandboxErrorsProjectionMode {
  if (backend === 'convex') return 'off'
  return backend === 'shadow' ? 'mirror' : 'insert_only'
}
