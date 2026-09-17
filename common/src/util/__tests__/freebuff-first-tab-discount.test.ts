import { describe, expect, test } from 'bun:test'
import { freebucksFixture } from '../../testing/freebuff'
import {
  applyFirstTabDiscount,
  firstTabListPriceFor,
  firstTabQuoteForSession,
} from '../freebuff-first-tab-discount'
import { applyFreebucksPriceChanges } from '../freebuff-price-changes'

describe('first-tab quotes', () => {
  test('only the live owning session can quote its replacement at the discounted price', () => {
    const now = Date.parse('2026-09-15T12:00:00Z')
    const session = {
      instanceId: 'owner',
      expiresAt: new Date(now + 60_000).toISOString(),
    }
    const quote = applyFirstTabDiscount(
      freebucksFixture(0, { cheap: 5, premium: 25 }),
      {
        amount: 10,
        available: false,
        holder: { ...session, surface: 'desktop' },
      },
    )
    const replacement = firstTabQuoteForSession(quote, session, 'desktop', now)!
    expect(replacement.prices).toEqual({ cheap: 0, premium: 15 })
    expect(firstTabQuoteForSession(replacement, session, 'desktop', now)).toBe(
      replacement,
    )
    expect(
      firstTabQuoteForSession(
        quote,
        { ...session, instanceId: 'other' },
        'desktop',
        now,
      ),
    ).toBe(quote)
    expect(firstTabQuoteForSession(quote, session, 'single', now)).toBe(quote)
    expect(firstTabQuoteForSession(quote, undefined, 'desktop', now)).toBe(
      quote,
    )
    expect(
      firstTabQuoteForSession(quote, session, 'desktop', now + 60_000),
    ).toBe(quote)
    expect(
      firstTabQuoteForSession(
        {
          ...quote,
          firstTabDiscount: {
            ...quote.firstTabDiscount!,
            holder: { ...session, instanceId: null, surface: 'desktop' },
          },
        },
        session,
        'desktop',
        now,
      )?.prices,
    ).toEqual(quote.prices)
  })
  test('discounts each model with a zero floor without changing balances or the source quote', () => {
    const original = freebucksFixture(7, {
      cheap: 5,
      exact: 10,
      premium: 25,
      promo: 0,
    })
    const quote = applyFirstTabDiscount(original, {
      amount: 10,
      available: true,
    })
    expect(quote.prices).toEqual({ cheap: 0, exact: 0, premium: 15, promo: 0 })
    expect(quote.balance).toBe(7)
    expect(original.prices.premium).toBe(25)
    expect(
      applyFirstTabDiscount(original, { amount: 10, available: false }).prices,
    ).toEqual(original.prices)
  })

  test('carries the list prices for the crossed-out original and never stacks on re-application', () => {
    const original = freebucksFixture(7, { cheap: 5, premium: 25, promo: 0 })
    const quote = applyFirstTabDiscount(original, {
      amount: 10,
      available: true,
    })
    expect(quote.listPrices).toEqual(original.prices)
    // Re-applying discounts from the LIST price, not the discounted one.
    expect(
      applyFirstTabDiscount(quote, { amount: 10, available: true }).prices,
    ).toEqual(quote.prices)
    // Withdrawing (in use elsewhere) restores the list prices as the quote.
    const inUse = applyFirstTabDiscount(quote, { amount: 10, available: false })
    expect(inUse.prices).toEqual(original.prices)
    expect(inUse.listPrices).toEqual(original.prices)
  })

  test('the crossed-out price shows only where an available discount moved the price', () => {
    const original = freebucksFixture(7, { cheap: 5, premium: 25, promo: 0 })
    const quote = applyFirstTabDiscount(original, {
      amount: 10,
      available: true,
    })
    expect(firstTabListPriceFor(quote, 'premium')).toBe(25)
    expect(firstTabListPriceFor(quote, 'cheap')).toBe(5)
    // Already free: "0 off 0" is not a discount.
    expect(firstTabListPriceFor(quote, 'promo')).toBeUndefined()
    expect(firstTabListPriceFor(quote, 'unpriced')).toBeUndefined()
    // In use by another session: the full price is the price, nothing struck.
    expect(
      firstTabListPriceFor(
        applyFirstTabDiscount(quote, { amount: 10, available: false }),
        'premium',
      ),
    ).toBeUndefined()
    // No offer at all, and an older server's quote without list prices:
    // undefined rather than a guessed `price + amount`.
    expect(firstTabListPriceFor(original, 'premium')).toBeUndefined()
    expect(firstTabListPriceFor(null, 'premium')).toBeUndefined()
    expect(
      firstTabListPriceFor(
        { prices: { premium: 15 }, firstTabDiscount: { amount: 10, available: true } },
        'premium',
      ),
    ).toBeUndefined()
  })

  test('scheduled list-price changes keep the same discount and do not stack it', () => {
    const quote = applyFirstTabDiscount(
      {
        ...freebucksFixture(20, { model: 25 }),
        priceChanges: [
          {
            modelId: 'model',
            price: 8,
            at: '2026-09-16T00:00:00Z',
            tagline: 'New price',
          },
        ],
      },
      { amount: 10, available: true },
    )
    const after = applyFreebucksPriceChanges(
      quote,
      Date.parse('2026-09-17T00:00:00Z'),
    )
    expect(after.prices.model).toBe(0)
    expect(applyFreebucksPriceChanges(after).prices.model).toBe(0)
    // The crossed-out original follows the list price the change set.
    expect(after.listPrices?.model).toBe(8)
    expect(firstTabListPriceFor(after, 'model')).toBe(8)
  })
})
