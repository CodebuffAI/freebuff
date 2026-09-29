/**
 * The post-click RETURN label (COD-694): after an ad click, did the user come
 * back to Freebuff, and how long were they away?
 *
 * It is the frequent proxy for the low-data L3 design (targeting doc 20 §3):
 * P(convert | click) is built on P(long click | click, context), and a long
 * click is one where the user stayed on the advertiser's page rather than
 * bouncing straight back. Measured on OUR side only -- there is no
 * advertiser-site beacon, and `landing_engaged` was rejected in doc 20.
 *
 * What each client can observe differs, so the signal is named on the wire
 * and never guessed afterwards:
 *
 * - CLI: the terminal cannot see focus. The return is the user's NEXT TURN
 *   (or next ad click) after the click, so `away_ms` is the latency from the
 *   click to the next prompt -- an upper bound on time away.
 * - Desktop: the window losing and regaining focus (or visibility).
 * - Web: `visibilitychange` on the tab (and window focus as a backstop).
 *
 * This module holds only the wire contract and a clock-injected state
 * machine. The DOM binding sits beside it so Desktop's renderer and Freebuff
 * Web share one implementation; the CLI drives the machine from its prompt
 * path. The threshold N that turns `away_ms` into "long" is deliberately NOT
 * applied here: clients report the raw duration and the eval lab applies N as
 * a label parameter, so changing N never needs a client release.
 */

/** The client that MEASURED the return, which fixes what the signal means. */
export const CLICK_RETURN_CLIENTS = ['cli', 'desktop', 'web'] as const
export type ClickReturnClient = (typeof CLICK_RETURN_CLIENTS)[number]

/**
 * - `returned`: the user came back; `away_ms` is click → return.
 * - `not_returned`: the watch window ran out while the user was still away.
 *   Reported only while the client is alive; a closed tab or exited CLI
 *   reports nothing, so ABSENCE is "unknown", never "did not return".
 * - `never_left`: Desktop/Web only. Nothing left focus within the leave grace
 *   after the click, so the landing page most likely never opened (a blocked
 *   popup, a failed redirect). A click-quality filter, not a label.
 */
export const CLICK_RETURN_OUTCOMES = [
  'returned',
  'not_returned',
  'never_left',
] as const
export type ClickReturnOutcome = (typeof CLICK_RETURN_OUTCOMES)[number]

/** What observed the outcome. Each outcome admits a fixed subset. */
export const CLICK_RETURN_SIGNALS = [
  /** CLI: the next prompt the user submitted. */
  'next_turn',
  /** Any client: another ad click, which proves the user was back. */
  'next_click',
  /** Desktop/Web: the window regained focus. */
  'focus',
  /** Desktop/Web: the document became visible again. */
  'visibility',
  /** `not_returned`: the watch window elapsed. */
  'watch_expired',
  /** `never_left`: the leave grace elapsed with no blur or hide. */
  'leave_grace_expired',
] as const
export type ClickReturnSignal = (typeof CLICK_RETURN_SIGNALS)[number]

const RETURN_SIGNALS: readonly ClickReturnSignal[] = [
  'next_turn',
  'next_click',
  'focus',
  'visibility',
]

/**
 * How long a click is watched. Thirty minutes is well past any plausible N
 * (doc 20 discusses tens of seconds to a few minutes) while still short
 * enough that a click is not held across a lunch break and reported as a
 * "return" that was really the next working session.
 */
export const CLICK_RETURN_WATCH_MS = 30 * 60_000

/**
 * How long after a Desktop/Web click the window must lose focus or
 * visibility before the click is judged `never_left`. Opening a browser from
 * Electron, or a new tab from a tab, blurs within well under a second; five
 * is generous for a slow machine.
 */
export const CLICK_RETURN_LEAVE_GRACE_MS = 5_000

/** A validated report, as a route receives it. */
export type ClickReturnReport = {
  client: ClickReturnClient
  outcome: ClickReturnOutcome
  signal: ClickReturnSignal
  /** Click → return in ms on `returned`; null on every other outcome. */
  awayMs: number | null
}

/** The report body minus the impression reference each rail adds itself. */
export type ClickReturnBody = {
  client: ClickReturnClient
  outcome: ClickReturnOutcome
  signal: ClickReturnSignal
  awayMs: number | null
}

function isOneOf<T extends string>(
  values: readonly T[],
  value: unknown,
): value is T {
  return (
    typeof value === 'string' && (values as readonly string[]).includes(value)
  )
}

