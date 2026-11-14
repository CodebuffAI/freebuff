import { describe, expect, test } from 'bun:test'

import {
  BRANDED_PLACEMENT_IDS,
  PLACEMENT_SLOTS,
  isFirstPartyOnlyFormat,
  isTargetablePlacement,
  placementFormat,
  placementSurface,
} from '../../constants/freebuff-placements'
import { campaignTargetsPlacement } from '../web-desktop-placements'
import {
  displayAdSlotForPlacement,
  isServedSponsor,
  parseServedDisplayAd,
  servedDisplayAdToSponsor,
  SERVED_DISPLAY_AD_FALLBACK_COLORS,
} from './served'
import {
  DISPLAY_AD_SERVED_PLACEMENT_IDS,
  DISPLAY_AD_SERVING_LIVE,
  isDarkDisplayAdPlacement,
  isDisplayAdServingLive,
  liveDisplayPlacementIds,
  withholdDarkDisplayPlacements,
} from './serving'
import { sponsorFor } from './sponsors'

const ALL = [
  'CLI-Splash',
  'Desktop-Home-Takeover',
  'Desktop-Home-Takeover:web',
  'Desktop-Top-Banner',
  'Desktop-Top-Banner:web',
  'Desktop-MCP-Featured',
  'Desktop-MCP-Featured:web',
  'CLI-Statusline',
  'CLI-Deals',
]

describe('the display-ad serving gate', () => {
  test('is empty: every display-ad placement is dark', () => {
    expect(DISPLAY_AD_SERVING_LIVE.size).toBe(0)
    expect([...DISPLAY_AD_SERVED_PLACEMENT_IDS]).toEqual(ALL)
    for (const id of ALL) {
      expect([id, isDarkDisplayAdPlacement(id)]).toEqual([id, true])
      expect([id, isDisplayAdServingLive(id)]).toEqual([id, false])
    }
    expect(liveDisplayPlacementIds('app')).toEqual([])
    expect(liveDisplayPlacementIds('web')).toEqual([])
  })

  test('registers each id as branded, first-party-only inventory', () => {
    expect([...BRANDED_PLACEMENT_IDS].sort()).toEqual([...ALL].sort())
    for (const id of ALL) {
      expect([id, placementFormat(id)]).toEqual([id, 'branded'])
      expect(placementSurface(id)).toBe(
        id.endsWith(':web') ? 'freebuff_web_chat' : 'cli_chat',
      )
    }
    expect(isFirstPartyOnlyFormat('branded')).toBe(true)
  })

  test('keeps dark ids out of the picker and campaign validation', () => {
    for (const id of ALL) {
      const slot = PLACEMENT_SLOTS.find((entry) => entry.id === id)!
      expect([id, slot.available]).toEqual([id, false])
      expect([id, isTargetablePlacement(id)]).toEqual([id, false])
    }
    // Every other registered slot is still targetable.
    expect(isTargetablePlacement('Desktop-Inline-Chat')).toBe(true)
    expect(isTargetablePlacement('Desktop-Billboard-Panel')).toBe(true)
    expect(isTargetablePlacement('not-a-slot')).toBe(false)
  })

  test('withholds dark ids from a request and keeps the rest in order', () => {
    expect(
      withholdDarkDisplayPlacements([
        'Desktop-Inline-Chat',
        'Desktop-Top-Banner',
        'waiting-room-1',
      ]),
    ).toEqual({
      placementIds: ['Desktop-Inline-Chat', 'waiting-room-1'],
      withheld: ['Desktop-Top-Banner'],
    })
    expect(withholdDarkDisplayPlacements(['CLI-Chat-Inline'])).toEqual({
      placementIds: ['CLI-Chat-Inline'],
      withheld: [],
    })
  })

  test('adding an id to the live set opens exactly that id', () => {
    const live = new Set(['Desktop-Top-Banner'])
    expect(isDisplayAdServingLive('Desktop-Top-Banner', live)).toBe(true)
    expect(isTargetablePlacement('Desktop-Top-Banner', live)).toBe(true)
    expect(
      withholdDarkDisplayPlacements(['Desktop-Top-Banner'], live),
    ).toEqual({ placementIds: ['Desktop-Top-Banner'], withheld: [] })
    // The web mirror is its own gate, even though a campaign targeting the
    // Desktop source would match it once it is live.
    expect(isDarkDisplayAdPlacement('Desktop-Top-Banner:web', live)).toBe(true)
    expect(isTargetablePlacement('Desktop-Top-Banner:web', live)).toBe(false)
    expect(
      campaignTargetsPlacement(['Desktop-Top-Banner'], 'Desktop-Top-Banner:web'),
    ).toBe(true)
    expect(liveDisplayPlacementIds('app', live)).toEqual(['Desktop-Top-Banner'])
    expect(liveDisplayPlacementIds('web', live)).toEqual([])
    expect(
      liveDisplayPlacementIds(
        'web',
        new Set(['Desktop-Top-Banner:web', 'CLI-Splash']),
      ),
    ).toEqual(['Desktop-Top-Banner:web'])
    // Only display-ad ids are gated by the set.
    expect(isDisplayAdServingLive('Desktop-Inline-Chat', live)).toBe(false)
  })
})

