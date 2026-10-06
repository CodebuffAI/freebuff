/**
 * Which store owns the platform-Convex integration tables that are KEPT
 * (COD-742 batch 6, track E5; docs/freebuff-kept-integrations-postgres.md).
 * Three independent checked-in switches, one per sub-domain, so each can be
 * shadowed and flipped on its own:
 *
 * - `INTEGRATION_BEARER_KEY_BACKEND`: Convex `integration_bearer_keys`, the
 *   per-project keys compiled into users' deployed apps and validated by
 *   integrations-gateway through `/integration-auth/validate`.
 * - `GRAVITY_INTEGRATION_BACKEND`: Convex `gravity_pending_integration`,
 *   Gravity Index attribution (recommended → configured → reported).
 * - `APP_CONVEX_BACKEND`: Convex `project_convex_instance`,
 *   `convex_connections` and `convex_migrations`: OUR tracking of users' app
 *   Convex deployments. The product itself stays on Convex.
 *
 * Each one:
 * - `convex`   (default): Convex is the writer and the reader. Nothing in
 *              the Postgres port runs.
 * - `shadow`   Convex still writes and serves. The server paths that read
 *              these tables also compute the Postgres answer (kept current by
 *              the catch-up/repair script) and log
 *              `convex_pg_shadow_row_mismatch` / `kept_integrations_shadow_mismatch`
 *              with ids, kinds and field NAMES only, never values: these
 *              rows carry keys, tokens, emails and deployment names.
 * - `postgres` The server paths read and write Postgres. A write is never
 *              performed in both stores.
 *
 * It lives in `common` because both sides read it: Convex crons that must
 * yield once Postgres owns a table, and the server. A flip is a reviewed
 * one-line diff here, never an env var. Do NOT flip any of them before the
 * runbook's "Before postgres" list is done: Convex-side readers of each
 * table still exist (the doc lists them), and they would read a table that
 * no longer moves.
 */
export type KeptIntegrationsBackendMode = 'convex' | 'shadow' | 'postgres'

export const INTEGRATION_BEARER_KEY_BACKEND: KeptIntegrationsBackendMode =
  'convex'

export const GRAVITY_INTEGRATION_BACKEND: KeptIntegrationsBackendMode = 'convex'

export const APP_CONVEX_BACKEND: KeptIntegrationsBackendMode = 'convex'

export type KeptIntegrationsDomain = 'bearer_keys' | 'gravity' | 'app_convex'

/**
 * The mode of `domain`. Read through a function (and overridable in tests)
 * so a caller's comparison is not narrowed away by the literal type.
 */
export function keptIntegrationsBackend(
  domain: KeptIntegrationsDomain,
): KeptIntegrationsBackendMode {
  switch (domain) {
    case 'bearer_keys':
      return INTEGRATION_BEARER_KEY_BACKEND
    case 'gravity':
      return GRAVITY_INTEGRATION_BACKEND
    case 'app_convex':
      return APP_CONVEX_BACKEND
  }
}

/** Who serves READS in `mode`. Shadow still serves Convex. */
export function keptIntegrationsReadBackend(
  mode: KeptIntegrationsBackendMode,
): 'convex' | 'postgres' {
  return mode === 'postgres' ? 'postgres' : 'convex'
}

/** Who performs WRITES in `mode`: exactly one store, never both. */
export function keptIntegrationsWriteBackend(
  mode: KeptIntegrationsBackendMode,
): 'convex' | 'postgres' {
  return mode === 'postgres' ? 'postgres' : 'convex'
}

/** Whether `mode` also computes the Postgres answer to compare. */
export function keptIntegrationsShadowEnabled(
  mode: KeptIntegrationsBackendMode,
): boolean {
  return mode === 'shadow'
}
