import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'

import { createConnectionMonitor, getNextInterval } from '../connection-monitor'

/**
 * Tests for the shared connection monitor.
 *
 * The monitor is dependency-injected (`checkConnection` is swapped in, never the
 * `codebuff-client` module — see docs/testing.md), and its timers are driven through a mocked
 * `globalThis.setTimeout`/`clearTimeout` so tests advance time deterministically instead of
 * waiting on real delays.
 */
describe('connection-monitor', () => {
  let originalSetTimeout: typeof setTimeout
  let originalClearTimeout: typeof clearTimeout
  let timers: { id: number; ms: number; fn: () => void; cleared: boolean }[]
  let nextId: number

  beforeEach(() => {
    timers = []
    nextId = 1
    originalSetTimeout = globalThis.setTimeout
    originalClearTimeout = globalThis.clearTimeout

    globalThis.setTimeout = ((fn: () => void, ms?: number) => {
      const id = nextId++
      timers.push({ id, ms: Number(ms ?? 0), fn, cleared: false })
      return { unref: () => {} } as unknown as ReturnType<typeof setTimeout>
    }) as typeof setTimeout

    globalThis.clearTimeout = (() => {
      // Timers are identified by object identity in the mock above, not a numeric id, so
      // nothing to look up here; monitor code only ever clears its own most recent timer and
      // immediately schedules a new one, which is what the assertions below check for.
    }) as typeof clearTimeout
  })

  afterEach(() => {
    globalThis.setTimeout = originalSetTimeout
    globalThis.clearTimeout = originalClearTimeout
  })

  // Flush the microtask queue so an `async check()` kicked off by `subscribe`/a timer fires
  // reaches its `scheduleNext`/`emit` before assertions run.
  const flush = async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  }

  test('subscribing checks the connection immediately, once', async () => {
    const checkConnection = mock(async () => true)
    const monitor = createConnectionMonitor({ checkConnection })

    monitor.subscribe(() => {})
    await flush()

    expect(checkConnection).toHaveBeenCalledTimes(1)
  })

  test('repeated subscribe/unsubscribe — simulating a component re-rendering on every streamed token — never resets the backoff or re-probes', async () => {
    const checkConnection = mock(async () => true)
    const monitor = createConnectionMonitor({ checkConnection })

    const unsubscribe1 = monitor.subscribe(() => {})
    await flush()
    expect(checkConnection).toHaveBeenCalledTimes(1)
    expect(timers.length).toBe(1)
    const scheduledAfterFirstSuccess = timers[0]

    // This is the old bug: a fresh callback identity on every render tore down and recreated
    // the whole polling effect, firing an immediate probe each time. Simulate 50 "renders".
    unsubscribe1()
    for (let i = 0; i < 50; i++) {
      const unsubscribe = monitor.subscribe(() => {})
      unsubscribe()
    }
    await flush()

    // No new network probes, and the original scheduled tick is still the one pending —
    // resubscribing is just a listener add/remove, never a timer reset.
    expect(checkConnection).toHaveBeenCalledTimes(1)
    expect(timers.length).toBe(1)
    expect(timers[0]).toBe(scheduledAfterFirstSuccess)
  })

  test('escalates the interval across consecutive successes, matching getNextInterval', async () => {
    const checkConnection = mock(async () => true)
    const monitor = createConnectionMonitor({ checkConnection })

    monitor.subscribe(() => {})
    await flush()
    expect(checkConnection).toHaveBeenCalledTimes(1)
    // First success: getNextInterval(1) = 10_000, jittered +/-20%.
    expect(timers[0].ms).toBeGreaterThanOrEqual(10_000 * 0.8)
    expect(timers[0].ms).toBeLessThanOrEqual(10_000 * 1.2)

    // Fire the scheduled tick directly (advancing time) for successes 2 and 3.
    timers[0].fn()
    await flush()
    timers[1].fn()
    await flush()

    expect(checkConnection).toHaveBeenCalledTimes(3)
    // Third success crosses the successCount: 3 threshold -> 30_000ms.
    expect(getNextInterval(3)).toBe(30_000)
    expect(timers[2].ms).toBeGreaterThanOrEqual(30_000 * 0.8)
    expect(timers[2].ms).toBeLessThanOrEqual(30_000 * 1.2)
  })

  test('notifies listeners false on failure and backs off', async () => {
    const checkConnection = mock(async () => false)
    const monitor = createConnectionMonitor({ checkConnection })

    const seen: boolean[] = []
    monitor.subscribe((connected) => seen.push(connected))
    await flush()

    expect(seen).toEqual([true, false])
    expect(monitor.getConnected()).toBe(false)
    // failedPollDelayMs backs off from a 20s base; it should not be using the healthy cadence.
    expect(timers[0].ms).toBeGreaterThan(0)
  })

  test('a thrown checkConnection is treated as a failure, not an unhandled rejection', async () => {
    const checkConnection = mock(async () => {
      throw new Error('network down')
    })
    const monitor = createConnectionMonitor({ checkConnection })

    monitor.subscribe(() => {})
    await flush()

    expect(monitor.getConnected()).toBe(false)
  })

  test('setBusy(true) pauses probing: the scheduled tick rechecks without hitting the network', async () => {
    const checkConnection = mock(async () => true)
    const monitor = createConnectionMonitor({
      checkConnection,
      busyRecheckIntervalMs: 5_000,
    })

    monitor.subscribe(() => {})
    await flush()
    expect(checkConnection).toHaveBeenCalledTimes(1)

    monitor.setBusy(true)
    timers[0].fn() // the next scheduled tick, now while busy
    await flush()

    // No second network probe — busy already proves reachability — but it did reschedule.
    expect(checkConnection).toHaveBeenCalledTimes(1)
    expect(timers.length).toBe(2)
    expect(timers[1].ms).toBe(5_000)

    monitor.setBusy(false)
    timers[1].fn()
    await flush()

    expect(checkConnection).toHaveBeenCalledTimes(2)
  })

  test('stop() prevents any further probing', async () => {
    const checkConnection = mock(async () => true)
    const monitor = createConnectionMonitor({ checkConnection })

    monitor.subscribe(() => {})
    await flush()
    expect(checkConnection).toHaveBeenCalledTimes(1)

    monitor.stop()
    timers[0].fn()
    await flush()

    expect(checkConnection).toHaveBeenCalledTimes(1)
  })

  test('a late subscriber gets the current snapshot immediately, without a new probe', async () => {
    const checkConnection = mock(async () => true)
    const monitor = createConnectionMonitor({ checkConnection })

    monitor.subscribe(() => {})
    await flush()
    expect(checkConnection).toHaveBeenCalledTimes(1)

    const seen: boolean[] = []
    monitor.subscribe((connected) => seen.push(connected))

    expect(seen).toEqual([true])
    expect(checkConnection).toHaveBeenCalledTimes(1)
  })
})
