import { describe, expect, test } from 'bun:test'

import {
  CONVEX_CRON_JOB_NAMES,
  CONVEX_CRON_JOB_RUNNERS,
  convexCronJobOwnedBy,
  isConvexCronJobName,
} from '../convex-cron-jobs-runner'

import { AGENT_CORE_WRITER_FOR_CONVEX } from '../agent-core-writer'

import type { ConvexCronJobRunners } from '../convex-cron-jobs-runner'

describe('Convex cron job runners (COD-742)', () => {
  test('ships dark, and the table names every job and nothing else', () => {
    expect(Object.keys(CONVEX_CRON_JOB_RUNNERS).sort()).toEqual([...CONVEX_CRON_JOB_NAMES].sort())
    for (const job of CONVEX_CRON_JOB_NAMES) expect(CONVEX_CRON_JOB_RUNNERS[job]).toBe('convex')
  })

  test('exactly one runner owns each job in either position of the switch', () => {
    for (const runner of ['convex', 'graphile'] as const) {
      const runners = Object.fromEntries(
        CONVEX_CRON_JOB_NAMES.map((job) => [job, runner]),
      ) as ConvexCronJobRunners
      for (const job of CONVEX_CRON_JOB_NAMES) {
        expect(
          (['convex', 'graphile'] as const).filter((r) => convexCronJobOwnedBy(job, r, runners)),
        ).toEqual([runner])
      }
    }
  })

  test('a corrupt value stops the job on both sides', () => {
    const runners = { ...CONVEX_CRON_JOB_RUNNERS, reconcile_pr_delivery: 'both' } as unknown as ConvexCronJobRunners
    expect(convexCronJobOwnedBy('reconcile_pr_delivery', 'convex', runners)).toBe(false)
    expect(convexCronJobOwnedBy('reconcile_pr_delivery', 'graphile', runners)).toBe(false)
  })

  test('the run sweep moves with the agent core writer, never alone', () => {
    // Postgres reaping Convex's runs, or Convex reaping frozen placeholders
    // beside the Postgres sweep, would reap twice or not at all.
    expect(CONVEX_CRON_JOB_RUNNERS.sweep_freebuff_runs === 'graphile').toBe(
      AGENT_CORE_WRITER_FOR_CONVEX === 'postgres',
    )
  })

  test('recognises only its own job names', () => {
    expect(isConvexCronJobName('reconcile_pr_delivery')).toBe(true)
    expect(isConvexCronJobName('sweep_errored')).toBe(false)
    expect(isConvexCronJobName(undefined)).toBe(false)
  })
})
