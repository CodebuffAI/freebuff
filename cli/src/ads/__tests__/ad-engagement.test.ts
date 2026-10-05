import { describe, expect, test } from 'bun:test'

import {
  AD_MS_CAP,
  parseAdEngagement,
} from '@codebuff/common/types/ad-client-context'

import {
  ENGAGEMENT_CHECKPOINT_MS,
  ENGAGEMENT_IDLE_AFTER_MS,
  ENGAGEMENT_RELEASE_GRACE_MS,
  POST_CLICK_LEAVE_GRACE_MS,
  createEngagementRegistry,
  createEngagementTracker,
  decideExit,
  layoutTruncated,
  rowsIntersect,
} from '../ad-engagement'
import {
  clickModifier,
  createAdEngagementPoster,
  flushAdEngagementOnExit,
} from '../use-ad-engagement'

import type { EngagementTrackerOptions, FocusState } from '../ad-engagement'
import type { AdEngagement } from '@codebuff/common/types/ad-client-context'

function clock() {
  let now = 1_000
  let id = 0
  const timers = new Map<number, { at: number; fn: () => void }>()
  return {
    now: () => now,
    setTimer: (fn: () => void, ms: number) => {
      timers.set(++id, { at: now + ms, fn })
      return id
    },
    clearTimer: (handle: unknown) => {
      timers.delete(handle as number)
    },
    timers,
    advance(ms: number) {
      const target = now + ms
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, t]) => t.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        now = due[1].at
        timers.delete(due[0])
        due[1].fn()
      }
      now = target
    },
  }
}

const NO_FOCUS: FocusState = { supported: false, focused: null }
const FOCUSED: FocusState = { supported: true, focused: true }

function trackerHarness(
  focus: FocusState = NO_FOCUS,
  extra: Partial<EngagementTrackerOptions> = {},
) {
  const c = clock()
  const sent: AdEngagement[] = []
  let done = 0
  const tracker = createEngagementTracker({
    impUrl: 'imp-1',
    now: c.now,
    focus,
    setTimer: c.setTimer,
    clearTimer: c.clearTimer,
    send: (record) => sent.push(record),
    onDone: () => done++,
    ...extra,
  })
  return { c, sent, tracker, done: () => done }
}

describe('engagement tracker: hover', () => {
  test('counts hover entries and accrues hover time per entry', () => {
    const { c, sent, tracker } = trackerHarness()
    const owner = {}
    tracker.attach(owner, 'pinned')
    c.advance(2_000)
    tracker.hover(owner, true)
    c.advance(500)
    tracker.hover(owner, false)
    c.advance(1_000)
    tracker.hover(owner, true)
    c.advance(250)
    tracker.hover(owner, false)
    tracker.flush('unmount')
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({
      hoverCount: 2,
      hoverMs: 750,
      firstHoverMs: 2_000,
      exit: 'unmount',
    })
  })

  test('a repeated over without an out is one hover', () => {
    const { c, sent, tracker } = trackerHarness()
    const owner = {}
    tracker.attach(owner, 'pinned')
    tracker.hover(owner, true)
    c.advance(100)
    tracker.hover(owner, true)
    c.advance(100)
    tracker.flush('unmount')
    expect(sent[0]).toMatchObject({ hoverCount: 1, hoverMs: 200 })
  })

  test('hovering two drawn copies at once is one hover', () => {
    const { c, sent, tracker } = trackerHarness()
    const a = {}
    const b = {}
    tracker.attach(a, 'pinned')
    tracker.attach(b, 'pinned')
    tracker.hover(a, true)
    c.advance(100)
    tracker.hover(b, true)
    tracker.hover(a, false)
    c.advance(100)
    tracker.hover(b, false)
    tracker.flush('unmount')
    expect(sent[0]).toMatchObject({ hoverCount: 1, hoverMs: 200 })
  })
})

