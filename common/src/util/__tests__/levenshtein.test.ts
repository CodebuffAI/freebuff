import { describe, expect, test } from 'bun:test'

import { levenshtein } from '../levenshtein'

describe('levenshtein', () => {
  test('counts a substitution, an insertion and a deletion as one edit each', () => {
    expect(levenshtein('kitten', 'sitting')).toBe(3)
    expect(levenshtein('lodash', 'lodahs')).toBe(2)
    expect(levenshtein('react', 'react')).toBe(0)
    expect(levenshtein('', 'abc')).toBe(3)
  })

  test('treats an astral character as a single edit', () => {
    // typosquat checks pass package and domain names through this; a name
    // containing an emoji must not read as two edits away from the real one
    expect(levenshtein('🚀a', 'a')).toBe(1)
    expect(levenshtein('🚀', 'b')).toBe(1)
    expect(levenshtein('🚀rocket', '🚀rockes')).toBe(1)
  })
})
