/**
 * Who FIRES each platform Convex cron whose data stays in Convex for now —
 * the checked-in switch for moving their scheduling off Convex (COD-742,
 * docs/freebuff-jobs.md). In either mode the same code reads and writes the
 * same Convex tables; only the process that starts it changes. Moving the
 * data is each domain's own work and brings its own switch.
 *
 * - `convex`   (default): today. The Convex cron fires; the graphile task logs
 *              and returns.
 * - `graphile` The freebuff-jobs crontab fires the task, which asks
 *              freebuff-web (`POST /api/admin/convex-cron-jobs`) to run the job
 *              over the Convex admin client; the Convex cron returns at once.
 *
 * Exactly one runner per job, as in ./sandbox-jobs-runner.ts: both sides read
 * this one table, so a flip is a single reviewed diff. Never an env var.
 *
 * How a Convex function tells the two apart: the cron passes
 * `trigger: 'cron'` and returns at once unless Convex owns the job;
 * freebuff-web passes `trigger: 'graphile'` and the function refuses unless
 * graphile owns it. A call with no trigger (a self-scheduled next page, an
 * admin's manual run) always runs.
 *
 * DEPLOY ORDER for a flip to `graphile`: the jobs worker must already run with
 * `FREEBUFF_WEB_INTERNAL_URL` and `SPEND_ROLLUP_CRON_SECRET`, and freebuff-web
 * must carry the env any job body it runs itself reads (for
 * `reconcile_pr_delivery`: the GitHub App id, slug and private key, and
 * `CLOUD_PR_BACKSTOP_MAX` if Convex sets it). The other jobs still run inside
 * Convex and need nothing new. In the gap between the Convex and freebuff-web
 * deploys a job may run twice or skip a tick; every job here re-checks each
 * row, so either is harmless for one tick.
 */
export type ConvexCronJobRunner = 'convex' | 'graphile'

export const CONVEX_CRON_JOB_NAMES = [
  /** Convex cron `enforce agent processing deadlines` (1 min): schedules one
   *  `forceFinishOverdueMessage` per streaming message past its deadline. */
  'enforce_processing_deadlines',
  /** Convex cron `reconcile cloud PR delivery` (30 min): re-reads PR state
   *  from GitHub for threads the webhook has not touched in 6 hours. */
  'reconcile_pr_delivery',
  /** Convex cron `reconcile convex usage limits` (5 min): caps users' app
   *  Convex deployments and PAUSES owners over their allowance. */
  'reconcile_usage_limits',
  /** Convex cron `enforce legacy convex usage limits` (Mon 09:00 UTC): caps
   *  the pre-cutoff fleet page by page and PAUSES owners over a cap. */
  'enforce_legacy_usage_limits',
  /** Convex cron `audit fleet usage from axiom` (Wed 09:00 UTC): the pooled
   *  month judgement from Axiom; PAUSES owners. */
  'audit_fleet_usage',
  /** Convex cron `sweep timed out freebuff agent runs` (1 min): reaps runs
   *  past their claim, heartbeat or turn deadline and finalizes their
   *  messages. NOT a Convex-data job: under `graphile` freebuff-web runs the
   *  POSTGRES sweep (freebuff/web src/server/agent-core-writes/
   *  run-sweep-runtime.ts), so this entry moves only with the agent core
   *  writer (`AGENT_CORE_WRITER_FOR_CONVEX`, ./agent-core-writer.ts); a test
   *  holds the two together. */
  'sweep_freebuff_runs',
  /** Convex cron `sweep timed out codex and claude agent runs` (1 min):
   *  clears Codex / Claude Code threads stuck processing past the idle
   *  window. Convex's agent_thread rows, as `enforce_processing_deadlines`. */
  'sweep_cli_agent_runs',
  /** Convex cron `rotate expiring github tokens` (60 min): renews OAuth
   *  refresh tokens near their lapse, against Convex's `github_connections`.
   *  Only the trigger moves: Convex's action still rotates, so exactly one
   *  system rotates in either position (docs/freebuff-github-postgres.md,
   *  "Rotation"). The Postgres rotation replaces this job, not this switch. */
  'rotate_github_tokens',
  /** Convex cron `sweep expired request-intent evaluation cohorts` (15 min):
   *  the privacy TTL that deletes one expired capture batch per tick from
   *  Convex. Moving its trigger deletes nothing new; it must keep running
   *  while any batch lives in Convex. */
  'sweep_request_intent_eval_cohorts',
] as const

export type ConvexCronJobName = (typeof CONVEX_CRON_JOB_NAMES)[number]

export type ConvexCronJobRunners = Readonly<
  Record<ConvexCronJobName, ConvexCronJobRunner>
>

export const CONVEX_CRON_JOB_RUNNERS: ConvexCronJobRunners = {
  enforce_processing_deadlines: 'graphile',
  reconcile_pr_delivery: 'convex',
  reconcile_usage_limits: 'graphile',
  enforce_legacy_usage_limits: 'graphile',
  audit_fleet_usage: 'graphile',
  sweep_freebuff_runs: 'convex',
  sweep_cli_agent_runs: 'convex',
  rotate_github_tokens: 'convex',
  sweep_request_intent_eval_cohorts: 'convex',
}

/**
 * Whether `runner` owns `job`. An unknown value (a bad edit) answers false
 * for both runners: the job stops rather than runs twice.
 */
export function convexCronJobOwnedBy(
  job: ConvexCronJobName,
  runner: ConvexCronJobRunner,
  runners: ConvexCronJobRunners = CONVEX_CRON_JOB_RUNNERS,
): boolean {
  const owner = runners[job]
  if (owner !== 'convex' && owner !== 'graphile') return false
  return owner === runner
}

export function isConvexCronJobName(value: unknown): value is ConvexCronJobName {
  return (
    typeof value === 'string' &&
    (CONVEX_CRON_JOB_NAMES as readonly string[]).includes(value)
  )
}
