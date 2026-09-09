import { describe, expect, it, spyOn } from 'bun:test'
import { freebucksFixture } from '../../testing/freebuff'
import {
  SOLAR_PRICE_CHANGES,
  SOLAR_REGULAR_OFFER,
} from '../../constants/freebuff-solar-promo'
import {
  applyFreebucksPriceChanges,
  nextFreebucksPriceChange,
  watchFreebucksPriceChanges,
} from '../freebuff-price-changes'

const solar = 'upstage/solar-pro4'
const start = Date.parse('2026-09-05T07:00:00Z')
const end = Date.parse('2026-09-08T07:00:00Z')
const restored = Date.parse('2026-09-09T15:49:00Z')
const quoteBeforeStart = () => ({
  ...freebucksFixture(0, { [solar]: SOLAR_REGULAR_OFFER.price }),
  priceNotices: { [solar]: SOLAR_REGULAR_OFFER.tagline },
  priceChanges: [...SOLAR_PRICE_CHANGES],
})

describe('announced Freebucks price changes', () => {
  it('keeps a serialized quote coherent at every boundary without mutating balances or the input', () => {
    const quote = JSON.parse(JSON.stringify(quoteBeforeStart()))
    expect(applyFreebucksPriceChanges(quote, start - 1)).toBe(quote)
    const free = applyFreebucksPriceChanges(quote, start)
    expect(free.prices[solar]).toBe(0)
    expect(free.priceNotices[solar]).toContain('Labor Day weekend')
    expect(nextFreebucksPriceChange(free)).toBe(end)
    const expired = applyFreebucksPriceChanges(free, end)
    expect(expired.prices[solar]).toBe(5)
    expect(expired.priceNotices[solar]).toBe('Limited-time trial')
    expect(expired.balance).toBe(0)
    expect(expired.daily).toEqual(quote.daily)
    expect(expired.wallet).toEqual(quote.wallet)
    expect(nextFreebucksPriceChange(expired)).toBe(restored)
    const freeAgain = applyFreebucksPriceChanges(expired, restored)
    expect(freeAgain.prices[solar]).toBe(0)
    expect(freeAgain.priceNotices[solar]).toBe('0 Freebucks')
    expect(nextFreebucksPriceChange(freeAgain)).toBe(Infinity)
    expect(quote.prices[solar]).toBe(5)
    expect(quote.priceChanges).toHaveLength(3)
  })

  it('catches up across all transitions, even when a delayed response lists them out of order', () => {
    const quote = quoteBeforeStart()
    quote.priceChanges.reverse()
    expect(applyFreebucksPriceChanges(quote, end).prices[solar]).toBe(5)
    expect(applyFreebucksPriceChanges(quote, restored).prices[solar]).toBe(0)
  })

  it('does not add an unpriced model or invent metadata on older server responses', () => {
    const old = freebucksFixture(0)
    expect(applyFreebucksPriceChanges(old, end)).toBe(old)
    expect(nextFreebucksPriceChange(undefined)).toBe(Infinity)
    const missing = {
      ...old,
      priceChanges: SOLAR_PRICE_CHANGES,
    }
    expect(
      applyFreebucksPriceChanges(missing, end).prices[solar],
    ).toBeUndefined()
  })

  it('cancels a picker wakeup on unmount', () => {
    const clock = spyOn(Date, 'now').mockReturnValue(end - 1000)
    const clear = spyOn(globalThis, 'clearTimeout')
    try {
      const stop = watchFreebucksPriceChanges(
        applyFreebucksPriceChanges(quoteBeforeStart(), end - 1000),
        () => {
          throw new Error('Disposed picker woke up')
        },
      )
      stop()
      expect(clear).toHaveBeenCalledTimes(1)
    } finally {
      clock.mockRestore()
      clear.mockRestore()
    }
  })
})
