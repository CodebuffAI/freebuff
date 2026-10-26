import { describe, expect, test } from 'bun:test'

import {
  FREEBUFF_IMMEDIATE_CANCEL_PHRASE,
  freebuffCancelEndsImmediately,
  freebuffImmediateCancelPhraseMatches,
} from '../freebuff-subscriptions'

describe('freebuffImmediateCancelPhraseMatches', () => {
  test('accepts the phrase regardless of case and surrounding whitespace', () => {
    expect(
      freebuffImmediateCancelPhraseMatches(FREEBUFF_IMMEDIATE_CANCEL_PHRASE),
    ).toBe(true)
    expect(
      freebuffImmediateCancelPhraseMatches(
        '  i UNDERSTAND my plan ends immediately\n',
      ),
    ).toBe(true)
    expect(
      freebuffImmediateCancelPhraseMatches(
        'I understand  my plan\tends immediately',
      ),
    ).toBe(true)
  })

  test('rejects anything short of the full phrase', () => {
    expect(freebuffImmediateCancelPhraseMatches('')).toBe(false)
    expect(freebuffImmediateCancelPhraseMatches('I understand')).toBe(false)
    expect(
      freebuffImmediateCancelPhraseMatches(
        'I understand my plan ends immediately.',
      ),
    ).toBe(false)
    expect(
      freebuffImmediateCancelPhraseMatches(
        'I understand my plan ends at period end',
      ),
    ).toBe(false)
  })
})

describe('freebuffCancelEndsImmediately', () => {
  test('monthly plans, and legacy payloads with no interval, end now', () => {
    expect(
      freebuffCancelEndsImmediately({
        source: 'stripe',
        billingInterval: 'monthly',
      }),
    ).toBe(true)
    expect(freebuffCancelEndsImmediately({ source: 'stripe' })).toBe(true)
  })

  test('a yearly plan in good standing only stops renewing', () => {
    expect(
      freebuffCancelEndsImmediately({
        source: 'stripe',
        billingInterval: 'yearly',
      }),
    ).toBe(false)
    expect(
      freebuffCancelEndsImmediately({
        source: 'prepaid',
        billingInterval: 'yearly',
      }),
    ).toBe(false)
  })

  test('a yearly plan whose renewal failed, or a grant, ends now', () => {
    expect(
      freebuffCancelEndsImmediately({
        source: 'stripe',
        billingInterval: 'yearly',
        paymentFailedTierId: 'starter',
      }),
    ).toBe(true)
    expect(
      freebuffCancelEndsImmediately({
        source: 'grant',
        billingInterval: 'yearly',
      }),
    ).toBe(true)
  })
})
