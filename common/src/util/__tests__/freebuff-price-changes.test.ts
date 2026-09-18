import { describe, expect, it, test, spyOn } from 'bun:test'
import { freebucksFixture } from '../../testing/freebuff'
import { applyFirstTabDiscount } from '../freebuff-first-tab-discount'
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
const metered = Date.parse('2026-09-13T05:00:00Z')
const increased = Date.parse('2026-09-14T03:46:00Z')
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
    expect(nextFreebucksPriceChange(freeAgain)).toBe(metered)
    const meteredAgain = applyFreebucksPriceChanges(freeAgain, metered)
    expect(meteredAgain.prices[solar]).toBe(5)
    expect(meteredAgain.priceNotices[solar]).toBe('Limited-time trial')
    expect(nextFreebucksPriceChange(meteredAgain)).toBe(increased)
    expect(applyFreebucksPriceChanges(meteredAgain, increased - 1)).toBe(
      meteredAgain,
    )
    expect(applyFreebucksPriceChanges(meteredAgain, increased)).toEqual({
      ...meteredAgain,
      prices: { ...meteredAgain.prices, [solar]: 10 },
      priceChanges: [],
    })
    expect(quote.prices[solar]).toBe(5)
    expect(quote.priceChanges).toHaveLength(5)
  })

  it('catches up across all transitions, even when a delayed response lists them out of order', () => {
    const quote = quoteBeforeStart()
    quote.priceChanges.reverse()
    expect(applyFreebucksPriceChanges(quote, end).prices[solar]).toBe(5)
    expect(applyFreebucksPriceChanges(quote, restored).prices[solar]).toBe(0)
    expect(applyFreebucksPriceChanges(quote, metered).prices[solar]).toBe(5)
    expect(applyFreebucksPriceChanges(quote, increased).prices[solar]).toBe(10)
  })

  it('does not add an unpriced model or invent metadata on older server responses', () => {
    const old = freebucksFixture(0)
    expect(applyFreebucksPriceChanges(old, end)).toBe(old)
    expect(nextFreebucksPriceChange(undefined)).toBe(Infinity)
    const missing = {
      ...old,
      priceChanges: SOLAR_PRICE_CHANGES,
      offPeak: { [solar]: flashPolicy },
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

const flashPolicy = {
  startHourUtc: 22,
  endHourUtc: 6,
  price: 10,
  regularPrice: 15,
}

describe('recurring server prices', () => {
  test.each([
    ['2026-09-19T06:00:00Z', 10, 15, '2026-09-19T22:00:00Z'],
    ['2026-09-18T22:00:00Z', 15, 10, '2026-09-19T06:00:00Z'],
  ] as const)(
    'repairs an exhausted quote at %s without touching the balance',
    (at, stale, price, next) => {
      const quote = {
        ...freebucksFixture(25, { flash: stale }),
        offPeak: { flash: flashPolicy },
        priceChanges: [],
      }
      const now = Date.parse(at)
      const current = applyFreebucksPriceChanges(quote, now)
      expect(current.prices.flash).toBe(price)
      expect(current.balance).toBe(quote.balance)
      expect(current.daily).toBe(quote.daily)
      expect(current.wallet).toBe(quote.wallet)
      expect(quote.prices.flash).toBe(stale)
      expect(applyFreebucksPriceChanges(current, now)).toBe(current)
      expect(nextFreebucksPriceChange(current, now)).toBe(Date.parse(next))
      const discounted = applyFirstTabDiscount(quote, { amount: 10, available: true })
      const firstTab = applyFreebucksPriceChanges(discounted, now)
      expect(firstTab.prices.flash).toBe(price - 10)
      expect(firstTab.listPrices?.flash).toBe(price)
      expect(discounted.listPrices?.flash).toBe(stale)
      expect(applyFreebucksPriceChanges(firstTab, now)).toBe(firstTab)
      expect(applyFirstTabDiscount(firstTab, { amount: 10, available: false }).prices.flash).toBe(price)
      // A stale crossed-out price still needs repair when the payable price is current.
      expect(applyFreebucksPriceChanges({ ...firstTab, listPrices: { flash: stale } }, now).listPrices?.flash).toBe(price)
    },
  )

  it('keeps waking when a multi-day sleep returns to the same price with no dated changes left', () => {
    const clock = spyOn(Date, 'now').mockReturnValue(
      Date.parse('2026-09-18T07:00:00Z'),
    )
    const realTimeout = globalThis.setTimeout
    let wake: (() => void) | undefined
    const timer = spyOn(globalThis, 'setTimeout').mockImplementation(((
      fn: () => void,
      ms: number,
    ) => {
      wake = fn
      return realTimeout(fn, ms)
    }) as typeof setTimeout)
    const quote = applyFreebucksPriceChanges({
      prices: { flash: 15 },
      offPeak: { flash: flashPolicy },
      priceChanges: [],
    })
    const seen: number[] = []
    const stop = watchFreebucksPriceChanges(quote, () => {
      seen.push(applyFreebucksPriceChanges(quote).prices.flash)
    })
    try {
      clock.mockReturnValue(Date.parse('2026-09-20T07:00:00Z'))
      wake!()
      expect(applyFreebucksPriceChanges(quote)).toBe(quote)
      expect(seen).toEqual([15])
      expect(timer.mock.calls.at(-1)?.[1]).toBe(15 * 3_600_000)
      clock.mockReturnValue(Date.parse('2026-09-20T22:00:00Z'))
      wake!()
      expect(seen).toEqual([15, 10])
      expect(timer.mock.calls.at(-1)?.[1]).toBe(8 * 3_600_000)
    } finally {
      stop()
      timer.mockRestore()
      clock.mockRestore()
    }
  })
})
