/**
 * Per-impression engagement accounting for the CLI's ad cards (COD-757): the
 * terminal port of Desktop's `freebuff-desktop/src/ui/chrome/ad-engagement.ts`.
 *
 * One `AdEngagement` record per `impUrl`, plus an optional post-click-only
 * record the server merges into it. TRAINING FEATURES ONLY: every value is
 * client-reported, so nothing downstream may bill or convict on it, and it
 * never touches the impression or click reports, which keep their own dedupe.
 *
 * What a terminal can and cannot honestly observe:
 *
 * - Hover is OpenTUI's mouse-over/out on the card. With no mouse reporting
 *   there are simply no hover events.
 * - Visibility. A PINNED card (the dock above the composer, the landing
 *   screen's columns) is laid out outside any scrollbox, so it is on screen
 *   for exactly as long as it is mounted. A card in the TRANSCRIPT is on
 *   screen only while its rows intersect the scrollbox viewport, which its
 *   owner measures and reports; until a measurement succeeds, visibility is
 *   unknown and `visibleAtMs`/`visibleMs` are omitted. There is no 50%
 *   threshold to apply, so `mrc50` is never set.
 * - Focus exists only when the terminal sends DEC 1004 focus reports. Without
 *   them `focusedVisibleMs`, `click.windowFocused` and `postClick` are omitted:
 *   an unknown focus is never reported as "unfocused".
 * - A click has no `isTrusted` and no DOM region; the CTA buttons say `cta`.
 * - Idle and keystrokes (wave 2) come from the CLI's activity tracker and the
 *   composer's keypress count. `idleVisibleMs` needs a known last-input time,
 *   `keysDuringExposure` needs the composer wired; without either, absent.
 *   A keystroke is counted, never identified. `reentries` counts a
 *   transcript card measured back inside the viewport after it left it; a
 *   pinned card has no viewport to leave, so its count is always 0.
 * - Pixel/DOM concepts (`cardWidth`/`cardHeight`, `closestPointer`,
 *   `imageLoadMs`, `copied`) have no terminal equivalent and are never set,
 *   and a CLI ad cannot be dismissed, so `dismissMs` is never set either.
 *
 * Two layers, so the timing rules are tested with a fake clock and no TUI:
 * `createEngagementTracker` (one impression's state machine, possibly drawn
 * in several places at once: the inline pool repeats an ad across slots) and
 * `createEngagementRegistry` (ownership by `impUrl`, the release grace that
 * lets a remount resume the same record, exactly one flush per impression).
 *
 * WHEN A RECORD LEAVES. The final record goes out when the last drawn copy
 * unmounts (after the grace) or when the CLI quits (`closeAll`). Neither is
 * enough on its own in a terminal: a transcript card stays mounted for the
 * whole session, and a quit is not guaranteed. So a live impression also
 * sends CHECKPOINTS -- the record so far, with no `exit` -- which the server
 * merges key by key and the final record later overwrites:
 *
 * - once, the first time a transcript card leaves the viewport after being
 *   seen, or after {@link ENGAGEMENT_CHECKPOINT_MS} of exposure, whichever
 *   comes first;
 * - once, at the first click, because the click is the label the record
 *   exists for.
 *
 * LATE CLICKS. The dock redraws a cached creative under its original
 * `impUrl` long after that impression's record went out, and the server
 * still bills the click. A mount of an already-flushed `impUrl` therefore
 * gets a CLICK-ONLY tracker: it measures nothing about the exposure (that
 * record is closed) and sends only `{ v, impUrl, click }` -- plus `postClick`
 * -- as a merge record. When the impression was already clicked, the first
 * click's features are kept and only the count grows, so a late click never
 * overwrites the click it follows.
 */
import {
  AD_ENGAGEMENT_VERSION,
  AD_MS_CAP,
  bucketCount,
  clampMs,
  parseAdEngagement,
  type AdEngagement,
  type CLICK_REGIONS,
} from '@codebuff/common/types/ad-client-context'

export type EngagementExit = NonNullable<AdEngagement['exit']>
export type ClickRegion = (typeof CLICK_REGIONS)[number]

