import { describe, expect, test } from 'bun:test'

import { BYOK_LOCAL_USER_ID } from '../byok'
import {
  DETERMINISTIC_COMPACTION_PERCENT,
  usesDeterministicCompaction,
} from '../compaction-policy'

const ids = Array.from(
  { length: 20_000 },
  (_, i) => `00000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`,
)

describe('usesDeterministicCompaction', () => {
  test('is sticky per user', () => {
    for (const id of ids.slice(0, 50))
      expect(usesDeterministicCompaction(id)).toBe(
        usesDeterministicCompaction(id),
      )
  })

  test('splits users close to the configured share', () => {
    const share =
      ids.filter((id) => usesDeterministicCompaction(id)).length / ids.length
    expect(
      Math.abs(share * 100 - DETERMINISTIC_COMPACTION_PERCENT),
    ).toBeLessThan(2)
  })

  test('a larger share only adds users', () => {
    const at25 = ids.filter((id) => usesDeterministicCompaction(id, 25))
    for (const id of at25)
      expect(usesDeterministicCompaction(id, 75)).toBe(true)
  })

  test('0 keeps everyone on the handoff; 100 moves everyone, signed out too', () => {
    expect(ids.some((id) => usesDeterministicCompaction(id, 0))).toBe(false)
    expect(ids.every((id) => usesDeterministicCompaction(id, 100))).toBe(true)
    expect(usesDeterministicCompaction(undefined, 50)).toBe(false)
    expect(usesDeterministicCompaction(undefined, 100)).toBe(true)
  })

  test('keeps the shared BYOK placeholder id out of the cohort until 100', () => {
    // Its hash lands under some share; every id-less BYOK user would flip there.
    for (const percent of [1, 10, 50, 99])
      expect(usesDeterministicCompaction(BYOK_LOCAL_USER_ID, percent)).toBe(
        false,
      )
    expect(usesDeterministicCompaction(BYOK_LOCAL_USER_ID, 100)).toBe(true)
  })
})
