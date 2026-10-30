import {
  BILLBOARD_SIDEBAR_PLACEMENT_ID,
  billboardDimensionsError,
  parseBillboardAssets,
} from './billboard'
import { desktopPlacementSource } from './web-desktop-placements'

/** Only these existing sidebar slots are opened to Gravity. */
export function isGravitySidebarPlacement(id: string): boolean {
  return desktopPlacementSource(id) === BILLBOARD_SIDEBAR_PLACEMENT_ID
}

export function isGravitySidebarRequest(ids: readonly string[]): boolean {
  return ids.length > 0 && ids.every(isGravitySidebarPlacement)
}

/** Gravity registration generates a hyphenated slug, unlike our :web IDs. */
export function gravitySidebarPlacementId(id: string): string {
  return id === `${BILLBOARD_SIDEBAR_PLACEMENT_ID}:web`
    ? `${BILLBOARD_SIDEBAR_PLACEMENT_ID}-web`
    : id
}

export function internalGravitySidebarPlacementId(id: string): string {
  return id === `${BILLBOARD_SIDEBAR_PLACEMENT_ID}-web`
    ? `${BILLBOARD_SIDEBAR_PLACEMENT_ID}:web`
    : id
}

/**
 * Proposed full-creative response contract for Gravity. brandImage is a
 * product image, NOT a finished ad. Neither it nor renderer_spec is inferred
 * as billboard artwork. No fetch, composition or generation occurs here.
 */
export function gravitySidebarAssets(value: unknown) {
  const asset = parseBillboardAssets(value)?.sidebar
  if (
    !asset ||
    !Number.isSafeInteger(asset.width) ||
    !Number.isSafeInteger(asset.height) ||
    billboardDimensionsError('sidebar', asset.width, asset.height)
  )
    return undefined
  try {
    const url = new URL(asset.url)
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      (url.port && url.port !== '443')
    )
      return undefined
  } catch {
    return undefined
  }
  return { sidebar: asset }
}

/** Native ACK and browser proxies only forward Gravity's own tracking hosts. */
export function gravitySidebarTrackingUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      (!url.port || url.port === '443') &&
      (url.hostname === 'trygravity.ai' ||
        url.hostname.endsWith('.trygravity.ai'))
    )
  } catch {
    return false
  }
}
