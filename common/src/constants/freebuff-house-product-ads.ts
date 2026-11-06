import { HOUSE_AD_FAVICON_URL } from './freebuff-house-ad'
import { FREEBUFF_WEB_URL_PROD } from './hosts'
import { houseCampaignSourceId } from './house-campaign-clone'

import type { HouseAdCreative } from './freebuff-house-ad'

export type HouseProductTip = 'integrations' | 'themes' | 'sites' | 'templates'

// Stable campaign IDs bind the seed to the serving policy. Names and copy may
// change without accidentally creating another campaign or losing targeting.
export const HOUSE_PRODUCT_CAMPAIGN_IDS: Record<HouseProductTip, string> = {
  integrations: 'house-product-integrations-v1',
  themes: 'house-product-themes-v1',
  sites: 'house-product-sites-v1',
  templates: 'house-product-templates-v1',
}

export const HOUSE_PRODUCT_FREQUENCY_CAP = {
  maxImpressions: 1,
  windowMinutes: 24 * 60,
} as const

function creative(
  title: string,
  adText: string,
  cta: string,
  path: string,
): HouseAdCreative {
  return {
    title,
    adText,
    cta,
    url: `${FREEBUFF_WEB_URL_PROD}${path}`,
    favicon: HOUSE_AD_FAVICON_URL,
  }
}

/**
 * Desktop/web inline copy. The 20-column CLI floor is not a creative limit
 * here: these campaigns never target CLI, breaks or billboards. Put the
 * action and feature in the headline; the responsive UI may ellipsize the
 * supporting sentence in a narrow pane.
 */
export const HOUSE_PRODUCT_ADS: Record<
  HouseProductTip,
  readonly HouseAdCreative[]
> = {
  integrations: [
    creative(
      'Connect your apps to Freebuff',
      'Use your connected apps from Freebuff chats.',
      'Connect an app',
      '/?settings=integrations',
    ),
    creative(
      'Try Freebuff integrations',
      'Give Freebuff access to the tools you already use.',
      'See integrations',
      '/?settings=integrations',
    ),
    creative(
      'Ask Freebuff to use your connected apps',
      'Connect an app in Integrations, then try it in your next chat.',
      'Connect an app',
      '/?settings=integrations',
    ),
    creative(
      'See which apps you can connect to Freebuff',
      'Browse available integrations and connect a tool you use.',
      'Browse integrations',
      '/?settings=integrations',
    ),
  ],
  themes: [
    creative(
      'Choose a new Freebuff theme',
      'Find a look you like in Desktop appearance settings.',
      'Pick a theme',
      '/?settings=appearance',
    ),
    creative(
      'Customize your Freebuff Desktop theme',
      'Still using the default? Browse themes and pick your favorite.',
      'Browse themes',
      '/?settings=appearance',
    ),
    creative(
      'Try a custom theme in Freebuff Desktop',
      'Choose your own colors in Appearance settings.',
      'Pick a theme',
      '/?settings=appearance',
    ),
    creative(
      'Customize the colors of your Freebuff theme',
      'Pick your own background, accent, and text colors.',
      'Pick my colors',
      '/?settings=appearance',
    ),
  ],
  sites: [
    creative(
      'Deploy your Freebuff site',
      'Build a site, then publish it from Freebuff.',
      'Publish a site',
      '/?view=sites',
    ),
    creative(
      'Publish a website with Freebuff',
      'Turn your next project into a site you can share.',
      'Publish a site',
      '/?view=sites',
    ),
    creative(
      'Publish a portfolio site with Freebuff',
      'Create a home for your work, then share it on the web.',
      'Publish a site',
      '/?view=sites',
    ),
    creative(
      'Deploy and host your website with Freebuff',
      'Build a landing page, then publish it from Sites.',
      'Publish a site',
      '/?view=sites',
    ),
  ],
  templates: [
    creative(
      'Start with a Freebuff template',
      'Choose a starter project instead of starting from scratch.',
      'Browse templates',
      '/?view=templates',
    ),
    creative(
      'Browse Freebuff project templates',
      'Pick a template, then make it your own with Freebuff.',
      'Browse templates',
      '/?view=templates',
    ),
    creative(
      'Explore project ideas in Freebuff templates',
      'Browse starter projects and find something you want to build.',
      'Browse templates',
      '/?view=templates',
    ),
    creative(
      'Add your own features to a Freebuff template',
      'Choose a starter project, then ask Freebuff to adapt it to your idea.',
      'Browse templates',
      '/?view=templates',
    ),
  ],
}

export function houseProductTipForCampaign(id: string): HouseProductTip | null {
  const sourceId = houseCampaignSourceId(id)
  return (
    (Object.keys(HOUSE_PRODUCT_CAMPAIGN_IDS) as HouseProductTip[]).find(
      (tip) => HOUSE_PRODUCT_CAMPAIGN_IDS[tip] === sourceId,
    ) ?? null
  )
}