/** A click followed by focus loss within this long means the browser took focus. */
export const POST_CLICK_LEAVE_GRACE_MS = 3_000
/** How long a click waits for the terminal to regain focus: the record's ms cap. */
export const POST_CLICK_WATCH_MS = AD_MS_CAP
/** How long an unowned impression waits for a remount of the same `impUrl`. */
export const ENGAGEMENT_RELEASE_GRACE_MS = 1_000
/** An unmount this soon after a send is attributed to the send. */
export const NEW_MESSAGE_EXIT_WINDOW_MS = 1_000
/** No input for this long is idle (the activity tracker's own threshold). */
export const ENGAGEMENT_IDLE_AFTER_MS = 30_000
/**
 * A live impression sends its record so far after this long, once. Longer
 * than the dock's 60s rotation, so a dock that rotates normally never pays
 * for a checkpoint; a transcript card that never unmounts always does.
 */
export const ENGAGEMENT_CHECKPOINT_MS = 120_000

const MAX_COUNT = 10_000
/** Bounds the rotation memos: a slot that rotates for a week must not grow them. */
const MAX_SWAP_MEMO = 64
/** Bounds the clicked-impression memo a late click merges into. */
const MAX_CLICK_MEMO = 256

export type EngagementClickBlock = NonNullable<AdEngagement['click']>

type TimerHandle = unknown

export interface EngagementTimers {
  setTimer?: (fn: () => void, ms: number) => TimerHandle
  clearTimer?: (handle: TimerHandle) => void
}

const defaultSetTimer = (fn: () => void, ms: number): TimerHandle => {
  const handle = setTimeout(fn, ms)
  // An engagement record must never hold the process open on exit.
  ;(handle as { unref?: () => void }).unref?.()
  return handle
}
const defaultClearTimer = (handle: TimerHandle): void =>
  clearTimeout(handle as ReturnType<typeof setTimeout>)

/** `pinned`: on screen while mounted. `measured`: the owner reports visibility. */
export type OwnerPlacement = 'pinned' | 'measured'

export interface EngagementClick {
  /** shift/alt/ctrl held, or a middle click, when the mouse event says so */
  modifier?: boolean
  region?: ClickRegion
}

export interface FocusState {
  /** The terminal has sent at least one focus report this process. */
  supported: boolean
  /** Known focus, or null when no report has arrived yet. */
  focused: boolean | null
}

export interface EngagementTrackerOptions extends EngagementTimers {
  impUrl: string
  /** Monotonic ms; every duration is a difference of two readings. */
  now: () => number
  focus: FocusState
  /** When the slot swapped to this creative, on the `now` clock. */
  rotatedAt?: number
  /** ms since the user's last input when the tracker starts; absent = unknown. */
  idleMsAtMount?: number
  /** The composer's keystrokes reach `keystroke()`, so a count is meaningful. */
  countsKeys?: boolean
  /**
   * Send a checkpoint (the record so far, no `exit`) the first time a
   * measured card leaves the viewport after being seen, on `checkpoint()`,
   * and at the first click. Off by default; the registry turns it on.
   */
  checkpoints?: boolean
  /**
   * A redraw of an impression whose record already went out: send only the
   * click (and post-click) as merge records. `priorClick` is the click block
   * the server already holds for it, which a late click extends rather than
   * replaces.
   */
  clickOnly?: { priorClick?: EngagementClickBlock }
  /** Receives every record that parses. Fire-and-forget; a throw is swallowed. */
  send: (record: AdEngagement) => void
  /** Called once the tracker has nothing left to send. */
  onDone?: () => void
}

export interface EngagementTracker {
  readonly impUrl: string
  /** A place this impression is drawn. Owners are opaque tokens. */
  attach(owner: object, placement: OwnerPlacement): void
  detach(owner: object): void
  readonly owners: number
  /** A measured owner's latest answer; `undefined` = could not measure. */
  setVisible(owner: object, visible: boolean | undefined): void
  hover(owner: object, hovering: boolean): void
  click(detail?: EngagementClick): void
  terminalFocus(focused: boolean): void
  messageSent(): void
  /** The user did something (key, mouse, paste): idle time restarts. */
  userInput(): void
  /** One composer keystroke; counted only while the card is on screen. */
  keystroke(): void
  /** The first measurement wins. */
  truncated(value: boolean): void
  /**
   * The bounded-exposure checkpoint: send the record so far and keep
   * tracking. At most once, shared with the leave-the-viewport checkpoint;
   * a no-op unless `checkpoints` is on.
   */
  checkpoint(): void
  /** Ends the impression and sends its record. Idempotent. */
  flush(exit: EngagementExit): void
  /**
   * The process is going away: settle a post-click watch now, with what is
   * already known (`browserOpened` when focus was lost, otherwise unknown).
   */
  closePostClick(): void
  snapshot(exit?: EngagementExit): AdEngagement | undefined
  /** The click block this impression has reported (or would), if clicked. */
  readonly clickBlock: EngagementClickBlock | undefined
  readonly flushed: boolean
  readonly done: boolean
}

