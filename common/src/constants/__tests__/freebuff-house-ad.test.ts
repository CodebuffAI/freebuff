import { describe, expect, test } from 'bun:test'

import {
  getInlineAdLayout,
  MIN_INLINE_AD_WIDTH,
} from '../../ads/inline-ad-layout'
import {
  PLACEMENT_PREVIEW_WIDTHS,
  PLACEMENT_SLOTS,
  SPONSOR_BREAK_CREATIVE_LIMITS,
  isSponsorBreakPlacement,
} from '../freebuff-placements'
import {
  HOUSE_AD_CREATIVES,
  HOUSE_AD_DESTINATION_URL,
  HOUSE_AD_DISPLAY_CREATIVE,
  HOUSE_AD_DISPLAY_VARIATIONS,
  HOUSE_AD_TEXT_BUDGET,
  HOUSE_AD_TITLE_BUDGET,
  HOUSE_AD_VARIATIONS,
  HOUSE_SOL_AD_VARIATIONS,
  HOUSE_BREAK_AD_PLACEMENT_IDS,
  HOUSE_BREAK_AD_VARIATIONS,
} from '../freebuff-house-ad'

import type { HouseAdCreative, HouseAdSurface } from '../freebuff-house-ad'

// The legacy budgets remain checked for older seeds. Current approved copy
// uses campaign field limits and can ellipsize in narrow CLI previews.
const DESCRIPTION_ENFORCED_FROM = 48

const SURFACES: HouseAdSurface[] = [
  'cli_chat',
  'waiting_room',
  'freebuff_web_chat',
  'chat_assistant',
  'chat_assistant_sr',
]

/**
 * Surfaces the FLOOR must cover but no campaign can target: the SR experiment
 * arm is a placement id under `chat_assistant`'s slot, not a sellable slot of
 * its own, so it has copy (the floor is total over `AD_SURFACES`) and no
 * `PLACEMENT_SLOTS` entry. Exempt from the slot check below, by name.
 */
const FLOOR_ONLY_SURFACES: ReadonlySet<HouseAdSurface> = new Set([
  'chat_assistant_sr',
])

const everyInlineCreative = (): Array<{
  surface: HouseAdSurface
  index: number
  creative: HouseAdCreative
}> =>
  SURFACES.flatMap((surface) =>
    HOUSE_AD_VARIATIONS[surface].map((creative, index) => ({
      surface,
      index,
      creative,
    })),
  )

const everyBreakCreative = (): Array<{
  placementId: string
  index: number
  creative: HouseAdCreative
}> =>
  HOUSE_BREAK_AD_PLACEMENT_IDS.flatMap((placementId) =>
    HOUSE_BREAK_AD_VARIATIONS[placementId].map((creative, index) => ({
      placementId,
      index,
      creative,
    })),
  )

describe('house ad width budget', () => {
  test('the declared budgets match what the renderer actually gives', () => {
    // Recomputed from `getInlineAdLayout` rather than asserted as literals, so
    // a layout change fails HERE -- naming the constant to update -- instead of
    // silently cutting live copy. A long probe string is truncated to exactly
    // the available width, which is what makes the returned length the budget.
    const probe = {
      title: 'T'.repeat(200),
      adText: 'D'.repeat(200),
      url: HOUSE_AD_DESTINATION_URL,
    }

    // The renderer FLOOR, not the narrowest console preview: the console
    // stopped offering 20 columns, but a real terminal can still be that
    // narrow and the title budget is what keeps ours uncut there.
    expect(getInlineAdLayout(probe, MIN_INLINE_AD_WIDTH).title).toHaveLength(
      HOUSE_AD_TITLE_BUDGET,
    )

    // The description budget is the narrowest width a description is REQUIRED
    // to survive, which is 48 rather than 20 -- at 20 the description gets 16
    // characters and no sentence survives, so that width is a degraded render
    // by policy. Asserted as the minimum over the widths at or above the
    // threshold, so adding a 40-column preview tightens this instead of being
    // quietly ignored.
    const enforcedWidths = PLACEMENT_PREVIEW_WIDTHS.filter(
      (width) => width >= DESCRIPTION_ENFORCED_FROM,
    )
    expect(enforcedWidths.length).toBeGreaterThan(0)
    const worstDescription = Math.min(
      ...enforcedWidths.map(
        (width) => getInlineAdLayout(probe, width).description.length,
      ),
    )
    expect(worstDescription).toBe(HOUSE_AD_TEXT_BUDGET)
  })

  test.each([
    ...everyInlineCreative(),
    ...HOUSE_SOL_AD_VARIATIONS.map((creative, index) => ({
      surface: 'sol',
      index,
      creative,
    })),
  ])(
    '$surface variation $index fits the campaign contract and wide CLI preview',
    ({ creative }) => {
      expect(creative.title.length).toBeLessThanOrEqual(120)
      expect(creative.adText.length).toBeLessThanOrEqual(500)
      expect(creative.cta.length).toBeLessThanOrEqual(80)
      const layout = getInlineAdLayout(creative, 100)
      expect(layout.title).toBe(creative.title)
      expect(layout.description).toBe(creative.adText)
    },
  )
})

