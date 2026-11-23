import { describe, expect, test } from 'bun:test'

import {
  freebuffCountryVerificationPrompt,
  freebuffLimitedAccessCopy,
  freebuffLimitedAccessReason,
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

  test('a limited-access country', () => {
    expect(
      reason({ ...vpn, countryCode: 'BD', countryBlockReason: 'country_not_allowed' }),
    ).toEqual({ kind: 'country' })
  })

  test('the access floor, a VPN the banner does not name, and unresolved connections', () => {
    expect(reason({ ...vpn, countryBlockReason: 'recent_limited_country' })).toEqual({
      kind: 'floor',
    })
    // The exit's country rides along: it decides whether the VPN is said.
    expect(reason({ ...vpn, countryCode: 'IN' })).toEqual({
      kind: 'anonymous',
      countryCode: 'IN',
    })
    expect(reason({ ...vpn, countryVerified: true })).toEqual({
      kind: 'anonymous',
      countryCode: 'US',
    })
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

// 2026-11-16: limited access is explained only when a VPN or proxy exit in a
// full-access country is the cause; every other reason says nothing.
describe('freebuffLimitedAccessCopy', () => {
  const copy = (session: Record<string, unknown>) =>
    freebuffLimitedAccessCopy(freebuffLimitedAccessReason(session as never))

  test('a VPN or proxy the banner names, with the verify link', () => {
    expect(copy(vpn)).toMatchObject({ verify: true })
    expect(copy({ ...vpn, ipPrivacySignals: ['proxy'] })).toMatchObject({
      verify: true,
    })
  })

  test('a VPN or proxy exit in a full-access country the banner does not name, without a link', () => {
    for (const session of [
      { ...vpn, countryVerified: true },
      { ...vpn, verificationCanChangeAccess: false },
    ]) {
      expect(copy(session)).toMatchObject({ verify: false })
    }
  })

  test('nothing for a VPN exit in a limited-access country or an unknown one', () => {
    for (const countryCode of ['IN', 'BD', 'UNKNOWN', null]) {
      expect(copy({ ...vpn, countryCode })).toBeNull()
      expect(copy({ ...vpn, countryCode, countryVerified: true })).toBeNull()
    }
  })

  test('nothing for a limited country, the access floor, an unresolved connection or no reason', () => {
    for (const session of [
      { ...vpn, countryCode: 'BD', countryBlockReason: 'country_not_allowed' },
      { ...vpn, countryBlockReason: 'recent_limited_country' },
      { ...vpn, countryBlockReason: 'unresolved_client_ip' },
      { ...vpn, countryBlockReason: 'ip_privacy_lookup_failed' },
      { ...vpn, countryBlockReason: null },
    ]) {
      expect(copy(session)).toBeNull()
    }
  })

  test('nothing at full access or on a plan', () => {
    expect(copy({ ...vpn, accessTier: 'full' })).toBeNull()
    expect(copy({ ...vpn, subscription: { tierId: 'pro' } })).toBeNull()
  })
})
