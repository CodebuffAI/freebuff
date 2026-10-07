import { describe, expect, test } from 'bun:test'

import {
  isPostgresQueueRun,
  parseRunQueueCohort,
  RUN_QUEUE_COHORT,
  runGoesToPostgresQueue,
  runQueueCohortBucket,
  runQueueCohortNeedsRole,
  runQueueRunnerLoopEnabled,
} from '../run-queue-cohort'

describe('run queue cohort (COD-742)', () => {
  test('is off as checked in: merging the cutover moves no run', () => {
    expect(RUN_QUEUE_COHORT).toBe('off')
    expect(parseRunQueueCohort(RUN_QUEUE_COHORT)).toEqual({ kind: 'off' })
  })

  test('parses the ladder, and anything else reads as off', () => {
    expect(parseRunQueueCohort('staff')).toEqual({ kind: 'staff' })
    expect(parseRunQueueCohort('drain')).toEqual({ kind: 'drain' })
    expect(parseRunQueueCohort(' ALL ')).toEqual({ kind: 'all' })
    expect(parseRunQueueCohort('5')).toEqual({ kind: 'percent', percent: 5 })
    expect(parseRunQueueCohort('100')).toEqual({ kind: 'all' })
    expect(parseRunQueueCohort('0')).toEqual({ kind: 'off' })
    for (const typo of ['5%', 'on', 'yes', '', undefined, '-1', '1000']) {
      expect(parseRunQueueCohort(typo)).toEqual({ kind: 'off' })
    }
  })

  test('chooses by role and a stable, salted bucket', () => {
    const users = Array.from({ length: 2000 }, (_, i) => `user_${i}`)
    const off = parseRunQueueCohort('off')
    const staff = parseRunQueueCohort('staff')
    const all = parseRunQueueCohort('all')
    for (const userId of users.slice(0, 20)) {
      expect(runGoesToPostgresQueue({ cohort: off, userId, userRole: 'god' })).toBe(false)
      expect(runGoesToPostgresQueue({ cohort: all, userId, userRole: undefined })).toBe(true)
      expect(runGoesToPostgresQueue({ cohort: staff, userId, userRole: 'admin' })).toBe(true)
      expect(runGoesToPostgresQueue({ cohort: staff, userId, userRole: 'user' })).toBe(false)
    }
    const at = (percent: number) =>
      users.filter((userId) =>
        runGoesToPostgresQueue({
          cohort: { kind: 'percent', percent },
          userId,
          userRole: undefined,
        }),
      )
    const five = at(5)
    const fifty = at(50)
    expect(five.length).toBeGreaterThan(50)
    expect(five.length).toBeLessThan(160)
    // Widening keeps every user already in.
    for (const userId of five) expect(fifty).toContain(userId)
    // Staff are always in a percentage cohort.
    expect(
      runGoesToPostgresQueue({
        cohort: { kind: 'percent', percent: 1 },
        userId: users.find((u) => runQueueCohortBucket(u) > 50)!,
        userRole: 'god',
      }),
    ).toBe(true)
  })

  test('drain marks no run, and keeps the runner loop on', () => {
    const drain = parseRunQueueCohort('drain')
    expect(
      runGoesToPostgresQueue({ cohort: drain, userId: 'u', userRole: 'god' }),
    ).toBe(false)
    expect(runQueueRunnerLoopEnabled(drain)).toBe(true)
    expect(runQueueRunnerLoopEnabled(parseRunQueueCohort('off'))).toBe(false)
    expect(runQueueRunnerLoopEnabled(parseRunQueueCohort('5'))).toBe(true)
  })

  test('reads the role only when the cohort depends on it', () => {
    expect(runQueueCohortNeedsRole({ kind: 'off' })).toBe(false)
    expect(runQueueCohortNeedsRole({ kind: 'drain' })).toBe(false)
    expect(runQueueCohortNeedsRole({ kind: 'all' })).toBe(false)
    expect(runQueueCohortNeedsRole({ kind: 'staff' })).toBe(true)
    expect(runQueueCohortNeedsRole({ kind: 'percent', percent: 5 })).toBe(true)
  })

  test('a run is the queue’s only when its payload says so', () => {
    expect(isPostgresQueueRun({ runner_payload: { runQueue: 'postgres' } })).toBe(true)
    expect(isPostgresQueueRun({ runner_payload: {} })).toBe(false)
    expect(isPostgresQueueRun({})).toBe(false)
    expect(isPostgresQueueRun({ runner_payload: null })).toBe(false)
  })
})