describe('engagement tracker: visibility', () => {
  test('a pinned card is visible for exactly as long as it is attached', () => {
    const { c, sent, tracker } = trackerHarness()
    const owner = {}
    tracker.attach(owner, 'pinned')
    c.advance(4_000)
    tracker.detach(owner)
    c.advance(10_000)
    tracker.flush('unmount')
    expect(sent[0]).toMatchObject({ visibleAtMs: 0, visibleMs: 4_000 })
    expect(sent[0]!.mrc50).toBeUndefined()
  })

  test('a measured card omits visibility until a measurement succeeds', () => {
    const { c, sent, tracker } = trackerHarness()
    const owner = {}
    tracker.attach(owner, 'measured')
    c.advance(1_000)
    tracker.setVisible(owner, undefined)
    c.advance(1_000)
    tracker.flush('unmount')
    expect(sent[0]!.visibleAtMs).toBeUndefined()
    expect(sent[0]!.visibleMs).toBeUndefined()
  })

  test('a measured card accrues only while inside the viewport', () => {
    const { c, sent, tracker } = trackerHarness()
    const owner = {}
    tracker.attach(owner, 'measured')
    c.advance(500)
    tracker.setVisible(owner, false)
    c.advance(1_500)
    tracker.setVisible(owner, true)
    c.advance(3_000)
    tracker.setVisible(owner, false)
    c.advance(2_000)
    tracker.flush('unmount')
    expect(sent[0]).toMatchObject({ visibleAtMs: 2_000, visibleMs: 3_000 })
  })

  test('scrolled away and never seen is a known zero', () => {
    const { c, sent, tracker } = trackerHarness()
    const owner = {}
    tracker.attach(owner, 'measured')
    tracker.setVisible(owner, false)
    c.advance(5_000)
    tracker.flush('unmount')
    expect(sent[0]!.visibleMs).toBe(0)
    expect(sent[0]!.visibleAtMs).toBeUndefined()
  })

  test('focusedVisibleMs needs focus reports and counts only focused time', () => {
    const { c, sent, tracker } = trackerHarness(FOCUSED)
    const owner = {}
    tracker.attach(owner, 'pinned')
    c.advance(1_000)
    tracker.terminalFocus(false)
    c.advance(2_000)
    tracker.terminalFocus(true)
    c.advance(500)
    tracker.flush('unmount')
    expect(sent[0]).toMatchObject({ visibleMs: 3_500, focusedVisibleMs: 1_500 })
  })

  test('without focus reports focusedVisibleMs is absent, not zero', () => {
    const { c, sent, tracker } = trackerHarness()
    tracker.attach({}, 'pinned')
    c.advance(1_000)
    tracker.flush('unmount')
    expect(sent[0]!.focusedVisibleMs).toBeUndefined()
  })
})

describe('engagement tracker: click and post-click', () => {
  test('captures the first click and counts the rest', () => {
    const { c, sent, tracker } = trackerHarness()
    const owner = {}
    tracker.attach(owner, 'pinned')
    c.advance(700)
    tracker.hover(owner, true)
    c.advance(300)
    tracker.click({ modifier: true, region: 'cta' })
    c.advance(100)
    tracker.click()
    tracker.flush('unmount')
    expect(sent).toHaveLength(1)
    expect(sent[0]!.click).toEqual({
      msSinceMount: 1_000,
      msSinceVisible: 1_000,
      msSinceRotation: 1_000,
      pointerMovedOver: true,
      region: 'cta',
      modifier: true,
      count: 2,
    })
    // no focus reports: neither the click's focus nor a post-click record
    expect(sent[0]!.postClick).toBeUndefined()
  })

  test('a click with no hover before it says so', () => {
    const { sent, tracker } = trackerHarness()
    tracker.attach({}, 'pinned')
    tracker.click()
    tracker.flush('unmount')
    expect(sent[0]!.click).toMatchObject({ pointerMovedOver: false, count: 1 })
  })

  test('focus lost after a click, then regained: browser opened, return time', () => {
    const { c, sent, tracker, done } = trackerHarness(FOCUSED)
    tracker.attach({}, 'pinned')
    c.advance(1_000)
    tracker.click()
    c.advance(800)
    tracker.terminalFocus(false)
    c.advance(9_200)
    tracker.terminalFocus(true)
    // held until the exposure record is out
    expect(sent).toHaveLength(0)
    tracker.flush('rotation')
    expect(sent).toHaveLength(2)
    expect(sent[0]!.click).toMatchObject({ windowFocused: true })
    expect(sent[1]).toEqual({
      v: 1,
      impUrl: 'imp-1',
      postClick: { browserOpened: true, returnMs: 10_000 },
    })
    expect(done()).toBe(1)
  })

  test('no focus loss inside the grace: the browser did not open', () => {
    const { c, sent, tracker } = trackerHarness(FOCUSED)
    tracker.attach({}, 'pinned')
    tracker.click()
    tracker.flush('unmount')
    expect(sent).toHaveLength(1)
    c.advance(POST_CLICK_LEAVE_GRACE_MS)
    expect(sent).toHaveLength(2)
    expect(sent[1]!.postClick).toEqual({ browserOpened: false })
  })

  test('a terminal that never came back is opened without a return time', () => {
    const { c, sent, tracker } = trackerHarness(FOCUSED)
    tracker.attach({}, 'pinned')
    tracker.click()
    c.advance(100)
    tracker.terminalFocus(false)
    tracker.flush('unmount')
    c.advance(AD_MS_CAP)
    expect(sent[1]!.postClick).toEqual({ browserOpened: true })
  })

  test('a click while unfocused arms no post-click watch', () => {
    const { c, sent, tracker, done } = trackerHarness({
      supported: true,
      focused: false,
    })
    tracker.attach({}, 'pinned')
    tracker.click()
    tracker.flush('unmount')
    c.advance(AD_MS_CAP)
    expect(sent).toHaveLength(1)
    expect(sent[0]!.click).toMatchObject({ windowFocused: false })
    expect(done()).toBe(1)
  })
})

