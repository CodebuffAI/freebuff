import { describe, expect, test } from 'bun:test'
import { billboardShapesForPlacement } from './billboard'
import { PLACEMENT_SLOTS } from '../constants/freebuff-placements'
import {
  campaignTargetsPlacement,
  desktopPlacementSource,
  inheritedPlacementTargets,
  isWebDesktopPlacement,
  webDesktopPlacement,
  WEB_DESKTOP_SOURCE_PLACEMENTS,
} from './web-desktop-placements'

describe('Desktop inventory mirrored into Web', () => {
  test('all ten copies preserve their format and targeting availability', () => {
    expect(WEB_DESKTOP_SOURCE_PLACEMENTS).toHaveLength(10)
    for (const id of WEB_DESKTOP_SOURCE_PLACEMENTS) {
      const source = PLACEMENT_SLOTS.find((slot) => slot.id === id)!
      expect(
        PLACEMENT_SLOTS.find((slot) => slot.id === webDesktopPlacement(id)),
      ).toEqual({ ...source, id: `${id}:web`, surface: 'freebuff_web_chat' })
      expect(desktopPlacementSource(`${id}:web`)).toBe(id)
      expect(campaignTargetsPlacement([id], `${id}:web`)).toBe(true)
      expect(campaignTargetsPlacement([`${id}:web`], id)).toBe(false)
    }
  })

  test('suffixes cannot invent inherited inventory or expand into another surface', () => {
    for (const id of [
      'CLI-Chat-Inline:web',
      'Desktop-Agentic:web',
      'Desktop-Inline-Chat:web:web',
    ]) {
      expect(isWebDesktopPlacement(id)).toBe(false)
      expect(desktopPlacementSource(id)).toBe(id)
      expect(campaignTargetsPlacement(['Desktop-Inline-Chat'], id)).toBe(false)
    }
    expect(campaignTargetsPlacement([], 'Desktop-Inline-Chat:web')).toBe(false)
    expect(
      inheritedPlacementTargets([
        'Desktop-Inline-Chat:web',
        'Desktop-Inline-Chat',
      ]),
    ).toEqual(['Desktop-Inline-Chat:web', 'Desktop-Inline-Chat'])
  })

  test('billboard artwork fits the same shapes on both copies', () => {
    for (const id of ['Desktop-Billboard-Sidebar', 'Desktop-Billboard-Panel']) {
      expect(billboardShapesForPlacement(`${id}:web`)).toEqual(
        billboardShapesForPlacement(id),
      )
    }
    expect(billboardShapesForPlacement('Unknown:web')).toEqual([])
  })
})
