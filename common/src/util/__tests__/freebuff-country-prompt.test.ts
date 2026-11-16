import { describe, expect, test } from 'bun:test'

import {
  freebuffCountryVerificationPrompt,
  freebuffLimitedAccessReason,
  freebuffLimitedCountry,
} from '../freebuff-country-prompt'

const vpn = {
  status: 'none',
  accessTier: 'limited',
  countryCode: 'US',
  countryBlockReason: 'anonymous_network',
  ipPrivacySignals: ['vpn'],
  verificationCanChangeAccess: true,
}

const prompt = (session: Record<string, unknown>) =>
  freebuffCountryVerificationPrompt(session as never)

describe('freebuffCountryVerificationPrompt', () => {
  test('a VPN exit in a full-access country is told it is a VPN', () => {
    expect(prompt(vpn)).toMatchObject({
      kind: 'vpn',
      label: 'VPN detected, verify country to unlock',
    })
    // Datacenter or Tor exits read as a VPN too.
    expect(prompt({ ...vpn, ipPrivacySignals: ['hosting'] })?.kind).toBe('vpn')
    expect(prompt({ ...vpn, ipPrivacySignals: null })?.kind).toBe('vpn')
  })

  test('a proxy says proxy, unless a VPN is also seen', () => {
    for (const signals of [['proxy'], ['res_proxy', 'anonymous']]) {
      expect(prompt({ ...vpn, ipPrivacySignals: signals })).toMatchObject({
        kind: 'proxy',
        label: 'Proxy detected, verify country to unlock',
      })
    }
    expect(
      prompt({ ...vpn, ipPrivacySignals: ['res_proxy'] })?.tooltip,
    ).toContain('bandwidth-sharing app')
    expect(prompt({ ...vpn, ipPrivacySignals: ['vpn', 'proxy'] })?.kind).toBe(
      'vpn',
    )
  })

  test('nothing for a limited country, a limited-country exit, or other reasons', () => {
    expect(
      prompt({ ...vpn, countryCode: 'IN', countryBlockReason: 'country_not_allowed' }),
    ).toBeNull()
    expect(prompt({ ...vpn, countryCode: 'IN' })).toBeNull()
    expect(prompt({ ...vpn, countryCode: null })).toBeNull()
    for (const countryBlockReason of [
      'recent_limited_country',
      'anonymized_or_unknown_country',
      'ip_privacy_lookup_failed',
      null,
    ]) {
      expect(prompt({ ...vpn, countryBlockReason })).toBeNull()
    }
  })

  test('nothing at full access, once verified, where verifying cannot help, or on a plan', () => {
    expect(prompt({ ...vpn, accessTier: 'full' })).toBeNull()
    expect(prompt({ ...vpn, countryVerified: true })).toBeNull()
    expect(prompt({ ...vpn, verificationCanChangeAccess: false })).toBeNull()
    expect(prompt({ ...vpn, subscription: { tierId: 'pro' } })).toBeNull()
    expect(freebuffCountryVerificationPrompt(null)).toBeNull()
  })
})

describe('freebuffLimitedCountry', () => {
  const limited = {
    status: 'none',
    accessTier: 'limited',
    countryCode: 'IN',
    countryBlockReason: 'country_not_allowed',
  }

  test('names a limited-access country the account is in', () => {
    expect(freebuffLimitedCountry(limited as never)).toEqual({
      code: 'IN',
      name: 'India',
    })
  })

  test('nothing for a VPN, an unknown country, a full-access country or full access', () => {
    for (const session of [
      { ...limited, countryBlockReason: 'anonymous_network' },
      { ...limited, countryCode: 'UNKNOWN' },
      { ...limited, countryCode: null },
      { ...limited, countryCode: 'US' },
      { ...limited, accessTier: 'full' },
    ]) {
      expect(freebuffLimitedCountry(session as never)).toBeNull()
    }
  })
})

describe('freebuffLimitedAccessReason', () => {
  const reason = (session: Record<string, unknown>) =>
    freebuffLimitedAccessReason(session as never)

  test('a VPN or proxy in a full-access country carries the banner prompt', () => {
    expect(reason(vpn)).toMatchObject({
      kind: 'vpn',
      prompt: { label: 'VPN detected, verify country to unlock' },
    })
    expect(reason({ ...vpn, ipPrivacySignals: ['proxy'] })?.kind).toBe('proxy')
  })

  test('a limited-access country names the country', () => {
    expect(
      reason({ ...vpn, countryCode: 'BD', countryBlockReason: 'country_not_allowed' }),
    ).toEqual({ kind: 'country', country: { code: 'BD', name: 'Bangladesh' } })
  })

  test('the access floor, a VPN verifying cannot unlock, and unresolved connections', () => {
    expect(reason({ ...vpn, countryBlockReason: 'recent_limited_country' })).toEqual({
      kind: 'floor',
    })
    expect(reason({ ...vpn, countryCode: 'IN' })).toEqual({ kind: 'anonymous' })
    expect(reason({ ...vpn, countryVerified: true })).toEqual({ kind: 'anonymous' })
    for (const countryBlockReason of [
      'anonymized_or_unknown_country',
      'missing_client_ip',
      'unresolved_client_ip',
      'ip_privacy_lookup_failed',
    ]) {
      expect(reason({ ...vpn, countryBlockReason })).toEqual({ kind: 'unresolved' })
    }
    expect(reason({ ...vpn, countryBlockReason: null })).toEqual({ kind: 'other' })
  })

  test('nothing at full access or on a plan', () => {
    expect(reason({ ...vpn, accessTier: 'full' })).toBeNull()
    expect(
      reason({
        ...vpn,
        countryCode: 'BD',
        countryBlockReason: 'country_not_allowed',
        subscription: { tierId: 'pro' },
      }),
    ).toBeNull()
    expect(freebuffLimitedAccessReason(undefined)).toBeNull()
  })
})