describe('engagement tracker: flush', () => {
  test('flushes exactly once and ignores events after it', () => {
    const { c, sent, tracker } = trackerHarness()
    const owner = {}
    tracker.attach(owner, 'pinned')
    tracker.truncated(true)
    tracker.truncated(false)
    tracker.messageSent()
    c.advance(1_000)
    tracker.flush('new_message')
    tracker.hover(owner, true)
    tracker.click()
    tracker.flush('unmount')
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({
      exit: 'new_message',
      truncated: true,
      sentMessageDuringExposure: true,
      hoverCount: 0,
    })
    expect(sent[0]!.click).toBeUndefined()
  })
})

function registryHarness(focus: FocusState = NO_FOCUS) {
  const c = clock()
  const sent: AdEngagement[] = []
  const registry = createEngagementRegistry({
    now: c.now,
    send: (record) => sent.push(record),
    focus: () => focus,
    setTimer: c.setTimer,
    clearTimer: c.clearTimer,
  })
  return { c, sent, registry }
}

describe('engagement registry', () => {
  test('a rotation ends the old record as `rotation` after the grace', () => {
    const { c, sent, registry } = registryHarness()
    registry.noteSlotSwap([], ['a'])
    const a = registry.mount('a', 'pinned')!
    c.advance(60_000)
    registry.noteSlotSwap(['a'], ['b'])
    registry.unmount(a)
    const b = registry.mount('b', 'pinned')!
    expect(sent).toHaveLength(0)
    c.advance(ENGAGEMENT_RELEASE_GRACE_MS)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({
      impUrl: 'a',
      exit: 'rotation',
      visibleMs: 60_000,
    })
    expect(b.tracker.flushed).toBe(false)
  })

  test('the slot swap time is the rotation origin of the next creative', () => {
    const { c, sent, registry } = registryHarness()
    registry.noteSlotSwap([], ['b'])
    c.advance(40)
    const b = registry.mount('b', 'pinned')!
    c.advance(960)
    b.tracker.click()
    registry.unmount(b)
    c.advance(ENGAGEMENT_RELEASE_GRACE_MS)
    expect(sent[0]!.click).toMatchObject({
      msSinceMount: 960,
      msSinceRotation: 1_000,
    })
  })

  test('a remount inside the grace resumes the same record', () => {
    const { c, sent, registry } = registryHarness()
    const first = registry.mount('a', 'pinned')!
    c.advance(1_000)
    first.tracker.hover(first.token, true)
    c.advance(100)
    registry.unmount(first)
    c.advance(200)
    const second = registry.mount('a', 'pinned')!
    expect(second.tracker).toBe(first.tracker)
    c.advance(5_000)
    registry.unmount(second)
    c.advance(ENGAGEMENT_RELEASE_GRACE_MS)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({
      exit: 'unmount',
      hoverCount: 1,
      visibleMs: 6_100,
    })
  })

  test('a creative rotated back into the slot is not a second impression', () => {
    const { c, sent, registry } = registryHarness()
    const a = registry.mount('a', 'pinned')!
    registry.unmount(a)
    c.advance(ENGAGEMENT_RELEASE_GRACE_MS)
    // the redraw gets a click-only handle: unclicked, it sends nothing
    const again = registry.mount('a', 'pinned')!
    expect(again.tracker).not.toBe(a.tracker)
    c.advance(30_000)
    registry.unmount(again)
    c.advance(ENGAGEMENT_RELEASE_GRACE_MS)
    expect(sent).toHaveLength(1)
    expect(registry.status('a')).toBe('flushed')
    expect(registry.size).toBe(0)
  })

  test('an ad drawn in two transcript slots flushes once, when the last goes', () => {
    const { c, sent, registry } = registryHarness()
    const one = registry.mount('a', 'measured')!
    const two = registry.mount('a', 'measured')!
    one.tracker.setVisible(one.token, true)
    c.advance(1_000)
    registry.unmount(one)
    c.advance(ENGAGEMENT_RELEASE_GRACE_MS * 3)
    expect(sent).toHaveLength(0)
    two.tracker.setVisible(two.token, true)
    c.advance(1_000)
    registry.unmount(two)
    c.advance(ENGAGEMENT_RELEASE_GRACE_MS)
    expect(sent).toHaveLength(1)
    expect(sent[0]!.visibleMs).toBe(2_000)
  })

  test('an unmount right after a send is a `new_message` exit', () => {
    const { c, sent, registry } = registryHarness()
    const a = registry.mount('a', 'pinned')!
    c.advance(5_000)
    registry.messageSent()
    c.advance(10)
    registry.unmount(a)
    c.advance(ENGAGEMENT_RELEASE_GRACE_MS)
    expect(sent[0]).toMatchObject({
      exit: 'new_message',
      sentMessageDuringExposure: true,
    })
  })

  test('focus changes reach live and post-click trackers alike', () => {
    const { c, sent, registry } = registryHarness(FOCUSED)
    const a = registry.mount('a', 'pinned')!
    a.tracker.click()
    // the click checkpoint
    expect(sent).toHaveLength(1)
    registry.unmount(a)
    c.advance(ENGAGEMENT_RELEASE_GRACE_MS)
    expect(sent).toHaveLength(2)
    registry.terminalFocus(false)
    c.advance(4_000)
    registry.terminalFocus(true)
    expect(sent).toHaveLength(3)
    expect(sent[2]!.postClick).toEqual({
      browserOpened: true,
      returnMs: ENGAGEMENT_RELEASE_GRACE_MS + 4_000,
    })
    expect(registry.size).toBe(0)
  })

  test('nothing to track without an impUrl', () => {
    const { registry } = registryHarness()
    expect(registry.mount(undefined, 'pinned')).toBeNull()
    expect(registry.mount('', 'pinned')).toBeNull()
  })
})

