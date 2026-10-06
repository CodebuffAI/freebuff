/**
 * Which store owns Freebuff Cloud feature-usage events (Convex
 * `cloud_feature_usage` + `cloud_feature_usage_daily`; Postgres
 * `cloud_feature_usage`, migration 0342) — the checked-in switch for moving
 * them off platform Convex (COD-742 Wave A2, light tier; runbook in
 * docs/convex-retirement-wave-a.md, "Cloud feature usage").
 *
 * - `convex`   (default): Convex is the writer and the reader, exactly as
 *              before the port. Nothing in the Postgres port runs, the
 *              registry entries answer `unknown_function`, and the bridge
 *              route answers 409.
 * - `postgres` the writers are still Convex mutations (users, integrations,
 *              invites, BYOK, publish, PR lifecycle) and keep scheduling
 *              `recordCloudFeatureUsage`, which then forwards the event to
 *              freebuff-web instead of inserting it; freebuff-web inserts it
 *              into Postgres. The admin page reads Postgres through the
 *              function registry. The daily counter table has no Postgres
 *              twin: its numbers are a GROUP BY. The Convex functions stay
 *              deployed as the rollback.
 *
 * Imported by Convex as well as by the Next servers, so it must stay a leaf.
 * A flip is a reviewed one-line diff here, never an env var; the revert is the
 * same diff while the Convex functions still exist.
 */
export type CloudFeatureUsageBackend = 'convex' | 'postgres'

export const CLOUD_FEATURE_USAGE_BACKEND: CloudFeatureUsageBackend = 'convex'

/** Whether `backend` serves Cloud feature-usage events from Postgres. */
export function cloudFeatureUsageOnPostgres(
  backend: CloudFeatureUsageBackend = CLOUD_FEATURE_USAGE_BACKEND,
): boolean {
  return backend === 'postgres'
}
