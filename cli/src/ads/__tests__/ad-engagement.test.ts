import { describe, expect, test } from 'bun:test'

import { AD_MS_CAP } from '@codebuff/common/types/ad-client-context'

import {
  ENGAGEMENT_RELEASE_GRACE_MS,
  POST_CLICK_LEAVE_GRACE_MS,
  createEngagementRegistry,
  createEngagementTracker,
  decideExit,
  layoutTruncated,
  rowsIntersect,
} from '../ad-engagement'
import { clickModifier } from '../use-ad-engagement'

import type { FocusState } from '../ad-engagement'
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

function trackerHarness(focus: FocusState = NO_FOCUS) {
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
    expect(registry.mount('a', 'pinned')).toBeNull()
    expect(sent).toHaveLength(1)
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
    registry.unmount(a)
    c.advance(ENGAGEMENT_RELEASE_GRACE_MS)
    expect(sent).toHaveLength(1)
    registry.terminalFocus(false)
    c.advance(4_000)
    registry.terminalFocus(true)
    expect(sent).toHaveLength(2)
    expect(sent[1]!.postClick).toEqual({
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
