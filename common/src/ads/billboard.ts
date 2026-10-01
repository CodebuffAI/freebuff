/**
 * BILLBOARDS: Desktop's full-bleed image placements, shared by the serving
 * side (which artwork a creative must carry to fill a slot), the asset
 * upload path (what a valid file for each shape is) and Desktop (which
 * artwork to draw, and how often to ask).
 *
 * Artwork is FLATTENED per shape rather than laid out live: copy and logo are
 * baked into each image, composed for that aspect ratio, with the brand and
 * message in the upper-left safe area so a `cover` crop never loses them.
 */

export const BILLBOARD_SIDEBAR_PLACEMENT_ID = 'Desktop-Billboard-Sidebar'
export const BILLBOARD_PANEL_PLACEMENT_ID = 'Desktop-Billboard-Panel'

export const BILLBOARD_SHAPES = [
  'sidebar',
  'panel_tall',
  'panel_portrait',
  'panel_square',
  'panel_landscape',
] as const
export type BillboardShape = (typeof BILLBOARD_SHAPES)[number]

export function isBillboardShape(value: unknown): value is BillboardShape {
  return (BILLBOARD_SHAPES as readonly unknown[]).includes(value)
}

/**
 * Width:height and the minimum stored size of each shape. The minimums are
 * the 2x exports the Desktop renders at (a 320x240 CSS-pixel sidebar card),
 * so an upload is never upscaled on a high-density display.
 */
export const BILLBOARD_SHAPE_SPECS: Record<
  BillboardShape,
  { ratio: number; minWidth: number; minHeight: number; label: string }
> = {
  sidebar: { ratio: 4 / 3, minWidth: 640, minHeight: 480, label: 'Sidebar 4:3' },
  panel_tall: { ratio: 2 / 5, minWidth: 640, minHeight: 1600, label: 'Panel tall 2:5' },
  panel_portrait: { ratio: 3 / 5, minWidth: 960, minHeight: 1600, label: 'Panel portrait 3:5' },
  panel_square: { ratio: 1, minWidth: 1200, minHeight: 1200, label: 'Panel square 1:1' },
  panel_landscape: { ratio: 16 / 9, minWidth: 1920, minHeight: 1080, label: 'Panel landscape 16:9' },
}

/** Relative aspect-ratio tolerance for an upload. */
export const BILLBOARD_RATIO_TOLERANCE = 0.02

/** Desktop asks each billboard for a new ad at most this often. */
export const BILLBOARD_REFRESH_MS = 15 * 60_000
/** Visible time before a billboard's close control unlocks. */
export const BILLBOARD_DISMISS_LOCK_MS = 10_000
/** A pause in typing/clicking that may open a closed panel for its billboard. */
export const BILLBOARD_PANEL_IDLE_MS = 3_000

export type BillboardAsset = { url: string; width: number; height: number }
export type BillboardAssets = Partial<Record<BillboardShape, BillboardAsset>>

/** The shapes that can fill a placement; any one of them suffices. */
export function billboardShapesForPlacement(
  placementId: string,
): readonly BillboardShape[] {
  if (placementId === BILLBOARD_SIDEBAR_PLACEMENT_ID) return ['sidebar']
  if (placementId === BILLBOARD_PANEL_PLACEMENT_ID)
    return ['panel_tall', 'panel_portrait', 'panel_square', 'panel_landscape']
  return []
}

export function billboardAssetsFillPlacement(
  placementId: string,
  assets: BillboardAssets | undefined,
): boolean {
  if (!assets) return false
  return billboardShapesForPlacement(placementId).some((shape) =>
    isBillboardAsset(assets[shape]),
  )
}

export function isBillboardAsset(value: unknown): value is BillboardAsset {
  if (!value || typeof value !== 'object') return false
  const asset = value as Record<string, unknown>
  return (
    typeof asset.url === 'string' &&
    /^https?:\/\//.test(asset.url) &&
    typeof asset.width === 'number' &&
    asset.width > 0 &&
    typeof asset.height === 'number' &&
    asset.height > 0
  )
}

/** Keep only well-formed assets for known shapes; untrusted wire input. */
export function parseBillboardAssets(value: unknown): BillboardAssets | undefined {
  if (!value || typeof value !== 'object') return undefined
  const parsed: BillboardAssets = {}
  for (const shape of BILLBOARD_SHAPES) {
    const asset = (value as Record<string, unknown>)[shape]
    if (isBillboardAsset(asset))
      parsed[shape] = { url: asset.url, width: asset.width, height: asset.height }
  }
  return Object.keys(parsed).length > 0 ? parsed : undefined
}

/**
 * The panel artwork to draw in a box of `width / height`, chosen from what
 * the creative actually has: the shape the box's breakpoints name if present,
 * otherwise the nearest available ratio.
 */
export function chooseBillboardPanelShape(
  boxRatio: number,
  assets: BillboardAssets,
): BillboardShape | null {
  const preferred: BillboardShape =
    boxRatio < 0.5
      ? 'panel_tall'
      : boxRatio < 0.78
        ? 'panel_portrait'
        : boxRatio < 1.25
          ? 'panel_square'
          : 'panel_landscape'
  if (assets[preferred]) return preferred
  const available = billboardShapesForPlacement(BILLBOARD_PANEL_PLACEMENT_ID).filter(
    (shape) => assets[shape],
  )
  if (available.length === 0) return null
  const distance = (shape: BillboardShape) =>
    Math.abs(Math.log(BILLBOARD_SHAPE_SPECS[shape].ratio) - Math.log(Math.max(boxRatio, 0.01)))
  return available.reduce((best, shape) => (distance(shape) < distance(best) ? shape : best))
}

/** Whether stored pixel dimensions are a valid file for `shape`. */
export function billboardDimensionsError(
  shape: BillboardShape,
  width: number,
  height: number,
): string | null {
  const spec = BILLBOARD_SHAPE_SPECS[shape]
  if (width < spec.minWidth || height < spec.minHeight)
    return `${spec.label} artwork must be at least ${spec.minWidth}x${spec.minHeight}.`
  if (Math.abs(width / height - spec.ratio) / spec.ratio > BILLBOARD_RATIO_TOLERANCE)
    return `${spec.label} artwork must match its aspect ratio.`
  return null
}
