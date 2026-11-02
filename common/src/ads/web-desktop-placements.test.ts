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
  test('all thirteen copies preserve their format and targeting availability', () => {
    expect(WEB_DESKTOP_SOURCE_PLACEMENTS).toHaveLength(13)
    for (const id of WEB_DESKTOP_SOURCE_PLACEMENTS) {
      const web = webDesktopPlacement(id)!
      const source = PLACEMENT_SLOTS.find((slot) => slot.id === id)!
      expect(PLACEMENT_SLOTS.find((slot) => slot.id === web)).toEqual({
        ...source,
        id: web,
        surface: 'freebuff_web_chat',
      })
      expect(desktopPlacementSource(web)).toBe(id)
      expect(isWebDesktopPlacement(web)).toBe(true)
      expect(campaignTargetsPlacement([id], web)).toBe(true)
      expect(campaignTargetsPlacement([web], id)).toBe(false)
    }
  })

  test('the two renamed chat slots map to their own Web ids; the rest keep :web', () => {
    expect(webDesktopPlacement('Above-Input-Desktop')).toBe('Above-Input-Web')
    expect(webDesktopPlacement('Inline-After-Agent-Desktop')).toBe(
      'Inline-After-Agent-Web',
    )
    expect(webDesktopPlacement('Desktop-Spotlight')).toBe(
      'Desktop-Spotlight:web',
    )
    // A legacy source names the same copy.
    expect(webDesktopPlacement('Desktop-Below-Chat')).toBe('Above-Input-Web')
  })

  test('legacy and canonical ids resolve and target identically', () => {
    const pairs = [
      ['Desktop-Below-Chat:web', 'Above-Input-Web'],
      ['Desktop-Inline-Chat:web', 'Inline-After-Agent-Web'],
    ] as const
    for (const [legacy, canonical] of pairs) {
      expect(isWebDesktopPlacement(legacy)).toBe(true)
      expect(desktopPlacementSource(legacy)).toBe(
        desktopPlacementSource(canonical),
      )
      expect(new Set(inheritedPlacementTargets([legacy]))).toEqual(
        new Set([...inheritedPlacementTargets([canonical]), legacy]),
      )
    }
    // A campaign stored with the legacy Desktop id still reaches both Web names.
    for (const placement of [
      'Desktop-Inline-Chat',
      'Inline-After-Agent-Desktop',
      'Desktop-Inline-Chat:web',
      'Inline-After-Agent-Web',
    ]) {
      expect(campaignTargetsPlacement(['Desktop-Inline-Chat'], placement)).toBe(
        true,
      )
      expect(
        campaignTargetsPlacement(['Inline-After-Agent-Desktop'], placement),
      ).toBe(true)
    }
    expect(
      campaignTargetsPlacement(
        ['Desktop-Inline-Chat:web'],
        'Inline-After-Agent-Desktop',
      ),
    ).toBe(false)
    expect(inheritedPlacementTargets(['Inline-After-Agent-Web'])).toEqual([
      'Inline-After-Agent-Web',
      'Desktop-Inline-Chat:web',
      'Workspace-Transcript-Inline-Web',
      'Inline-After-Agent-Desktop',
      'Desktop-Inline-Chat',
      'Chat-Transcript-Inline-Desktop',
    ])
  })

  test('suffixes cannot invent inherited inventory or expand into another surface', () => {
    for (const id of [
      'CLI-Chat-Inline:web',
      'Desktop-Agentic:web',
      'Desktop-Inline-Chat:web:web',
      'Inline-After-Agent-Desktop:web',
    ]) {
      expect(isWebDesktopPlacement(id)).toBe(false)
      expect(desktopPlacementSource(id)).toBe(id)
      expect(campaignTargetsPlacement(['Desktop-Inline-Chat'], id)).toBe(false)
    }
    expect(campaignTargetsPlacement([], 'Desktop-Inline-Chat:web')).toBe(false)
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
