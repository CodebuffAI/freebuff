/**
 * MRC50 viewability: an ad counts as viewed once at least 50% of its pixels
 * have been continuously visible for one full second while the page is in the
 * foreground.
 *
 * "Continuous" is the whole difficulty. Scrolling the ad half out of view, or
 * backgrounding the tab, restarts the clock from zero rather than pausing it —
 * so this is a small state machine rather than an accumulator.
 *
 * This lives in `common` because two surfaces measure it: the web chat
 * renderer and the Desktop renderer (Electron is Chromium, so it has a real
 * viewport, layout and page-visibility state). If the two ever disagreed about
 * what "viewable" means, engagement numbers would depend on which app the user
 * happened to open. The CLI is deliberately NOT a caller — a terminal has no
 * viewport to measure against, so it reports insertion only.
 *
 * `createMrc50Tracker` is kept free of React and of the DOM so the timing
 * rules can be tested directly; `observeMrc50` is the thin DOM binding that
 * feeds it IntersectionObserver ratios and the page visibility state.
 */

/** Fraction of the ad's pixels that must be on screen. */
export const MRC50_VISIBLE_RATIO = 0.5

/** How long those pixels must stay on screen, uninterrupted. */
export const MRC50_DURATION_MS = 1_000

/**
 * Ratios we ask IntersectionObserver to notify us at. The 0.5 entry is the one
 * that matters; the others keep `update` honest as the unit scrolls in and out
 * so the continuity timer resets at the right moments.
 */
export const MRC50_OBSERVER_THRESHOLDS = [0, 0.25, MRC50_VISIBLE_RATIO, 0.75, 1]

export type Mrc50Tracker = {
  /**
   * Report the current visible fraction (0–1) and whether the page is in the
   * foreground. Safe to call as often as the observer fires.
   */
  update: (visibleRatio: number, isForeground: boolean) => void
  /** Cancel any pending timer. Fires nothing. */
  dispose: () => void
}

export function createMrc50Tracker(params: {
  /** Called exactly once, when the criteria have been met. */
  onViewable: () => void
  /** How long the ad must stay visible. Overridden only by tests. */
  durationMs?: number
}): Mrc50Tracker {
  const { onViewable, durationMs = MRC50_DURATION_MS } = params

  let timer: ReturnType<typeof setTimeout> | null = null
  let fired = false

  const stopTimer = () => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  return {
    update(ratio, isForeground) {
      if (fired) return

      if (ratio < MRC50_VISIBLE_RATIO || !isForeground) {
        // Dropped below the bar before the second elapsed — reset, don't pause.
        stopTimer()
        return
      }

      // Already counting down; leaving the existing timer alone is what makes
      // the second continuous rather than restarting on every observer tick.
      if (timer !== null) return

      timer = setTimeout(() => {
        timer = null
        fired = true
        onViewable()
      }, durationMs)
    },
    dispose() {
      stopTimer()
    },
  }
}

/**
 * Watch one element and call `onViewable` the first time it meets MRC50.
 *
 * Returns a disposer; calling it after the callback has fired is harmless.
 * Returns a no-op disposer where there is nothing to observe (SSR, or a
 * runtime with no IntersectionObserver), so callers need no environment check
 * of their own.
 */
export function observeMrc50(params: {
  element: Element
  onViewable: () => void
  /** Overridden only by tests. */
  durationMs?: number
}): () => void {
  const { element, onViewable, durationMs } = params
  const noop = () => {}
  if (typeof IntersectionObserver === 'undefined') return noop

  const tracker = createMrc50Tracker({ onViewable, durationMs })

  let lastRatio = 0
  const isForeground = () =>
    typeof document === 'undefined' || document.visibilityState === 'visible'

  const observer = new IntersectionObserver(
    (entries) => {
      const entry = entries[entries.length - 1]
      if (!entry) return
      lastRatio = entry.intersectionRatio
      tracker.update(lastRatio, isForeground())
    },
    { threshold: MRC50_OBSERVER_THRESHOLDS },
  )
  observer.observe(element)

  // Backgrounding the window stops the clock even though the element's
  // geometry never changed, so the observer alone would happily count a hidden
  // window as viewable. On Desktop this is what an occluded or minimized
  // Electron window trips.
  const onVisibilityChange = () => tracker.update(lastRatio, isForeground())
  const doc = typeof document === 'undefined' ? null : document
  doc?.addEventListener('visibilitychange', onVisibilityChange)

  return () => {
    observer.disconnect()
    doc?.removeEventListener('visibilitychange', onVisibilityChange)
    tracker.dispose()
  }
}