/**
 * The report, or null when it is not internally consistent. Unlike the click
 * ack's telemetry fields this REJECTS rather than clamps: the report is the
 * label itself, a new endpoint with no legacy binaries to protect, and a
 * clamped `away_ms` would be a fabricated label value.
 */
export function parseClickReturnBody(body: unknown): ClickReturnReport | null {
  if (typeof body !== 'object' || body === null) return null
  const raw = body as Record<string, unknown>
  const { client, outcome, signal, awayMs } = raw
  if (!isOneOf(CLICK_RETURN_CLIENTS, client)) return null
  if (!isOneOf(CLICK_RETURN_OUTCOMES, outcome)) return null
  if (!isOneOf(CLICK_RETURN_SIGNALS, signal)) return null

  if (outcome === 'returned') {
    if (!RETURN_SIGNALS.includes(signal)) return null
    // The CLI cannot see focus; Desktop/Web have no "turn" to wait for.
    if (signal === 'next_turn' && client !== 'cli') return null
    if ((signal === 'focus' || signal === 'visibility') && client === 'cli') {
      return null
    }
    if (
      typeof awayMs !== 'number' ||
      !Number.isInteger(awayMs) ||
      awayMs < 0 ||
      awayMs > CLICK_RETURN_WATCH_MS
    ) {
      return null
    }
    return { client, outcome, signal, awayMs }
  }

  if (awayMs !== null && awayMs !== undefined) return null
  if (outcome === 'not_returned') {
    if (signal !== 'watch_expired') return null
    return { client, outcome, signal, awayMs: null }
  }
  // never_left: only a client that can see focus can say nothing left it.
  if (signal !== 'leave_grace_expired' || client === 'cli') return null
  return { client, outcome, signal, awayMs: null }
}

// ---------------------------------------------------------------------------
// The watcher: one pending click at a time, clock injected.
// ---------------------------------------------------------------------------

type TimerHandle = unknown

export type ClickReturnWatcherDeps<Key> = {
  client: ClickReturnClient
  now: () => number
  setTimer: (fn: () => void, ms: number) => TimerHandle
  clearTimer: (handle: TimerHandle) => void
  /** Called exactly once per watched click. Never awaited; must not throw. */
  report: (key: Key, body: ClickReturnBody) => void
  watchMs?: number
  leaveGraceMs?: number
}

export type ClickReturnWatcher<Key> = {
  /** A click happened. Any click still pending resolves as `next_click`. */
  click: (key: Key) => void
  /** Desktop/Web: the window blurred or the document hid. */
  left: () => void
  /**
   * The user is back. On Desktop/Web a return before any leave is ignored
   * (a focus event fired by the click itself is not a return).
   */
  back: (signal: 'next_turn' | 'focus' | 'visibility') => void
  /** Drop the pending click without reporting it (unmount, logout). */
  dispose: () => void
}

type Pending<Key> = {
  key: Key
  clickedAt: number
  hasLeft: boolean
  watchTimer: TimerHandle
  graceTimer: TimerHandle | null
}

/**
 * The state machine every client drives. Only one click is pending at a
 * time: a second click proves the user was back in Freebuff, so the first
 * resolves as `returned` via `next_click` before the second is armed.
 *
 * `away_ms` runs from the CLICK, not from the moment focus left, because the
 * CLI cannot see the leave at all and one definition across clients is worth
 * more than a few hundred milliseconds of precision on two of them.
 */
