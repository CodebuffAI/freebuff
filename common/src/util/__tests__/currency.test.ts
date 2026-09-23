import { describe, expect, it } from 'bun:test'

import {
  convertCreditsToUsdCents,
  convertStripeGrantAmountToCredits,
} from '../currency'

describe('convertCreditsToUsdCents', () => {
  it('converts credits to cents correctly', () => {
    expect(convertCreditsToUsdCents(1, 100)).toBe(100)
    expect(convertCreditsToUsdCents(1.5, 100)).toBe(150)
    expect(convertCreditsToUsdCents(0.1, 100)).toBe(10)
  })

  it('throws for non-positive centsPerCredit', () => {
    expect(() => convertCreditsToUsdCents(100, 0)).toThrow('centsPerCredit must be positive')
    expect(() => convertCreditsToUsdCents(100, -10)).toThrow('centsPerCredit must be positive')
  })

  it('throws for NaN credits', () => {
    expect(() => convertCreditsToUsdCents(NaN, 100)).toThrow('credits must be finite')
  })

  it('throws for Infinity credits', () => {
    expect(() => convertCreditsToUsdCents(Infinity, 100)).toThrow('credits must be finite')
  })

  it('throws for negative Infinity credits', () => {
    expect(() => convertCreditsToUsdCents(-Infinity, 100)).toThrow('credits must be finite')
  })
})

describe('convertStripeGrantAmountToCredits', () => {
  it('converts cents to credits correctly', () => {
    expect(convertStripeGrantAmountToCredits(10000, 100)).toBe(100)
    expect(convertStripeGrantAmountToCredits(15000, 100)).toBe(150)
    expect(convertStripeGrantAmountToCredits(1000, 100)).toBe(10)
  })

  it('throws for non-positive centsPerCredit', () => {
    expect(() => convertStripeGrantAmountToCredits(10000, 0)).toThrow('centsPerCredit must be positive')
    expect(() => convertStripeGrantAmountToCredits(10000, -10)).toThrow('centsPerCredit must be positive')
  })

  it('throws for NaN amountInCents', () => {
    expect(() => convertStripeGrantAmountToCredits(NaN, 100)).toThrow('amountInCents must be finite')
  })

  it('throws for Infinity amountInCents', () => {
    expect(() => convertStripeGrantAmountToCredits(Infinity, 100)).toThrow('amountInCents must be finite')
  })

  it('throws for negative Infinity amountInCents', () => {
    expect(() => convertStripeGrantAmountToCredits(-Infinity, 100)).toThrow('amountInCents must be finite')
  })
})