type OwnerState = {
  placement: OwnerPlacement
  visible: boolean | undefined
  hovering: boolean
}

const count = (value: number) =>
  Math.min(MAX_COUNT, Math.max(0, Math.floor(value)))

/** Drops `undefined` keys so the wire body carries only what is known. */
function defined<T extends Record<string, unknown>>(value: T): T {
  const out: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value))
    if (entry !== undefined) out[key] = entry
  return out as T
}

export function createEngagementTracker(
  options: EngagementTrackerOptions,
): EngagementTracker {
  const { impUrl, now } = options
  const setTimer = options.setTimer ?? defaultSetTimer
  const clearTimer = options.clearTimer ?? defaultClearTimer
  const clickOnly = options.clickOnly !== undefined
  const priorClick = options.clickOnly?.priorClick
  const checkpoints = !clickOnly && options.checkpoints === true

  const mountAt = now()
  const rotatedAt =
    options.rotatedAt !== undefined &&
    Number.isFinite(options.rotatedAt) &&
    options.rotatedAt <= mountAt
      ? options.rotatedAt
      : mountAt

  const owners = new Map<object, OwnerState>()
  let flushed = false
  let lastAt = mountAt

  let focusSupported = options.focus.supported
  let focused: boolean | null = options.focus.focused

  // Visibility is reported only once something could actually tell.
  let visibilityKnown = false
  let visibleAt: number | undefined
  let visibleMs = 0
  let focusedVisibleMs = 0

  let hoverCount = 0
  let hoverMs = 0
  let firstHoverAt: number | undefined
  let pointerMoved = false

  let sentMessage = false
  let truncated: boolean | undefined

  // wave 2: idle exposure, re-entries, keystrokes on screen
  let lastInputAt: number | undefined =
    options.idleMsAtMount !== undefined &&
    Number.isFinite(options.idleMsAtMount) &&
    options.idleMsAtMount >= 0
      ? mountAt - options.idleMsAtMount
      : undefined
  let idleVisibleMs = 0
  let reentries = 0
  let leftAt: number | undefined
  let keysVisible = 0

  let click: Omit<NonNullable<AdEngagement['click']>, 'count'> | undefined
  let clickCount = 0

  // post-click: armed by the first click only, and outlives the flush
  let postClickSettled = true
  let postClickClickAt = 0
  let postClickLeft = false
  let postClickTimer: TimerHandle | null = null
  let postClick: NonNullable<AdEngagement['postClick']> | undefined
  let postClickSent = false
  let doneReported = false

  // A record (checkpoint, final or click-only) has gone out, so the server
  // has a row for the post-click record to merge into.
  let recordOut = false
  let exposureCheckpointed = false
  let clickCheckpointed = false
  // click-only: the click count the last late-click record carried
  let emittedClickCount = 0

  const isVisible = () => {
    if (flushed) return false
    for (const owner of owners.values())
      if (owner.placement === 'pinned' || owner.visible === true) return true
    return false
  }
  const isHovering = () => {
    if (flushed) return false
    for (const owner of owners.values()) if (owner.hovering) return true
    return false
  }

  let wasVisible = false
  let wasHovering = false

  /** Accrue the interval since the last event under the state that held during it. */
  const advance = (t: number) => {
    const dt = Math.max(0, t - lastAt)
    if (wasVisible) {
      visibleMs += dt
      if (focused === true) focusedVisibleMs += dt
      if (lastInputAt !== undefined) {
        const idleFrom = Math.max(
          lastAt,
          lastInputAt + ENGAGEMENT_IDLE_AFTER_MS,
        )
        if (t > idleFrom) idleVisibleMs += t - idleFrom
      }
    }
    if (wasHovering) hoverMs += dt
    if (t > lastAt) lastAt = t
  }

  /** Re-derive edge-triggered state after a change. */
  const settle = (t: number) => {
    for (const owner of owners.values())
      if (owner.placement === 'pinned' || owner.visible !== undefined)
        visibilityKnown = true
    const visible = isVisible()
    if (!visible && wasVisible) leftAt = t
    if (visible && visibleAt === undefined) visibleAt = t
    wasVisible = visible
    const hovering = isHovering()
    if (hovering && !wasHovering) {
      hoverCount += 1
      if (firstHoverAt === undefined) firstHoverAt = t
    }
    wasHovering = hovering
  }

  const update = (change: (t: number) => void) => {
    const t = now()
    advance(t)
    change(t)
    settle(t)
  }

  const emit = (record: unknown) => {
    const parsed = parseAdEngagement(record)
    if (!parsed) return
    try {
      options.send(parsed)
    } catch {
      // fire-and-forget: a failed report is a missing row, never a broken ad
    }
  }

  const maybeDone = () => {
    if (doneReported || !flushed || !postClickSettled) return
    doneReported = true
    try {
      options.onDone?.()
    } catch {
      // registry bookkeeping only
    }
  }

  const maybeSendPostClick = () => {
    // Held until a record carrying this impression is out, so the server
    // always sees the row it is asked to merge into first.
    if (!recordOut || !postClick || postClickSent) return
    postClickSent = true
    emit({ v: AD_ENGAGEMENT_VERSION, impUrl, postClick })
  }

  const settlePostClick = (
    value: NonNullable<AdEngagement['postClick']> | undefined,
  ) => {
    if (postClickSettled) return
    postClickSettled = true
    if (postClickTimer !== null) {
      clearTimer(postClickTimer)
      postClickTimer = null
    }
    if (value && Object.keys(value).length > 0) postClick = value
    maybeSendPostClick()
    maybeDone()
  }

  const armPostClick = (t: number) => {
    // Only a terminal known to be focused at the click can lose focus to the
    // browser; anything else leaves `postClick` absent (unknown).
    if (!focusSupported || focused !== true) return
    postClickSettled = false
    postClickClickAt = t
    postClickLeft = false
    postClickTimer = setTimer(() => {
      postClickTimer = null
      settlePostClick({ browserOpened: false })
    }, POST_CLICK_LEAVE_GRACE_MS)
  }

  const postClickFocus = (next: boolean) => {
    if (postClickSettled) return
    const t = now()
    if (!next && !postClickLeft) {
      postClickLeft = true
      if (postClickTimer !== null) clearTimer(postClickTimer)
      postClickTimer = setTimer(
        () => {
          postClickTimer = null
          settlePostClick({ browserOpened: true })
        },
        Math.max(0, POST_CLICK_WATCH_MS - (t - postClickClickAt)),
      )
    } else if (next && postClickLeft) {
      settlePostClick(
        defined({
          browserOpened: true,
          returnMs: clampMs(t - postClickClickAt),
        }),
      )
    }
  }

  const build = (exit: EngagementExit | undefined): AdEngagement =>
    defined({
      v: AD_ENGAGEMENT_VERSION,
      impUrl,
      visibleAtMs:
        visibilityKnown && visibleAt !== undefined
          ? clampMs(visibleAt - mountAt)
          : undefined,
      visibleMs: visibilityKnown ? clampMs(visibleMs) : undefined,
      focusedVisibleMs:
        visibilityKnown && focusSupported
          ? clampMs(focusedVisibleMs)
          : undefined,
      hoverCount: count(hoverCount),
      hoverMs: clampMs(hoverMs),
      firstHoverMs:
        firstHoverAt === undefined
          ? undefined
          : clampMs(firstHoverAt - mountAt),
      sentMessageDuringExposure: sentMessage,
      exit,
      truncated,
      idleVisibleMs:
        visibilityKnown && lastInputAt !== undefined
          ? clampMs(idleVisibleMs)
          : undefined,
      reentries: visibilityKnown ? count(reentries) : undefined,
      keysDuringExposure:
        visibilityKnown && options.countsKeys
          ? bucketCount(keysVisible)
          : undefined,
      click: currentClick(),
    }) as AdEngagement

  /**
   * The click block to report. A late click on an impression the server
   * already holds a click for keeps that first click's features and adds to
   * its count: the record describes the FIRST click and counts the rest.
   */
  function currentClick(): EngagementClickBlock | undefined {
    if (clickOnly && priorClick) {
      if (clickCount === 0) return priorClick
      return defined({
        ...priorClick,
        count: count((priorClick.count ?? 1) + clickCount),
      })
    }
    return click ? defined({ ...click, count: count(clickCount) }) : undefined
  }

  /** The record so far, with no `exit`; tracking continues. */
  const sendCheckpoint = () => {
    if (flushed) return
    advance(now())
    emit(build(undefined))
    recordOut = true
    maybeSendPostClick()
  }

  const exposureCheckpoint = () => {
    if (!checkpoints || flushed || exposureCheckpointed) return
    exposureCheckpointed = true
    sendCheckpoint()
  }

  /** click-only: `{ v, impUrl, click }`, when the count moved since the last. */
  const sendLateClick = () => {
    if (clickCount === 0 || clickCount === emittedClickCount) return
    emittedClickCount = clickCount
    emit({ v: AD_ENGAGEMENT_VERSION, impUrl, click: currentClick() })
    recordOut = true
    maybeSendPostClick()
  }

  const tracker: EngagementTracker = {
    impUrl,
    get owners() {
      return owners.size
    },
    get flushed() {
      return flushed
    },
    get done() {
      return flushed && postClickSettled
    },
    get clickBlock() {
      return currentClick()
    },
    attach(owner, placement) {
      if (flushed || owners.has(owner)) return
      update(() => {
        owners.set(owner, { placement, visible: undefined, hovering: false })
      })
    },
    detach(owner) {
      if (flushed || !owners.has(owner)) return
      update(() => {
        owners.delete(owner)
      })
    },
    setVisible(owner, visible) {
      const state = owners.get(owner)
      if (
        flushed ||
        !state ||
        state.placement !== 'measured' ||
        state.visible === visible
      )
        return
      const before = isVisible()
      update((t) => {
        state.visible = visible
        // Only a MEASUREMENT brings a card back: a pinned card remounting
        // inside the release grace is a redraw, not a re-entry.
        if (!before && visible === true && leftAt !== undefined && t > leftAt)
          reentries += 1
      })
      // Scrolled out of the transcript viewport after being seen: the
      // exposure that matters most has happened, and a transcript card may
      // never unmount, so its record goes out now.
      if (before && !isVisible()) exposureCheckpoint()
    },
    hover(owner, hovering) {
      const state = owners.get(owner)
      if (flushed || !state) return
      update(() => {
        if (hovering) pointerMoved = true
        state.hovering = hovering
      })
    },
    click(detail = {}) {
      if (flushed) return
      update((t) => {
        clickCount += 1
        if (click) return
        click = defined({
          msSinceMount: clampMs(t - mountAt),
          msSinceVisible:
            visibilityKnown && visibleAt !== undefined
              ? clampMs(t - visibleAt)
              : undefined,
          msSinceRotation: clampMs(t - rotatedAt),
          pointerMovedOver: pointerMoved,
          windowFocused:
            focusSupported && focused !== null ? focused : undefined,
          region: detail.region,
          modifier: detail.modifier,
        })
        armPostClick(t)
      })
      if (clickOnly) {
        // the first late click goes out now; later ones ride the flush
        if (clickCount === 1) sendLateClick()
      } else if (checkpoints && !clickCheckpointed) {
        clickCheckpointed = true
        sendCheckpoint()
      }
    },
    terminalFocus(next) {
      if (flushed) {
        focusSupported = true
        focused = next
      } else
        update(() => {
          focusSupported = true
          focused = next
        })
      postClickFocus(next)
    },
    messageSent() {
      if (flushed || owners.size === 0) return
      sentMessage = true
    },
    userInput() {
      if (flushed) return
      update((t) => {
        lastInputAt = t
      })
    },
    keystroke() {
      if (flushed || !isVisible()) return
      keysVisible = Math.min(MAX_COUNT, keysVisible + 1)
    },
    truncated(value) {
      if (flushed || truncated !== undefined) return
      truncated = value
    },
    checkpoint() {
      exposureCheckpoint()
    },
    flush(exit) {
      if (flushed) return
      if (clickOnly) {
        flushed = true
        owners.clear()
        wasVisible = false
        wasHovering = false
        sendLateClick()
        maybeSendPostClick()
        maybeDone()
        return
      }
      advance(now())
      const record = build(exit)
      flushed = true
      owners.clear()
      wasVisible = false
      wasHovering = false
      emit(record)
      recordOut = true
      maybeSendPostClick()
      maybeDone()
    },
    closePostClick() {
      if (postClickSettled) return
      settlePostClick(postClickLeft ? { browserOpened: true } : undefined)
    },
    snapshot(exit) {
      if (clickOnly)
        return parseAdEngagement({
          v: AD_ENGAGEMENT_VERSION,
          impUrl,
          click: currentClick(),
        })
      const saved = {
        visibleMs,
        focusedVisibleMs,
        hoverMs,
        idleVisibleMs,
        lastAt,
      }
      if (!flushed) advance(now())
      const record = build(exit)
      visibleMs = saved.visibleMs
      focusedVisibleMs = saved.focusedVisibleMs
      hoverMs = saved.hoverMs
      idleVisibleMs = saved.idleVisibleMs
      lastAt = saved.lastAt
      return parseAdEngagement(record)
    },
  }
  return tracker
}

