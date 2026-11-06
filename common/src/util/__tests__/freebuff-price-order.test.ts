import { describe, expect, test } from 'bun:test'

import {
  compareByFreebucksPrice,
  freebucksListPriceFor,
  freebucksRowPrice,
} from '../freebuff-price-order'

const rows = [
  { id: 'glm', displayName: 'GLM 5.3 Flash' },
  { id: 'laguna', displayName: 'Laguna S 2.1' },
  { id: 'deepseek', displayName: 'DeepSeek V4.1 Flash' },
  { id: 'bunny', displayName: 'Space Bunny Alpha' },
  { id: 'mimo', displayName: 'MiMo 2.6 Flash' },
  { id: 'unpriced', displayName: 'Aardvark' },
]
const order = (freebucks: Parameters<typeof compareByFreebucksPrice>[0]) =>
  [...rows]
    .sort((a, b) => compareByFreebucksPrice(freebucks, a, b))
    .map((r) => r.id)

describe('compareByFreebucksPrice', () => {
  test('cheapest first, unpriced last', () => {
    expect(
      order({
        prices: { glm: 15, laguna: 2, deepseek: 15, bunny: 0, mimo: 10 },
      }),
    ).toEqual(['bunny', 'laguna', 'mimo', 'deepseek', 'glm', 'unpriced'])
  })

  test('rows a discount brought to the same price still rank by their regular price', () => {
    expect(
      order({
        prices: { glm: 5, laguna: 0, deepseek: 5, bunny: 0, mimo: 0 },
        listPrices: { glm: 15, laguna: 2, deepseek: 15, bunny: 0, mimo: 10 },
      }),
    ).toEqual(['bunny', 'laguna', 'mimo', 'deepseek', 'glm', 'unpriced'])
  })
})

describe('freebucksListPriceFor', () => {
  test('crosses out only a list price above what the row costs', () => {
    const quote = {
      prices: { glm: 5, laguna: 2, mimo: 10 },
      listPrices: { glm: 15, laguna: 2 },
    }
    expect(freebucksListPriceFor(quote, 'glm')).toBe(15)
    expect(freebucksListPriceFor(quote, 'laguna')).toBeUndefined()
    expect(freebucksListPriceFor(quote, 'mimo')).toBeUndefined()
    expect(freebucksListPriceFor(quote, 'unpriced')).toBeUndefined()
    expect(freebucksListPriceFor(null, 'glm')).toBeUndefined()
  })
})

describe('freebucksRowPrice', () => {
  const quote = {
    prices: { flash: 15, luna: 50, glm: 5 },
    listPrices: { glm: 15 },
    soloDiscount: 15,
  }

  test('charges the price less the solo discount, the quote struck beside it', () => {
    expect(freebucksRowPrice(quote, 'flash', 15)).toEqual({ price: 0, listPrice: 15 })
    expect(freebucksRowPrice(quote, 'luna', 50)).toEqual({ price: 35, listPrice: 50 })
  })

  test('strikes a catalog list price over the quote', () => {
    expect(freebucksRowPrice(quote, 'glm', 5)).toEqual({ price: 0, listPrice: 15 })
  })

  test('no discount moves nothing; an unpriced or withheld row has no price', () => {
    const { soloDiscount: _, ...full } = quote
    expect(freebucksRowPrice(full, 'luna', 50)).toEqual({ price: 50, listPrice: undefined })
    expect(freebucksRowPrice(quote, 'missing', undefined)).toEqual({ price: undefined, listPrice: undefined })
    expect(freebucksRowPrice(quote, 'luna', undefined)).toEqual({ price: undefined, listPrice: undefined })
    expect(freebucksRowPrice(null, 'luna', 50)).toEqual({ price: 50, listPrice: undefined })
  })
})
