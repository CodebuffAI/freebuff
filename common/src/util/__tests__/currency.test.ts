import { describe, expect, test } from 'bun:test'

import {
  convertCreditsToUsdCents,
  convertStripeGrantAmountToCredits,
} from '../currency'

describe('convertCreditsToUsdCents', () => {
  test('converts credits to USD cents correctly', () => {
    expect(convertCreditsToUsdCents(100, 2)).toBe(200)
    expect(convertCreditsToUsdCents(50, 3)).toBe(150)
    expect(convertCreditsToUsdCents(0, 100)).toBe(0)
    expect(convertCreditsToUsdCents(0.5, 2)).toBe(1)
  })

  test('rounds up fractional cents', () => {
    expect(convertCreditsToUsdCents(1, 1.5)).toBe(2)
    expect(convertCreditsToUsdCents(1, 0.1)).toBe(1)
  })

  test('throws when centsPerCredit is not positive', () => {
    expect(() => convertCreditsToUsdCents(100, 0)).toThrow(
      'centsPerCredit must be a positive finite number, got 0',
    )
    expect(() => convertCreditsToUsdCents(100, -5)).toThrow(
      'centsPerCredit must be a positive finite number, got -5',
    )
    expect(() => convertCreditsToUsdCents(100, NaN)).toThrow(
      'centsPerCredit must be a positive finite number, got NaN',
    )
    expect(() => convertCreditsToUsdCents(100, Infinity)).toThrow(
      'centsPerCredit must be a positive finite number, got Infinity',
    )
    expect(() => convertCreditsToUsdCents(100, -Infinity)).toThrow(
      'centsPerCredit must be a positive finite number, got -Infinity',
    )
  })

  test('throws when credits is not finite', () => {
    expect(() => convertCreditsToUsdCents(NaN, 100)).toThrow(
      'credits must be a finite number, got NaN',
    )
    expect(() => convertCreditsToUsdCents(Infinity, 100)).toThrow(
      'credits must be a finite number, got Infinity',
    )
    expect(() => convertCreditsToUsdCents(-Infinity, 100)).toThrow(
      'credits must be a finite number, got -Infinity',
    )
  })
})

describe('convertStripeGrantAmountToCredits', () => {
  test('converts Stripe grant amount to credits correctly', () => {
    expect(convertStripeGrantAmountToCredits(200, 2)).toBe(100)
    expect(convertStripeGrantAmountToCredits(150, 3)).toBe(50)
    expect(convertStripeGrantAmountToCredits(0, 100)).toBe(0)
  })

  test('floors fractional credits', () => {
    expect(convertStripeGrantAmountToCredits(150, 2)).toBe(75)
    expect(convertStripeGrantAmountToCredits(1, 0.1)).toBe(10)
  })

  test('throws when centsPerCredit is not positive', () => {
    expect(() => convertStripeGrantAmountToCredits(100, 0)).toThrow(
      'centsPerCredit must be a positive finite number, got 0',
    )
    expect(() => convertStripeGrantAmountToCredits(100, -5)).toThrow(
      'centsPerCredit must be a positive finite number, got -5',
    )
    expect(() => convertStripeGrantAmountToCredits(100, NaN)).toThrow(
      'centsPerCredit must be a positive finite number, got NaN',
    )
    expect(() => convertStripeGrantAmountToCredits(100, Infinity)).toThrow(
      'centsPerCredit must be a positive finite number, got Infinity',
    )
    expect(() => convertStripeGrantAmountToCredits(100, -Infinity)).toThrow(
      'centsPerCredit must be a positive finite number, got -Infinity',
    )
  })

  test('throws when amountInCents is not finite', () => {
    expect(() => convertStripeGrantAmountToCredits(NaN, 100)).toThrow(
      'amountInCents must be a finite number, got NaN',
    )
    expect(() => convertStripeGrantAmountToCredits(Infinity, 100)).toThrow(
      'amountInCents must be a finite number, got Infinity',
    )
    expect(() => convertStripeGrantAmountToCredits(-Infinity, 100)).toThrow(
      'amountInCents must be a finite number, got -Infinity',
    )
  })
})
