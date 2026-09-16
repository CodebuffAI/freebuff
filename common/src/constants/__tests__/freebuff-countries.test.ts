import { describe, expect, it } from 'bun:test'

import {
  FREE_MODE_ALLOWED_COUNTRIES,
  FREE_MODE_TIER_ONE_COUNTRIES,
  FREE_MODE_TIER_THREE_COUNTRIES,
  FREE_MODE_TIER_TWO_COUNTRIES,
  formatCountryCodes,
} from '../freebuff-countries'

describe('free-mode country groups', () => {
  it('keeps the groups disjoint and their union the full-access allowlist', () => {
    const groups = [
      FREE_MODE_TIER_ONE_COUNTRIES,
      FREE_MODE_TIER_TWO_COUNTRIES,
      FREE_MODE_TIER_THREE_COUNTRIES,
    ]
    const union = new Set(groups.flatMap((g) => [...g]))
    expect(union.size).toBe(groups.reduce((n, g) => n + g.size, 0))
    expect([...FREE_MODE_ALLOWED_COUNTRIES].sort()).toEqual([...union].sort())
  })

  it('pins who has full access', () => {
    // This list IS model access. Changing it moves accounts between the full
    // and limited catalogs, so it has to be a decision somebody states here.
    // SG and IL were removed on 2026-09-15 (ads fill 8-25% of their requests).
    expect([...FREE_MODE_ALLOWED_COUNTRIES].sort()).toEqual(
      [
        'US', 'CA', 'GB', 'AU', 'NZ', 'NO', 'SE', 'NL', 'DK', 'DE', 'FR', 'IT',
        'ES', 'PT', 'FI', 'BE', 'LU', 'LI', 'CH', 'AT', 'MT', 'IE', 'IS', 'KR',
      ].sort(),
    )
    for (const demoted of ['SG', 'IL', 'JP']) {
      expect(FREE_MODE_ALLOWED_COUNTRIES.has(demoted)).toBe(false)
    }
  })

  it('formats codes the way a sentence reads them', () => {
    expect(formatCountryCodes(['US'])).toBe('US')
    expect(formatCountryCodes(['CA', 'GB'])).toBe('CA and GB')
    expect(formatCountryCodes(['CA', 'GB', 'IE'])).toBe('CA, GB and IE')
    expect(formatCountryCodes([])).toBe('')
  })
})
