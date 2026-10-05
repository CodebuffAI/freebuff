import { afterEach, describe, expect, test } from 'bun:test'

import { observeMrc50 } from '../mrc50-viewability'

/**
 * The DOM binding, not the timing rules (those are covered against
 * `createMrc50Tracker` directly). What matters here is that the two surfaces
 * measuring MRC50 — web chat and the Desktop renderer — get identical answers
 * out of it, because both are billed against the same publisher account.
 */

/** Short enough to keep the suite fast, long enough not to race the loop. */
const DURATION = 60

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

type Listener = () => void

/**
 * Stand-ins for the two browser globals `observeMrc50` reads. Both are driven
 * by hand so a test can put the element and the window into any combination of
 * states without a real layout engine.
 */
function harness(options: { withDocument?: boolean } = {}) {
  const { withDocument = true } = options
  let emit: ((ratio: number) => void) | null = null
  let disconnected = false
  let observedThresholds: number[] | undefined
  const visibilityListeners = new Set<Listener>()
  const state = { visibility: 'visible' as 'visible' | 'hidden' }

  const priorObserver = (globalThis as Record<string, unknown>)
    .IntersectionObserver
  const priorDocument = (globalThis as Record<string, unknown>).document

  ;(globalThis as Record<string, unknown>).IntersectionObserver = class {
    constructor(
      callback: (entries: { intersectionRatio: number }[]) => void,
      init?: { threshold?: number[] },
    ) {
      observedThresholds = init?.threshold
      emit = (ratio) => callback([{ intersectionRatio: ratio }])
    }
    observe() {}
    disconnect() {
      disconnected = true
    }
  }

  if (withDocument) {
    ;(globalThis as Record<string, unknown>).document = {
      get visibilityState() {
        return state.visibility
      },
      addEventListener: (type: string, listener: Listener) => {
        if (type === 'visibilitychange') visibilityListeners.add(listener)
      },
      removeEventListener: (type: string, listener: Listener) => {
        if (type === 'visibilitychange') visibilityListeners.delete(listener)
      },
    }
  } else {
    delete (globalThis as Record<string, unknown>).document
  }

  let fired = 0
  const dispose = observeMrc50({
    // The element is never touched by the fake observer above.
    element: {} as Element,
    onViewable: () => fired++,
    durationMs: DURATION,
  })

  return {
    scrollTo: (ratio: number) => emit?.(ratio),
    background: () => {
      state.visibility = 'hidden'
      for (const listener of visibilityListeners) listener()
    },
    foreground: () => {
      state.visibility = 'visible'
      for (const listener of visibilityListeners) listener()
    },
    dispose,
    fired: () => fired,
    disconnected: () => disconnected,
    thresholds: () => observedThresholds,
    listenerCount: () => visibilityListeners.size,
    restore: () => {
      ;(globalThis as Record<string, unknown>).IntersectionObserver =
        priorObserver
      if (priorDocument === undefined) {
        delete (globalThis as Record<string, unknown>).document
      } else {
        ;(globalThis as Record<string, unknown>).document = priorDocument
      }
    },
  }
}

let active: ReturnType<typeof harness> | null = null

afterEach(() => {
  active?.restore()
  active = null
})

describe('observeMrc50', () => {
  test('fires once half the unit has been on screen for the full duration', async () => {
    const h = (active = harness())

    h.scrollTo(0.5)
    await sleep(20)
    expect(h.fired()).toBe(0)
    await sleep(80)
    expect(h.fired()).toBe(1)
  })

  test('scrolling out before the duration elapses resets the clock', async () => {
    const h = (active = harness())

    h.scrollTo(1)
    await sleep(30)
    h.scrollTo(0.2)
    await sleep(60)
    // Back over the bar, but the clock restarts rather than resuming, so the
    // 30ms already served does not count toward the 60ms.
    h.scrollTo(1)
    await sleep(30)
    expect(h.fired()).toBe(0)
    await sleep(50)
    expect(h.fired()).toBe(1)
  })

  test('a backgrounded window never counts, however visible the element is', async () => {
    // The geometry never changes here, so the observer alone would happily
    // count this. On Desktop it is an occluded or minimized Electron window.
    const h = (active = harness())

    h.scrollTo(1)
    await sleep(20)
    h.background()
    await sleep(100)
    expect(h.fired()).toBe(0)

    h.foreground()
    await sleep(80)
    expect(h.fired()).toBe(1)
  })

  test('fires at most once', async () => {
    const h = (active = harness())

    h.scrollTo(1)
    await sleep(80)
    h.scrollTo(0.1)
    h.scrollTo(1)
    await sleep(80)
    expect(h.fired()).toBe(1)
  })

  test('disposing stops the pending measurement and unhooks both listeners', async () => {
    const h = (active = harness())

    h.scrollTo(1)
    await sleep(20)
    h.dispose()
    await sleep(80)

    expect(h.fired()).toBe(0)
    expect(h.disconnected()).toBe(true)
    expect(h.listenerCount()).toBe(0)
  })

  test('asks the observer for the 50% threshold it measures against', () => {
    const h = (active = harness())

    expect(h.thresholds()).toContain(0.5)
  })

  test('is inert where there is no IntersectionObserver', () => {
    // Server rendering, and the CLI. Callers do no environment check of their
    // own, so this must be a no-op disposer rather than a throw.
    const prior = (globalThis as Record<string, unknown>).IntersectionObserver
    delete (globalThis as Record<string, unknown>).IntersectionObserver
    try {
      let fired = 0
      const dispose = observeMrc50({
        element: {} as Element,
        onViewable: () => fired++,
      })
      expect(() => dispose()).not.toThrow()
      expect(fired).toBe(0)
    } finally {
      ;(globalThis as Record<string, unknown>).IntersectionObserver = prior
    }
  })

  test('works with no document at all', async () => {
    // `document` is absent in a plain worker/SSR context; foreground is then
    // assumed rather than treated as hidden, so measurement still happens.
    const h = (active = harness({ withDocument: false }))

    h.scrollTo(1)
    await sleep(80)
    expect(h.fired()).toBe(1)
  })
})
