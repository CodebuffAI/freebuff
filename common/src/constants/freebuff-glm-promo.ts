/**
 * GLM 5.3 Flash's promotion (2026-10-03): 10 Freebucks an hour, down from 15,
 * labelled temporary by product decision.
 *
 * `GLM_V53_FLASH_PROMOTIONAL` is the catalog row's `promotional` field and the
 * server price notice (`freebucksPricing().priceNotices`) that released CLI
 * and Desktop builds render in place of the tagline. One constant so the two
 * cannot disagree.
 *
 * A leaf module, like freebuff-sol-promo.ts, because the Freebucks price map
 * and the model catalog both read it and neither may import the other.
 */
export const GLM_V53_FLASH_PROMOTIONAL = {
  short: 'Promotional',
  tooltip:
    'Temporary promotional price: 10 Freebucks an hour. The price will go up when the promotion ends.',
} as const
