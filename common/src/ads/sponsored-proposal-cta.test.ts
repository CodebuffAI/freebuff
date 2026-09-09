import { describe, expect, test } from 'bun:test'

import { HOSTILE_PR_URLS } from './__fixtures__/sponsored-proposal-rows'
import {
  isSignedConversionToken,
  sponsoredAdvertiserCtaUrl,
} from './sponsored-proposal-cta'

/**
 * The server-side CTA composition (COD-512). What is asserted is the three
 * gates: a settlement verdict with a click behind it, the SIGNED token rather
 * than Accept's placeholder, and a landing URL that passes the destination
 * gate. Everything else is the URL library.
 */

const SIGNED = 'bfc_1.eyJpZCI6ImF0dHJpYnV0aW9uXzEifQ.c2lnbmF0dXJl'
const SIGNED_TEST = 'bfc_test_1.eyJpZCI6ImF0dHJpYnV0aW9uXzEifQ.c2lnbmF0dXJl'
const PLACEHOLDER = 'spct_0123456789abcdef0123456789abcdef'
const LANDING = 'https://acme.example/signup'

const cta = (
  overrides: Partial<Parameters<typeof sponsoredAdvertiserCtaUrl>[0]>,
) =>
  sponsoredAdvertiserCtaUrl({
    landingUrl: LANDING,
    conversionToken: SIGNED,
    settlementStatus: 'charged',
    ...overrides,
  })

describe('isSignedConversionToken', () => {
  test('accepts the live and test bfcid shapes', () => {
    expect(isSignedConversionToken(SIGNED)).toBe(true)
    expect(isSignedConversionToken(SIGNED_TEST)).toBe(true)
  })

  test("refuses Accept's opaque placeholder and everything else", () => {
    for (const token of [
      PLACEHOLDER,
      undefined,
      '',
      'bfc_1',
      'bfc_1.payload',
      'bfc_2.payload.sig',
      'bfc_1.pay load.sig',
      'bfc_1.payload.sig.extra',
      'plt_1.payload.sig',
    ]) {
      expect(isSignedConversionToken(token), String(token)).toBe(false)
    }
  })
})

describe('sponsoredAdvertiserCtaUrl', () => {
  test('appends the signed token to the landing URL as bfcid', () => {
    expect(cta({})).toBe(`${LANDING}?bfcid=${SIGNED}`)
    expect(cta({ settlementStatus: 'already_clicked' })).toBe(
      `${LANDING}?bfcid=${SIGNED}`,
    )
  })

  test('keeps the landing URL’s own query and replaces an existing bfcid rather than doubling it', () => {
    const url = cta({
      landingUrl: 'https://acme.example/signup?utm_source=freebuff&bfcid=stale',
    })!
    const parsed = new URL(url)
    expect(parsed.searchParams.get('utm_source')).toBe('freebuff')
    expect(parsed.searchParams.getAll('bfcid')).toEqual([SIGNED])
  })

  test('is absent unless the settlement verdict has a click behind it', () => {
    for (const settlementStatus of [
      undefined,
      '',
      'absorbed',
      'not_billable',
      'unbillable',
      'skipped',
      'error',
      'attribution_recorded',
    ]) {
      expect(cta({ settlementStatus }), String(settlementStatus)).toBeNull()
    }
  })

  test("is absent while the row still carries Accept's placeholder, and on a charged row with no token", () => {
    // A `charged` settlement that minted no token leaves the placeholder in
    // place: no CTA and no placeholder, never a link that 401s at the postback.
    expect(cta({ conversionToken: PLACEHOLDER })).toBeNull()
    expect(cta({ conversionToken: undefined })).toBeNull()
    expect(cta({ conversionToken: '' })).toBeNull()
  })

  test('is absent when there is no landing URL to carry the token', () => {
    expect(cta({ landingUrl: undefined })).toBeNull()
    expect(cta({ landingUrl: '' })).toBeNull()
  })

  for (const landingUrl of HOSTILE_PR_URLS) {
    test(`refuses ${JSON.stringify(landingUrl)} as a landing URL`, () => {
      expect(cta({ landingUrl })).toBeNull()
    })
  }

  test('strips terminal escapes from the landing URL through the shared gate', () => {
    const url = cta({ landingUrl: 'https://acme.example/\u001b[31msignup' })
    expect(url).toBe(`https://acme.example/signup?bfcid=${SIGNED}`)
  })
})
