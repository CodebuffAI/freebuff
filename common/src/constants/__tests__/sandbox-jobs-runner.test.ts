import { describe, expect, test } from 'bun:test'

import {
  SANDBOX_JOB_NAMES,
  SANDBOX_JOB_RUNNERS,
  sandboxJobOwnedBy,
} from '../sandbox-jobs-runner'

import type { SandboxJobRunners } from '../sandbox-jobs-runner'

describe('sandbox job runners (COD-742 E1)', () => {
  test('ships dark: every job is still run by Convex', () => {
    for (const job of SANDBOX_JOB_NAMES) {
      expect({ job, runner: SANDBOX_JOB_RUNNERS[job] }).toEqual({
        job,
        runner: 'convex',
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
