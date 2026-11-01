import { describe, expect, test } from 'bun:test'

import { gravitySidebarPlacementId } from '../gravity-sidebar'
import {
  GRAVITY_SLUG_FLIPPED,
  fromGravitySlug,
  toGravitySlug,
} from '../gravity-placement-slugs'
import {
  PLACEMENT_RENAMES,
  canonicalPlacementId,
  isLegacyPlacementId,
  legacyPlacementId,
  placementIdAliases,
  samePlacement,
} from '../placement-aliases'

describe('placement aliases', () => {
  test('every rename round-trips', () => {
    for (const { id, legacy } of PLACEMENT_RENAMES) {
      expect(canonicalPlacementId(legacy)).toBe(id)
      expect(canonicalPlacementId(id)).toBe(id)
      expect(legacyPlacementId(id)).toBe(legacy)
      expect(legacyPlacementId(legacy)).toBe(legacy)
      expect(isLegacyPlacementId(legacy)).toBe(true)
      expect(isLegacyPlacementId(id)).toBe(false)
      expect(placementIdAliases(legacy)).toEqual([id, legacy])
      expect(samePlacement(id, legacy)).toBe(true)
    }
  })

  test('ids and legacy ids are unique, and never collide', () => {
    const ids = PLACEMENT_RENAMES.map((r) => r.id)
    const legacy = PLACEMENT_RENAMES.map((r) => r.legacy)
    expect(new Set(ids).size).toBe(ids.length)
    expect(new Set(legacy).size).toBe(legacy.length)
    for (const id of ids) expect(legacy).not.toContain(id)
  })

  test('new ids are hyphen-only Gravity-safe slugs', () => {
    for (const { id } of PLACEMENT_RENAMES)
      expect(id).toMatch(/^[A-Za-z0-9]+(-[A-Za-z0-9]+)+$/)
  })

  test('an id never renamed is itself', () => {
    expect(canonicalPlacementId('Desktop-Showcase')).toBe('Desktop-Showcase')
    expect(legacyPlacementId('Desktop-Showcase')).toBeUndefined()
    expect(placementIdAliases('Desktop-Showcase')).toEqual(['Desktop-Showcase'])
    expect(canonicalPlacementId('CLI-Chat-Inline-3')).toBe('CLI-Chat-Inline-3')
  })
})

describe('gravity slugs', () => {
  test('ships with every slug unflipped', () => {
    expect(Object.values(GRAVITY_SLUG_FLIPPED).every((v) => v === false)).toBe(
      true,
    )
    expect(Object.keys(GRAVITY_SLUG_FLIPPED).sort()).toEqual(
      PLACEMENT_RENAMES.map((r) => r.id).sort(),
    )
  })

  test('unflipped: Gravity is sent the legacy slug for either name', () => {
    for (const { id, legacy } of PLACEMENT_RENAMES) {
      expect(toGravitySlug(id)).toBe(legacy)
      expect(toGravitySlug(legacy)).toBe(legacy)
    }
  })

  test('flipped: Gravity is sent the new slug', () => {
    const flipped = { 'WaitingRoom-Slot1-CLI': true }
    expect(toGravitySlug('waiting-room-1', flipped)).toBe(
      'WaitingRoom-Slot1-CLI',
    )
    expect(toGravitySlug('waiting-room-2', flipped)).toBe('waiting-room-2')
  })

  test('read-back is canonical whichever slug Gravity used', () => {
    for (const { id, legacy } of PLACEMENT_RENAMES) {
      expect(fromGravitySlug(legacy)).toBe(id)
      expect(fromGravitySlug(id)).toBe(id)
    }
  })

  test('the sidebar alias still applies', () => {
    const slug = gravitySidebarPlacementId('Desktop-Billboard-Sidebar:web')
    expect(toGravitySlug('Desktop-Billboard-Sidebar:web')).toBe(slug)
    expect(fromGravitySlug(slug)).toBe('Desktop-Billboard-Sidebar:web')
  })
})
