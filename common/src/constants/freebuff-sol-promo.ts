/**
 * GPT-6.1 Sol's promotional-price label (2026-09-29): the catalog row's
 * `promotional` field, and the server price notice
 * (`freebucksPricing().priceNotices`) that released CLI and Desktop builds
 * render in place of the tagline. One constant so the two cannot disagree.
 *
 * A leaf module, like freebuff-solar-promo.ts, because the Freebucks price
 * map and the model catalog both read it and neither may import the other.
 */
export const GPT_61_SOL_PROMOTIONAL = {
  short: 'Promotional price, temporary',
  tooltip:
    'Temporary promotional price. It will go up when the promotion ends.',
} as const
