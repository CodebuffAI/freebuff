/**
 * Analytics for the MOCK display-ad placements: one vocabulary for Desktop,
 * the Cloud/web workspace and the CLI.
 *
 * NOT BILLING. These units draw hardcoded sponsors (`sponsors.ts`); no ad was
 * served, so there is no `impUrl`, no `ad_impression` row, no view ack and no
 * ledger entry, and nothing here may call `/api/ad/impression`,
 * `/api/v1/ads/{impression,click}` or emit `ads.impression_recorded`,
 * `desktop.ad_shown` or `desktop.ad_clicked` (whose counts are served-ad
 * truth). Events go only through each surface's ordinary analytics client
 * (PostHog, mirrored to Axiom). Every row carries `mock_creative: true` and
 * `billable: false` so a later real-serving readout can exclude them.
 *
 * Events (the funnel stage) and `action` (the control that caused it):
 * - `display_ads.impression`: the unit met the viewability rule once for this
 *   mount. Desktop/web: MRC50 (50% of pixels for 1s continuously, foreground,
 *   `common/util/mrc50-viewability.ts`), `viewability: 'mrc50'`. CLI: on
 *   insertion (a terminal has no viewport), `viewability: 'insertion'`, as the
 *   CLI's served ads do.
 * - `display_ads.click`: a link to the sponsor (`cta`, `link`, `row`,
 *   `header`, `offer_cta`, `deals_use`).
 * - `display_ads.dismiss` / `display_ads.restore`: hide / show again
 *   (`hide_button`, `show_button`, `deals_off`, `deals_on`), with `scope`.
 * - `display_ads.action`: a placement-specific action that is not a click-out
 *   (`mcp_add_server`).
 *
 * Callers fire only while the placement's flag is on; `buildDisplayAdEvent`
 * is total and drops anything outside the allowlist, so the Desktop server
 * route can rebuild a renderer's payload with it rather than trust it.
 */
import { AnalyticsEvent } from '../../constants/analytics-events'
import {
  DISPLAY_AD_PLACEMENT_IDS,
  type DisplayAdPlacement,
  type DisplayAdSlot,
  type DisplayAdSurface,
} from './placements'
import { DISPLAY_AD_SPONSORS, type SponsorId } from './sponsors'

export const DISPLAY_AD_EVENTS = {
  impression: AnalyticsEvent.DISPLAY_AD_IMPRESSION,
  click: AnalyticsEvent.DISPLAY_AD_CLICK,
  dismiss: AnalyticsEvent.DISPLAY_AD_DISMISS,
  restore: AnalyticsEvent.DISPLAY_AD_RESTORE,
  action: AnalyticsEvent.DISPLAY_AD_ACTION,
} as const

export type DisplayAdEventKind = keyof typeof DISPLAY_AD_EVENTS
export type DisplayAdAnalyticsEvent = (typeof DISPLAY_AD_EVENTS)[DisplayAdEventKind]

/** Which controls may report which event. */
export const DISPLAY_AD_ACTIONS = {
  impression: ['view'],
  click: ['cta', 'link', 'row', 'header', 'offer_cta', 'deals_use'],
  dismiss: ['hide_button', 'deals_off'],
  restore: ['show_button', 'deals_on'],
  action: ['mcp_add_server'],
} as const satisfies Record<DisplayAdEventKind, readonly string[]>

export type DisplayAdAction<K extends DisplayAdEventKind = DisplayAdEventKind> =
  (typeof DISPLAY_AD_ACTIONS)[K][number]

export type DisplayAdViewability = 'mrc50' | 'insertion'
export type DisplayAdDismissScope = 'session' | 'day'

export interface DisplayAdEventInput<K extends DisplayAdEventKind = DisplayAdEventKind> {
  kind: K
  slot: DisplayAdSlot
  surface: DisplayAdSurface
  sponsorId: SponsorId
  action: DisplayAdAction<K>
  /** 1-based position in a multi-sponsor unit (MCP row, /deals list). */
  position?: number
  viewability?: DisplayAdViewability
  scope?: DisplayAdDismissScope
}

export type DisplayAdEventProperties = {
  placement_id: string
  slot: DisplayAdSlot
  surface: DisplayAdSurface
  sponsor_id: SponsorId
  action: string
  mock_creative: true
  billable: false
  position?: number
  viewability?: DisplayAdViewability
  scope?: DisplayAdDismissScope
}

export interface DisplayAdEvent {
  event: DisplayAdAnalyticsEvent
  properties: DisplayAdEventProperties
}

/** The flag a slot draws under (`/deals` rides on `cliStatusline`). */
export function displayAdFlagFor(slot: DisplayAdSlot): DisplayAdPlacement {
  return slot === 'deals' ? 'cliStatusline' : slot
}

const has = <T extends object>(o: T, k: PropertyKey): k is keyof T =>
  Object.prototype.hasOwnProperty.call(o, k)

/** The event for one interaction, or null when any field is outside the allowlist. */
export function buildDisplayAdEvent(input: unknown): DisplayAdEvent | null {
  if (!input || typeof input !== 'object') return null
  const v = input as Record<string, unknown>
  const { kind, slot, surface, sponsorId, action } = v
  if (typeof kind !== 'string' || !has(DISPLAY_AD_EVENTS, kind)) return null
  if (typeof slot !== 'string' || !has(DISPLAY_AD_PLACEMENT_IDS, slot)) return null
  const ids = DISPLAY_AD_PLACEMENT_IDS[slot] as Partial<Record<DisplayAdSurface, string>>
  if (typeof surface !== 'string' || !has(ids, surface)) return null
  const placementId = ids[surface]
  if (!placementId) return null
  if (typeof sponsorId !== 'string' || !has(DISPLAY_AD_SPONSORS, sponsorId)) return null
  if (
    typeof action !== 'string' ||
    !(DISPLAY_AD_ACTIONS[kind] as readonly string[]).includes(action)
  )
    return null

  const properties: DisplayAdEventProperties = {
    placement_id: placementId,
    slot,
    surface,
    sponsor_id: sponsorId,
    action,
    mock_creative: true,
    billable: false,
  }
  if (typeof v.position === 'number' && Number.isInteger(v.position) && v.position >= 1 && v.position <= 10)
    properties.position = v.position
  if (kind === 'impression' && (v.viewability === 'mrc50' || v.viewability === 'insertion'))
    properties.viewability = v.viewability
  if ((kind === 'dismiss' || kind === 'restore') && (v.scope === 'session' || v.scope === 'day'))
    properties.scope = v.scope
  return { event: DISPLAY_AD_EVENTS[kind], properties }
}

/**
 * Rebuild an event that crossed a process boundary (Desktop renderer → its
 * local server) through the allowlist, so the receiver never trusts the
 * sender's properties. Null for anything `buildDisplayAdEvent` would refuse.
 */
export function parseDisplayAdEvent(value: unknown): DisplayAdEvent | null {
  if (!value || typeof value !== 'object') return null
  const { event, properties } = value as { event?: unknown; properties?: unknown }
  const kind = (Object.keys(DISPLAY_AD_EVENTS) as DisplayAdEventKind[]).find(
    (k) => DISPLAY_AD_EVENTS[k] === event,
  )
  if (!kind || !properties || typeof properties !== 'object') return null
  const p = properties as Record<string, unknown>
  return buildDisplayAdEvent({
    kind,
    slot: p.slot,
    surface: p.surface,
    sponsorId: p.sponsor_id,
    action: p.action,
    position: p.position,
    viewability: p.viewability,
    scope: p.scope,
  })
}
