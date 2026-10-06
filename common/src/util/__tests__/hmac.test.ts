import { createHmac } from 'node:crypto'

import { describe, expect, test } from 'bun:test'

import {
  constantTimeEquals,
  hmacSha256,
  hmacSha256Base64Url,
  hmacSha256Hex,
} from '../hmac'

/**
 * The helper replaced six hand-rolled `createHmac` calls whose outputs are
 * STORED (ip hashes, identity facets) or PRESENTED BY CLIENTS (signed links,
 * run tokens). A change in the construction would silently orphan every row
 * and token already out there, so the outputs are pinned against the raw
 * `node:crypto` construction and against fixed vectors.
 */
describe('hmacSha256', () => {
  const secret = 'freebuff-placements-dev-tracking-secret-0000'

  test('is exactly createHmac(sha256).update().digest()', () => {
    const expected = createHmac('sha256', secret).update('203.0.113.7').digest()
    expect(hmacSha256(secret, '203.0.113.7').equals(expected)).toBe(true)
    expect(hmacSha256Hex(secret, '203.0.113.7')).toBe(expected.toString('hex'))
    expect(hmacSha256Base64Url(secret, '203.0.113.7')).toBe(
      expected.toString('base64url'),
    )
  })

  test('hex is 64 lowercase hex characters; base64url is 43 unpadded', () => {
    const hex = hmacSha256Hex('k', 'v')
    expect(hex).toMatch(/^[0-9a-f]{64}$/)
    const b64 = hmacSha256Base64Url('k', 'v')
    expect(b64).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  test('fixed vector (RFC 4231 style, key "key", message "The quick brown fox jumps over the lazy dog")', () => {
    // The well-known HMAC-SHA256 test vector.
    expect(
      hmacSha256Hex('key', 'The quick brown fox jumps over the lazy dog'),
    ).toBe('f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8')
  })

  test('the secret and the message are not interchangeable', () => {
    expect(hmacSha256Hex('a', 'b')).not.toBe(hmacSha256Hex('b', 'a'))
  })

  test('accepts Buffer inputs on either side', () => {
    expect(hmacSha256Hex(Buffer.from('k'), Buffer.from('v'))).toBe(
      hmacSha256Hex('k', 'v'),
    )
  })
})

describe('constantTimeEquals', () => {
  test('equal strings match, unequal do not', () => {
    expect(constantTimeEquals('abc', 'abc')).toBe(true)
    expect(constantTimeEquals('abc', 'abd')).toBe(false)
  })

  test('a length mismatch is false rather than a throw', () => {
    // `timingSafeEqual` throws on unequal lengths; a presented signature of
    // the wrong length must be an ordinary refusal.
    expect(constantTimeEquals('abc', 'ab')).toBe(false)
    expect(constantTimeEquals('', 'a')).toBe(false)
    expect(constantTimeEquals('', '')).toBe(true)
  })

  test('compares code units, not normalised text', () => {
    expect(constantTimeEquals('é', 'é')).toBe(false)
  })
})