describe('helpers', () => {
  test('decideExit', () => {
    expect(decideExit({ rotatedAway: true, msSinceMessageSent: 0 })).toBe(
      'rotation',
    )
    expect(decideExit({ rotatedAway: false, msSinceMessageSent: 500 })).toBe(
      'new_message',
    )
    expect(decideExit({ rotatedAway: false, msSinceMessageSent: 5_000 })).toBe(
      'unmount',
    )
    expect(
      decideExit({ rotatedAway: false, msSinceMessageSent: undefined }),
    ).toBe('unmount')
  })

  test('layoutTruncated', () => {
    expect(layoutTruncated([['Short title', 'Short title']])).toBe(false)
    expect(layoutTruncated([['A long title', 'A long t…']])).toBe(true)
    expect(
      layoutTruncated([
        ['', ''],
        [undefined, 'x'],
      ]),
    ).toBe(false)
    expect(layoutTruncated([['  padded  ', 'padded']])).toBe(false)
  })

  test('rowsIntersect', () => {
    const viewport = { top: 2, bottom: 20 }
    expect(rowsIntersect({ top: 5, height: 4 }, viewport)).toBe(true)
    expect(rowsIntersect({ top: -2, height: 5 }, viewport)).toBe(true)
    expect(rowsIntersect({ top: -10, height: 4 }, viewport)).toBe(false)
    expect(rowsIntersect({ top: 20, height: 4 }, viewport)).toBe(false)
    expect(rowsIntersect({ top: 5, height: 4 }, null)).toBeUndefined()
    expect(rowsIntersect({ top: 5, height: 0 }, viewport)).toBeUndefined()
  })

  test('clickModifier reads OpenTUI mouse events', () => {
    expect(clickModifier(undefined)).toBeUndefined()
    expect(
      clickModifier({
        button: 0,
        modifiers: { shift: false, alt: false, ctrl: false },
      }),
    ).toBe(false)
    expect(
      clickModifier({
        button: 0,
        modifiers: { shift: false, alt: true, ctrl: false },
      }),
    ).toBe(true)
    expect(clickModifier({ button: 1 })).toBe(true)
  })
})

// ------------------------------------------------------------------ wave 2

function waveTwoTracker(options: { idleMsAtMount?: number; countsKeys?: boolean }) {
  const c = clock()
  const sent: AdEngagement[] = []
  const tracker = createEngagementTracker({
    impUrl: 'imp-2',
    now: c.now,
    focus: NO_FOCUS,
    setTimer: c.setTimer,
    clearTimer: c.clearTimer,
    send: (record) => sent.push(record),
    ...options,
  })
  return { c, sent, tracker }
}

describe('engagement tracker: wave 2', () => {
  test('idleVisibleMs counts visible time after 30s without input', () => {
    const { c, sent, tracker } = waveTwoTracker({ idleMsAtMount: 10_000 })
    tracker.attach({}, 'pinned')
    // idle from mount + 20s
    c.advance(50_000)
    tracker.userInput()
    c.advance(10_000)
    tracker.flush('unmount')
    expect(sent[0]).toMatchObject({ visibleMs: 60_000, idleVisibleMs: 30_000 })
  })

  test('idle while invisible is not counted', () => {
    const { c, sent, tracker } = waveTwoTracker({ idleMsAtMount: 0 })
    const owner = {}
    tracker.attach(owner, 'measured')
    tracker.setVisible(owner, false)
    c.advance(ENGAGEMENT_IDLE_AFTER_MS + 20_000)
    tracker.setVisible(owner, true)
    c.advance(5_000)
    tracker.flush('unmount')
    expect(sent[0]).toMatchObject({ visibleMs: 5_000, idleVisibleMs: 5_000 })
  })

  test('without a known last input idleVisibleMs is absent, not zero', () => {
    const { c, sent, tracker } = waveTwoTracker({})
    tracker.attach({}, 'pinned')
    c.advance(120_000)
    tracker.flush('unmount')
    expect(sent[0]!.idleVisibleMs).toBeUndefined()
  })

  test('reentries count measured returns to the viewport only', () => {
    const { c, sent, tracker } = waveTwoTracker({})
    const owner = {}
    tracker.attach(owner, 'measured')
    tracker.setVisible(owner, true)
    c.advance(1_000)
    tracker.setVisible(owner, false)
    c.advance(1_000)
    tracker.setVisible(owner, true)
    c.advance(1_000)
    tracker.setVisible(owner, false)
    c.advance(1_000)
    tracker.setVisible(owner, true)
    tracker.flush('unmount')
    expect(sent[0]!.reentries).toBe(2)
  })

  test('a pinned card has no re-entries; unknown visibility has none either', () => {
    const pinned = waveTwoTracker({})
    pinned.tracker.attach({}, 'pinned')
    pinned.c.advance(1_000)
    pinned.tracker.flush('unmount')
    expect(pinned.sent[0]!.reentries).toBe(0)

    const unknown = waveTwoTracker({})
    unknown.tracker.attach({}, 'measured')
    unknown.tracker.flush('unmount')
    expect(unknown.sent[0]!.reentries).toBeUndefined()
  })

  test('keysDuringExposure counts only keystrokes while on screen, bucketed', () => {
    const { c, sent, tracker } = waveTwoTracker({ countsKeys: true })
    const owner = {}
    tracker.attach(owner, 'measured')
    tracker.setVisible(owner, false)
    for (let i = 0; i < 50; i++) tracker.keystroke()
    tracker.setVisible(owner, true)
    for (let i = 0; i < 4; i++) tracker.keystroke()
    c.advance(1_000)
    tracker.flush('unmount')
    expect(sent[0]!.keysDuringExposure).toBe('2-5')
    expect(typeof sent[0]!.keysDuringExposure).toBe('string')
  })

  test('without the composer wired keysDuringExposure is absent', () => {
    const { sent, tracker } = waveTwoTracker({})
    tracker.attach({}, 'pinned')
    tracker.keystroke()
    tracker.flush('unmount')
    expect(sent[0]!.keysDuringExposure).toBeUndefined()
    expect(sent[0]!.dismissMs).toBeUndefined()
    expect(sent[0]!.cardWidth).toBeUndefined()
  })
})

