/**
 * The stale-migration sweep rules for users' self-host Convex migrations
 * (`convex_migrations`). Shared by the Convex cron (`convex_migration/status.ts`
 * `sweepStaleMigrations`, through `migration_run_rules.ts`) and its
 * freebuff-jobs port (`app_convex.sweep_stale_migrations`), so the two cannot
 * drift. Pure; no imports.
 */

export type MigrationStatus =
  | 'initiated'
  | 'exporting'
  | 'importing'
  | 'updating_credentials'
  | 'completed'
  | 'failed'

export function isTerminalMigrationStatus(status: MigrationStatus): boolean {
  return status === 'completed' || status === 'failed'
}

/**
 * Browser-driven migrations have no server watchdog at
 * all — a closed tab leaves the row 'initiated' forever, which renders a
 * perpetual progress card and blocks retries. The sweeper fails anything
 * non-terminal older than this. Generous on purpose: a huge browser-side
 * export/import may legitimately run tens of minutes.
 */
export const STALE_MIGRATION_TIMEOUT_MS = 45 * 60 * 1000

export function isStaleMigration(input: {
  status: MigrationStatus
  startedAt: number
  now: number
  timeoutMs?: number
}): boolean {
  if (isTerminalMigrationStatus(input.status)) return false
  return (
    input.now - input.startedAt >=
    (input.timeoutMs ?? STALE_MIGRATION_TIMEOUT_MS)
  )
}

/** Human-readable name for the step a row was in when it stopped moving. */
const MIGRATION_STEP_LABELS: Record<string, string> = {
  initiated: 'preparing (no data had been exported yet)',
  exporting: 'exporting data out of the Freebuff deployment',
  importing: 'importing data into the user\u2019s own deployment',
  updating_credentials: 'repointing the project at its new deployment',
}

/**
 * What the SERVER knows about a migration nobody ever reported on.
 *
 * A browser migration that dies with its tab produces no client report at
 * all, so the sweeper's row used to carry one generic sentence and nothing
 * else — no step, no duration, no way to tell a hung export from a closed
 * laptop. This is deliberately not an error message: it is the evidence that
 * survives when the only witness (the tab) is gone.
 */
export function describeSweptMigration(input: {
  status: MigrationStatus
  progressPercentage: number
  startedAt: number
  now: number
  hasClientReport: boolean
}): string {
  const minutes = Math.max(0, Math.round((input.now - input.startedAt) / 60000))
  const step = MIGRATION_STEP_LABELS[input.status] ?? input.status
  return [
    `Swept by the stale-migration sweeper after ${minutes} minute(s).`,
    `Last recorded step: ${input.status} — ${step}.`,
    `Progress reported: ${input.progressPercentage}%.`,
    input.hasClientReport
      ? 'The browser had already reported an error; see error_message.'
      : 'The browser never reported an outcome — its tab was most likely closed, ' +
        'reloaded or suspended mid-run. No cutover happened.',
  ].join('\n')
}
