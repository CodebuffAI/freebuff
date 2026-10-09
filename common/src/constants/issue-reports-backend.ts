/**
 * Which store owns issue reports and in-app feedback messages (Convex
 * `issue_reports` and `feedback_message`; Postgres `issue_report` and
 * `feedback_message`, migration 0336) — the checked-in switch for moving them
 * off platform Convex (COD-742 Wave A, light tier; runbook in
 * docs/convex-retirement-wave-a.md, "Issue reports and feedback messages").
 *
 * - `convex`   (default): Convex is the writer and the reader, exactly as
 *              before the port. Nothing in the Postgres port runs, and the
 *              registry entries answer `unknown_function`.
 * - `postgres` every write is ONE Postgres transaction (per-user advisory
 *              lock, the 24h quota, the INSERT, and the notification email
 *              as a graphile job). The web form and `/api/feedback` call
 *              Postgres directly; the native apps keep calling the same
 *              Convex functions, which forward the submit to freebuff-web and
 *              answer the quota with a shim. The Convex functions stay
 *              deployed as the rollback.
 *
 * One constant for both tables: they share the email path and the Axiom
 * `feedback.received` event (docs/logging.md, "User feedback"). The
 * feedback-hub feed and sweep they also shared are gone with the frozen hub
 * (docs/freebuff-feedback-hub.md).
 *
 * Imported by Convex as well as by the Next servers, so it must stay a leaf.
 * A flip is a reviewed one-line diff here, never an env var; the revert is the
 * same diff while the Convex functions still exist.
 */
export type IssueReportsBackend = 'convex' | 'postgres'

export const ISSUE_REPORTS_BACKEND: IssueReportsBackend = 'convex'

/** Whether `backend` serves issue reports and feedback messages from Postgres. */
export function issueReportsOnPostgres(
  backend: IssueReportsBackend = ISSUE_REPORTS_BACKEND,
): boolean {
  return backend === 'postgres'
}
