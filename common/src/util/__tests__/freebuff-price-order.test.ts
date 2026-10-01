import { describe, expect, test } from 'bun:test'

import { compareByFreebucksPrice } from '../freebuff-price-order'

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

  test('a discount that floors rows at 0 still ranks them by their regular price', () => {
    // The first-tab discount (10 off) on 2026-10-01: four rows at 0/hr were
    // drawn alphabetically, so GLM (15) led Laguna (2).
    expect(
      order({
        prices: { glm: 5, laguna: 0, deepseek: 5, bunny: 0, mimo: 0 },
        listPrices: { glm: 15, laguna: 2, deepseek: 15, bunny: 0, mimo: 10 },
      }),
    ).toEqual(['bunny', 'laguna', 'mimo', 'deepseek', 'glm', 'unpriced'])
  })
})
