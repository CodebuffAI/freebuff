/**
 * THE ONE SERVING GATE for the display-ad placements.
 *
 * The placement ids in `DISPLAY_AD_PLACEMENT_IDS` are registered inventory
 * (`PLACEMENT_SLOTS`, format `branded`; the Desktop three are mirrored to
 * `:web` through `WEB_DESKTOP_SOURCE_PLACEMENTS`), so the billed impression
 * and click endpoints, the delivery rows and the reporting grain all know
 * them. What keeps them DARK is this set, and nothing else:
 *
 * - The serve path withholds an id not in it before any provider is asked
 *   (both rails: `withholdDarkDisplayPlacements`), so no campaign can be
 *   delivered to it, and the request reports `no_fill_reason: display_dark`.
 * - `GET /api/v1/ads/policy` and `GET /api/ads/policy` announce only live ids
 *   (`displayPlacementIds`), so a client knows not to ask.
 * - Campaign targeting refuses an id not in it (`isTargetablePlacement`), for
 *   advertisers and operators alike, and the self-serve picker never offers
 *   it (`available` on its slot is derived from this set).
 *
 * TO GO LIVE for one placement, add its exact id here, for example
 * `'Desktop-Top-Banner'`. Each surface is its own id: the `:web` mirror is
 * NOT implied by its Desktop source, so add `'Desktop-Top-Banner:web'` too
 * when the Cloud/web workspace should serve it. A deploy of `web` (CLI and
 * Desktop rail) and `freebuff-web` (browser rail) is what turns it on. No env
 * var, by design: going live is a reviewed code change.
 */
import { DISPLAY_AD_PLACEMENT_IDS } from './placements'

import type { DisplayAdPlacementId } from './placements'

/** Live display-ad placement ids. EMPTY: nothing is served yet. */
export const DISPLAY_AD_SERVING_LIVE: ReadonlySet<DisplayAdPlacementId> =
  new Set<DisplayAdPlacementId>([])

/** Every display-ad placement id, on every surface, in slot order. */
export const DISPLAY_AD_SERVED_PLACEMENT_IDS: readonly DisplayAdPlacementId[] =
  Object.values(DISPLAY_AD_PLACEMENT_IDS).flatMap(
    (ids) => Object.values(ids) as DisplayAdPlacementId[],
  )

const DISPLAY_IDS: ReadonlySet<string> = new Set(DISPLAY_AD_SERVED_PLACEMENT_IDS)

export function isDisplayAdPlacementId(id: string): id is DisplayAdPlacementId {
  return DISPLAY_IDS.has(id)
}

/**
 * Whether a display-ad placement may serve. `live` is a test seam; production
 * callers always use the checked-in set.
 */
export function isDisplayAdServingLive(
  id: string,
  live: ReadonlySet<string> = DISPLAY_AD_SERVING_LIVE,
): boolean {
  return isDisplayAdPlacementId(id) && live.has(id)
}

/** A display-ad placement that is registered but not yet live. */
export function isDarkDisplayAdPlacement(
  id: string,
  live: ReadonlySet<string> = DISPLAY_AD_SERVING_LIVE,
): boolean {
  return isDisplayAdPlacementId(id) && !live.has(id)
}

/**
 * Split a resolved placement list into what may be served and the dark
 * display-ad ids withheld from it. Order is preserved.
 */
export function withholdDarkDisplayPlacements(
  placementIds: readonly string[],
  live: ReadonlySet<string> = DISPLAY_AD_SERVING_LIVE,
): { placementIds: string[]; withheld: string[] } {
  const withheld = placementIds.filter((id) =>
    isDarkDisplayAdPlacement(id, live),
  )
  return {
    placementIds: withheld.length
      ? placementIds.filter((id) => !withheld.includes(id))
      : [...placementIds],
    withheld,
  }
}

/**
 * The live display-ad ids a policy response announces for one surface: the
 * Desktop and CLI ids on `/api/v1/ads/policy`, the `:web` ids on the browser
 * policy.
 */
export function liveDisplayPlacementIds(
  surface: 'app' | 'web',
  live: ReadonlySet<string> = DISPLAY_AD_SERVING_LIVE,
): DisplayAdPlacementId[] {
  return DISPLAY_AD_SERVED_PLACEMENT_IDS.filter(
    (id) => live.has(id) && id.endsWith(':web') === (surface === 'web'),
  )
}