describe('engagement registry: wave 2', () => {
  test('forwards input and keystrokes, reports status and flushes', () => {
    const c = clock()
    const sent: AdEngagement[] = []
    const flushed: string[] = []
    const registry = createEngagementRegistry({
      now: c.now,
      send: (record) => sent.push(record),
      focus: () => NO_FOCUS,
      setTimer: c.setTimer,
      clearTimer: c.clearTimer,
      idleMs: () => 0,
      countsKeys: true,
      onFlushed: (impUrl) => flushed.push(impUrl),
    })
    expect(registry.status('a')).toBe('unknown')
    const a = registry.mount('a', 'pinned')!
    expect(registry.status('a')).toBe('live')
    registry.keystroke()
    registry.keystroke()
    c.advance(ENGAGEMENT_IDLE_AFTER_MS + 10_000)
    registry.userInput()
    c.advance(1_000)
    registry.unmount(a)
    c.advance(ENGAGEMENT_RELEASE_GRACE_MS)
    expect(registry.status('a')).toBe('flushed')
    expect(flushed).toEqual(['a'])
    expect(sent[0]).toMatchObject({
      keysDuringExposure: '2-5',
      idleVisibleMs: 10_000,
      reentries: 0,
    })
  })
})

/**
 * `upsertAdEngagement`'s conflict branch
 * (packages/internal/src/ad-serving/ad-engagement.ts), in JS: the stored
 * payload is the record minus `v` and `impUrl`, merged shallowly with the
 * later write winning, except `postClick`, which merges one level deeper.
 */
function serverMerge(
  existing: Record<string, unknown> | undefined,
  record: AdEngagement,
): Record<string, unknown> {
  const parsed = parseAdEngagement(record)
  if (!parsed) throw new Error('the route would 400 this record')
  const { v: _v, impUrl: _impUrl, ...payload } = parsed
  if (!existing) return payload
  const merged: Record<string, unknown> = { ...existing, ...payload }
  if (
    typeof existing.postClick === 'object' &&
    typeof payload.postClick === 'object'
  )
    merged.postClick = { ...existing.postClick, ...payload.postClick }
  return merged
}

