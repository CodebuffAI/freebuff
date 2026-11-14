/**
 * Which store answers the god admin panel's reads (`freebuff/web/convex/admin.ts`:
 * user and project lookups, pause status, members, platform statistics):
 * the checked-in switch for moving them off platform Convex (COD-742,
 * "Admin, stats, tickets and email"). The data is the identity and project
 * spine mirrors, which their own lanes keep current; this switch moves only
 * the reads.
 *
 * - `convex`   Convex answers. The registry entries answer `unknown_function`.
 * - `shadow`   the panel's queries render Convex and fetch Postgres
 *              in the background, logging `convex_pg_shadow_mismatch` on a
 *              difference. Its one action (`getUserDetails`) stays on Convex.
 * - `postgres` (current, since 2026-10-19 after two days of shadow) the registry answers every one of them. The Convex functions
 *              stay deployed as the rollback.
 *
 * A flip is a reviewed one-line diff here, never an env var.
 */
export type AdminReadsBackend = 'convex' | 'shadow' | 'postgres'

export const ADMIN_READS_BACKEND: AdminReadsBackend = 'postgres'

/** Whether the registry entries answer at all (`shadow` or `postgres`). */
export function adminReadsServedFromPostgres(
  backend: AdminReadsBackend = ADMIN_READS_BACKEND,
): boolean {
  return backend !== 'convex'
}
