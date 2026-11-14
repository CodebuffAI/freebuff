import { canonicalPlacementId } from './placement-aliases'

/**
 * Placement ids no client is served any more, but that an older client may
 * still ask for.
 *
 * The Spotlight and Intermission sponsor breaks were removed on 2026-11-12
 * (their experiment arms had been at 0% since the cadence holdout launched).
 * Published Desktop builds and stale browser tabs can still name them, so both
 * ad rails take these ids out of a request BEFORE any cap, book or network is
 * asked and answer what is left -- an empty `200` no-fill with
 * `no_fill_reason: placement_retired` when nothing is -- never a 4xx/5xx.
 * Without this a native `Desktop-Spotlight` request would resolve as an
 * unknown `inline` slot and could be filled with a text ad.
 *
 * The ids are no longer registered anywhere else (`PLACEMENT_SLOTS`, the Web
 * copy table), so historical rows that carry them are plain strings: nothing
 * looks them up on a serve path.
 *
 * `Desktop-Spotlight:web` had already been retired on its own on 11-12
 * (Gravity never filled it).
 */
export const RETIRED_AD_PLACEMENT_IDS: ReadonlySet<string> = new Set([
  'Desktop-Spotlight',
  'Desktop-Spotlight:web',
  'Desktop-Intermission',
  'Desktop-Intermission:web',
])

export function isRetiredAdPlacement(id: string | null | undefined): boolean {
  if (typeof id !== 'string' || id === '') return false
  return RETIRED_AD_PLACEMENT_IDS.has(canonicalPlacementId(id))
}
