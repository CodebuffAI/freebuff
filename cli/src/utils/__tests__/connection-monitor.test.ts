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

  test('repeated subscribe/unsubscribe — simulating a component re-rendering on every streamed token — never re-probes or resets the success streak', async () => {
    const checkConnection = mock(async () => true)
    const monitor = createConnectionMonitor({ checkConnection })

    let currentUnsubscribe = monitor.subscribe(() => {})
    await flush() // success #1
    timers[timers.length - 1].fn()
    await flush() // success #2
    timers[timers.length - 1].fn()
    await flush() // success #3 -> consecutiveSuccesses = 3, next tick scheduled ~30s out
    expect(checkConnection).toHaveBeenCalledTimes(3)

    // This is the old bug: a fresh callback identity on every render tore down and recreated
    // the whole polling effect, firing an immediate probe each time. Simulate 50 "renders" —
    // each one unsubscribes then resubscribes within the same synchronous tick, exactly as
    // React's effect cleanup/re-run does for an unstable `onReconnect` identity. Dropping to
    // zero listeners between the two correctly pauses the loop (see the dedicated pause
    // tests below); what must NOT happen is a new network probe or a reset of the streak.
    for (let i = 0; i < 50; i++) {
      currentUnsubscribe()
      currentUnsubscribe = monitor.subscribe(() => {})
    }
    await flush()

    // No new network probes from the churn itself.
    expect(checkConnection).toHaveBeenCalledTimes(3)

    // Firing whichever tick the churn left pending makes one real probe...
    expect(timers.length).toBeGreaterThan(0)
    timers[timers.length - 1].fn()
    await flush()
    expect(checkConnection).toHaveBeenCalledTimes(4)

    // ...and the interval scheduled after THAT success reflects a continuing streak (4
    // successes land in the 30s bucket), not the old bug's reset to the 10s floor on every
    // single render.
    expect(getNextInterval(4)).toBe(30_000)
    const nextPending = timers[timers.length - 1]
    expect(nextPending.ms).toBeGreaterThanOrEqual(30_000 * 0.8)
    expect(nextPending.ms).toBeLessThanOrEqual(30_000 * 1.2)
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

  test('unsubscribing the last listener pauses the loop — no more probes once it is scheduled', async () => {
    // Regression test for a bug flagged on PR #5229: unsubscribing (e.g. a BYOK session's
    // `useConnectionStatus` taking its early return) only removed the listener. The scheduled
    // tick kept firing forever with nobody listening.
    const checkConnection = mock(async () => true)
    const monitor = createConnectionMonitor({ checkConnection })

    const unsubscribe = monitor.subscribe(() => {})
    await flush()
    expect(checkConnection).toHaveBeenCalledTimes(1)
    expect(timers.length).toBe(1)

    unsubscribe()

    // The tick that was already scheduled before the unsubscribe must not fire a probe either.
    timers[0].fn()
    await flush()

    expect(checkConnection).toHaveBeenCalledTimes(1)
  })

  test('resubscribing after a pause resumes polling', async () => {
    const checkConnection = mock(async () => true)
    const monitor = createConnectionMonitor({ checkConnection })

    const unsubscribe = monitor.subscribe(() => {})
    await flush()
    expect(checkConnection).toHaveBeenCalledTimes(1)

    unsubscribe()
    await flush()
    expect(checkConnection).toHaveBeenCalledTimes(1)
    expect(timers.length).toBe(1) // nothing new scheduled while paused

    // Resubscribing re-arms the loop — debounced rather than firing an immediate probe (see
    // the "rapid cycles" test below) — instead of leaving it paused forever.
    const seen: boolean[] = []
    monitor.subscribe((connected) => seen.push(connected))
    await flush()

    expect(seen[0]).toBe(true) // cached snapshot, emitted synchronously on subscribe
    expect(checkConnection).toHaveBeenCalledTimes(1) // still debounced, not an immediate reprobe
    expect(timers.length).toBe(2) // but the loop did re-arm a tick

    // And that tick, once it fires, makes a real probe — the loop actually resumed, it didn't
    // just silently re-arm and die.
    timers[1].fn()
    await flush()
    expect(checkConnection).toHaveBeenCalledTimes(2)
  })

  test('rapid unsubscribe/resubscribe cycles never trigger more than one check per initial interval', async () => {
    const checkConnection = mock(async () => true)
    const monitor = createConnectionMonitor({ checkConnection })

    const first = monitor.subscribe(() => {})
    await flush()
    expect(checkConnection).toHaveBeenCalledTimes(1)

    // Simulate renders rapidly tearing down and recreating the subscription — immediately
    // after the one real check, well inside its ~10s initial interval.
    first()
    for (let i = 0; i < 20; i++) {
      const unsubscribe = monitor.subscribe(() => {})
      unsubscribe()
    }
    await flush()

    // Still just the one real probe: each resubscribe is throttled to "whatever's left of the
    // initial interval," and each subsequent unsubscribe pauses it again before it can fire.
    expect(checkConnection).toHaveBeenCalledTimes(1)
  })

  test('an in-flight check resolving after the last listener unsubscribed does not revive the loop', async () => {
    let resolveCheck: (value: boolean) => void = () => {}
    const checkConnection = mock(
      () =>
        new Promise<boolean>((resolve) => {
          resolveCheck = resolve
        }),
    )
    const monitor = createConnectionMonitor({ checkConnection })

    const unsubscribe = monitor.subscribe(() => {})
    await flush()
    expect(checkConnection).toHaveBeenCalledTimes(1)
    // Nothing scheduled yet — the first check is still in flight.
    expect(timers.length).toBe(0)

    // Last listener leaves while the check is still pending.
    unsubscribe()

    // Now the in-flight check resolves — after the pause.
    resolveCheck(true)
    await flush()

    // A stale resolution must not schedule a new tick, nor flip the cached state via emit.
    expect(timers.length).toBe(0)
    expect(monitor.getConnected()).toBe(true) // unchanged from its optimistic default
  })

  // The shared probe adds `.then`/`.finally` hops, so give continuations a few extra turns.
  const settle = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve()
  }

  test('resubscribing while a probe from before the pause is pending adopts it instead of starting another', async () => {
    let resolveCheck: (value: boolean) => void = () => {}
    const checkConnection = mock(
      () =>
        new Promise<boolean>((resolve) => {
          resolveCheck = resolve
        }),
    )
    const monitor = createConnectionMonitor({ checkConnection })

    monitor.subscribe(() => {})()
    await settle()
    for (let i = 0; i < 5; i++) monitor.subscribe(() => {})()
    const seen: boolean[] = []
    monitor.subscribe((value) => seen.push(value))
    await settle()
    expect(checkConnection).toHaveBeenCalledTimes(1)

    resolveCheck(false)
    await settle()

    // The live subscriber gets the adopted probe's result and the loop carries on from it.
    expect(seen).toEqual([true, false])
    expect(checkConnection).toHaveBeenCalledTimes(1)
    expect(timers.length).toBe(1)
  })

  test('a probe that settles while paused becomes the next subscriber’s snapshot, without emitting', async () => {
    let resolveCheck: (value: boolean) => void = () => {}
    const checkConnection = mock(
      () =>
        new Promise<boolean>((resolve) => {
          resolveCheck = resolve
        }),
    )
    const monitor = createConnectionMonitor({ checkConnection })

    const paused: boolean[] = []
    const unsubscribe = monitor.subscribe((value) => paused.push(value))
    await settle()
    unsubscribe()
    resolveCheck(false)
    await settle()

    expect(paused).toEqual([true]) // only the initial snapshot; the stale result never emits
    expect(timers.length).toBe(0)

    // Within the initial interval, a new subscriber starts from the fresh (offline) reading
    // rather than the stale optimistic one, and the next probe waits out the interval.
    const seen: boolean[] = []
    monitor.subscribe((value) => seen.push(value))
    await settle()
    expect(seen).toEqual([false])
    expect(checkConnection).toHaveBeenCalledTimes(1)
    expect(timers.length).toBe(1)
  })
})
