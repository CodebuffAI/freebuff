/**
 * The wire contract between the freebuff-jobs worker and freebuff-web's
 * `POST /api/admin/support-jobs` (COD-742 Wave A; docs/convex-retirement-
 * wave-a.md, "Issue reports and feedback messages"). The worker owns the
 * retry; freebuff-web owns the work, because the email templates, Resend, the
 * blob store (screenshot URLs) and the Convex admin client (thread context)
 * all live there. The `feed_hub` job went with the frozen feedback hub
 * (docs/freebuff-feedback-hub.md).
 *
 * Plain types and a hand-written parser rather than zod: both a Next route
 * and a leaf-only package read this.
 */

export const SUPPORT_JOB_SOURCES = [
  'issue_report',
  'feedback_message',
] as const
export type SupportJobSource = (typeof SUPPORT_JOB_SOURCES)[number]

export const SUPPORT_JOBS = ['send_notification'] as const
export type SupportJobName = (typeof SUPPORT_JOBS)[number]

export type SupportJobRequest = {
  job: SupportJobName
  source: SupportJobSource
  /** The Postgres row id (the Convex `_id` for a backfilled row). */
  id: string
}

export type SupportJobOutcome =
  /** The row is not in Postgres (wrong id, or rolled back): nothing to do. */
  | 'missing'
  /** Already emailed (a retried job): nothing sent. */
  | 'already_sent'
  | 'sent'
  /** Resend refused, or is not configured: recorded on the row, not retried. */
  | 'failed'

export type SupportJobResponse = {
  job: SupportJobName
  ran: true
  outcome: SupportJobOutcome
}

export function parseSupportJobRequest(value: unknown): SupportJobRequest | null {
  if (typeof value !== 'object' || value === null) return null
  const { job, source, id } = value as Record<string, unknown>
  if (typeof job !== 'string' || !(SUPPORT_JOBS as readonly string[]).includes(job)) {
    return null
  }
  if (
    typeof source !== 'string' ||
    !(SUPPORT_JOB_SOURCES as readonly string[]).includes(source)
  ) {
    return null
  }
  if (typeof id !== 'string' || id.length === 0 || id.length > 200) return null
  return { job: job as SupportJobName, source: source as SupportJobSource, id }
}
