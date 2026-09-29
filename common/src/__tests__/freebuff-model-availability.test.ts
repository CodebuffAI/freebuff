// The line the CLI landing picker and the Desktop model menu both show under a
// reduced model list. It is support-facing copy as much as product copy: users
// who cannot see a model others talk about write in asking whether their
// account is restricted, so what this says — and what it refuses to say — is
// the behaviour worth pinning.

import { describe, expect, test } from 'bun:test'

import {
  formatFreebuffPrivacySignalList,
  getFreebuffModelAvailabilityNotice,
} from '../util/freebuff-model-availability'

describe('the availability notice', () => {
  test('names the country, so "why not Luna?" has a concrete answer', () => {
    expect(
      getFreebuffModelAvailabilityNotice({
        countryCode: 'BR',
        countryBlockReason: 'country_not_allowed',
      }),
    ).toBe("Some models aren't available in Brazil yet")
  })

  test('an unresolved country falls back to "your region" rather than printing UNKNOWN', () => {
    expect(
      getFreebuffModelAvailabilityNotice({
        countryCode: 'UNKNOWN',
        countryBlockReason: 'country_not_allowed',
      }),
    ).toBe("Some models aren't available in your region yet")
  })

  test('the VPN case leads with the action, because it is the one the user can take', () => {
    expect(
      getFreebuffModelAvailabilityNotice({
        countryCode: 'DE',
        countryBlockReason: 'anonymous_network',
        ipPrivacySignals: ['vpn'],
      }),
    ).toBe(
      'Using a VPN? We lose money on every VPN user, so more models and Freebucks are available on a direct connection',
    )
  })

  test('an inconclusive check reads as ours to explain, not as the user doing something wrong', () => {
    for (const reason of [
      'anonymized_or_unknown_country',
      'missing_client_ip',
      'unresolved_client_ip',
    ] as const) {
      expect(getFreebuffModelAvailabilityNotice({ countryBlockReason: reason })).toBe(
        "We couldn't confirm your region, so we're showing models available everywhere",
      )
    }
    expect(
      getFreebuffModelAvailabilityNotice({
        countryBlockReason: 'ip_privacy_lookup_failed',
      }),
    ).toBe("We couldn't finish a network check, so we're showing models available everywhere")
  })

  test('a missing reason still answers the question — the short list is on screen either way', () => {
    const generic = "Some models aren't available on this connection"
    expect(getFreebuffModelAvailabilityNotice(null)).toBe(generic)
    expect(getFreebuffModelAvailabilityNotice(undefined)).toBe(generic)
    expect(getFreebuffModelAvailabilityNotice({})).toBe(generic)
    expect(getFreebuffModelAvailabilityNotice({ countryCode: 'BR' })).toBe(generic)
  })

  // the reason this copy exists in one shared place: every branch is read by
  // someone comparing their picker to a friend's, and none of them should
  // describe the user's account as lesser
  test('no branch tells the user they are limited, blocked, or restricted', () => {
    const lines = [
      getFreebuffModelAvailabilityNotice(null),
      getFreebuffModelAvailabilityNotice({ countryBlockReason: 'country_not_allowed' }),
      getFreebuffModelAvailabilityNotice({
        countryBlockReason: 'anonymous_network',
        ipPrivacySignals: ['tor'],
      }),
      getFreebuffModelAvailabilityNotice({ countryBlockReason: 'missing_client_ip' }),
      getFreebuffModelAvailabilityNotice({ countryBlockReason: 'ip_privacy_lookup_failed' }),
    ]
    for (const line of lines) {
      expect(line.toLowerCase()).not.toMatch(/limited|blocked|restricted|denied|not allowed/)
    }
  })
})

describe('the privacy-signal list', () => {
  test('reads as prose, and never repeats a label two signals share', () => {
    expect(formatFreebuffPrivacySignalList(['vpn', 'tor'])).toBe('VPN or Tor')
    expect(formatFreebuffPrivacySignalList(['vpn', 'proxy', 'tor'])).toBe('VPN, proxy, or Tor')
    expect(formatFreebuffPrivacySignalList(['proxy', 'proxy'])).toBe('proxy')
  })

  test('an empty or unrecognized set names the whole family rather than nothing', () => {
    const family = 'VPN, Tor, proxy, relay, or anonymized network'
    expect(formatFreebuffPrivacySignalList([])).toBe(family)
    expect(formatFreebuffPrivacySignalList(null)).toBe(family)
    expect(formatFreebuffPrivacySignalList(undefined)).toBe(family)
  })
})
