import { describe, test, expect } from 'bun:test'

import {
  createProbeFailureTracker,
  getNextInterval,
} from '../use-connection-status'

/**
 * Tests for the adaptive health check interval logic.
 *
 * These tests verify the core exponential backoff algorithm that determines
 * how frequently health checks should run based on consecutive successful checks.
 */

describe('useConnectionStatus - adaptive interval logic', () => {
  describe('getNextInterval', () => {
    test('returns 10s for 0-2 consecutive successes', () => {
      expect(getNextInterval(0)).toBe(10_000)
      expect(getNextInterval(1)).toBe(10_000)
      expect(getNextInterval(2)).toBe(10_000)
    })

    test('returns 30s for 3-5 consecutive successes', () => {
      expect(getNextInterval(3)).toBe(30_000)
      expect(getNextInterval(4)).toBe(30_000)
      expect(getNextInterval(5)).toBe(30_000)
    })

    test('returns 60s for 6-9 consecutive successes', () => {
      expect(getNextInterval(6)).toBe(60_000)
      expect(getNextInterval(7)).toBe(60_000)
      expect(getNextInterval(8)).toBe(60_000)
      expect(getNextInterval(9)).toBe(60_000)
    })

    test('returns 2min for 10-14 consecutive successes', () => {
      expect(getNextInterval(10)).toBe(120_000)
      expect(getNextInterval(11)).toBe(120_000)
      expect(getNextInterval(14)).toBe(120_000)
    })

    test('returns 5min for 15-19 consecutive successes', () => {
      expect(getNextInterval(15)).toBe(300_000)
      expect(getNextInterval(16)).toBe(300_000)
      expect(getNextInterval(19)).toBe(300_000)
    })

    test('returns 10min (max) for 20+ consecutive successes', () => {
      expect(getNextInterval(20)).toBe(600_000)
      expect(getNextInterval(25)).toBe(600_000)
      expect(getNextInterval(100)).toBe(600_000)
      expect(getNextInterval(1000)).toBe(600_000)
    })
  })

  describe('interval progression', () => {
    test('progresses through all thresholds in order', () => {
      const progression = [
        { successes: 0, expectedInterval: 10_000 },
        { successes: 3, expectedInterval: 30_000 },
        { successes: 6, expectedInterval: 60_000 },
        { successes: 10, expectedInterval: 120_000 },
        { successes: 15, expectedInterval: 300_000 },
        { successes: 20, expectedInterval: 600_000 },
      ]

      for (const { successes, expectedInterval } of progression) {
        expect(getNextInterval(successes)).toBe(expectedInterval)
      }
    })

    test('intervals increase monotonically', () => {
      let previousInterval = 0
      // Test first occurrence of each threshold
      const testPoints = [0, 3, 6, 10, 15, 20, 50]

      for (const successes of testPoints) {
        const interval = getNextInterval(successes)
        expect(interval).toBeGreaterThanOrEqual(previousInterval)
        previousInterval = interval
      }
    })
  })

  describe('edge cases', () => {
    test('handles negative values (treated as 0)', () => {
      // In practice, consecutive successes should never be negative,
      // but the function should handle it gracefully
      expect(getNextInterval(-1)).toBe(10_000)
      expect(getNextInterval(-100)).toBe(10_000)
    })

    test('handles very large values', () => {
      expect(getNextInterval(Number.MAX_SAFE_INTEGER)).toBe(600_000)
    })
  })

  describe('boundary conditions', () => {
    test('uses correct interval at exact threshold boundaries', () => {
      // At threshold - 1: should use previous interval
      expect(getNextInterval(2)).toBe(10_000) // Just before 3
      expect(getNextInterval(5)).toBe(30_000) // Just before 6
      expect(getNextInterval(9)).toBe(60_000) // Just before 10
      expect(getNextInterval(14)).toBe(120_000) // Just before 15
      expect(getNextInterval(19)).toBe(300_000) // Just before 20

      // At threshold: should use new interval
      expect(getNextInterval(3)).toBe(30_000)
      expect(getNextInterval(6)).toBe(60_000)
      expect(getNextInterval(10)).toBe(120_000)
      expect(getNextInterval(15)).toBe(300_000)
      expect(getNextInterval(20)).toBe(600_000)
    })
  })

  describe('disconnect hysteresis', () => {
    test('a single failed probe does not report a disconnection', () => {
      const tracker = createProbeFailureTracker()

      expect(tracker.recordFailure()).toBe(false)
    })

    test('a sustained streak still reports a disconnection', () => {
      const tracker = createProbeFailureTracker()

      expect(tracker.recordFailure()).toBe(false)
      expect(tracker.recordFailure()).toBe(true)
      // Stays reported while the outage lasts; it is not a one-shot signal.
      expect(tracker.recordFailure()).toBe(true)
    })

    test('a sequence of isolated blips never flips the badge', () => {
      const tracker = createProbeFailureTracker()
      const reportedDisconnected: boolean[] = []

      // fail → success → fail → success → fail → success
      for (let i = 0; i < 3; i++) {
        reportedDisconnected.push(tracker.recordFailure())
        tracker.recordSuccess()
      }

      expect(reportedDisconnected).toEqual([false, false, false])
    })

    test('recovery is immediate: one success clears the streak', () => {
      const tracker = createProbeFailureTracker()
      tracker.recordFailure()
      tracker.recordFailure()

      tracker.recordSuccess()

      expect(tracker.consecutiveFailures).toBe(0)
      // The cleared streak means the next blip is tolerated again.
      expect(tracker.recordFailure()).toBe(false)
    })

    test('the streak still measures the length of the outage for backoff', () => {
      const tracker = createProbeFailureTracker()
      expect(tracker.consecutiveFailures).toBe(0)

      tracker.recordFailure()
      tracker.recordFailure()
      tracker.recordFailure()

      expect(tracker.consecutiveFailures).toBe(3)
    })

    test('threshold 1 reproduces the old notify-on-first-failure behaviour', () => {
      const tracker = createProbeFailureTracker({ threshold: 1 })

      expect(tracker.recordFailure()).toBe(true)
    })
  })
})