// ------------------------------------------------------------------ registry

export interface EngagementRegistryEnv extends EngagementTimers {
  now: () => number
  send: (record: AdEngagement) => void
  focus: () => FocusState
  releaseGraceMs?: number
  /**
   * Exposure before a live impression sends its checkpoint; defaults to
   * {@link ENGAGEMENT_CHECKPOINT_MS}. `null` turns every checkpoint off
   * (the leave-the-viewport and first-click ones too).
   */
  checkpointAfterMs?: number | null
  /** ms since the user's last input; null/undefined = unknown. */
  idleMs?: () => number | null | undefined
  /** The composer's keystrokes are forwarded through `keystroke()`. */
  countsKeys?: boolean
  /** An impression's main record went out (its flush). */
  onFlushed?: (impUrl: string) => void
}

/** `flushed`: the main record is out. `unknown`: never tracked this process. */
export type EngagementStatus = 'unknown' | 'live' | 'flushed'

export interface EngagementHandle {
  readonly impUrl: string
  readonly tracker: EngagementTracker
  /** @internal ownership token */
  readonly token: object
}

export interface EngagementRegistry {
  /**
   * Start (or join, or resume) the record for `impUrl`. A redraw of an
   * impression whose record already went out (a creative rotated back into
   * the slot) is not a new impression: it gets a click-only handle, so a
   * click on it still reaches that impression's record. `null` only when
   * there is no impUrl.
   */
  mount(
    impUrl: string | undefined,
    placement: OwnerPlacement,
  ): EngagementHandle | null
  /** The owning card went away; the flush follows the grace unless it remounts. */
  unmount(handle: EngagementHandle): void
  /** Slots swapped creatives: `from` left on a rotation, `to` arrived. */
  noteSlotSwap(from: readonly string[], to: readonly string[]): void
  terminalFocus(focused: boolean): void
  messageSent(): void
  userInput(): void
  keystroke(): void
  status(impUrl: string): EngagementStatus
  /**
   * The CLI is quitting: flush every live record now, as `exit` for a card
   * still on screen (a card inside its release grace keeps the exit it was
   * given), and settle every post-click watch. Idempotent.
   */
  closeAll(exit?: EngagementExit): void
  /** Test seam. */
  reset(): void
  readonly size: number
}

