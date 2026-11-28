import { z } from 'zod/v4'

import { ARTIFACT_ID_PATTERN, ARTIFACT_KINDS, type ArtifactKind } from './artifacts'

/**
 * render_artifact: a picture of an artifact, drawn by the user's open workspace tab.
 *
 * The run inserts one `artifact_render` event (the request below). A hosted workspace tab that
 * is watching the run live renders the kind's bare read-only view offscreen, rasterises it and
 * posts the PNG to `POST runs/:runId/renders/:eventId/:revision` (raw bytes), or posts
 * `.../unavailable` with a reason. The bytes wait under the run's own object prefix only until
 * the run reads (and deletes) them or the request expires; they are never an artifact asset, so
 * they never show in the asset list or count against its quota. Nothing answers in time: the
 * tool tells the model no render is available and to use the textual checks instead.
 */

export const ARTIFACT_RENDER_TOOL_NAME = 'render_artifact'
export const ARTIFACT_RENDER_EVENT_KIND = 'artifact_render'

/** Output width bounds (CSS px of the rendered picture). */
export const ARTIFACT_RENDER_MAX_WIDTH = 1600
export const ARTIFACT_RENDER_MIN_WIDTH = 320
/** A tall picture is cut, never squeezed: at most this many pixels in all. */
export const ARTIFACT_RENDER_MAX_PIXELS = 1600 * 2000
/** One PNG's bytes at most; the client downscales until it fits. */
export const ARTIFACT_RENDER_MAX_BYTES = 1_500_000
/** How long the run waits for a tab to answer. */
export const ARTIFACT_RENDER_TIMEOUT_MS = 20_000
/** Renders one run may ask for, and their bytes in all. */
export const ARTIFACT_RENDERS_PER_RUN = 12
export const ARTIFACT_RENDER_BYTES_PER_RUN = 10_000_000

const id = z.string().min(1).max(128)

/**
 * What to draw. Every key is optional and the kind decides which apply; nothing (or
 * `overview`) draws the kind's default view. Plain optional keys, never a union, so every model
 * provider accepts the schema.
 */
export const artifactRenderTargetSchema = z
  .object({
    /** Slides: a contact sheet of the deck. Design: every board of the first page. Whiteboard, data, doc: the whole artifact. */
    overview: z.boolean().optional(),
    /** Slides: one slide at its design size. */
    slideId: id.optional(),
    /** Slides: crop the rendered slide to the selected elements and/or layout image. */
    composition: z.literal(true).optional(),
    region: z.literal('image').optional(),
    /** Design: one board. */
    boardId: id.optional(),
    /** Data: one block (kpi, chart, table). Doc: start at this block (its outline id). */
    blockId: id.optional(),
    /** Sheet: the tab (its id or name); doc: the tab. */
    tabId: id.optional(),
    /** Sheet: an A1 range such as A1:F20 (capped to 60 rows × 20 columns). */
    range: z.string().regex(/^\$?[A-Za-z]{1,3}\$?[1-9]\d{0,6}(?::\$?[A-Za-z]{1,3}\$?[1-9]\d{0,6})?$/).optional(),
    /** Whiteboard: crop to these elements. Design: crop the board to these nodes. */
    elementIds: z.array(id).min(1).max(50).optional(),
  })
  .strict()
export type ArtifactRenderTarget = z.infer<typeof artifactRenderTargetSchema>

/** The `artifact_render` event's payload: what a tab needs to draw it, and no content. */
export const artifactRenderRequestSchema = z.object({
  artifactId: z.string().regex(ARTIFACT_ID_PATTERN),
  kind: z.enum(ARTIFACT_KINDS),
  /** The revision the run read; the tab renders what it loads and reports that revision. */
  revision: z.number().int().positive(),
  target: artifactRenderTargetSchema,
  width: z.number().int().min(ARTIFACT_RENDER_MIN_WIDTH).max(ARTIFACT_RENDER_MAX_WIDTH),
  /** The run's user: a tab signed in as anyone else ignores the request. */
  userId: z.string().min(1).max(128),
  /** Epoch ms. A tab never starts a request past it (a replayed transcript). */
  expiresAt: z.number().int().positive(),
})
export type ArtifactRenderRequest = z.infer<typeof artifactRenderRequestSchema>

