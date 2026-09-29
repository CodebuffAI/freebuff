import { describe, expect, test } from 'bun:test'

import {
  SPONSORED_CLIENT_VERSION_PATTERN,
  sponsoredClientVersionFromUserAgent,
} from './sponsored-client-version'

describe('sponsoredClientVersionFromUserAgent', () => {
  test('maps the Desktop and CLI user agents', () => {
    expect(
      sponsoredClientVersionFromUserAgent('Freebuff-Desktop/0.0.151'),
    ).toBe('desktop/0.0.151')
    expect(
      sponsoredClientVersionFromUserAgent('Freebuff-Desktop/0.0.151 (win32)'),
    ).toBe('desktop/0.0.151')
    expect(sponsoredClientVersionFromUserAgent('Freebuff-CLI/1.0.700')).toBe(
      'cli/1.0.700',
    )
  })

  test('keeps dev builds', () => {
    expect(sponsoredClientVersionFromUserAgent('Freebuff-Desktop/dev')).toBe(
      'desktop/dev',
    )
  })

  test('is null for anything else, and never throws', () => {
    for (const ua of [
      null,
      undefined,
      '',
      'Mozilla/5.0',
      'Codebuff-CLI/1.0.0',
      'Freebuff-Desktop/',
      `Freebuff-CLI/${'9'.repeat(40)}`,
      'Freebuff-Desktop/1.0;rm',
    ]) {
      expect(sponsoredClientVersionFromUserAgent(ua)).toBeNull()
    }
  })

  test('every value it returns matches the stored pattern', () => {
    const value = sponsoredClientVersionFromUserAgent(
      'Freebuff-CLI/1.2.3-beta+4',
    )
    expect(value).toBe('cli/1.2.3-beta+4')
    expect(SPONSORED_CLIENT_VERSION_PATTERN.test(value!)).toBe(true)
  })
})
