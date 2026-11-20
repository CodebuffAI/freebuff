import { PLACEMENT_SLOTS } from '../constants/freebuff-placements'
import { canonicalPlacementId } from './placement-aliases'
import { isMobileAdPlacement } from './mobile-placements'
import { isWebDesktopPlacement } from './web-desktop-placements'

export const PLACEMENT_SURFACES = ['mobile', 'web', 'desktop', 'cli'] as const
export type PlacementSurface = (typeof PLACEMENT_SURFACES)[number]

/** Product inventory, not user-agent device detection. Mobile means native apps. */
export function placementSurface(rawId: string): PlacementSurface | null {
  const id = canonicalPlacementId(rawId)
  const slot = PLACEMENT_SLOTS.find((slot) => slot.id === id)
  if (!slot) return null
  if (isMobileAdPlacement(id)) return 'mobile'
  if (isWebDesktopPlacement(id)) return 'web'
  if (id.startsWith('Desktop-') || id.endsWith('-Desktop')) return 'desktop'
  if (id.startsWith('CLI-') || id.endsWith('-CLI')) return 'cli'
  return 'web'
}

/** Null/omitted keeps legacy coverage; a restriction fails closed for unknown inventory. */
export function placementSurfaceAllowed(
  surfaces: readonly string[] | null | undefined,
  placementId: string,
): boolean {
  if (surfaces == null) return true
  const surface = placementSurface(placementId)
  return surface !== null && surfaces.includes(surface)
}
