/**
 * Which store serves the community pages (Convex `community_*`; Postgres
 * `community_post`, `community_profile` and `community_comment`, migration
 * 0342) — the checked-in switch for the community read-only freeze (COD-742;
 * runbook in docs/convex-retirement-wave-a.md, "Community (read-only freeze)").
 *
 * - `convex`   (default): the `community:*` Convex queries serve every read,
 *              exactly as before. The registry entries answer
 *              `unknown_function` and nothing reads the Postgres copy.
 * - `postgres` the pages (`useFnQuery`), the SEO server render, both sitemaps
 *              and the referral leaderboard's profile lookup read the frozen
 *              Postgres copy. Flip only after the backfill reconciled
 *              `verified`.
 *
 * There is no writer on either side: community has been read-only since the
 * freeze, so the flip needs no write freeze and the revert is the same
 * one-line diff while the Convex queries still exist.
 *
 * Imported by the browser bundle (the backend map) as well as the server, so
 * it must stay a leaf. Never an env var.
 */
export type CommunityBackend = 'convex' | 'postgres'

export const COMMUNITY_BACKEND: CommunityBackend = 'convex'

/** Whether `backend` serves the community reads from Postgres. */
export function communityOnPostgres(
  backend: CommunityBackend = COMMUNITY_BACKEND,
): boolean {
  return backend === 'postgres'
}
