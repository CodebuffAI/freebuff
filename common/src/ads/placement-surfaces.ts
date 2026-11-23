import { PLACEMENT_SLOTS } from '../constants/freebuff-placements'
import { canonicalPlacementId } from './placement-aliases'
import { isMobileAdPlacement } from './mobile-placements'
import { isWebDesktopPlacement } from './web-desktop-placements'

export const PLACEMENT_SURFACE_OPTIONS = [
  'cli',
  'desktop',
  'mobile',
  'web_desktop',
  'web_mobile',
] as const
// Existing API payloads and saved campaigns use `web` for both browser types.
export const PLACEMENT_SURFACES = [...PLACEMENT_SURFACE_OPTIONS, 'web'] as const
export type PlacementSurface = (typeof PLACEMENT_SURFACES)[number]

/** Slot inventory. A hosted Desktop app can request a Web slot. */
export function placementSurface(
  rawId: string,
): 'mobile' | 'web' | 'desktop' | 'cli' | null {
  const id = canonicalPlacementId(rawId)
  if (!PLACEMENT_SLOTS.some((slot) => slot.id === id)) return null
  if (isMobileAdPlacement(id)) return 'mobile'
  if (isWebDesktopPlacement(id)) return 'web'
  if (id.startsWith('Desktop-') || id.endsWith('-Desktop')) return 'desktop'
  if (id.startsWith('CLI-') || id.endsWith('-CLI')) return 'cli'
  return 'web'
}

const MOBILE_UA =
  /Android|iPhone|iPad|iPod|Mobile|Windows Phone|okhttp\/|CFNetwork\//i

/** Also recognizes iPadOS desktop-mode Safari without treating touch laptops as phones. */
export function browserAdMobileDevice(navigator: {
  userAgent: string
  maxTouchPoints: number
}): boolean {
  return (
    MOBILE_UA.test(navigator.userAgent) ||
    (/Macintosh/i.test(navigator.userAgent) && navigator.maxTouchPoints > 1)
  )
}

export type AdTargetingClient = 'native' | 'browser' | 'hosted_desktop'

/** Request classification for campaign eligibility. No analytics context is read. */
export function adTargetingSurface(
  placementId: string,
  client: AdTargetingClient,
  userAgent?: string | null,
  mobileDevice?: boolean,
): PlacementSurface | null {
  const id = canonicalPlacementId(placementId)
  const slot = placementSurface(id)
  if (slot === 'mobile') return 'mobile'
  if (slot === 'cli' || slot === 'desktop') {
    if (client !== 'native') return null
    // An old placement name cannot make a CLI caller eligible for Desktop ads.
    if (slot === 'desktop' && !/^Freebuff-Desktop\//i.test(userAgent ?? ''))
      return null
    if (slot === 'cli' && /^Freebuff-Desktop\//i.test(userAgent ?? ''))
      return null
    return slot
  }
  if (slot !== 'web') return null
  if (mobileDevice || MOBILE_UA.test(userAgent ?? '')) {
    return 'web_mobile'
  }
  if (client === 'hosted_desktop' && isWebDesktopPlacement(id)) return 'desktop'
  if (/Macintosh|Mac OS X|Windows NT|X11|Linux|CrOS/i.test(userAgent ?? '')) {
    return 'web_desktop'
  }
  return id === 'Above-Input-Mobile' ? 'web_mobile' : 'web'
}

/** Null preserves unrestricted delivery; legacy Web targets either browser. */
export function placementSurfaceAllowed(
  surfaces: readonly string[] | null | undefined,
  surface: PlacementSurface | null,
): boolean {
  return (
    surfaces == null ||
    (surface !== null &&
      (surfaces.includes(surface) ||
        ((surface === 'web_desktop' || surface === 'web_mobile') &&
          surfaces.includes('web'))))
  )
}

/** A slot can be eligible in several clients. Used by validation and previews. */
export function placementSupportsSurfaces(
  surfaces: readonly string[] | null | undefined,
  placementId: string,
): boolean {
  if (surfaces == null) return true
  const slot = placementSurface(placementId)
  if (slot !== 'web') return placementSurfaceAllowed(surfaces, slot)
  return (
    placementSurfaceAllowed(surfaces, 'web_desktop') ||
    placementSurfaceAllowed(surfaces, 'web_mobile') ||
    (isWebDesktopPlacement(placementId) && surfaces.includes('desktop'))
  )
}
