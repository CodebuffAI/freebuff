import { FREEBUFF_SUBSCRIPTION_TIERS } from './freebuff-subscriptions'
import { FREEBUFF_WEB_URL_PROD } from './hosts'

/**
 * Approved subscription house copy. Live campaigns store their own creative
 * rows; changing this catalog alone does not change serving. Use the reviewed
 * rollout in scripts/rollout-house-usage-copy.ts to refresh existing rows.
 *
 * The uncapped floor is retired. Compatibility exports remain for historical
 * consumers, while live subscription campaigns require the limited-country
 * audience and exclude entitled subscribers. Prices follow the plan catalog;
 * numeric session allowances do not describe the current usage-balance meter.
 *
 * This file is published. Keep private, server-owned configuration out of it.
 */
export type HouseAdSurface =
  | 'waiting_room'
  | 'freebuff_web_chat'
  | 'chat_assistant'
  | 'chat_assistant_sr'
  | 'cli_chat'

export const HOUSE_AD_DESTINATION_URL = `${FREEBUFF_WEB_URL_PROD}/plans`
export const HOUSE_AD_FAVICON_URL = `${FREEBUFF_WEB_URL_PROD}/favicon/favicon-32x32.ico`

const ENTRY_TIER = FREEBUFF_SUBSCRIPTION_TIERS[0]!
const PRICE = `$${ENTRY_TIER.priceUsd}/month`

export interface HouseAdCreative {
  title: string
  adText: string
  cta: string
  url: string
  favicon: string
  /** Only surfaces that render a card use this; inline text ads ignore it. */
  imageUrl?: string
}

/**
 * Legacy CLI preview budgets, retained for the older Sol launch seed. These
 * are not campaign field limits. Current copy uses meaningful headlines and
 * accepts the renderer's ellipsis in narrow panes (120/500/80 field limits).
 */
export const HOUSE_AD_TITLE_BUDGET = 12
export const HOUSE_AD_TEXT_BUDGET = 28

const creative = (title: string, adText: string): HouseAdCreative => ({
  title,
  adText,
  cta: 'See plans',
  url: HOUSE_AD_DESTINATION_URL,
  favicon: HOUSE_AD_FAVICON_URL,
})

const SUBSCRIPTION_VARIATIONS = Object.freeze([
  creative(
    'Get more daily usage with a Freebuff plan',
    `From ${PRICE}. More daily usage, plus a monthly bonus.`,
  ),
  creative(
    `Upgrade to Freebuff ${ENTRY_TIER.displayName} for ${PRICE}`,
    'More usage each day, plus a monthly bonus.',
  ),
  creative(
    'One Freebuff plan across your devices',
    `More usage on Web, Desktop, and CLI. From ${PRICE}.`,
  ),
])

/** Keep the named-model offer in its existing country-targeted campaign. */
export const HOUSE_SOL_AD_VARIATIONS: readonly HouseAdCreative[] =
  Object.freeze([
    creative(
      'Get access to GPT-6.1 Sol with a Freebuff plan',
      `Unlock Sol from ${PRICE}. Usage limits apply.`,
    ),
  ])

export const HOUSE_AD_VARIATIONS: Readonly<
  Record<HouseAdSurface, readonly HouseAdCreative[]>
> = Object.freeze({
  cli_chat: SUBSCRIPTION_VARIATIONS,
  waiting_room: SUBSCRIPTION_VARIATIONS,
  freebuff_web_chat: SUBSCRIPTION_VARIATIONS,
  chat_assistant: SUBSCRIPTION_VARIATIONS,
  chat_assistant_sr: SUBSCRIPTION_VARIATIONS,
})

/** Compatibility catalog only; the former uncapped floor cannot serve it. */
export const HOUSE_AD_CREATIVES: Readonly<
  Record<HouseAdSurface, HouseAdCreative>
> = Object.freeze({
  cli_chat: HOUSE_AD_VARIATIONS.cli_chat[0]!,
  waiting_room: HOUSE_AD_VARIATIONS.waiting_room[0]!,
  freebuff_web_chat: HOUSE_AD_VARIATIONS.freebuff_web_chat[0]!,
  chat_assistant: HOUSE_AD_VARIATIONS.chat_assistant[0]!,
  chat_assistant_sr: HOUSE_AD_VARIATIONS.chat_assistant_sr[0]!,
})

/**
 * The break placement the house campaign fills. Spotlight was dropped when it
 * was removed (2026-11-12); a stored Spotlight target on the house campaign
 * row is answered `placement_retired` and ignored by the refresh scripts.
 */
export const HOUSE_BREAK_AD_PLACEMENT_IDS = ['Desktop-Showcase'] as const

export type HouseBreakAdPlacementId =
  (typeof HOUSE_BREAK_AD_PLACEMENT_IDS)[number]

/**
 * Break cards have real 28/60/18 limits. Shorten the approved headlines for
 * these cards and keep their descriptions. The rollout preserves the existing
 * uploaded hero images.
 */
const BREAK_VARIATIONS = Object.freeze([
  creative('More daily Freebuff usage', SUBSCRIPTION_VARIATIONS[0]!.adText),
  creative(
    `Freebuff ${ENTRY_TIER.displayName}: ${PRICE}`,
    SUBSCRIPTION_VARIATIONS[1]!.adText,
  ),
  creative('One plan across your devices', SUBSCRIPTION_VARIATIONS[2]!.adText),
])

export const HOUSE_BREAK_AD_VARIATIONS: Readonly<
  Record<HouseBreakAdPlacementId, readonly HouseAdCreative[]>
> = Object.freeze({
  'Desktop-Showcase': BREAK_VARIATIONS,
})

/** Legacy display-card consumers use the same approved subscription copy. */
export const HOUSE_AD_DISPLAY_VARIATIONS: readonly HouseAdCreative[] =
  Object.freeze(
    SUBSCRIPTION_VARIATIONS.map((item) => ({
      ...item,
      imageUrl: `${FREEBUFF_WEB_URL_PROD}/opengraph-image.png`,
    })),
  )

export const HOUSE_AD_DISPLAY_CREATIVE: HouseAdCreative =
  HOUSE_AD_DISPLAY_VARIATIONS[0]!
