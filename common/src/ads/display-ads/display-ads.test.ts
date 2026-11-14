import { describe, expect, test } from 'bun:test'

import { PLACEMENT_SLOTS } from '../../constants/freebuff-placements'
import { WEB_DESKTOP_SOURCE_PLACEMENTS } from '../web-desktop-placements'
import {
  DISPLAY_AD_FLAG_DEFAULTS,
  DISPLAY_AD_PLACEMENTS,
  DISPLAY_AD_PLACEMENT_IDS,
  displayAdEnabled,
  displayAdPlacementId,
  displayAdPlacementIds,
  parseDisplayAdOverride,
} from './placements'
import {
  DARK_INK,
  LIGHT_INK,
  MIN_INK_CONTRAST,
  contrastRatio,
  deriveInk,
  mixHex,
  resolveSponsorTheme,
} from './sponsor-theme'
import {
  DISPLAY_AD_LINEUP,
  DISPLAY_AD_SPONSORS,
  sponsorFor,
  sponsorsFor,
} from './sponsors'

describe('resolveSponsorTheme', () => {
  test('keeps a stated ink and reports its contrast', () => {
    const theme = resolveSponsorTheme({ fill: '#6C5FC7', ink: '#FFFFFF' })
    expect(theme.fill).toBe('#6c5fc7')
    expect(theme.ink).toBe('#ffffff')
    expect(theme.contrast).toBeGreaterThan(5)
    expect(theme.fillIsLight).toBe(false)
  })

  test('derives dark ink on a light fill and white ink on a dark one', () => {
    expect(resolveSponsorTheme({ fill: '#34d59a' }).ink).toBe(DARK_INK)
    expect(resolveSponsorTheme({ fill: '#34d59a' }).fillIsLight).toBe(true)
    expect(resolveSponsorTheme({ fill: '#1a1a2e' }).ink).toBe(LIGHT_INK)
  })

  test('a derived ink always clears 4.5:1, across the whole sRGB cube', () => {
    for (let r = 0; r < 256; r += 17)
      for (let g = 0; g < 256; g += 17)
        for (let b = 0; b < 256; b += 17) {
          const fill = `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`
          expect(contrastRatio(fill, deriveInk(fill))).toBeGreaterThanOrEqual(
            MIN_INK_CONTRAST,
          )
        }
  })

  test('tint blends the fill over a background', () => {
    const theme = resolveSponsorTheme({ fill: '#ffffff' })
    expect(theme.tint(0, '#000000')).toBe('#000000')
    expect(theme.tint(100, '#000000')).toBe('#ffffff')
    expect(theme.tint(50, '#000000')).toBe('#808080')
    expect(theme.tint(150, '#000000')).toBe('#ffffff')
    expect(mixHex('#34d59a', '#0a0a0a', 12)).toBe('#0f221b')
  })

  test('rejects a malformed colour rather than drawing grey', () => {
    expect(() => resolveSponsorTheme({ fill: 'green' })).toThrow()
    expect(() => resolveSponsorTheme({ fill: '#fff' })).toThrow()
    expect(() => resolveSponsorTheme({ fill: '#ffffff', ink: 'black' })).toThrow()
  })

  test('contrast ratio matches WCAG endpoints', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5)
    expect(contrastRatio('#777777', '#777777')).toBe(1)
  })
})

describe('mock sponsors', () => {
  test('every sponsor ink is readable on its fill', () => {
    for (const sponsor of Object.values(DISPLAY_AD_SPONSORS)) {
      expect(resolveSponsorTheme(sponsor.colors).contrast).toBeGreaterThanOrEqual(
        MIN_INK_CONTRAST,
      )
    }
  })

  test('every sponsor links over https to its stated domain', () => {
    for (const sponsor of Object.values(DISPLAY_AD_SPONSORS)) {
      const url = new URL(sponsor.url)
      expect(url.protocol).toBe('https:')
      expect(url.hostname.endsWith(sponsor.domain)).toBe(true)
    }
  })

  test('every slot has a lineup of known sponsors, and placement data exists where needed', () => {
    for (const placement of DISPLAY_AD_PLACEMENTS) {
      expect(DISPLAY_AD_LINEUP[placement].length).toBeGreaterThan(0)
    }
    expect(sponsorsFor('mcpFeatured').length).toBeLessThanOrEqual(3)
    for (const sponsor of sponsorsFor('mcpFeatured')) expect(sponsor.mcp).toBeDefined()
  })

  test('sponsorFor resolves the theme and merges per-slot copy', () => {
    const neon = sponsorFor('cliSplash')
    expect(neon?.id).toBe('neon')
    expect(neon?.theme.fill).toBe('#34d59a')
    expect(neon?.copy.headline).toBe(DISPLAY_AD_SPONSORS.neon.copy.headline)
    expect('placementCopy' in (neon ?? {})).toBe(false)
  })
})

describe('display-ad flags', () => {
  test('every placement defaults off', () => {
    expect(Object.values(DISPLAY_AD_FLAG_DEFAULTS).every((on) => !on)).toBe(true)
    for (const placement of DISPLAY_AD_PLACEMENTS) {
      expect(displayAdEnabled(placement)).toBe(false)
      expect(displayAdEnabled(placement, '')).toBe(false)
    }
  })

  test('an override names placements, or all of them', () => {
    expect([...parseDisplayAdOverride('all')]).toEqual([...DISPLAY_AD_PLACEMENTS])
    expect([...parseDisplayAdOverride(' cliSplash, nope ,topBanner')]).toEqual([
      'cliSplash',
      'topBanner',
    ])
    expect([...parseDisplayAdOverride(['mcpFeatured'])]).toEqual(['mcpFeatured'])
    expect(displayAdEnabled('topBanner', 'cliSplash,topBanner')).toBe(true)
    expect(displayAdEnabled('homeTakeover', 'cliSplash,topBanner')).toBe(false)
    expect(parseDisplayAdOverride(null).size).toBe(0)
  })
})

describe('display-ad placement ids', () => {
  test('follow the Desktop / `:web` / CLI convention', () => {
    expect(displayAdPlacementId('topBanner', 'desktop')).toBe('Desktop-Top-Banner')
    expect(displayAdPlacementId('topBanner', 'web')).toBe('Desktop-Top-Banner:web')
    expect(displayAdPlacementId('cliSplash', 'cli')).toBe('CLI-Splash')
    expect(displayAdPlacementId('deals', 'cli')).toBe('CLI-Deals')
    expect(displayAdPlacementIds('cliStatusline')).toEqual(['CLI-Statusline', 'CLI-Deals'])
    for (const ids of Object.values(DISPLAY_AD_PLACEMENT_IDS)) {
      const byId = ids as Partial<Record<'desktop' | 'web', string>>
      if (byId.desktop) expect(byId.web).toBe(`${byId.desktop}:web`)
    }
  })

  test('are registered inventory with unique ids, mirrored to web', () => {
    const all = DISPLAY_AD_PLACEMENTS.flatMap(displayAdPlacementIds)
    expect(new Set(all).size).toBe(all.length)
    const registered = new Set<string>(PLACEMENT_SLOTS.map((slot) => slot.id))
    for (const id of all) {
      expect([id, registered.has(id)]).toEqual([id, true])
      if (id.endsWith(':web'))
        expect(
          (WEB_DESKTOP_SOURCE_PLACEMENTS as readonly string[]).includes(
            id.slice(0, -4),
          ),
        ).toBe(true)
    }
  })
})
