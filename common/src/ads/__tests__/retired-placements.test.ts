import { describe, expect, test } from 'bun:test'

import { isRetiredAdPlacement, RETIRED_AD_PLACEMENT_IDS } from '../retired-placements'
import { PLACEMENT_SLOTS } from '../../constants/freebuff-placements'

describe('retired ad placements', () => {
  test('lists the removed Spotlight and Intermission ids, native and Web', () => {
    expect([...RETIRED_AD_PLACEMENT_IDS].sort()).toEqual([
      'Desktop-Intermission',
      'Desktop-Intermission:web',
      'Desktop-Spotlight',
      'Desktop-Spotlight:web',
    ])
    for (const id of RETIRED_AD_PLACEMENT_IDS) {
      expect(isRetiredAdPlacement(id)).toBe(true)
      // Retired means unregistered: nothing resolves it as a live slot.
      expect(PLACEMENT_SLOTS.some((slot) => slot.id === id)).toBe(false)
    }
  })

  test('every live slot, Showcase included, is not retired', () => {
    for (const slot of PLACEMENT_SLOTS) expect(isRetiredAdPlacement(slot.id)).toBe(false)
    expect(isRetiredAdPlacement('Desktop-Showcase')).toBe(false)
    expect(isRetiredAdPlacement('Desktop-Showcase:web')).toBe(false)
    expect(isRetiredAdPlacement(undefined)).toBe(false)
    expect(isRetiredAdPlacement('')).toBe(false)
  })
})
