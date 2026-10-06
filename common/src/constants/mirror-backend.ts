/**
 * Which store owns the Desktop to phone mirror (the `mirror_*` tables) — the
 * checked-in switch for moving the mirror off platform Convex (COD-742 batch
 * 5, track D1; docs/freebuff-mirror-postgres.md).
 *
 * LIGHT tier, so there is no shadow mode: the Desktop's local SQLite is the
 * source of truth and re-pushes every open thread on connect, so the
 * Postgres copy rebuilds itself after a flip and a flip back loses nothing.
 *
 * - `convex`   (default): Desktop is told to use Convex, every
 *              `/api/fn/*` mirror entry answers `unknown_function`, the
 *              `mirror.*` jobs no-op and the mobile config keeps phones on
 *              Convex.
 * - `postgres` freebuff-web advertises `mirror_backend: 'postgres'` to
 *              Desktop and `mirrorBackend: 'postgres'` to the phones, the
 *              registry entries serve, and the APNs push and retention sweep
 *              run as graphile jobs.
 *
 * It lives in `common` because freebuff-web (advertisement, registry) and
 * the `freebuff-jobs` worker (push, sweep) both read it. A flip is a reviewed
 * one-line diff here, never an env var.
 */
export type MirrorBackend = 'convex' | 'postgres'

export const MIRROR_BACKEND: MirrorBackend = 'convex'

/** Whether the Postgres mirror is in charge in `mode`. */
export function mirrorPostgresEnabled(
  mode: MirrorBackend = MIRROR_BACKEND,
): boolean {
  return mode === 'postgres'
}
