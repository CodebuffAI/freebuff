import { describe, expect, test } from 'bun:test'

import {
  BILLBOARD_PANEL_PLACEMENT_ID,
  BILLBOARD_SIDEBAR_PLACEMENT_ID,
  billboardAssetsFillPlacement,
  billboardDimensionsError,
  chooseBillboardPanelShape,
  parseBillboardAssets,
} from './billboard'

const asset = (width: number, height: number) => ({
  url: `https://ad-assets.example/${width}x${height}.webp`,
  width,
  height,
})

describe('billboardAssetsFillPlacement', () => {
  test('the sidebar needs its own 4:3 artwork; panel shapes do not count', () => {
    expect(
      billboardAssetsFillPlacement(BILLBOARD_SIDEBAR_PLACEMENT_ID, {
        panel_square: asset(1200, 1200),
      }),
    ).toBe(false)
    expect(
      billboardAssetsFillPlacement(BILLBOARD_SIDEBAR_PLACEMENT_ID, {
        sidebar: asset(640, 480),
      }),
    ).toBe(true)
  })

  test('any one panel shape can fill the panel', () => {
    expect(
      billboardAssetsFillPlacement(BILLBOARD_PANEL_PLACEMENT_ID, {
        panel_landscape: asset(1920, 1080),
      }),
    ).toBe(true)
    expect(
      billboardAssetsFillPlacement(BILLBOARD_PANEL_PLACEMENT_ID, {
        sidebar: asset(640, 480),
      }),
    ).toBe(false)
  })

  test('no other placement is a billboard', () => {
    expect(
      billboardAssetsFillPlacement('Desktop-Inline-Chat', {
        sidebar: asset(640, 480),
      }),
    ).toBe(false)
  })
})

describe('chooseBillboardPanelShape', () => {
  const all = {
    panel_tall: asset(640, 1600),
    panel_portrait: asset(960, 1600),
    panel_square: asset(1200, 1200),
    panel_landscape: asset(1920, 1080),
  }

  test('follows the panel breakpoints when every shape exists', () => {
    expect(chooseBillboardPanelShape(0.4, all)).toBe('panel_tall')
    expect(chooseBillboardPanelShape(0.6, all)).toBe('panel_portrait')
    expect(chooseBillboardPanelShape(1, all)).toBe('panel_square')
    expect(chooseBillboardPanelShape(1.8, all)).toBe('panel_landscape')
  })

  test('falls back to the nearest ratio the creative has', () => {
    expect(
      chooseBillboardPanelShape(0.4, { panel_square: all.panel_square, panel_portrait: all.panel_portrait }),
    ).toBe('panel_portrait')
    expect(chooseBillboardPanelShape(2, { panel_square: all.panel_square })).toBe(
      'panel_square',
    )
    expect(chooseBillboardPanelShape(1, {})).toBeNull()
  })
})

describe('billboardDimensionsError', () => {
  test('accepts the export sizes and larger files of the same shape', () => {
    expect(billboardDimensionsError('sidebar', 640, 480)).toBeNull()
    expect(billboardDimensionsError('panel_landscape', 3840, 2160)).toBeNull()
  })

  test('refuses files that are too small or the wrong shape', () => {
    expect(billboardDimensionsError('sidebar', 320, 240)).toContain('at least')
    expect(billboardDimensionsError('panel_square', 1600, 1200)).toContain(
      'aspect ratio',
    )
  })
})

describe('parseBillboardAssets', () => {
  test('keeps well-formed assets for known shapes only', () => {
    expect(
      parseBillboardAssets({
        sidebar: asset(640, 480),
        panel_square: { url: 'javascript:alert(1)', width: 1, height: 1 },
        unknown: asset(1, 1),
      }),
    ).toEqual({ sidebar: asset(640, 480) })
    expect(parseBillboardAssets(null)).toBeUndefined()
    expect(parseBillboardAssets({ sidebar: 'nope' })).toBeUndefined()
  })
})
