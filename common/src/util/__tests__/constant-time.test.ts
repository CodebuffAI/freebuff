import { describe, expect, test } from 'bun:test'

import { constantTimeStringEquals } from '../constant-time'
import { constantTimeEquals } from '../hmac'

/** A string from raw UTF-16 code units, so lone surrogates survive the source file. */
const units = (...codes: number[]) => String.fromCharCode(...codes)

const E_ACUTE = units(0xe9)
const E_COMBINING = units(0x65, 0x301)
const GRIN = units(0xd83d, 0xde00)
const GRIN_NEXT = units(0xd83d, 0xde01)
const LONE_HIGH = units(0xd800)
const LONE_HIGH_OTHER = units(0xdbff)
const REPLACEMENT = units(0xfffd)

// Pairs where a careless compare goes wrong: lengths that differ in UTF-16 but
// not in UTF-8 (or the reverse), lone surrogates (which UTF-8 collapses to
// U+FFFD), and the empty string on either side.
const CASES: Array<[string, string]> = [
  ['', ''],
  ['', 'a'],
  ['a', ''],
  ['abc', 'abc'],
  ['abc', 'abd'],
  ['abc', 'ab'],
  ['Bearer s3cret', 'Bearer s3cret'],
  ['Bearer s3cret', 'Bearer s3creT'],
  [E_ACUTE, E_COMBINING],
  [E_ACUTE, 'a'],
  [E_ACUTE, E_ACUTE],
  [GRIN, GRIN],
  [GRIN, GRIN_NEXT],
  [LONE_HIGH, LONE_HIGH_OTHER],
  [LONE_HIGH, LONE_HIGH],
  [`a${units(0xdc00)}`, `a${units(0xdfff)}`],
  [REPLACEMENT, LONE_HIGH],
]

const HELPERS: Array<[string, (a: string, b: string) => boolean]> = [
  ['constantTimeEquals (node:crypto)', constantTimeEquals],
  ['constantTimeStringEquals (portable)', constantTimeStringEquals],
]

for (const [name, equals] of HELPERS) describe(name, () => {
  test.each(CASES)('(%j, %j) answers exactly a === b', (a, b) => {
    expect(equals(a, b)).toBe(a === b)
    expect(equals(b, a)).toBe(a === b)
  })

  test('distinct lone surrogates do not compare equal', () => {
    // UTF-8 encodes both as U+FFFD, so a compare of UTF-8 bytes answers true.
    expect(Buffer.from(LONE_HIGH).equals(Buffer.from(LONE_HIGH_OTHER))).toBe(
      true,
    )
    expect(equals(LONE_HIGH, LONE_HIGH_OTHER)).toBe(false)
  })

  test('unequal lengths are an ordinary false, never a throw', () => {
    expect(() => equals('x'.repeat(64), 'x'.repeat(65))).not.toThrow()
    expect(equals('x'.repeat(64), 'x'.repeat(65))).toBe(false)
    expect(equals('', 'x'.repeat(64))).toBe(false)
  })
})
