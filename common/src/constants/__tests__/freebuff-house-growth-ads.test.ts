import { describe, expect, test } from 'bun:test'

import { FEATURED_INTEGRATIONS } from '../../desktop-cloud/integrations'
import { isAdTextSafe } from '../../util/ad-creative-safety'
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

  test('one referral ad for everyone, offering free coding and themes', () => {
    const referrals = HOUSE_GROWTH_CAMPAIGNS.filter((c) =>
      c.id.startsWith('house-growth-referrals'),
    )
    expect(referrals.map((c) => c.id)).toEqual(['house-growth-referrals-v1'])
    const [campaign] = referrals
    expect(campaign!.creatives[0]!.title).toBe(
      'Give your friends unlimited free coding',
    )
    for (const creative of campaign!.creatives) {
      const copy = `${creative.title} ${creative.adText}`
      expect(copy).toContain('unlimited free coding')
      // The invite cards' words (docs/referrals.md, "Invite surfaces").
      expect(copy).toContain('Invite 3 friends to unlock custom themes')
      // The referral reward is themes; no model time is promised.
      expect(copy).not.toMatch(/terra|hour|session|freebucks/i)
      expect(creative.url).toBe('https://freebuff.com/referrals')
    }
  })

  test('copy is ad-safe and makes none of the house false claims', () => {
    // The list `freebuff-house-ad.test.ts` and the refresh's `acceptDraft`
    // hold house copy to, plus "limited", which copy never says to users.
    // There "unlimited" guards subscription claims; free coding is unlimited,
    // so the referral ad's "unlimited free coding" is the one exception.
    const FALSE_CLAIMS = [
      /no ads/i,
      /ad-free/i,
      /without ads/i,
      /skip the queue/i,
      /no wait/i,
      /instant/i,
      /every model/i,
      /unlimited/i,
      /\blimited/i,
    ]
    for (const campaign of HOUSE_GROWTH_CAMPAIGNS)
      for (const creative of campaign.creatives) {
        for (const text of [creative.title, creative.adText, creative.cta])
          expect(isAdTextSafe(text)).toBe(true)
        const copy = `${creative.title} ${creative.adText}`.replace(
          /unlimited free coding/g,
          '',
        )
        for (const claim of FALSE_CLAIMS) expect(copy).not.toMatch(claim)
      }
  })
})
