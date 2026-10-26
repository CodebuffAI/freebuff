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

/**
 * The stale-move backstop of a Cloud snapshot migration that ran on
 * freebuff-web (docs/freebuff-sandbox-workspace-actions.md, "The Cloud
 * snapshot migration"): the `cleanupStaleMigration` / `cleanupStaleRollback`
 * bodies of `convex/cloud/sandboxMigration.ts`. Ids only, never credentials.
 */
export type SnapshotMigrationCleanup =
  | { kind: 'migration'; projectId: string; attemptId: string }
  | {
      kind: 'rollback'
      projectId: string
      attemptId: string
      rollbackAttemptId: string
      currentSandboxId: string
    }

/**
 * A cold start's Daytona attach (`codesandbox/projectCrud:attachDaytonaToInitializingProject`),
 * forwarded by the Convex action `initializeUnassignedProject` so freebuff-web
 * runs the mutation through Postgres (docs/freebuff-project-pool.md, "Cold
 * start"). The raw Daytona sandbox id, its preview URL and the detected
 * package manager; no credentials.
 */
export type ColdStartDaytonaAttach = {
  projectId: string
  sandboxId: string
  previewUrl: string
  packageManager: 'pnpm' | 'bun'
}

export type SandboxJobRequest =
  | { job: SandboxSweepRequestJob }
  /** Forwarded by Convex's cold start, not scheduled: no runner-table entry
   *  owns it. */
  | { job: 'attach_cold_start_daytona'; attach: ColdStartDaytonaAttach }
  /** One delayed `sandbox_migration.cleanup` job. Enqueued only by
   *  freebuff-web's own migration, so no runner-table entry owns it. */
  | { job: 'snapshot_migration_cleanup'; cleanup: SnapshotMigrationCleanup }
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
  | { job: 'snapshot_migration_cleanup'; ran: true; durationMs: number }
  | { job: 'attach_cold_start_daytona'; ran: true; durationMs: number }

/** Which runner-table entry a request belongs to: the route refuses a request
 *  whose job is not owned by `graphile`, so a stray POST can never make a
 *  sweep run beside its Convex cron. Null for a job no Convex cron runs (a
 *  migration cleanup: its producer is the freebuff-web migration itself,
 *  and the Convex migration keeps its own scheduler). */
export function sandboxJobForRequest(
  request: SandboxJobRequest,
): SandboxJobName | null {
  switch (request.job) {
    case 'dispatch_pool_jobs':
    case 'provision_pool_slot':
      return 'provision_pool'
    case 'snapshot_migration_cleanup':
    case 'attach_cold_start_daytona':
      return null
    default:
      return request.job
  }
}

/** Convex document ids (pool jobs, projects) are lowercase alphanumerics;
 *  refuse anything else. */
const POOL_JOB_ID = /^[a-z0-9]{1,64}$/

/** A migration or rollback attempt id (a UUID, or the linux-vm move's own). */
const ATTEMPT_ID = /^[A-Za-z0-9:_-]{1,128}$/
/** A prefixed sandbox id (`daytona:<uuid>`). */
const SANDBOX_ID = /^[A-Za-z0-9:_.-]{1,200}$/

export function parseSnapshotMigrationCleanup(
  value: unknown,
): SnapshotMigrationCleanup | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const { kind, projectId, attemptId, rollbackAttemptId, currentSandboxId } =
    value as Record<string, unknown>
  if (
    typeof projectId !== 'string' ||
    !POOL_JOB_ID.test(projectId) ||
    typeof attemptId !== 'string' ||
    !ATTEMPT_ID.test(attemptId)
  ) {
    return null
  }
  if (kind === 'migration') return { kind, projectId, attemptId }
  if (
    kind === 'rollback' &&
    typeof rollbackAttemptId === 'string' &&
    ATTEMPT_ID.test(rollbackAttemptId) &&
    typeof currentSandboxId === 'string' &&
    SANDBOX_ID.test(currentSandboxId)
  ) {
    return { kind, projectId, attemptId, rollbackAttemptId, currentSandboxId }
  }
  return null
}

/** A raw Daytona sandbox id (a UUID; the `daytona:` prefix is added by the
 *  mutation). */
const RAW_SANDBOX_ID = /^[A-Za-z0-9_.-]{1,200}$/
const MAX_PREVIEW_URL = 2048

export function parseColdStartDaytonaAttach(
  value: unknown,
): ColdStartDaytonaAttach | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const { projectId, sandboxId, previewUrl, packageManager } = value as Record<
    string,
    unknown
  >
  if (
    typeof projectId !== 'string' ||
    !POOL_JOB_ID.test(projectId) ||
    typeof sandboxId !== 'string' ||
    !RAW_SANDBOX_ID.test(sandboxId) ||
    typeof previewUrl !== 'string' ||
    previewUrl.length > MAX_PREVIEW_URL ||
    !/^https?:\/\//.test(previewUrl) ||
    (packageManager !== 'pnpm' && packageManager !== 'bun')
  ) {
    return null
  }
  return { projectId, sandboxId, previewUrl, packageManager }
}

export function parseSandboxJobRequest(body: unknown): SandboxJobRequest | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const { job, poolJobId, cleanup, attach } = body as Record<string, unknown>
  if (job === 'snapshot_migration_cleanup') {
    const parsed = parseSnapshotMigrationCleanup(cleanup)
    return parsed ? { job, cleanup: parsed } : null
  }
  if (job === 'attach_cold_start_daytona') {
    const parsed = parseColdStartDaytonaAttach(attach)
    return parsed ? { job, attach: parsed } : null
  }
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
