/**
 * Which store owns the Freebuff affiliate program (Convex `affiliates` and
 * `affiliate_*`; Postgres `affiliate` and `affiliate_*`, migration 0336) — the
 * checked-in switch for moving it off platform Convex (COD-742 Wave A,
 * light tier; runbook in docs/convex-retirement-wave-a.md, "Affiliates").
 *
 * - `convex`   (default): Convex is the writer and the reader. Attribution
 *              events go through the HMAC hop to `/api/internal/affiliate/
 *              events`, the partner API proxies to the Convex site, `/r/[code]`
 *              resolves through a Convex query, and the dashboard and admin
 *              pages call Convex. Nothing in the Postgres port runs.
 * - `postgres` every path above reads and writes Postgres in-process: the
 *              senders call the Drizzle writers directly (no HMAC hop), the
 *              partner API is served natively by the Next routes, and the
 *              dashboard/admin functions are served by the function registry.
 *
 * There is deliberately no shadow mode (light tier): flip after the freeze,
 * backfill and a verified reconcile. A flip is a reviewed one-line diff here,
 * never an env var, and the revert is the same diff while the Convex
 * functions still exist.
 */
export type AffiliatesBackend = 'convex' | 'postgres'

export const AFFILIATES_BACKEND: AffiliatesBackend = 'convex'

/** Whether `backend` serves the affiliate program from Postgres. */
export function affiliatesOnPostgres(
  backend: AffiliatesBackend = AFFILIATES_BACKEND,
): boolean {
  return backend === 'postgres'
}
