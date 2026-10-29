import { describe, expect, test } from 'bun:test'

import { resolveStateSnapshotIntervalMs } from '../run'

describe('resolveStateSnapshotIntervalMs', () => {
  test('defaults to 5s when the host does not ask for anything', () => {
    expect(resolveStateSnapshotIntervalMs()).toBe(5_000)
    expect(resolveStateSnapshotIntervalMs(undefined)).toBe(5_000)
  })

  test('keeps an interval a host scaled to its transcript size', () => {
    expect(resolveStateSnapshotIntervalMs(10_000)).toBe(10_000)
    expect(resolveStateSnapshotIntervalMs(20_000)).toBe(20_000)
    expect(resolveStateSnapshotIntervalMs(1_500.4)).toBe(1_500)
  })

  test('clamps, so checkpointing can never be disabled by the option', () => {
    expect(resolveStateSnapshotIntervalMs(0)).toBe(1_000)
    expect(resolveStateSnapshotIntervalMs(-5)).toBe(1_000)
    expect(resolveStateSnapshotIntervalMs(Number.POSITIVE_INFINITY)).toBe(5_000)
    expect(resolveStateSnapshotIntervalMs(Number.NaN)).toBe(5_000)
    expect(resolveStateSnapshotIntervalMs(10 * 60_000)).toBe(60_000)
  })
})
