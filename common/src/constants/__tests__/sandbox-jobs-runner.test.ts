import { describe, expect, test } from 'bun:test'

import {
  POOL_JOB_STORE,
  SANDBOX_JOB_NAMES,
  SANDBOX_JOB_RUNNERS,
  poolJobsOnPostgres,
  sandboxJobOwnedBy,
} from '../sandbox-jobs-runner'

import type { SandboxJobRunners } from '../sandbox-jobs-runner'

describe('sandbox job runners (COD-742 E1)', () => {
  // Flipped one at a time on Owen's go (2026-10-14): storage sweep, run leases, errored sweep, pool reconcile, pool provisioning, idle sleep.
  const FLIPPED: readonly string[] = ['sweep_storage', 'sweep_run_leases', 'sweep_errored', 'reconcile_pool', 'provision_pool', 'sleep_idle']

  test('only the flipped jobs run on graphile; Convex runs the rest', () => {
    for (const job of SANDBOX_JOB_NAMES) {
      expect({ job, runner: SANDBOX_JOB_RUNNERS[job] }).toEqual({
        job,
        runner: FLIPPED.includes(job) ? 'graphile' : 'convex',
      })
    }
  })

  test('the table names every job and nothing else', () => {
    expect(Object.keys(SANDBOX_JOB_RUNNERS).sort()).toEqual(
      [...SANDBOX_JOB_NAMES].sort(),
    )
  })

  test('exactly one runner owns each job, in either position of the switch', () => {
    for (const runner of ['convex', 'graphile'] as const) {
      const runners = Object.fromEntries(
        SANDBOX_JOB_NAMES.map((job) => [job, runner]),
      ) as SandboxJobRunners
      for (const job of SANDBOX_JOB_NAMES) {
        const owners = (['convex', 'graphile'] as const).filter((r) =>
          sandboxJobOwnedBy(job, r, runners),
        )
        expect(owners).toEqual([runner])
      }
    }
  })

  test('a mixed table hands each job to its own runner only', () => {
    const runners: SandboxJobRunners = {
      ...SANDBOX_JOB_RUNNERS,
      sweep_errored: 'graphile',
      reconcile_pool: 'convex',
    }
    expect(sandboxJobOwnedBy('sweep_errored', 'graphile', runners)).toBe(true)
    expect(sandboxJobOwnedBy('sweep_errored', 'convex', runners)).toBe(false)
    expect(sandboxJobOwnedBy('reconcile_pool', 'convex', runners)).toBe(true)
    expect(sandboxJobOwnedBy('reconcile_pool', 'graphile', runners)).toBe(false)
  })

  test('a corrupt value stops the job on both sides rather than running it twice', () => {
    const runners = {
      ...SANDBOX_JOB_RUNNERS,
      sweep_errored: 'both',
    } as unknown as SandboxJobRunners
    expect(sandboxJobOwnedBy('sweep_errored', 'convex', runners)).toBe(false)
    expect(sandboxJobOwnedBy('sweep_errored', 'graphile', runners)).toBe(false)
  })
})

describe('pool job store (COD-742)', () => {
  test('the queue is on Postgres, with both pool jobs on graphile', () => {
    expect(POOL_JOB_STORE).toBe('postgres')
    expect(poolJobsOnPostgres()).toBe(true)
  })

  test('refused while either pool job still runs on Convex', () => {
    for (const job of ['reconcile_pool', 'provision_pool'] as const) {
      const runners = {
        ...SANDBOX_JOB_RUNNERS,
        [job]: 'convex',
      } as SandboxJobRunners
      expect(poolJobsOnPostgres('postgres', runners)).toBe(false)
    }
    expect(poolJobsOnPostgres('convex')).toBe(false)
  })
})