describe('late clicks: a redraw of an already-flushed impression (bug 1)', () => {
  test('a click on a creative rotated back after its record went out reaches the record', () => {
    const { c, sent, registry } = registryHarness()
    registry.noteSlotSwap([], ['a'])
    const a = registry.mount('a', 'pinned')!
    c.advance(60_000)
    registry.noteSlotSwap(['a'], ['b'])
    registry.unmount(a)
    const b = registry.mount('b', 'pinned')!
    c.advance(ENGAGEMENT_RELEASE_GRACE_MS)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ impUrl: 'a', exit: 'rotation' })
    expect(sent[0]!.click).toBeUndefined()

    // an hour later the cache rotates `a` back in under the same impUrl
    c.advance(3_600_000)
    registry.noteSlotSwap(['b'], ['a'])
    registry.unmount(b)
    c.advance(300)
    const redraw = registry.mount('a', 'pinned')!
    expect(redraw).not.toBeNull()
    c.advance(700)
    redraw.tracker.hover(redraw.token, true)
    redraw.tracker.click({ region: 'cta' })

    const late = sent.find((r) => r.impUrl === 'a' && r !== sent[0])!
    // ONLY the click: the exposure record is closed and must not be touched
    expect(late).toEqual({
      v: 1,
      impUrl: 'a',
      click: {
        msSinceMount: 700,
        msSinceVisible: 700,
        msSinceRotation: 1_000,
        pointerMovedOver: true,
        region: 'cta',
        count: 1,
      },
    })

    // merged into the stored exposure record, every exposure key survives
    const row = serverMerge(serverMerge(undefined, sent[0]!), late)
    expect(row).toMatchObject({
      exit: 'rotation',
      visibleMs: 60_000,
      click: { msSinceRotation: 1_000, count: 1 },
    })

    // the redraw's own unmount sends nothing more
    const before = sent.length
    registry.unmount(redraw)
    c.advance(ENGAGEMENT_RELEASE_GRACE_MS)
    expect(sent).toHaveLength(before)
    expect(registry.status('a')).toBe('flushed')
  })

  test('a late click on an already-clicked impression keeps the first click and counts', () => {
    const { c, sent, registry } = registryHarness()
    const a = registry.mount('a', 'pinned')!
    c.advance(2_000)
    a.tracker.click({ region: 'cta' })
    registry.unmount(a)
    c.advance(ENGAGEMENT_RELEASE_GRACE_MS)
    const final = sent.at(-1)!
    expect(final).toMatchObject({ exit: 'unmount', click: { count: 1 } })
    let row = serverMerge(undefined, sent[0]!)
    row = serverMerge(row, final)

    for (const expected of [2, 3]) {
      c.advance(120_000)
      const redraw = registry.mount('a', 'pinned')!
      c.advance(50)
      redraw.tracker.click()
      const late = sent.at(-1)!
      expect(late.click).toEqual({ ...final.click, count: expected })
      expect(Object.keys(late).sort()).toEqual(['click', 'impUrl', 'v'])
      row = serverMerge(row, late)
      registry.unmount(redraw)
      c.advance(ENGAGEMENT_RELEASE_GRACE_MS)
    }
    expect(row).toMatchObject({
      exit: 'unmount',
      visibleMs: 2_000,
      click: { ...final.click, count: 3 },
    })
  })

  test('repeat clicks on one redraw ride its flush; an unclicked redraw sends nothing', () => {
    const { sent, tracker, done } = trackerHarness(NO_FOCUS, {
      clickOnly: {},
    })
    tracker.attach({}, 'pinned')
    tracker.click()
    tracker.click()
    tracker.click()
    expect(sent).toHaveLength(1)
    expect(sent[0]!.click).toMatchObject({ count: 1 })
    tracker.flush('unmount')
    expect(sent).toHaveLength(2)
    expect(sent[1]).toEqual({ v: 1, impUrl: 'imp-1', click: sent[1]!.click })
    expect(sent[1]!.click).toMatchObject({ count: 3 })
    expect(done()).toBe(1)

    const idle = trackerHarness(NO_FOCUS, { clickOnly: {} })
    idle.tracker.attach({}, 'pinned')
    idle.tracker.flush('unmount')
    expect(idle.sent).toHaveLength(0)
    expect(idle.done()).toBe(1)
  })

  test('a late click arms the post-click watch and reports it as a merge', () => {
    const { c, sent, registry } = registryHarness(FOCUSED)
    const a = registry.mount('a', 'pinned')!
    registry.unmount(a)
    c.advance(ENGAGEMENT_RELEASE_GRACE_MS)
    const redraw = registry.mount('a', 'pinned')!
    redraw.tracker.click()
    expect(sent.at(-1)!.click).toMatchObject({ windowFocused: true })
    registry.terminalFocus(false)
    c.advance(9_000)
    registry.terminalFocus(true)
    expect(sent.at(-1)).toEqual({
      v: 1,
      impUrl: 'a',
      postClick: { browserOpened: true, returnMs: 9_000 },
    })
  })
})

