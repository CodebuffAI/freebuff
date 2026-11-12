import { afterEach, describe, expect, test } from 'bun:test'

import {
  CARD_OUT_OF_VIEW_RELEASE_MS,
  cardRequestNeedsNetworkHint,
  dockRequestNeedsNetworkHint,
  dropOurFillBesideNetwork,
  isNetworkAd,
  keepNewestResponseAd,
  networkAdOnScreen,
  reportDockHeld,
  reportInlineCardDrawn,
  reportInlineCardVisibility,
  resetAdScreenForTests,
  suppressOurCards,
  useAdScreenStore,
} from '../ad-screen'

afterEach(resetAdScreenForTests)

type Ad = { impUrl: string; provider: 'gravity' | 'first_party' }
const gravity: Ad = { impUrl: 'imp-g', provider: 'gravity' }
const gravity2: Ad = { impUrl: 'imp-g2', provider: 'gravity' }
const ours: Ad = { impUrl: 'imp-fp', provider: 'first_party' }
const state = () => useAdScreenStore.getState()

describe('isNetworkAd', () => {
  test('anything but our own inventory is a network ad; nothing is not', () => {
    expect(isNetworkAd(gravity)).toBe(true)
    expect(isNetworkAd({})).toBe(true)
    expect(isNetworkAd(ours)).toBe(false)
    expect(isNetworkAd(null)).toBe(false)
    expect(isNetworkAd(undefined)).toBe(false)
  })
})

describe('the card in view, with hysteresis', () => {
  test('in view at once; out of view only after a full release window', () => {
    reportInlineCardVisibility(gravity, true, 0)
    expect(state().inlineCard).toEqual(gravity)
    reportInlineCardVisibility(gravity, false, 250)
    reportInlineCardVisibility(
      gravity,
      false,
      250 + CARD_OUT_OF_VIEW_RELEASE_MS - 1,
    )
    expect(state().inlineCard).toEqual(gravity)
    reportInlineCardVisibility(
      gravity,
      false,
      250 + CARD_OUT_OF_VIEW_RELEASE_MS,
    )
    expect(state().inlineCard).toBeNull()
  })

  test('a blip back into view restarts the release window', () => {
    reportInlineCardVisibility(gravity, true, 0)
    reportInlineCardVisibility(gravity, false, 100)
    reportInlineCardVisibility(gravity, true, 900)
    reportInlineCardVisibility(gravity, false, 1_000)
    reportInlineCardVisibility(gravity, false, 1_900)
    expect(state().inlineCard).toEqual(gravity)
    reportInlineCardVisibility(gravity, false, 2_000)
    expect(state().inlineCard).toBeNull()
  })

  test('an unmeasurable card never takes the screen, so the dock is never left blank by one', () => {
    for (let t = 0; t < 60_000; t += 250)
      reportInlineCardVisibility(gravity, undefined, t)
    expect(state().inlineCard).toBeNull()
  })

  test('a card that becomes unmeasurable gives the screen back after the window', () => {
    reportInlineCardVisibility(gravity, true, 0)
    reportInlineCardVisibility(gravity, undefined, 250)
    reportInlineCardVisibility(
      gravity,
      undefined,
      250 + CARD_OUT_OF_VIEW_RELEASE_MS,
    )
    expect(state().inlineCard).toBeNull()
  })

  test("another card's report never clears the current card; unmount clears at once", () => {
    reportInlineCardDrawn(gravity, true)
    reportInlineCardVisibility(gravity, true, 0)
    reportInlineCardVisibility(ours, false, 0)
    reportInlineCardVisibility(ours, false, 5_000)
    expect(state().inlineCard).toEqual(gravity)
    reportInlineCardDrawn(gravity, false)
    expect(state().inlineCard).toBeNull()
    expect(state().inlineCardDrawn).toBeNull()
  })
})

describe('our own units read what is HELD and DRAWN', () => {
  test('a network ad held by the dock or drawn as the card closes the gate', () => {
    expect(networkAdOnScreen(state())).toBe(false)
    reportDockHeld(ours)
    expect(networkAdOnScreen(state())).toBe(false)
    reportDockHeld(gravity)
    expect(networkAdOnScreen(state())).toBe(true)
    reportDockHeld(null)
    reportInlineCardDrawn(gravity2, true)
    expect(networkAdOnScreen(state())).toBe(true)
    reportInlineCardDrawn(gravity2, false)
    reportInlineCardDrawn(ours, true)
    expect(networkAdOnScreen(state())).toBe(false)
  })

  test('the dock going blank for a card does not change the gate', () => {
    reportDockHeld(gravity)
    const before = networkAdOnScreen(state())
    // the card comes into view: the dock blanks but still HOLDS its ad
    reportInlineCardDrawn(ours, true)
    reportInlineCardVisibility(ours, true, 0)
    expect(networkAdOnScreen(state())).toBe(before)
  })

  test('the request hints follow the other slot', () => {
    expect(cardRequestNeedsNetworkHint()).toBe(false)
    reportDockHeld(gravity)
    expect(cardRequestNeedsNetworkHint()).toBe(true)
    reportDockHeld(ours)
    expect(cardRequestNeedsNetworkHint()).toBe(false)
    expect(dockRequestNeedsNetworkHint()).toBe(false)
    reportInlineCardVisibility(gravity2, true, 0)
    expect(dockRequestNeedsNetworkHint()).toBe(true)
  })
})