/** Why a tab did not draw it. The model hears the reason and falls back to the textual checks. */
export const ARTIFACT_RENDER_UNAVAILABLE = [
  'not_readable',
  'unsupported_target',
  'render_failed',
  'too_large',
] as const
export type ArtifactRenderUnavailable = (typeof ARTIFACT_RENDER_UNAVAILABLE)[number]
export const artifactRenderUnavailableSchema = z.object({
  reason: z.enum(ARTIFACT_RENDER_UNAVAILABLE),
  /** One line for the model (e.g. "no slide with id intro"). */
  detail: z.string().max(300).optional(),
})

/** What a picture may be missing, told to the model with it. */
export type RenderMeta = { missingImages: number; fontsMissing: boolean; hidden: boolean; cut: boolean }

/** `m<missing images>f<fonts missing>h<tab hidden>c<cut>`: the answer path's last segment. */
export function renderMetaSegment(meta: RenderMeta): string {
  return `m${Math.min(999, Math.max(0, Math.round(meta.missingImages)))}f${meta.fontsMissing ? 1 : 0}h${meta.hidden ? 1 : 0}c${meta.cut ? 1 : 0}`
}
export const RENDER_META_SEGMENT = /^m(\d{1,3})f([01])h([01])c([01])$/
export function parseRenderMeta(segment: string): RenderMeta | null {
  const match = RENDER_META_SEGMENT.exec(segment)
  return match ? { missingImages: Number(match[1]), fontsMissing: match[2] === '1', hidden: match[3] === '1', cut: match[4] === '1' } : null
}

/** What the row keeps once answered: a pointer, never the bytes. */
export type ArtifactRenderAnswer =
  | { image: { key: string; width: number; height: number; bytes: number; revision: number; meta: RenderMeta } }
  | { unavailable: z.infer<typeof artifactRenderUnavailableSchema> }
  | { expired: true }

export const isRenderKind = (kind: string): kind is ArtifactKind => (ARTIFACT_KINDS as readonly string[]).includes(kind)

/**
 * The output size for content `w`×`h` drawn at `width`: the width capped to the bounds, the
 * height following the aspect, and the picture cut (never squeezed) to the pixel budget.
 * `scale` maps content px to output px; `cropHeight` is the content height that fits.
 */
export function fitRenderSize(
  contentWidth: number,
  contentHeight: number,
  width: number = contentWidth,
): { width: number; height: number; scale: number; cropHeight: number; cut: boolean } {
  const w = Math.max(1, contentWidth)
  const h = Math.max(1, contentHeight)
  const outWidth = Math.round(Math.min(ARTIFACT_RENDER_MAX_WIDTH, Math.max(ARTIFACT_RENDER_MIN_WIDTH, width)))
  const scale = outWidth / w
  const maxHeight = Math.max(1, Math.floor(ARTIFACT_RENDER_MAX_PIXELS / outWidth))
  const fullHeight = Math.max(1, Math.round(h * scale))
  const height = Math.min(fullHeight, maxHeight)
  return { width: outWidth, height, scale, cropHeight: Math.min(h, height / scale), cut: fullHeight > maxHeight }
}

/**
 * The next scale to try when an encoded picture came out `bytes` long against `limit`: area,
 * and so roughly bytes, goes with the square of the scale, with a margin so one retry usually
 * fits. Null once it fits, or when another try would drop under the minimum width.
 */
export function shrinkForBytes(bytes: number, limit: number, width: number): number | null {
  if (bytes <= limit) return null
  const factor = Math.sqrt(limit / bytes) * 0.9
  const next = Math.floor(width * Math.min(factor, 0.9))
  return next >= ARTIFACT_RENDER_MIN_WIDTH / 2 ? next / width : null
}

/**
 * A PNG's size from its IHDR chunk, or null when the bytes are not a PNG. The server checks
 * this itself rather than trusting what a client says it drew.
 */
export function pngDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (bytes.length < 33 || signature.some((value, index) => bytes[index] !== value)) return null
  // Length (13), then "IHDR".
  if (bytes[12] !== 0x49 || bytes[13] !== 0x48 || bytes[14] !== 0x44 || bytes[15] !== 0x52) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const width = view.getUint32(16)
  const height = view.getUint32(20)
  return width > 0 && height > 0 ? { width, height } : null
}
