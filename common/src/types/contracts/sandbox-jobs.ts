import type { SandboxJobName } from '../../constants/sandbox-jobs-runner'

/**
 * The wire contract between the freebuff-jobs worker and freebuff-web's
 * `POST /api/admin/sandbox-jobs` (COD-742 E1; docs/freebuff-sandbox-jobs.md).
 * The worker owns the SCHEDULE (crontab, per-slot jobs, retries); freebuff-web
 * owns the EXECUTION, because the sweep bodies, the Daytona SDK wiring and the
 * Convex admin client all live there. The data stays in Convex either way.
 *
 * Plain types and a hand-written parser rather than zod: both a Next route and
 * a leaf-only package read this, and it is five shapes.
 */

/** Jobs that are one sweep, run to completion inside the request. */
export const SANDBOX_SWEEP_REQUEST_JOBS = [
  'reconcile_pool',
  'sweep_errored',
  'sweep_storage',
  'sweep_run_leases',
  'sleep_idle',
] as const

export type SandboxSweepRequestJob = (typeof SANDBOX_SWEEP_REQUEST_JOBS)[number]

export type SandboxJobRequest =
  | { job: SandboxSweepRequestJob }
  /** List `daytona_pool_job` rows still `scheduled`; the worker enqueues one
   *  `sandbox.provision_pool_slot` per row. Claims nothing. */
  | { job: 'dispatch_pool_jobs' }
  /** Claim one row with the Convex CAS, provision it, settle it. */
  | { job: 'provision_pool_slot'; poolJobId: string }

export type PoolSlotOutcome =
  | { status: 'not_claimed' }
  | { status: 'provisioned'; snapshotId: string }
  | {
      status: 'failed'
      snapshotId: string
      failure: 'capacity' | 'dead_snapshot' | 'other'
    }

export type SandboxJobResponse =
  | { job: SandboxSweepRequestJob; ran: true; durationMs: number }
  | {
      job: 'dispatch_pool_jobs'
      ran: true
      poolJobs: Array<{ poolJobId: string; snapshotId: string }>
    }
  | { job: 'provision_pool_slot'; ran: true; outcome: PoolSlotOutcome }

/** Which runner-table entry a request belongs to: the route refuses a request
 *  whose job is not owned by `graphile`, so a stray POST can never make a
 *  sweep run beside its Convex cron. */
export function sandboxJobForRequest(
  request: SandboxJobRequest,
): SandboxJobName {
  switch (request.job) {
    case 'dispatch_pool_jobs':
    case 'provision_pool_slot':
      return 'provision_pool'
    default:
      return request.job
  }
}

/** Convex document ids are lowercase alphanumerics; refuse anything else. */
const POOL_JOB_ID = /^[a-z0-9]{1,64}$/

export function parseSandboxJobRequest(body: unknown): SandboxJobRequest | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const { job, poolJobId } = body as Record<string, unknown>
  if (
    typeof job === 'string' &&
    (SANDBOX_SWEEP_REQUEST_JOBS as readonly string[]).includes(job)
  ) {
    return { job: job as SandboxSweepRequestJob }
  }
  if (job === 'dispatch_pool_jobs') return { job }
  if (
    job === 'provision_pool_slot' &&
    typeof poolJobId === 'string' &&
    POOL_JOB_ID.test(poolJobId)
  ) {
    return { job, poolJobId }
  }
  return null
}
