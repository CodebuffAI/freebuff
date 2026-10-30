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

/** External Gravity names are independent of our stable client/reporting IDs. */
export function gravitySidebarPlacementId(id: string): string {
  if (id === BILLBOARD_SIDEBAR_PLACEMENT_ID) return 'billboard-sidebar-desktop'
  if (id === `${BILLBOARD_SIDEBAR_PLACEMENT_ID}:web`)
    return 'billboard-sidebar-web'
  return id
}

/** Accept historical response labels while requests migrate to the new names. */
export function internalGravitySidebarPlacementId(id: string): string {
  if (id === 'billboard-sidebar-desktop') return BILLBOARD_SIDEBAR_PLACEMENT_ID
  if (
    id === 'billboard-sidebar-web' ||
    id === `${BILLBOARD_SIDEBAR_PLACEMENT_ID}-web`
  )
    return `${BILLBOARD_SIDEBAR_PLACEMENT_ID}:web`
  return id
}

/**
 * Legacy complete-image support for clients without sidebarNative. Normal
 * Gravity product images and renderer specs are rendered separately by newer
 * clients, never inferred as flattened billboard artwork.
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
