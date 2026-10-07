/**
 * Whether freebuff-jobs writes the nightly engagement snapshot to Postgres
 * `platform_daily_stats` (COD-742; docs/freebuff-jobs.md, "snapshot daily
 * stats") — the checked-in switch for moving Convex's `snapshot daily stats`
 * cron off platform Convex.
 *
 * - `convex`  (default): only the Convex cron writes, into `daily_stats`,
 *             `web_daily_stats` and `cloud_daily_stats`. The graphile task
 *             returns at once.
 * - `dual`    the graphile task ALSO writes `platform_daily_stats` from the
 *             Postgres mirrors, beside the unchanged Convex cron, so the two
 *             can be compared day by day. Turn it on only once the mirrors it
 *             reads are seeded and current (`user_profile`, the project spine,
 *             the agent core `cloud_agent_run`): a day snapshotted from a
 *             half-filled mirror is wrong, though it can be recomputed while
 *             the runs it counts are still in `cloud_agent_run`.
 *
 * Daily active users come from the Postgres agent run ledger (Owen,
 * 2026-10-06), not from BigQuery `MESSAGE_SENT`.
 *
 * A flip is a reviewed one-line diff here, never an env var. Retiring the
 * Convex cron is a later step: the admin readers move to Postgres first.
 */
export type PlatformDailyStatsBackend = 'convex' | 'dual'

export const PLATFORM_DAILY_STATS_BACKEND: PlatformDailyStatsBackend = 'convex'

/** Whether the graphile task writes `platform_daily_stats`. */
export function platformDailyStatsWritesPostgres(
  backend: PlatformDailyStatsBackend = PLATFORM_DAILY_STATS_BACKEND,
): boolean {
  return backend === 'dual'
}