describe('checkpoints: records that do not wait for an unmount (bug 2)', () => {
  test('a transcript card scrolled out after being seen sends its record once, then the final', () => {
    const { c, sent, tracker } = trackerHarness(NO_FOCUS, {
      checkpoints: true,
    })
    const owner = {}
    tracker.attach(owner, 'measured')
    tracker.setVisible(owner, true)
    c.advance(2_000)
    tracker.setVisible(owner, false)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ visibleMs: 2_000, reentries: 0 })
    expect(sent[0]!.exit).toBeUndefined()

    c.advance(5_000)
    tracker.setVisible(owner, true)
    c.advance(1_000)
    tracker.setVisible(owner, false)
    expect(sent).toHaveLength(1)
    tracker.flush('window_close')
    expect(sent).toHaveLength(2)
    expect(sent[1]).toMatchObject({
      exit: 'window_close',
      visibleMs: 3_000,
      reentries: 1,
    })
  })

  test('a card never seen does not checkpoint on a measurement', () => {
    const { sent, tracker } = trackerHarness(NO_FOCUS, { checkpoints: true })
    const owner = {}
    tracker.attach(owner, 'measured')
    tracker.setVisible(owner, false)
    tracker.setVisible(owner, undefined)
    expect(sent).toHaveLength(0)
  })

  test('the first click sends the record so far; later clicks ride the final', () => {
    const { c, sent, tracker } = trackerHarness(NO_FOCUS, {
      checkpoints: true,
    })
    tracker.attach({}, 'pinned')
    c.advance(1_000)
    tracker.click()
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ visibleMs: 1_000, click: { count: 1 } })
    expect(sent[0]!.exit).toBeUndefined()
    tracker.click()
    expect(sent).toHaveLength(1)
    tracker.flush('rotation')
    expect(sent[1]).toMatchObject({ exit: 'rotation', click: { count: 2 } })
  })

  test('post-click goes out once the click checkpoint has, not at the flush', () => {
    const { c, sent, tracker } = trackerHarness(FOCUSED, {
      checkpoints: true,
    })
    tracker.attach({}, 'measured')
    tracker.click()
    tracker.terminalFocus(false)
    c.advance(6_000)
    tracker.terminalFocus(true)
    expect(sent).toHaveLength(2)
    expect(sent[1]).toEqual({
      v: 1,
      impUrl: 'imp-1',
      postClick: { browserOpened: true, returnMs: 6_000 },
    })
    expect(tracker.flushed).toBe(false)
  })

  test('checkpoints are off unless asked for', () => {
    const { c, sent, tracker } = trackerHarness()
    const owner = {}
    tracker.attach(owner, 'measured')
    tracker.setVisible(owner, true)
    c.advance(1_000)
    tracker.setVisible(owner, false)
    tracker.click()
    tracker.checkpoint()
    expect(sent).toHaveLength(0)
  })

  test('a card that never unmounts checkpoints after the bounded exposure', () => {
    const { c, sent, registry } = registryHarness()
    const a = registry.mount('a', 'measured')!
    a.tracker.setVisible(a.token, true)
    c.advance(ENGAGEMENT_CHECKPOINT_MS - 1)
    expect(sent).toHaveLength(0)
    c.advance(1)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ visibleMs: ENGAGEMENT_CHECKPOINT_MS })
    expect(sent[0]!.exit).toBeUndefined()
    c.advance(ENGAGEMENT_CHECKPOINT_MS * 5)
    expect(sent).toHaveLength(1)
  })

  test('a dock that rotates on time never pays for a checkpoint', () => {
    const { c, sent, registry } = registryHarness()
    for (const impUrl of ['a', 'b', 'c']) {
      const handle = registry.mount(impUrl, 'pinned')!
      c.advance(60_000)
      registry.noteSlotSwap([impUrl], ['next'])
      registry.unmount(handle)
      c.advance(ENGAGEMENT_RELEASE_GRACE_MS)
    }
    c.advance(ENGAGEMENT_CHECKPOINT_MS)
    expect(sent.map((r) => r.exit)).toEqual(['rotation', 'rotation', 'rotation'])
  })

  test('`checkpointAfterMs: null` turns every checkpoint off', () => {
    const c = clock()
    const sent: AdEngagement[] = []
    const registry = createEngagementRegistry({
      now: c.now,
      send: (record) => sent.push(record),
      focus: () => NO_FOCUS,
      setTimer: c.setTimer,
      clearTimer: c.clearTimer,
      checkpointAfterMs: null,
    })
    const a = registry.mount('a', 'measured')!
    a.tracker.setVisible(a.token, true)
    a.tracker.click()
    c.advance(ENGAGEMENT_CHECKPOINT_MS * 2)
    expect(sent).toHaveLength(0)
  })

  test('a checkpoint reports the row once and status reads `recorded` until the flush', () => {
    const c = clock()
    const sent: AdEngagement[] = []
    const recorded: string[] = []
    const flushed: string[] = []
    const registry = createEngagementRegistry({
      now: c.now,
      send: (record) => sent.push(record),
      focus: () => NO_FOCUS,
      setTimer: c.setTimer,
      clearTimer: c.clearTimer,
      onRecordOut: (impUrl) => recorded.push(impUrl),
      onFlushed: (impUrl) => flushed.push(impUrl),
    })
    const a = registry.mount('a', 'measured')!
    a.tracker.setVisible(a.token, true)
    expect(registry.status('a')).toBe('live')

    a.tracker.click()
    expect(sent).toHaveLength(1)
    expect(sent[0]!.exit).toBeUndefined()
    expect(recorded).toEqual(['a'])
    expect(registry.status('a')).toBe('recorded')

    // the bounded-exposure checkpoint does not report the row a second time
    c.advance(ENGAGEMENT_CHECKPOINT_MS * 2)
    expect(recorded).toEqual(['a'])

    registry.closeAll()
    expect(registry.status('a')).toBe('flushed')
    expect(flushed).toEqual(['a'])
    expect(recorded).toEqual(['a'])
  })

  test('an impression whose only record is its final one never reports `onRecordOut`', () => {
    const recorded: string[] = []
    const r = createEngagementRegistry({
      now: () => 0,
      send: () => {},
      focus: () => NO_FOCUS,
      checkpointAfterMs: null,
      onRecordOut: (impUrl) => recorded.push(impUrl),
    })
    r.mount('a', 'pinned')
    r.closeAll()
    expect(recorded).toEqual([])
    expect(r.status('a')).toBe('flushed')
  })
})

