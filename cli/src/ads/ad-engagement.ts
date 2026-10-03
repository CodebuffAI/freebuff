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
 *
 * Two layers, so the timing rules are tested with a fake clock and no TUI:
 * `createEngagementTracker` (one impression's state machine, possibly drawn
 * in several places at once: the inline pool repeats an ad across slots) and
 * `createEngagementRegistry` (ownership by `impUrl`, the release grace that
 * lets a remount resume the same record, exactly one flush per impression).
 */
import {
  AD_ENGAGEMENT_VERSION,
  AD_MS_CAP,
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

const MAX_COUNT = 10_000
/** Bounds the rotation memos: a slot that rotates for a week must not grow them. */
const MAX_SWAP_MEMO = 64

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
  /** The first measurement wins. */
  truncated(value: boolean): void
  /** Ends the impression and sends its record. Idempotent. */
  flush(exit: EngagementExit): void
  snapshot(exit?: EngagementExit): AdEngagement | undefined
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
    // Held until the main record is out, so the server always sees the row it
    // is asked to merge into first.
    if (!flushed || !postClick || postClickSent) return
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
      click: click
        ? defined({ ...click, count: count(clickCount) })
        : undefined,
    }) as AdEngagement

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
      update(() => {
        state.visible = visible
      })
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
    truncated(value) {
      if (flushed || truncated !== undefined) return
      truncated = value
    },
    flush(exit) {
      if (flushed) return
      advance(now())
      const record = build(exit)
      flushed = true
      owners.clear()
      wasVisible = false
      wasHovering = false
      emit(record)
      maybeSendPostClick()
      maybeDone()
    },
    snapshot(exit) {
      const saved = { visibleMs, focusedVisibleMs, hoverMs, lastAt }
      if (!flushed) advance(now())
      const record = build(exit)
      visibleMs = saved.visibleMs
      focusedVisibleMs = saved.focusedVisibleMs
      hoverMs = saved.hoverMs
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
}

export interface EngagementHandle {
  readonly impUrl: string
  readonly tracker: EngagementTracker
  /** @internal ownership token */
  readonly token: object
}

export interface EngagementRegistry {
  /**
   * Start (or join, or resume) the record for `impUrl`. `null` when there is
   * nothing to track: no impUrl, or the impression already flushed this
   * process (a creative rotated back into the slot is not a new impression).
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
  /** Test seam. */
  reset(): void
  readonly size: number
}

interface Entry {
  tracker: EngagementTracker
  timer: TimerHandle | null
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

  const entries = new Map<string, Entry>()
  const finished = new Set<string>()
  const rotatedAway = new Set<string>()
  const swappedInAt = new Map<string, number>()
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
  ) => {
    if (memo.size >= MAX_SWAP_MEMO) {
      const oldest = memo.keys().next().value
      if (oldest !== undefined) memo.delete(oldest)
    }
    if (memo instanceof Map) memo.set(key, value as T)
    else memo.add(key)
  }

  const finish = (impUrl: string, entry: Entry, exit: EngagementExit) => {
    if (entry.timer !== null) {
      clearTimer(entry.timer)
      entry.timer = null
    }
    finished.add(impUrl)
    rotatedAway.delete(impUrl)
    safely(() => entry.tracker.flush(exit))
    if (entry.tracker.done && entries.get(impUrl) === entry)
      entries.delete(impUrl)
  }

  return {
    get size() {
      return entries.size
    },
    mount(impUrl, placement) {
      if (!impUrl || finished.has(impUrl)) return null
      const token = {}
      let entry = entries.get(impUrl)
      if (!entry) {
        const rotatedAt = swappedInAt.get(impUrl)
        swappedInAt.delete(impUrl)
        const created: Entry = { tracker: undefined as never, timer: null }
        created.tracker = createEngagementTracker({
          impUrl,
          now: env.now,
          focus: env.focus(),
          rotatedAt,
          setTimer,
          clearTimer,
          send: env.send,
          onDone: () => {
            if (entries.get(impUrl) === created && created.timer === null)
              entries.delete(impUrl)
          },
        })
        entries.set(impUrl, created)
        entry = created
      } else if (entry.timer !== null) {
        // a remount inside the grace resumes the same record
        clearTimer(entry.timer)
        entry.timer = null
      }
      const tracker = entry.tracker
      safely(() => tracker.attach(token, placement))
      return { impUrl, tracker, token }
    },
    unmount(handle) {
      const entry = entries.get(handle.impUrl)
      if (!entry || entry.tracker !== handle.tracker || entry.tracker.flushed)
        return
      safely(() => entry.tracker.detach(handle.token))
      if (entry.tracker.owners > 0 || entry.timer !== null) return
      // The exit is decided NOW, from what is known at the moment the last
      // owner left; the flush waits out the grace for a remount.
      const exit = decideExit({
        rotatedAway: rotatedAway.has(handle.impUrl),
        msSinceMessageSent:
          lastMessageAt === undefined ? undefined : env.now() - lastMessageAt,
      })
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
        if (!impUrl || outgoing.has(impUrl) || finished.has(impUrl)) continue
        rotatedAway.delete(impUrl)
        remember(swappedInAt, impUrl, env.now())
      }
    },
    terminalFocus(focused) {
      for (const entry of entries.values())
        safely(() => entry.tracker.terminalFocus(focused))
    },
    messageSent() {
      lastMessageAt = env.now()
      for (const entry of entries.values())
        safely(() => entry.tracker.messageSent())
    },
    reset() {
      for (const entry of entries.values())
        if (entry.timer !== null) clearTimer(entry.timer)
      entries.clear()
      finished.clear()
      rotatedAway.clear()
      swappedInAt.clear()
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
