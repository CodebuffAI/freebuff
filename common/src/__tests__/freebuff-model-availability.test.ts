// The line the CLI landing picker and the Desktop model menu both show under a
// reduced model list. It is support-facing copy as much as product copy: users
// who cannot see a model others talk about write in asking whether their
// account is restricted, so what this says — and what it refuses to say — is
// the behaviour worth pinning.

import { describe, expect, test } from 'bun:test'

import {
  formatFreebuffPrivacySignalList,
  getFreebuffModelAvailabilityNotice,
  getFreebuffSessionModelAvailabilityNotice,
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
      "Using a VPN? We lose money on every VPN user, so more models and hours are available on a direct connection. Turn it off first. Can't, or not on one? Confirm your country at freebuff.com/account?tab=country",
    )
    // A limited country has nothing to confirm.
    expect(
      getFreebuffModelAvailabilityNotice({
        countryCode: 'IN',
        countryBlockReason: 'anonymous_network',
        ipPrivacySignals: ['vpn'],
      }),
    ).toBe(
      'Using a VPN? We lose money on every VPN user, so more models and hours are available on a direct connection',
    )
  })

  test('a line listed only as a residential proxy names the likely cause, not a VPN', () => {
    expect(
      getFreebuffModelAvailabilityNotice({
        countryCode: 'GB',
        countryBlockReason: 'anonymous_network',
        ipPrivacySignals: ['res_proxy', 'anonymous'],
      }),
    ).toBe(
      "This network is listed as a residential proxy, often because of a bandwidth-sharing app on a device here, so some models aren't available on it. Confirm your country at freebuff.com/account?tab=country",
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

  // 2026-11-20: a paying CLI user was told "…on this connection" for a reason
  // the server never gave, and went looking for a network problem.
  test('a missing reason still answers the question, without naming a cause it does not know', () => {
    for (const reason of [null, undefined, {}, { countryCode: 'BR' }]) {
      const line = getFreebuffModelAvailabilityNotice(reason)
      expect(line).not.toBe('')
      expect(line.toLowerCase()).not.toMatch(
        /connection|network|vpn|proxy|region|country/,
      )
    }
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

describe('which session responses raise the notice', () => {
  // Only a limited, planless response that says why. Everything else was
  // shown the fallback by the CLI header, paying accounts included.
  test('a limited account without a plan, and nobody else', () => {
    const limited = {
      status: 'none',
      accessTier: 'limited',
      countryCode: 'BR',
      countryBlockReason: 'country_not_allowed',
    } as const
    expect(getFreebuffSessionModelAvailabilityNotice(limited)).toBe(
      getFreebuffModelAvailabilityNotice(limited),
    )

    const onStarter = { ...limited, subscription: { tierId: 'starter' } }
    const poolOnPro = { ...limited, freebucks: { planId: 'pro' } }
    // A full-access override in a limited country still carries the reason.
    const full = { ...limited, accessTier: 'full' }
    const refused = {
      status: 'model_locked',
      accessTier: 'limited',
      currentModel: 'a',
      requestedModel: 'b',
    }
    for (const session of [null, onStarter, poolOnPro, full, refused]) {
      expect(getFreebuffSessionModelAvailabilityNotice(session)).toBeNull()
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