describe('closeAll: the CLI quitting (bug 2)', () => {
  test('flushes live cards as window_close and keeps an exit already decided', () => {
    const { c, sent, registry } = registryHarness()
    const live = registry.mount('live', 'measured')!
    live.tracker.setVisible(live.token, true)
    const leaving = registry.mount('leaving', 'pinned')!
    c.advance(4_000)
    registry.noteSlotSwap(['leaving'], ['next'])
    registry.unmount(leaving)
    c.advance(200)

    registry.closeAll()
    expect(sent.map((r) => [r.impUrl, r.exit])).toEqual([
      ['live', 'window_close'],
      ['leaving', 'rotation'],
    ])
    expect(sent[0]!.visibleMs).toBe(4_200)
    expect(registry.size).toBe(0)

    // nothing left armed: no grace, no checkpoint, no second record
    c.advance(ENGAGEMENT_CHECKPOINT_MS * 2)
    registry.closeAll()
    expect(sent).toHaveLength(2)
  })

  test('settles a post-click watch with what is known', () => {
    const { c, sent, registry } = registryHarness(FOCUSED)
    const left = registry.mount('left', 'pinned')!
    left.tracker.click()
    registry.terminalFocus(false)
    const stayed = registry.mount('stayed', 'pinned')!
    registry.terminalFocus(true)
    // `left` came back: settled. Click `stayed`, then lose focus and quit.
    stayed.tracker.click()
    c.advance(100)
    registry.terminalFocus(false)
    registry.closeAll()
    const postClicks = sent.filter((r) => r.postClick)
    expect(postClicks.map((r) => [r.impUrl, r.postClick])).toEqual([
      ['left', { browserOpened: true, returnMs: 0 }],
      ['stayed', { browserOpened: true }],
    ])
    expect(registry.size).toBe(0)
  })

  test('a quit inside the click grace leaves post-click unknown, not "not opened"', () => {
    const { sent, registry } = registryHarness(FOCUSED)
    const a = registry.mount('a', 'pinned')!
    a.tracker.click()
    registry.closeAll()
    expect(sent.some((r) => r.postClick)).toBe(false)
    expect(sent.at(-1)).toMatchObject({ exit: 'window_close' })
  })

  test('flushAdEngagementOnExit closes the registry, then waits for what is in flight', async () => {
    const { sent, registry } = registryHarness()
    registry.mount('a', 'pinned')
    const order: string[] = []
    await flushAdEngagementOnExit({
      registry,
      settle: async () => {
        order.push(`settle after ${sent.length}`)
      },
    })
    expect(sent[0]).toMatchObject({ impUrl: 'a', exit: 'window_close' })
    expect(order).toEqual(['settle after 1'])

    // a session that never drew an ad has nothing to close
    let settled = false
    await flushAdEngagementOnExit({
      registry: null,
      settle: async () => {
        settled = true
      },
    })
    expect(settled).toBe(true)
  })
})

describe('the engagement poster', () => {
  test('one impression\'s records go out in order; others do not wait', async () => {
    const started: string[] = []
    const release = new Map<string, () => void>()
    const poster = createAdEngagementPoster(
      (record) =>
        new Promise<void>((resolve) => {
          const key = `${record.impUrl}:${record.exit ?? 'checkpoint'}`
          started.push(key)
          release.set(key, resolve)
        }),
    )
    void poster.post({ v: 1, impUrl: 'a' })
    void poster.post({ v: 1, impUrl: 'a', exit: 'window_close' })
    void poster.post({ v: 1, impUrl: 'b', exit: 'unmount' })
    await Promise.resolve()
    await Promise.resolve()
    expect(started).toEqual(['a:checkpoint', 'b:unmount'])
    expect(poster.pending).toBe(2)

    let settled = false
    const settle = poster.settle().then(() => {
      settled = true
    })
    release.get('a:checkpoint')!()
    for (let i = 0; i < 5; i++) await Promise.resolve()
    expect(started).toEqual(['a:checkpoint', 'b:unmount', 'a:window_close'])
    expect(settled).toBe(false)
    release.get('a:window_close')!()
    release.get('b:unmount')!()
    await settle
    expect(settled).toBe(true)
    for (let i = 0; i < 5; i++) await Promise.resolve()
    expect(poster.pending).toBe(0)
  })

  test('a transport that throws is a missing row, never a stuck queue', async () => {
    const seen: string[] = []
    const poster = createAdEngagementPoster(async (record) => {
      seen.push(record.exit ?? 'checkpoint')
      if (!record.exit) throw new Error('offline')
    })
    await poster.post({ v: 1, impUrl: 'a' })
    await poster.post({ v: 1, impUrl: 'a', exit: 'unmount' })
    expect(seen).toEqual(['checkpoint', 'unmount'])
  })
})