describe('a pair from two suppliers: the network wins', () => {
  const cards: Record<string, Ad[]> = { 'ai-1': [ours], 'ai-2': [gravity2] }

  test('beside a network dock our cards are not drawn; network cards are', () => {
    expect(suppressOurCards(cards, gravity)).toEqual({ 'ai-2': [gravity2] })
  })

  test('beside our dock (or none) every card is drawn, same identity', () => {
    expect(suppressOurCards(cards, ours)).toBe(cards)
    expect(suppressOurCards(cards, null)).toBe(cards)
    const onlyNetwork: Record<string, Ad[]> = { 'ai-2': [gravity2] }
    expect(suppressOurCards(onlyNetwork, gravity)).toBe(onlyNetwork)
  })

  test('our fill for a request that asked for the network only is dropped', () => {
    expect(dropOurFillBesideNetwork(ours, true)).toBe(true)
    expect(dropOurFillBesideNetwork(gravity, true)).toBe(false)
    expect(dropOurFillBesideNetwork(ours, false)).toBe(false)
  })
})

describe('keepNewestResponseAd', () => {
  const order = ['ai-1', 'ai-2', 'ai-3']

  test("a newer answer's card replaces the older one, which gives way", () => {
    expect(
      keepNewestResponseAd({ 'ai-1': ['old'] }, 'ai-2', 'new', order),
    ).toEqual({
      next: { 'ai-2': ['new'] },
      superseded: ['old'],
      dropped: false,
    })
  })

  test('a late card for an older answer is dropped when a newer one has a card', () => {
    const prev = { 'ai-3': ['newest'] }
    const result = keepNewestResponseAd(prev, 'ai-1', 'late', order)
    expect(result.next).toBe(prev)
    expect(result).toMatchObject({ superseded: [], dropped: true })
  })

  test('a late card for an answer no longer in the transcript changes nothing', () => {
    const prev = { 'ai-3': ['newest'] }
    const result = keepNewestResponseAd(prev, 'ai-gone', 'late', order)
    expect(result.next).toBe(prev)
    expect(result).toMatchObject({ superseded: [], dropped: true })
    // after /new: nothing in the transcript at all
    const cleared = keepNewestResponseAd(prev, 'ai-3', 'late', [])
    expect(cleared.next).toBe(prev)
    expect(cleared.dropped).toBe(true)
  })

  test('the first card is simply kept', () => {
    expect(keepNewestResponseAd({}, 'ai-1', 'a', order)).toEqual({
      next: { 'ai-1': ['a'] },
      superseded: [],
      dropped: false,
    })
  })
})

/**
 * THE FLAP. A one-row unit of ours (the statusline) above the composer
 * changes the transcript viewport by a row. With the card on the viewport's
 * last row, showing the row pushes the card out of view and hiding it
 * brings the card back. If the row's gate read what is VISIBLE, the dock
 * blanking for the card would open the gate, the row would push the card
 * out, the dock would come back and close the gate, and so on every poll.
 */
describe('the flap: a row of ours, the card on the edge, the dock', () => {
  const CARD_ROW = 20
  const simulate = (options: {
    dock: Ad
    card: Ad
    gate: 'visible' | 'held'
  }) => {
    reportDockHeld(options.dock)
    // our card is not drawn beside a network dock (rule 1)
    const cardDrawn =
      options.gate === 'visible' ||
      !(isNetworkAd(options.dock) && !isNetworkAd(options.card))
    if (cardDrawn) reportInlineCardDrawn(options.card, true)
    let rowShown: boolean | null = null
    let rowFlips = 0
    let dockFlips = 0
    let blank = false
    for (let t = 0; t <= 10_000; t += 250) {
      const s = state()
      blank = s.inlineCard !== null
      const gateClosed =
        options.gate === 'held'
          ? networkAdOnScreen(s)
          : // the old reading: what is visible right now
            (!blank && isNetworkAd(s.dockHeld)) || isNetworkAd(s.inlineCard)
      const shown = !gateClosed
      if (rowShown !== null && shown !== rowShown) rowFlips++
      rowShown = shown
      const viewportBottom = shown ? CARD_ROW : CARD_ROW + 1
      if (cardDrawn) {
        const before = state().inlineCard !== null
        reportInlineCardVisibility(options.card, CARD_ROW < viewportBottom, t)
        if ((state().inlineCard !== null) !== before) dockFlips++
      }
    }
    return { rowFlips, dockFlips, blank }
  }

  test('reading what is visible, it flaps (the bug this guards against)', () => {
    const { rowFlips } = simulate({
      dock: gravity,
      card: ours,
      gate: 'visible',
    })
    expect(rowFlips).toBeGreaterThan(2)
  })

  test('reading what is held and drawn, every pairing settles at once', () => {
    for (const dock of [gravity, ours])
      for (const card of [gravity2, ours]) {
        resetAdScreenForTests()
        const { rowFlips, dockFlips } = simulate({ dock, card, gate: 'held' })
        expect(rowFlips).toBe(0)
        expect(dockFlips).toBeLessThanOrEqual(1)
      }
  })
})
