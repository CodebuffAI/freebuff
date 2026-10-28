import { describe, expect, test } from 'bun:test'

import { FEATURED_INTEGRATIONS } from '../../desktop-cloud/integrations'
import {
  HOUSE_GROWTH_CAMPAIGNS,
  HOUSE_GROWTH_INTEGRATION_CAMPAIGNS,
  houseCampaignFaviconFor,
  houseCampaignGateFor,
  integrationSlugForGate,
} from '../freebuff-house-growth-ads'
import { HOUSE_PRODUCT_CAMPAIGN_IDS } from '../freebuff-house-product-ads'

describe('growth house campaign catalog', () => {
  test('ids are unique, stable and never collide with the product tips', () => {
    const ids = HOUSE_GROWTH_CAMPAIGNS.map((campaign) => campaign.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) {
      expect(id).toMatch(/^house-growth-[a-z0-9-]+-v1$/)
      expect(Object.values(HOUSE_PRODUCT_CAMPAIGN_IDS)).not.toContain(id)
    }
  })

  test('one gated campaign per featured integration', () => {
    expect(
      HOUSE_GROWTH_INTEGRATION_CAMPAIGNS.map((campaign) =>
        integrationSlugForGate(campaign.gate!),
      ),
    ).toEqual([...FEATURED_INTEGRATIONS])
  })

  test('every creative links over https and fits the CLI preview', () => {
    for (const campaign of HOUSE_GROWTH_CAMPAIGNS) {
      expect(campaign.creatives.length).toBeGreaterThan(0)
      const destinations = new Set(campaign.creatives.map((c) => c.url))
      // The seed requires one reviewed destination per campaign.
      expect(destinations.size).toBe(1)
      for (const creative of campaign.creatives) {
        expect(creative.url.startsWith('https://')).toBe(true)
        // The 48-column CLI baseline the Discord headlines target.
        expect(creative.title.length).toBeLessThanOrEqual(48)
        expect(creative.adText.length).toBeLessThanOrEqual(80)
      }
    }
  })

  test('integration campaigns carry their app logo; others carry none', () => {
    for (const campaign of HOUSE_GROWTH_INTEGRATION_CAMPAIGNS) {
      const slug = integrationSlugForGate(campaign.gate!)
      expect(houseCampaignFaviconFor(campaign.id)).toBe(
        `https://freebuff.com/api/integrations/logo/${slug}`,
      )
      for (const creative of campaign.creatives)
        expect(creative.favicon).toBe(houseCampaignFaviconFor(campaign.id)!)
    }
    expect(houseCampaignFaviconFor('house-growth-desktop-v1')).toBeNull()
  })

  test('the gate map answers by id and ignores unknown ids', () => {
    expect(houseCampaignGateFor('house-growth-desktop-v1')).toBe('desktop_user')
    expect(houseCampaignGateFor('house-growth-referrals-v1')).toBeNull()
    expect(houseCampaignGateFor('house-product-sites-v1')).toBeNull()
  })
})
