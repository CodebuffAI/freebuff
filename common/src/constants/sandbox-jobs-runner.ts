/**
 * Who RUNS each Daytona sandbox / warm-pool background job — the checked-in
 * switch for moving their execution off platform Convex (COD-742 batch 5,
 * track E1; docs/freebuff-sandbox-jobs.md). The DATA stays in Convex: in
 * either mode every read and write goes to the same Convex tables, through
 * the same internal functions. Only the process that runs the loop changes.
 *
 * - `convex`   (default): today. The Convex cron fires the internal action,
 *              and for pool provisioning the embedded runner's subscription
 *              plus the Convex fallback batch claim the `daytona_pool_job`
 *              rows. The graphile tasks log and return without doing anything.
 * - `graphile` The freebuff-jobs crontab fires the task, which asks
 *              freebuff-web to run the same code with the Convex admin client.
 *              The Convex cron action returns immediately, and for pool
 *              provisioning neither the runner subscription nor the Convex
 *              fallback batch is started.
 *
 * The invariant every reader enforces: for each job EXACTLY ONE runner does
 * the work. Both sides read this one table, so a flip is a single reviewed
 * diff that both sides deploy with. It lives in `common` because the Convex
 * actions (which may import only `@codebuff/common` from outside convex/),
 * freebuff-web and the jobs worker all read it. Never an env var.
 *
 * DEPLOY ORDER for a flip to `graphile`: the jobs worker must already be
 * running, and freebuff-web must carry the same env the Convex deployment
 * gives the action (Daytona keys, `DAYTONA_*` budgets and kill switches,
 * `MIN_POOL_SIZE*`), or the moved job runs with different settings. A Convex
 * deploy and a freebuff-web deploy are not atomic: in the gap the job runs
 * TWICE (old Convex code, new web) or not at all (new Convex, old worker).
 * Every job here tolerates both for one tick; nothing tolerates it for long.
 */
export type SandboxJobRunner = 'convex' | 'graphile'

export const SANDBOX_JOB_NAMES = [
  /** Convex cron `verify and replenish Daytona pool` (5 min): health-check
   *  ready slots, discard dead ones, re-insert the deficit as pool jobs. */
  'reconcile_pool',
  /** Claiming and running `daytona_pool_job` rows: the runner subscription +
   *  `claimPoolProvisionJob` CAS + the Convex `runPoolProvisionBatch`
   *  fallback today; one graphile job per row under `graphile`. */
  'provision_pool',
  /** Convex cron `sweep errored daytona sandboxes` (10 min). One verdict of
   *  its triage DELETES a VM (convex/erroredSandboxTriage.ts). */
  'sweep_errored',
  /** Convex cron `sweep daytona storage watermarks` (30 min). */
  'sweep_storage',
  /** Convex cron `sweep sandbox run leases` (15 min): stops idle sandboxes. */
  'sweep_run_leases',
  /** Convex cron `sleep idle provider sandboxes` (5 min): parks E2B and
   *  Modal sandboxes with no recent presence (Modal snapshots, then
   *  terminates). Needs the E2B and Modal keys on whichever host runs it. */
  'sleep_idle',
] as const

export type SandboxJobName = (typeof SANDBOX_JOB_NAMES)[number]

export type SandboxJobRunners = Readonly<Record<SandboxJobName, SandboxJobRunner>>

export const SANDBOX_JOB_RUNNERS: SandboxJobRunners = {
  reconcile_pool: 'convex',
  provision_pool: 'convex',
  sweep_errored: 'convex',
  sweep_storage: 'convex',
  sweep_run_leases: 'convex',
  sleep_idle: 'convex',
}

/**
 * Whether `runner` owns `job`. The ONLY question either side asks: the Convex
 * cron asks `sandboxJobOwnedBy(job, 'convex')` and no-ops on false; the
 * graphile task asks `sandboxJobOwnedBy(job, 'graphile')` and no-ops on false.
 * Because the table holds exactly one runner per job, exactly one answers
 * true. An unknown runner value (a bad edit) answers false for both — the job
 * stops rather than runs twice, which for a sweep that deletes VMs is the
 * safe failure.
 */
export function sandboxJobOwnedBy(
  job: SandboxJobName,
  runner: SandboxJobRunner,
  runners: SandboxJobRunners = SANDBOX_JOB_RUNNERS,
): boolean {
  const owner = runners[job]
  if (owner !== 'convex' && owner !== 'graphile') return false
  return owner === runner
}
