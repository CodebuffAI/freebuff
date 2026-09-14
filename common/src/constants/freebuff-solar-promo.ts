import { FREEBUFF_SOLAR_PRO_4_MODEL_ID } from './freebuff-model-entitlements'

// Historical offer; use solarOfferAt() for the current price.
export const SOLAR_REGULAR_OFFER = {
  price: 5,
  tagline: 'Limited-time trial',
} as const

// These transitions travel with the server quote so idle clients can update
// even during a slow refresh. Preserve past prices for historical accounting.
export const SOLAR_PRICE_CHANGES = [
  {
    at: '2026-09-05T00:00:00-07:00',
    modelId: FREEBUFF_SOLAR_PRO_4_MODEL_ID,
    price: 0,
    tagline: '0 Freebucks · Labor Day weekend (through Sep 7 PT)',
  },
  {
    at: '2026-09-08T00:00:00-07:00',
    modelId: FREEBUFF_SOLAR_PRO_4_MODEL_ID,
    ...SOLAR_REGULAR_OFFER,
  },
  {
    at: '2026-09-09T15:49:00Z',
    modelId: FREEBUFF_SOLAR_PRO_4_MODEL_ID,
    price: 0,
    tagline: '0 Freebucks',
  },
  {
    // Metered again. Takes effect as each server deploys it.
    at: '2026-09-13T05:00:00Z',
    modelId: FREEBUFF_SOLAR_PRO_4_MODEL_ID,
    ...SOLAR_REGULAR_OFFER,
  },
  {
    at: '2026-09-14T03:46:00Z',
    modelId: FREEBUFF_SOLAR_PRO_4_MODEL_ID,
    price: 10,
    tagline: SOLAR_REGULAR_OFFER.tagline,
  },
] as const

export function solarOfferAt(now: number = Date.now()) {
  return (
    [...SOLAR_PRICE_CHANGES]
      .reverse()
      .find((change) => Date.parse(change.at) <= now) ?? SOLAR_REGULAR_OFFER
  )
}
