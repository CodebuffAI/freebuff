import {
  gravitySidebarPlacementId,
  internalGravitySidebarPlacementId,
} from './gravity-sidebar'
import {
  PLACEMENT_RENAMES,
  canonicalPlacementId,
  legacyPlacementId,
  type RenamedPlacementId,
} from './placement-aliases'

/**
 * Which renamed placements Gravity knows by their NEW slug (COD-1043).
 *
 * A slug Gravity has not registered fills 0%
 * (`freebuff-desktop/src/server/services/ads.ts`), so each entry flips to
 * `true` in its own PR only after the new slug is registered in the Gravity
 * dashboard, lowest volume first. Rollback is flipping it back: the old slug
 * stays registered until shipped clients stop sending it.
 */
export const GRAVITY_SLUG_FLIPPED: Readonly<
  Record<RenamedPlacementId, boolean>
> = Object.fromEntries(PLACEMENT_RENAMES.map(({ id }) => [id, false])) as Record<
  RenamedPlacementId,
  boolean
>

/** The `placement_id` Gravity is sent for one of our ids (legacy or canonical). */
export function toGravitySlug(
  id: string,
  flipped: Readonly<Record<string, boolean>> = GRAVITY_SLUG_FLIPPED,
): string {
  const canonical = canonicalPlacementId(id)
  const legacy = legacyPlacementId(canonical)
  if (legacy === undefined) return gravitySidebarPlacementId(id)
  return flipped[canonical] ? canonical : legacy
}

/** Our canonical id for a `placement_id` Gravity returned, whichever slug it used. */
export function fromGravitySlug(slug: string): string {
  return canonicalPlacementId(internalGravitySidebarPlacementId(slug))
}
