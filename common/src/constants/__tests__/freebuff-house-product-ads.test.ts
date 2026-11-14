import { describe, expect, test } from 'bun:test'

import {
  HOUSE_PRODUCT_ADS,
  HOUSE_PRODUCT_CAMPAIGN_IDS,
  houseProductTipForCampaign,
} from '../freebuff-house-product-ads'

describe('product discovery house copy', () => {
  test('headlines name the feature and fit the campaign contract', () => {
    // These campaigns target Desktop/web only. Their renderer uses pixel-based
    // ellipsis; a 20-column terminal's 12/28 budget does not apply. Match the
    // campaign input limits (120 title, 500 body), not an invented UI hard cap.
    const feature = {
      integrations: /apps|integrations/i,
      themes: /theme/i,
      sites: /site/i,
      templates: /template/i,
    }
    for (const [tip, creatives] of Object.entries(HOUSE_PRODUCT_ADS)) {
      for (const creative of creatives) {
        expect(creative.title.length).toBeLessThanOrEqual(120)
        expect(creative.adText.length).toBeLessThanOrEqual(500)
        expect(creative.title).toMatch(/Freebuff/)
        expect(creative.title).toMatch(feature[tip as keyof typeof feature])
        expect(new URL(creative.url).origin).toBe('https://freebuff.com')
      }
    }
  })

  test('stable IDs distinguish all four tips and do not identify other campaigns', () => {
    expect(new Set(Object.values(HOUSE_PRODUCT_CAMPAIGN_IDS)).size).toBe(4)
    for (const [tip, id] of Object.entries(HOUSE_PRODUCT_CAMPAIGN_IDS)) {
      expect(houseProductTipForCampaign(id)).toBe(tip)
    }
    expect(houseProductTipForCampaign('other-house')).toBeNull()
  })
})
