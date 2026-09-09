import { describe, expect, it } from 'bun:test'

import {
  FREEBUFF_FREE_PROMOTION_SPEND_WINDOWS,
  isFreePromotionSpendAt,
} from '../freebuff-free-promotions'
import { SOLAR_PRICE_CHANGES } from '../freebuff-solar-promo'
import { FREEBUFF_SOLAR_PRO_4_MODEL_ID } from '../freebuff-model-entitlements'

describe('free-promotion spend windows', () => {
  it('matches the offer it is derived from, to the boundary', () => {
    // The window has to be exactly the span the user is charged 0 for. A
    // window WIDER than the offer exempts spend from a paid day; a NARROWER
    // one charges a user for a model we told them was free — which is the
    // complaint this was built for.
    const free = SOLAR_PRICE_CHANGES.find((c) => c.price === 0)!
    const back = SOLAR_PRICE_CHANGES.find(
      (c) => c.price !== 0 && Date.parse(c.at) > Date.parse(free.at),
    )!
    expect(FREEBUFF_FREE_PROMOTION_SPEND_WINDOWS).toEqual([
      {
        modelId: FREEBUFF_SOLAR_PRO_4_MODEL_ID,
        from: new Date(Date.parse(free.at)).toISOString(),
        to: new Date(Date.parse(back.at)).toISOString(),
      },
      {
        modelId: FREEBUFF_SOLAR_PRO_4_MODEL_ID,
        from: '2026-09-09T15:49:00.000Z',
        to: '2099-01-01T00:00:00.000Z',
      },
    ])
  })

  it('is half-open, so the day the price returns is charged again', () => {
    const solar = FREEBUFF_SOLAR_PRO_4_MODEL_ID
    expect(isFreePromotionSpendAt(solar, new Date('2026-09-04T23:59:59-07:00'))).toBe(false)
    expect(isFreePromotionSpendAt(solar, new Date('2026-09-05T00:00:00-07:00'))).toBe(true)
    expect(isFreePromotionSpendAt(solar, new Date('2026-09-07T23:59:59-07:00'))).toBe(true)
    // The instant the price goes back to 5, spend counts again — with no
    // deploy, which is the point of deriving this from the schedule.
    expect(isFreePromotionSpendAt(solar, new Date('2026-09-08T00:00:00-07:00'))).toBe(false)
    expect(isFreePromotionSpendAt(solar, new Date('2026-09-09T15:48:59.999Z'))).toBe(false)
    expect(isFreePromotionSpendAt(solar, new Date('2026-09-09T15:49:00Z'))).toBe(true)
  })

  it('exempts nothing else', () => {
    for (const modelId of [
      'deepseek/deepseek-v4-flash',
      'z-ai/glm-5.3-flash',
      'openai/gpt-5.6-luna',
    ]) {
      expect(
        isFreePromotionSpendAt(modelId, new Date('2026-09-06T12:00:00-07:00')),
      ).toBe(false)
    }
  })

  it('never leaves a window open when the price returns', () => {
    // A window that never closes makes a weekend promotion permanent. Every
    // span here must end at a real transition unless the schedule genuinely
    // leaves the price at zero.
    for (const window of FREEBUFF_FREE_PROMOTION_SPEND_WINDOWS) {
      const returns = SOLAR_PRICE_CHANGES.some(
        (c) => c.modelId === window.modelId && c.price !== 0 &&
          Date.parse(c.at) > Date.parse(window.from),
      )
      if (returns) {
        expect(Date.parse(window.to)).toBeLessThan(
          Date.parse('2099-01-01T00:00:00.000Z'),
        )
      }
      expect(Date.parse(window.to)).toBeGreaterThan(Date.parse(window.from))
    }
  })
})
