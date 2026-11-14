import { sponsorFor } from '@codebuff/common/ads/display-ads/sponsors'
import { RGBA } from '@opentui/core'
import { describe, expect, test } from 'bun:test'

import {
  CLI_DISPLAY_AD_PLACEMENT_IDS,
  cliDisplayAdEnabled,
  cliSponsorColors,
  nearestXterm256,
} from '../display-ads'

const theme = { surface: '#202327', foreground: '#f1f5f9', muted: '#acb3bf' }

describe('cliSponsorColors', () => {
  const neon = sponsorFor('cliSplash')!.theme

  test('truecolor draws the sponsor colours and tints over our surface', () => {
    const colors = cliSponsorColors(neon, theme, { truecolor: true })
    expect(colors.fill).toBe('#34d59a')
    expect(colors.ink).toBe('#0a0a0a')
    expect(colors.border).toBe('#34d59a')
    expect(colors.tint).toBe(neon.tint(12, theme.surface))
    expect(colors.tintText).toBe(theme.foreground)
  })

  test('without truecolor the fill snaps to the 256 cube and ink to indexed black/white', () => {
    const colors = cliSponsorColors(neon, theme, { truecolor: false })
    expect(colors.fill).toBeInstanceOf(RGBA)
    expect((colors.fill as RGBA).slot).toBe(nearestXterm256('#34d59a'))
    expect((colors.ink as RGBA).slot).toBe(16)
    expect(colors.tint).toBe(theme.surface)
    const sentry = cliSponsorColors(sponsorFor('topBanner')!.theme, theme, { truecolor: false })
    expect((sentry.ink as RGBA).slot).toBe(231)
  })

  test('nearestXterm256 maps cube corners', () => {
    expect(nearestXterm256('#000000')).toBe(16)
    expect(nearestXterm256('#ffffff')).toBe(231)
    expect(nearestXterm256('#ff0000')).toBe(196)
  })
})

describe('cliDisplayAdEnabled', () => {
  test('off unless settings name it', () => {
    expect(cliDisplayAdEnabled('cliSplash', null)).toBe(false)
    expect(cliDisplayAdEnabled('cliSplash', ['cliSplash'])).toBe(true)
    expect(cliDisplayAdEnabled('cliStatusline', 'all')).toBe(true)
    expect(cliDisplayAdEnabled('cliStatusline', 'cliSplash')).toBe(false)
  })

  test('CLI placement ids', () => {
    expect(CLI_DISPLAY_AD_PLACEMENT_IDS).toEqual({
      cliSplash: 'CLI-Splash',
      cliStatusline: 'CLI-Statusline',
      deals: 'CLI-Deals',
    })
  })
})