const FILL = {
  adText: 'Errors, traces and replays for the app you are building.',
  title: 'See the stack trace first',
  cta: 'Start free',
  url: 'https://www.sentry.io/welcome',
  favicon: 'https://codebuff.test/api/ads/first-party/creative-image/logo',
  clickUrl: 'https://codebuff.test/api/v1/ads/first-party/click/cap',
  impUrl: 'https://codebuff.test/api/v1/ads/first-party/impression/tok',
  placementId: 'Desktop-Top-Banner',
  brandColor: '#6C5FC7',
  brandInk: '#FFFFFF',
  sponsorName: 'Sentry',
}

describe('the served display-ad contract', () => {
  test('parses a first-party fill for its placement', () => {
    const ad = parseServedDisplayAd(FILL, 'Desktop-Top-Banner', {
      provider: 'first_party',
    })
    expect(ad).toEqual({ ...FILL, provider: 'first_party' } as never)
  })

  test('refuses what cannot be drawn or billed', () => {
    const parse = (raw: unknown, provider: unknown = 'first_party') =>
      parseServedDisplayAd(raw, 'Desktop-Top-Banner', { provider })
    expect(parse({ ...FILL, impUrl: undefined })).toBeNull()
    expect(parse({ ...FILL, title: '' })).toBeNull()
    expect(parse({ ...FILL, url: 'javascript:alert(1)' })).toBeNull()
    expect(parse(FILL, 'gravity')).toBeNull()
    expect(parse({ ...FILL, placementId: 'Desktop-Inline-Chat' })).toBeNull()
    expect(parse(null)).toBeNull()
    // Bad colours are dropped, not drawn.
    expect(parse({ ...FILL, brandColor: 'red', brandInk: '#fff' })).not.toHaveProperty(
      'brandColor',
    )
    // Relative first-party paths only where the caller allows them (web).
    const relative = {
      ...FILL,
      impUrl: '/api/ads/first-party/impression/tok',
      clickUrl: '/api/ads/first-party/click/cap',
    }
    expect(parse(relative)).toBeNull()
    expect(
      parseServedDisplayAd(relative, 'Desktop-Top-Banner', {
        provider: 'first_party',
        allowRelative: true,
      })?.clickUrl,
    ).toBe('/api/ads/first-party/click/cap')
  })

  test('maps to the shape placements draw, beside the mock sponsors', () => {
    const ad = parseServedDisplayAd(FILL, 'Desktop-Top-Banner', {
      provider: 'first_party',
    })!
    const sponsor = servedDisplayAdToSponsor(ad)
    expect(sponsor).toMatchObject({
      id: FILL.impUrl,
      name: 'Sentry',
      domain: 'sentry.io',
      url: FILL.clickUrl,
      lettermark: 'S',
      logoUrl: FILL.favicon,
      copy: {
        headline: FILL.title,
        body: FILL.adText,
        cta: 'Start free',
        tagline: FILL.title,
      },
      served: {
        placementId: 'Desktop-Top-Banner',
        provider: 'first_party',
        impUrl: FILL.impUrl,
        clickUrl: FILL.clickUrl,
      },
    })
    expect(sponsor.theme.fill).toBe('#6c5fc7')
    expect(sponsor.theme.ink).toBe('#ffffff')
    expect(isServedSponsor(sponsor)).toBe(true)
    expect(isServedSponsor(sponsorFor('topBanner')!)).toBe(false)
    expect(displayAdSlotForPlacement('Desktop-Top-Banner:web')).toBe('topBanner')
    expect(displayAdSlotForPlacement('CLI-Deals')).toBe('deals')
    expect(displayAdSlotForPlacement('Desktop-Inline-Chat')).toBeNull()
  })

  test('derives what the creative did not state', () => {
    const ad = parseServedDisplayAd(
      { ...FILL, brandColor: undefined, brandInk: undefined, sponsorName: undefined, favicon: '' },
      'Desktop-Top-Banner',
      { provider: 'first_party' },
    )!
    const sponsor = servedDisplayAdToSponsor(ad)
    expect(sponsor.name).toBe('sentry.io')
    expect(sponsor.colors).toEqual(SERVED_DISPLAY_AD_FALLBACK_COLORS)
    expect(sponsor.theme.contrast).toBeGreaterThanOrEqual(4.5)
    expect(sponsor).not.toHaveProperty('logoUrl')
    const inkless = servedDisplayAdToSponsor({ ...ad, brandColor: '#34d59a' })
    expect(inkless.theme.ink).toBe('#0a0a0a')
  })
})
