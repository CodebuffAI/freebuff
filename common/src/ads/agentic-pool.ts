/**
 * The AGENTIC POOL's wire contract, shared by Freebuff Desktop and the
 * `/api/ads` route (`freebuff/web/src/server/ads/agentic-pool.ts`).
 *
 * Agentic cards -- a paid generic proposal (lane A) or a non-billable setup
 * invitation (lane B) -- used to be served IN the `Desktop-Inline-Chat`
 * display slot, so every one of them replaced a display ad, and a paid offer
 * only became a proposal if it also won first-party display selection. The
 * pool serves them on a placement of their own, beside the display ad: the
 * display response is what it would have been had agentic not existed.
 */

/**
 * The placement a pool-served agentic impression is recorded under
 * (`ad_impression.placement_id` / `ad_placement_delivery.placement_id`).
 *
 * NOT a sellable slot and deliberately absent from `PLACEMENT_SLOTS`: no
 * advertiser buys it and no display campaign can target it. A campaign
 * reaches it by being a reviewed agentic campaign that targets
 * `Desktop-Inline-Chat` and that the generic selector matched on the request.
 */
export const AGENTIC_POOL_PLACEMENT_ID = 'Desktop-Agentic'

/**
 * `agenticPoolVersion` on an `/api/ads` request: this client renders an
 * agentic card as its own element and takes BOTH `ads` and `invitation` from
 * one response. A released client never sends it, and the server keeps
 * today's behaviour for it whatever `FREEBUFF_AGENTIC_POOL` says.
 */
export const AGENTIC_POOL_CLIENT_VERSION = 1
