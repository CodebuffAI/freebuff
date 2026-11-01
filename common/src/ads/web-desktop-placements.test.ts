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
    expect(webDesktopPlacement('Chat-AboveComposer-Rotating-Desktop')).toBe(
      'Workspace-AboveComposer-Rotating-Web',
    )
    expect(webDesktopPlacement('Chat-Transcript-Inline-Desktop')).toBe(
      'Workspace-Transcript-Inline-Web',
    )
    expect(webDesktopPlacement('Desktop-Spotlight')).toBe(
      'Desktop-Spotlight:web',
    )
    // A legacy source names the same copy.
    expect(webDesktopPlacement('Desktop-Below-Chat')).toBe(
      'Workspace-AboveComposer-Rotating-Web',
    )
  })

  test('legacy and canonical ids resolve and target identically', () => {
    const pairs = [
      ['Desktop-Below-Chat:web', 'Workspace-AboveComposer-Rotating-Web'],
      ['Desktop-Inline-Chat:web', 'Workspace-Transcript-Inline-Web'],
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
      'Chat-Transcript-Inline-Desktop',
      'Desktop-Inline-Chat:web',
      'Workspace-Transcript-Inline-Web',
    ]) {
      expect(campaignTargetsPlacement(['Desktop-Inline-Chat'], placement)).toBe(
        true,
      )
      expect(
        campaignTargetsPlacement(['Chat-Transcript-Inline-Desktop'], placement),
      ).toBe(true)
    }
    expect(
      campaignTargetsPlacement(
        ['Desktop-Inline-Chat:web'],
        'Chat-Transcript-Inline-Desktop',
      ),
    ).toBe(false)
    expect(
      inheritedPlacementTargets(['Workspace-Transcript-Inline-Web']),
    ).toEqual([
      'Workspace-Transcript-Inline-Web',
      'Desktop-Inline-Chat:web',
      'Chat-Transcript-Inline-Desktop',
      'Desktop-Inline-Chat',
    ])
  })

  test('suffixes cannot invent inherited inventory or expand into another surface', () => {
    for (const id of [
      'CLI-Chat-Inline:web',
      'Desktop-Agentic:web',
      'Desktop-Inline-Chat:web:web',
      'Chat-Transcript-Inline-Desktop:web',
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