export function createClickReturnWatcher<Key>(
  deps: ClickReturnWatcherDeps<Key>,
): ClickReturnWatcher<Key> {
  const watchMs = deps.watchMs ?? CLICK_RETURN_WATCH_MS
  const leaveGraceMs = deps.leaveGraceMs ?? CLICK_RETURN_LEAVE_GRACE_MS
  // The CLI has no leave to observe; every other client must see one.
  const requiresLeave = deps.client !== 'cli'
  let pending: Pending<Key> | null = null

  const settle = (body: Omit<ClickReturnBody, 'client'>) => {
    const current = pending
    if (!current) return
    pending = null
    deps.clearTimer(current.watchTimer)
    if (current.graceTimer !== null) deps.clearTimer(current.graceTimer)
    try {
      deps.report(current.key, { client: deps.client, ...body })
    } catch {
      // A label must never break the surface that measured it.
    }
  }

  const elapsed = (clickedAt: number) =>
    Math.min(watchMs, Math.max(0, Math.round(deps.now() - clickedAt)))

  /**
   * A return observed at or after the deadline is not a return. A page that
   * sat backgrounded past `watchMs` can have its expiry timer throttled or
   * suspended, so the focus event may arrive first; the absolute deadline,
   * not the timer, decides.
   */
  const settleReturn = (
    clickedAt: number,
    signal: ClickReturnBody['signal'],
  ) => {
    if (deps.now() - clickedAt >= watchMs) {
      settle({ outcome: 'not_returned', signal: 'watch_expired', awayMs: null })
      return
    }
    settle({ outcome: 'returned', signal, awayMs: elapsed(clickedAt) })
  }

  return {
    click(key) {
      if (pending) settleReturn(pending.clickedAt, 'next_click')
      const next: Pending<Key> = {
        key,
        clickedAt: deps.now(),
        hasLeft: !requiresLeave,
        watchTimer: null,
        graceTimer: null,
      }
      pending = next
      next.watchTimer = deps.setTimer(() => {
        if (pending !== next) return
        settle({
          outcome: 'not_returned',
          signal: 'watch_expired',
          awayMs: null,
        })
      }, watchMs)
      if (requiresLeave) {
        next.graceTimer = deps.setTimer(() => {
          if (pending !== next || next.hasLeft) return
          settle({
            outcome: 'never_left',
            signal: 'leave_grace_expired',
            awayMs: null,
          })
        }, leaveGraceMs)
      }
    },
    left() {
      if (!pending || pending.hasLeft) return
      pending.hasLeft = true
      if (pending.graceTimer !== null) {
        deps.clearTimer(pending.graceTimer)
        pending.graceTimer = null
      }
    },
    back(signal) {
      if (!pending || !pending.hasLeft) return
      if (signal === 'next_turn' ? requiresLeave : !requiresLeave) return
      settleReturn(pending.clickedAt, signal)
    },
    dispose() {
      const current = pending
      if (!current) return
      pending = null
      deps.clearTimer(current.watchTimer)
      if (current.graceTimer !== null) deps.clearTimer(current.graceTimer)
    },
  }
}

/**
 * Holds a return report until that click's own acknowledgement has settled.
 * The return endpoint answers 409 for a click it has not recorded yet, and
 * the reporters are fire-and-forget, so a fast bounce (focus back before the
 * click POST finished) would otherwise be dropped -- biasing the label
 * against exactly the shortest visits. Navigation is never delayed: only the
 * report waits. A key with no tracked click reports immediately.
 */
export function createClickAckGate<Key>(): {
  track: (key: Key, ack: Promise<unknown>) => void
  after: (key: Key, report: () => void) => void
} {
  const acks = new Map<Key, Promise<void>>()
  return {
    track(key, ack) {
      acks.set(
        key,
        ack.then(
          () => {},
          () => {},
        ),
      )
    },
    after(key, report) {
      const ack = acks.get(key)
      acks.delete(key)
      if (!ack) {
        report()
        return
      }
      void ack.then(report)
    },
  }
}

// ---------------------------------------------------------------------------
// DOM binding (Desktop renderer, Freebuff Web). Structural types only, so
// `common` needs no DOM lib.
// ---------------------------------------------------------------------------

type ListenerTarget = {
  addEventListener: (type: string, listener: () => void) => void
  removeEventListener: (type: string, listener: () => void) => void
}

export type ClickReturnDomTargets = {
  document: ListenerTarget & { visibilityState?: string }
  window: ListenerTarget
}

/**
 * Feed `visibilitychange`, `blur` and `focus` into a watcher. Returns the
 * unbind function. Both signals are wired because each misses a case the
 * other catches: opening an external browser from Electron blurs without
 * hiding, and switching tabs hides even when focus bookkeeping lags.
 */
export function bindClickReturnToDom<Key>(
  watcher: ClickReturnWatcher<Key>,
  targets: ClickReturnDomTargets,
): () => void {
  const onVisibility = () => {
    if (targets.document.visibilityState === 'hidden') watcher.left()
    else if (targets.document.visibilityState === 'visible') {
      watcher.back('visibility')
    }
  }
  const onBlur = () => watcher.left()
  const onFocus = () => watcher.back('focus')
  targets.document.addEventListener('visibilitychange', onVisibility)
  targets.window.addEventListener('blur', onBlur)
  targets.window.addEventListener('focus', onFocus)
  return () => {
    targets.document.removeEventListener('visibilitychange', onVisibility)
    targets.window.removeEventListener('blur', onBlur)
    targets.window.removeEventListener('focus', onFocus)
  }
}