describe('house ad catalog', () => {
  test('every surface has variations for the CTR bias to choose between', () => {
    // One creative is a campaign the optimizer cannot improve: it would be
    // exactly as good as whichever line was written first.
    for (const surface of SURFACES) {
      expect(HOUSE_AD_VARIATIONS[surface].length).toBeGreaterThan(1)
    }
  })

  test('variations within a surface are distinct', () => {
    for (const surface of SURFACES) {
      const rendered = HOUSE_AD_VARIATIONS[surface].map(
        (creative) => `${creative.title}|${creative.adText}`,
      )
      expect(new Set(rendered).size).toBe(rendered.length)
    }
  })

  test('the floor serves variation 0 of its surface', () => {
    // The floor and the campaign must not drift into two different products.
    for (const surface of SURFACES) {
      expect(HOUSE_AD_CREATIVES[surface]).toBe(HOUSE_AD_VARIATIONS[surface][0]!)
    }
    expect(HOUSE_AD_DISPLAY_CREATIVE).toBe(HOUSE_AD_DISPLAY_VARIATIONS[0]!)
  })

  test('every sellable surface has house copy except the explicit phone opt-outs', () => {
    // The seed script groups slots by surface and skips a surface it has no
    // creatives for. Without this, adding a slot on a new surface would leave
    // that surface out of the campaign silently -- the run would report
    // success and the slot would keep rendering empty.
    const surfacesWithSlots = new Set(
      PLACEMENT_SLOTS.filter((slot) => slot.available).map(
        (slot) => slot.surface,
      ),
    )
    for (const surface of surfacesWithSlots) {
      // The phones deliberately have no automatic subscription promotion or
      // seeded house campaign. Mobile inventory is an explicit campaign choice.
      if (surface === 'ios' || surface === 'android') {
        expect(Object.hasOwn(HOUSE_AD_VARIATIONS, surface)).toBe(false)
        continue
      }
      expect(HOUSE_AD_VARIATIONS[surface as HouseAdSurface]).toBeDefined()
    }
  })

  test('every surface with copy has a slot to serve it into', () => {
    // The other direction: copy written for a surface nothing targets is copy
    // that can only ever reach the floor, never the campaign.
    for (const surface of SURFACES) {
      if (FLOOR_ONLY_SURFACES.has(surface)) continue
      const slots = PLACEMENT_SLOTS.filter(
        (slot) => slot.surface === surface && slot.available,
      )
      expect(slots.length).toBeGreaterThan(0)
    }
  })

  test('no creative claims a benefit the subscription does not deliver', () => {
    // The first version of this copy sold "no ads" and "skip the queue". A
    // subscription does NEITHER: nothing on any serve path reads subscription
    // status, so a subscriber sees the same ads as everybody else, and the
    // `waiting_room` surface is the CLI landing screen rather than an
    // admission queue. Both claims survived a width-budget test, a typecheck
    // and a review, because none of those can tell whether a sentence is TRUE.
    //
    // This is the check that can. Adding a claim here means first adding the
    // code that makes it real.
    const FALSE_CLAIMS = [
      /no ads/i,
      /ad-free/i,
      /adfree/i,
      /without ads/i,
      /skip the queue/i,
      /no queue/i,
      /no wait/i,
      /no waiting/i,
      /jump the/i,
      /starts? (right )?now/i,
      /instant/i,
      /every model/i,
      /unlimited/i,
    ]
    const everyCreative = [
      ...everyInlineCreative().map(({ creative }) => creative),
      ...everyBreakCreative().map(({ creative }) => creative),
      ...HOUSE_AD_DISPLAY_VARIATIONS,
      ...HOUSE_SOL_AD_VARIATIONS,
    ]
    for (const creative of everyCreative) {
      const copy = `${creative.title} ${creative.adText}`
      for (const claim of FALSE_CLAIMS) {
        expect(copy).not.toMatch(claim)
      }
    }
  })

  test('break copy fits the card the break actually draws', () => {
    // The inline budget above is the TERMINAL's; a break is drawn at display
    // size and has its own, tighter, limits. Read from
    // `SPONSOR_BREAK_CREATIVE_LIMITS` rather than retyped, so a retune of the
    // card moves this assertion with it -- the same reason the inline budget
    // is recomputed from the layout function.
    for (const { creative } of everyBreakCreative()) {
      expect(creative.title.length).toBeLessThanOrEqual(
        SPONSOR_BREAK_CREATIVE_LIMITS.titleMaxLength,
      )
      expect(creative.adText.length).toBeLessThanOrEqual(
        SPONSOR_BREAK_CREATIVE_LIMITS.bodyMaxLength,
      )
      expect(creative.cta.length).toBeLessThanOrEqual(
        SPONSOR_BREAK_CREATIVE_LIMITS.ctaMaxLength,
      )
    }
  })

  test('Showcase copy carries no accent markup, because Showcase does not draw it', () => {
    // MEASURED, on the `showcase-house` shot: the Showcase banner renders its
    // title as plain text, so a `*Pro*` there reaches the reader with the
    // asterisks in it.
    for (const creative of HOUSE_BREAK_AD_VARIATIONS['Desktop-Showcase']) {
      expect(creative.title).not.toContain('*')
    }
  })

  test('break copy marks at most one accent run, and closes it', () => {
    // `splitMarkedTitle` degrades an unmatched asterisk to plain text rather
    // than failing, so a stray one is invisible in the card and visible only
    // here. The console allows ONE marked run; two is a headline the accent
    // colour no longer emphasises anything in.
    for (const { creative } of everyBreakCreative()) {
      const marks = creative.title.match(/\*/g)?.length ?? 0
      expect(marks % 2).toBe(0)
      expect(marks).toBeLessThanOrEqual(2)
    }
  })

  test('every break creative targets a placement that is really a break', () => {
    for (const placementId of HOUSE_BREAK_AD_PLACEMENT_IDS) {
      expect(isSponsorBreakPlacement(placementId)).toBe(true)
      expect(
        PLACEMENT_SLOTS.some(
          (slot) => slot.id === placementId && slot.available,
        ),
      ).toBe(true)
      expect(
        HOUSE_BREAK_AD_VARIATIONS[placementId].length,
      ).toBeGreaterThanOrEqual(2)
    }
    // Spotlight and Intermission were removed 2026-11-12.
    expect(HOUSE_BREAK_AD_PLACEMENT_IDS).toEqual(['Desktop-Showcase'])
  })

  test('the floor can never serve a break creative', () => {
    // The text-only floor is excluded from a break by COD-453, and a break
    // card cannot render a creative with no hero at all. The structural
    // guarantee is that `HOUSE_AD_CREATIVES` is built from
    // `HOUSE_AD_VARIATIONS` alone; this asserts the two catalogs stay
    // disjoint, so break copy cannot reach the floor by being pasted into a
    // surface set as well.
    const floorCopy = new Set(
      Object.values(HOUSE_AD_CREATIVES).map(
        (creative) => `${creative.title}|${creative.adText}`,
      ),
    )
    const inlineCopy = new Set(
      everyInlineCreative().map(
        ({ creative }) => `${creative.title}|${creative.adText}`,
      ),
    )
    for (const { creative } of everyBreakCreative()) {
      const key = `${creative.title}|${creative.adText}`
      expect(floorCopy.has(key)).toBe(false)
      expect(inlineCopy.has(key)).toBe(false)
    }
  })

  test('every creative sends the reader to the plans page', () => {
    for (const { creative } of [
      ...everyInlineCreative(),
      ...everyBreakCreative(),
    ]) {
      expect(creative.url).toBe(HOUSE_AD_DESTINATION_URL)
      expect(creative.cta.length).toBeGreaterThan(0)
      expect(creative.favicon).toStartWith('https://')
    }
    // A break's picture is the uploaded HERO, not a static URL. A break
    // creative carrying `imageUrl` would be describing the display card's
    // mechanism, which the break renderer does not read.
    for (const { creative } of everyBreakCreative()) {
      expect(creative.imageUrl).toBeUndefined()
    }
    for (const creative of HOUSE_AD_DISPLAY_VARIATIONS) {
      expect(creative.url).toBe(HOUSE_AD_DESTINATION_URL)
      // The card surface is the one that renders an image; an absent one would
      // leave a blank panel where the creative is meant to be.
      expect(creative.imageUrl).toStartWith('https://')
    }
  })
})
