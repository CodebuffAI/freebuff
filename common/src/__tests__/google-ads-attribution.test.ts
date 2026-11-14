import { describe, expect, test } from 'bun:test'
import {
  GOOGLE_ADS_CLICK_WINDOW_MS,
  normalizeGoogleAdsAttribution,
  parseGoogleAdsClickCookie,
} from '../util/google-ads-conversions'

const now = Date.parse('2026-10-21T12:00:00Z')
describe('Google Ads attribution contract', () => {
  test('retains one identifier by priority and discards unrelated fields', () => {
    expect(
      normalizeGoogleAdsAttribution(
        {
          gclid: 'click_1-~.test',
          gbraid: 'braid',
          wbraid: 'web',
          capturedAt: now,
          email: 'private@example.com',
          url: '/private',
        },
        now,
      ),
    ).toEqual({ gclid: 'click_1-~.test', capturedAt: now })
    expect(
      normalizeGoogleAdsAttribution(
        { gbraid: 'braid', wbraid: 'web', capturedAt: now },
        now,
      ),
    ).toEqual({ gbraid: 'braid', capturedAt: now })
    expect(
      normalizeGoogleAdsAttribution({ wbraid: 'web', capturedAt: now }, now),
    ).toEqual({ wbraid: 'web', capturedAt: now })
  })
  test.each([
    '',
    'a'.repeat(513),
    'a/b',
    'a+b',
    'a b',
    '<script>',
    'a=1',
    12,
    null,
  ])('rejects unsafe identifiers %p', (gclid) => {
    expect(
      normalizeGoogleAdsAttribution({ gclid, capturedAt: now }, now),
    ).toBeUndefined()
  })
  test.each([
    now + 1,
    now - GOOGLE_ADS_CLICK_WINDOW_MS,
    NaN,
    Infinity,
    String(now),
    undefined,
  ])('rejects invalid/expired timestamp %p', (capturedAt) => {
    expect(
      normalizeGoogleAdsAttribution({ gclid: 'click', capturedAt }, now),
    ).toBeUndefined()
  })
  test('accepts the age boundary only while still inside ninety days', () => {
    const attribution = {
      gclid: 'a'.repeat(512),
      capturedAt: now - GOOGLE_ADS_CLICK_WINDOW_MS + 1,
    }
    expect(normalizeGoogleAdsAttribution(attribution, now)).toEqual(attribution)
    expect(
      parseGoogleAdsClickCookie(
        encodeURIComponent(JSON.stringify(attribution)),
        now,
      ),
    ).toEqual(attribution)
    expect(parseGoogleAdsClickCookie('%malformed', now)).toBeUndefined()
  })
})