interface Entry {
  tracker: EngagementTracker
  /** the release grace after the last owner left */
  timer: TimerHandle | null
  /** the exit decided when the last owner left, while the grace runs */
  pendingExit: EngagementExit | null
  /** the bounded-exposure checkpoint */
  checkpointTimer: TimerHandle | null
  /** a click-only redraw of an already-flushed impression */
  late: boolean
}

export function decideExit(input: {
  rotatedAway: boolean
  msSinceMessageSent: number | undefined
}): EngagementExit {
  if (input.rotatedAway) return 'rotation'
  if (
    input.msSinceMessageSent !== undefined &&
    input.msSinceMessageSent >= 0 &&
    input.msSinceMessageSent <= NEW_MESSAGE_EXIT_WINDOW_MS
  )
    return 'new_message'
  return 'unmount'
}

export function createEngagementRegistry(
  env: EngagementRegistryEnv,
): EngagementRegistry {
  const setTimer = env.setTimer ?? defaultSetTimer
  const clearTimer = env.clearTimer ?? defaultClearTimer
  const grace = env.releaseGraceMs ?? ENGAGEMENT_RELEASE_GRACE_MS
  const checkpointAfterMs =
    env.checkpointAfterMs === null
      ? null
      : (env.checkpointAfterMs ?? ENGAGEMENT_CHECKPOINT_MS)

  const entries = new Map<string, Entry>()
  // Click-only redraws of impressions in `finished`, keyed the same way.
  const lateEntries = new Map<string, Entry>()
  const finished = new Set<string>()
  const rotatedAway = new Set<string>()
  const swappedInAt = new Map<string, number>()
  // The click block each clicked impression has reported, for late clicks.
  const clicks = new Map<string, EngagementClickBlock>()
  // Flushed click-only trackers displaced by a newer redraw of the same
  // impression while their post-click watch still waits for focus.
  const settling = new Set<EngagementTracker>()
  let lastMessageAt: number | undefined

  const safely = (fn: () => void) => {
    try {
      fn()
    } catch {
      // engagement is additive; it must never break the ad it measures
    }
  }

  const remember = <T>(
    memo: Set<string> | Map<string, T>,
    key: string,
    value?: T,
    max = MAX_SWAP_MEMO,
  ) => {
    // re-inserting moves the key to the newest end
    memo.delete(key)
    if (memo.size >= max) {
      const oldest = memo.keys().next().value
      if (oldest !== undefined) memo.delete(oldest)
    }
    if (memo instanceof Map) memo.set(key, value as T)
    else memo.add(key)
  }

  const clearTimers = (entry: Entry) => {
    if (entry.timer !== null) {
      clearTimer(entry.timer)
      entry.timer = null
    }
    if (entry.checkpointTimer !== null) {
      clearTimer(entry.checkpointTimer)
      entry.checkpointTimer = null
    }
  }

  /** Every tracker that can still use a broadcast. */
  const trackers = (): EngagementTracker[] => [
    ...[...entries.values()].map((entry) => entry.tracker),
    ...[...lateEntries.values()].map((entry) => entry.tracker),
    ...settling,
  ]

  const finish = (impUrl: string, entry: Entry, exit: EngagementExit) => {
    clearTimers(entry)
    entry.pendingExit = null
    const map = entry.late ? lateEntries : entries
    if (!entry.late) {
      finished.add(impUrl)
      rotatedAway.delete(impUrl)
    }
    safely(() => entry.tracker.flush(exit))
    safely(() => {
      const click = entry.tracker.clickBlock
      if (click) remember(clicks, impUrl, click, MAX_CLICK_MEMO)
    })
    if (!entry.late) safely(() => env.onFlushed?.(impUrl))
    if (entry.tracker.done && map.get(impUrl) === entry) map.delete(impUrl)
  }

  const create = (
    impUrl: string,
    late: boolean,
    map: Map<string, Entry>,
  ): Entry => {
    const rotatedAt = swappedInAt.get(impUrl)
    swappedInAt.delete(impUrl)
    const created: Entry = {
      tracker: undefined as never,
      timer: null,
      pendingExit: null,
      checkpointTimer: null,
      late,
    }
    let idleMsAtMount: number | undefined
    try {
      idleMsAtMount = env.idleMs?.() ?? undefined
    } catch {
      idleMsAtMount = undefined
    }
    created.tracker = createEngagementTracker({
      impUrl,
      now: env.now,
      focus: env.focus(),
      rotatedAt,
      idleMsAtMount,
      countsKeys: env.countsKeys,
      checkpoints: !late && checkpointAfterMs !== null,
      ...(late ? { clickOnly: { priorClick: clicks.get(impUrl) } } : {}),
      setTimer,
      clearTimer,
      send: env.send,
      onDone: () => {
        settling.delete(created.tracker)
        if (map.get(impUrl) === created && created.timer === null)
          map.delete(impUrl)
      },
    })
    if (!late && checkpointAfterMs !== null)
      created.checkpointTimer = setTimer(() => {
        created.checkpointTimer = null
        // inside the release grace the final record is a second away
        if (created.timer !== null) return
        safely(() => created.tracker.checkpoint())
      }, checkpointAfterMs)
    map.set(impUrl, created)
    return created
  }

  return {
    get size() {
      return entries.size + lateEntries.size
    },
    mount(impUrl, placement) {
      if (!impUrl) return null
      const late = finished.has(impUrl)
      const map = late ? lateEntries : entries
      const token = {}
      let entry = map.get(impUrl)
      if (entry && entry.tracker.flushed) {
        // a click-only redraw whose own record went out, still watching for
        // focus to come back: it keeps hearing focus, and this fresh redraw
        // gets a fresh click-only tracker
        settling.add(entry.tracker)
        entry = undefined
      }
      if (!entry) {
        entry = create(impUrl, late, map)
      } else if (entry.timer !== null) {
        // a remount inside the grace resumes the same record
        clearTimer(entry.timer)
        entry.timer = null
        entry.pendingExit = null
      }
      const tracker = entry.tracker
      safely(() => tracker.attach(token, placement))
      return { impUrl, tracker, token }
    },
    unmount(handle) {
      const entry = [
        entries.get(handle.impUrl),
        lateEntries.get(handle.impUrl),
      ].find((candidate) => candidate?.tracker === handle.tracker)
      if (!entry || entry.tracker.flushed) return
      safely(() => entry.tracker.detach(handle.token))
      if (entry.tracker.owners > 0 || entry.timer !== null) return
      // The exit is decided NOW, from what is known at the moment the last
      // owner left; the flush waits out the grace for a remount.
      const exit = decideExit({
        rotatedAway: rotatedAway.has(handle.impUrl),
        msSinceMessageSent:
          lastMessageAt === undefined ? undefined : env.now() - lastMessageAt,
      })
      entry.pendingExit = exit
      entry.timer = setTimer(() => {
        entry.timer = null
        finish(handle.impUrl, entry, exit)
      }, grace)
    },
    noteSlotSwap(from, to) {
      const incoming = new Set(to)
      for (const impUrl of from)
        if (impUrl && !incoming.has(impUrl) && !finished.has(impUrl))
          remember(rotatedAway, impUrl)
      const outgoing = new Set(from)
      for (const impUrl of to) {
        if (!impUrl || outgoing.has(impUrl)) continue
        rotatedAway.delete(impUrl)
        // a flushed impression rotating back in is remembered too: a late
        // click on it is timed from this swap
        remember(swappedInAt, impUrl, env.now())
      }
    },
    terminalFocus(focused) {
      for (const tracker of trackers())
        safely(() => tracker.terminalFocus(focused))
    },
    messageSent() {
      lastMessageAt = env.now()
      for (const tracker of trackers()) safely(() => tracker.messageSent())
    },
    userInput() {
      for (const tracker of trackers()) safely(() => tracker.userInput())
    },
    keystroke() {
      for (const tracker of trackers()) safely(() => tracker.keystroke())
    },
    status(impUrl) {
      if (finished.has(impUrl)) return 'flushed'
      return entries.has(impUrl) ? 'live' : 'unknown'
    },
    closeAll(exit = 'window_close') {
      for (const map of [entries, lateEntries])
        for (const [impUrl, entry] of [...map]) {
          if (!entry.tracker.flushed)
            finish(
              impUrl,
              entry,
              entry.tracker.owners > 0 ? exit : (entry.pendingExit ?? exit),
            )
          clearTimers(entry)
          safely(() => entry.tracker.closePostClick())
          map.delete(impUrl)
        }
      for (const tracker of [...settling])
        safely(() => tracker.closePostClick())
      settling.clear()
    },
    reset() {
      for (const entry of [...entries.values(), ...lateEntries.values()])
        clearTimers(entry)
      entries.clear()
      lateEntries.clear()
      finished.clear()
      rotatedAway.clear()
      swappedInAt.clear()
      clicks.clear()
      settling.clear()
      lastMessageAt = undefined
    },
  }
}

// --------------------------------------------------------------- truncation

/**
 * Whether the width budget cut or ellipsized any of the creative's text. Each
 * pair is (what the advertiser wrote, what the layout drew); an empty source
 * cannot be truncated.
 */
export function layoutTruncated(
  pairs: readonly (readonly [string | undefined, string | undefined])[],
): boolean {
  for (const [source, shown] of pairs) {
    const original = (source ?? '').trim()
    if (!original) continue
    if ((shown ?? '').trim() !== original) return true
  }
  return false
}

// ---------------------------------------------------------- viewport check

/**
 * A transcript card is on screen when any of its rows lies inside the
 * scrollbox viewport. `undefined` when either side cannot be measured.
 */
export function rowsIntersect(
  card: { top: number; height: number } | null,
  viewport: { top: number; bottom: number } | null,
): boolean | undefined {
  if (!card || !viewport) return undefined
  if (
    !Number.isFinite(card.top) ||
    !Number.isFinite(card.height) ||
    card.height <= 0
  )
    return undefined
  return card.top < viewport.bottom && card.top + card.height > viewport.top
}
