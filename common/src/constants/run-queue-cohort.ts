/**
 * Which runs the Postgres run queue carries while Convex still writes the
 * agent core (COD-742, docs/freebuff-run-queue.md, "Dual run").
 *
 * Read by Convex `createFreebuffAgentRun`, where every run is created
 * (sends, follow-ups, goals, automations, sponsored runs), so a run's queue is
 * decided ONCE, there, and written on the run as `runner_payload.runQueue`. A
 * run never moves between queues: turning the cohort down leaves every run
 * already marked in Postgres until it ends.
 *
 *   off      every run stays on the Convex queue, and no runner polls
 *            Postgres (today)
 *   drain    no new run goes to Postgres, but runners keep claiming from it:
 *            the first rung going live (runners first) and the last one
 *            rolling back (until the Postgres queue is empty)
 *   staff    god/admin accounts only
 *   <1-99>   that percentage of users by a stable hash of the user id, plus
 *            staff
 *   all      every run
 *
 * A checked-in constant, not an env var and not a Convex feature flag (that
 * table is retired): a rung of the ladder is a reviewed diff plus a Convex
 * deploy, and the runner that claims these runs must be deployed first.
 *
 * Once `AGENT_CORE_WRITER` is `postgres` this constant no longer matters: the
 * Postgres writer creates every run in Postgres and enqueues it in the same
 * transaction.
 */
export type RunQueueCohortSetting =
  | 'off'
  | 'drain'
  | 'staff'
  | 'all'
  | `${number}`

export const RUN_QUEUE_COHORT: RunQueueCohortSetting = 'off'

export type RunQueueCohort =
  | { kind: 'off' }
  | { kind: 'drain' }
  | { kind: 'staff' }
  | { kind: 'percent'; percent: number }
  | { kind: 'all' }

/** An unrecognised value reads as `off`: a typo must never widen a rollout. */
export function parseRunQueueCohort(raw: string | undefined): RunQueueCohort {
  const value = (raw ?? '').trim().toLowerCase()
  if (value === 'all') return { kind: 'all' }
  if (value === 'drain') return { kind: 'drain' }
  if (value === 'staff') return { kind: 'staff' }
  if (/^\d{1,3}$/.test(value)) {
    const percent = Number(value)
    if (percent <= 0) return { kind: 'off' }
    if (percent >= 100) return { kind: 'all' }
    return { kind: 'percent', percent }
  }
  return { kind: 'off' }
}

/**
 * A stable bucket in [0, 100) for a user (FNV-1a over a salted id), so a
 * percentage keeps the same users as it widens. Salted so this cohort is not
 * the runner-service cohort's (`runnerPool.ts`) users again.
 */
export function runQueueCohortBucket(userId: string): number {
  const key = `run-queue:${userId}`
  let hash = 0x811c9dc5
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash % 100
}

/** Whether a new run belongs to the Postgres run queue. */
export function runGoesToPostgresQueue(input: {
  cohort: RunQueueCohort
  userId: string
  userRole: string | undefined
}): boolean {
  const { cohort } = input
  if (cohort.kind === 'off' || cohort.kind === 'drain') return false
  if (cohort.kind === 'all') return true
  const staff = input.userRole === 'god' || input.userRole === 'admin'
  if (cohort.kind === 'staff') return staff
  return staff || runQueueCohortBucket(input.userId) < cohort.percent
}

/**
 * Whether a runner runs the Postgres claim loop: on every setting but `off`,
 * so the runners can be live before the first run is marked and stay live
 * while the last ones drain. Off means no runner opens a Postgres claim loop.
 */
export function runQueueRunnerLoopEnabled(cohort: RunQueueCohort): boolean {
  return cohort.kind !== 'off'
}

/** Whether the cohort needs the user's role to decide (one read saved). */
export function runQueueCohortNeedsRole(cohort: RunQueueCohort): boolean {
  return cohort.kind === 'staff' || cohort.kind === 'percent'
}

/** The value a cohort run carries in `runner_payload.runQueue`. */
export const POSTGRES_RUN_QUEUE = 'postgres' as const

/** Whether a Convex run row (or its listing) belongs to the Postgres queue. */
export function isPostgresQueueRun(run: {
  runner_payload?: { runQueue?: string } | null
}): boolean {
  return run.runner_payload?.runQueue === POSTGRES_RUN_QUEUE
}
