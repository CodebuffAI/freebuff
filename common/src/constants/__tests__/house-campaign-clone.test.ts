import { describe, expect, test } from 'bun:test'

import {
  houseCampaignFaviconFor,
  houseCampaignGateFor,
  HOUSE_GROWTH_CAMPAIGNS,
} from '../freebuff-house-growth-ads'
import {
  HOUSE_PRODUCT_CAMPAIGN_IDS,
  houseProductTipForCampaign,
} from '../freebuff-house-product-ads'
import {
  houseCampaignCloneId,
  houseCampaignSourceId,
  isHouseCampaignClone,
} from '../house-campaign-clone'

describe('house campaign clones', () => {
  test('a clone id resolves to its source and never stacks', () => {
    const clone = houseCampaignCloneId('house-growth-desktop-v1', 2)
    expect(clone).toBe('house-growth-desktop-v1~dup2')
    expect(houseCampaignSourceId(clone)).toBe('house-growth-desktop-v1')
    expect(houseCampaignCloneId(clone, 3)).toBe('house-growth-desktop-v1~dup3')
    expect(isHouseCampaignClone(clone)).toBe(true)
    expect(isHouseCampaignClone('house-growth-desktop-v1')).toBe(false)
    expect(houseCampaignSourceId('some-uuid~dup0')).toBe('some-uuid~dup0')
    expect(() => houseCampaignCloneId('x', 0)).toThrow()
  })

  test('every gated or favicon campaign keeps its policy on a clone', () => {
    for (const campaign of HOUSE_GROWTH_CAMPAIGNS) {
      const clone = houseCampaignCloneId(campaign.id, 1)
      expect(houseCampaignGateFor(clone)).toBe(houseCampaignGateFor(campaign.id))
      expect(houseCampaignFaviconFor(clone)).toBe(
        houseCampaignFaviconFor(campaign.id),
      )
    }
  })

  test('a product tip clone keeps its tip suppression', () => {
    for (const [tip, id] of Object.entries(HOUSE_PRODUCT_CAMPAIGN_IDS)) {
      expect(houseProductTipForCampaign(houseCampaignCloneId(id, 4))).toBe(
        tip as keyof typeof HOUSE_PRODUCT_CAMPAIGN_IDS,
      )
    }
  })
})
