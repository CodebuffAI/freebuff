/**
 * Freebuff Whiteboards: the content model.
 *
 * ── For an agent writing a board ───────────────────────────────────────────────────────────
 *
 * A board is ONE JSON object, `{ version: 1, title, elements: [...] }`, at most 1 MB and 800
 * elements. It is declarative: there is no HTML, script, style or markup anywhere in it, and every
 * object is strict (an unknown key is an error). `elements` is back-to-front: later entries are
 * drawn on top. Keep every `id` you were given when you edit; mint new ids for new elements
 * (short, unique, `[A-Za-z0-9_-]`, e.g. `note-launch-1`).
 *
 * Coordinates are world units (1 unit = 1 CSS pixel at 100% zoom), x to the right and y down.
 * `x, y` is an element's top-left corner. The canvas is infinite; start near (0, 0).
 *
 * Elements, by `type`:
 *   note     A sticky note. { id, x, y, w, h, text, color }. Usually 200×200 (a short phrase), or
 *            240×160 for a sentence. Text wraps inside; keep it under ~25 words.
 *   shape    A labelled block. { id, kind, x, y, w, h, text?, color }. kind is one of SHAPE_KINDS:
 *            rect, rounded, pill, ellipse, diamond, hexagon, parallelogram, cylinder (a database),
 *            document, subroutine, queue, triangle, cloud, person (its label sits under the figure).
 *            Sizes in SHAPE_DEFAULT_SIZE (usually 160×80). Text is centred.
 *   text     Free text with no box. { id, x, y, text, size, w? }. size: xs 12px, s 14px, m 18px,
 *            l 28px, xl 44px (line height 1.3×). Without `w` a line never wraps; with `w` it wraps
 *            at that width. A board title is usually `xl` at the top-left of the content.
 *   section  A titled frame that groups what sits inside it. { id, x, y, w, h, title, color? }.
 *            An element belongs to a section when its centre is inside the section's box; moving
 *            the section moves its members. Put sections BEFORE their members in `elements` so
 *            they draw underneath. Leave 40 units of padding inside the edge and 48 at the top for
 *            the title.
 *   arrow    A connector. { id, from, to, label?, style, head?, color? }. Each end is either
 *            `{ elementId, side? }` (bound: it follows that element when it moves) or `{ x, y }`
 *            (a free point). side is top, right, bottom or left; leave it out and the nearest side
 *            is chosen. An arrow cannot bind to another arrow, a stroke or itself. style: solid or
 *            dashed. head: end (default), start, both or none. Labels are short (1–4 words).
 *   stroke   A marker sketch. { id, points: [[x, y], ...], color, width }. Points are absolute,
 *            already simplified (≤ 2000 points, 1 decimal place). width 1–48, usually 4.
 *   image    { id, x, y, w, h, src, alt, crop? }. src is an uploaded `/_asset/<id>`: for a web
 *            picture, call `import_artifact_image` first and use its ref. Never hotlink: an
 *            `https://` src still validates (stored boards) but views draw it as a placeholder.
 *            Never `data:` or `javascript:`. `crop` is the part shown, in fractions 0–1.
 *   sticker  { id, x, y, w, h, sticker, attachedTo? }. A built-in sticker (STICKERS), usually
 *            56×56; put several on a note to vote. `attachedTo` makes it move with that element.
 *   table    { id, x, y, w, h, rows: [[cell, ...], ...], header?, color? }. Every row has the
 *            same number of cells (≤ 12 columns, ≤ 30 rows, ≤ 500 chars a cell). Columns and rows
 *            are equal unless `colWidths` / `rowHeights` weight them. Usually 140 per column and
 *            40 per row.
 *   link     { id, x, y, w, h, url, title, color?, artifact? }. A card for a web page (`https://`
 *            only), usually 280×96. Only the title and host are shown: nothing is fetched. With
 *            `artifact` it stands for another Freebuff artifact (its url is `artifactCardUrl`).
 *
 * Optional on every element: `groups` (group ids, innermost first: a click selects the outermost
 * group), `locked: true` (the editor will not move, resize, edit or delete it) and, round 5,
 * `hidden: true` (not drawn, exported or shown to readers; arrows bound to it hide too). Notes and shapes
 * take `fontSize` (a text size; absent fits the text to the box) and three text marks: **bold**,
 * *italic*, and lines starting with "- " as bullets. Arrows take `routing` (`elbow` right angles,
 * `straight` one segment; absent or `curved` a curve), `bend` (moves an elbow's middle segment,
 * world units), `labelAt` (0–1, where the label sits; absent is the middle) and `stroke`. Notes
 * take `votes`, sections `noteColor`, shapes `timer` (WHITEBOARD_GUIDE has the details).
 *
 * Colours are names: one of COLORS (yellow, green, blue, purple, red, gray). The page maps each to
 * the reader's theme, so a board looks right in light and dark.
 *
 * Every later field is additive and optional, so every older body still parses unchanged:
 *   round 4  `fill` / `stroke` (a colour name or `#rrggbb`, drawn as is on either theme) on notes,
 *            shapes, sections, tables and link cards (`stroke` on arrows); note `votes`; shape
 *            `timer`; image `crop`; sticker `attachedTo`; section `noteColor`.
 *   round 5  `hidden` on every element; note `autoSize` (its height follows its text); section
 *            `stack` (a kanban column: its notes stack top to bottom); arrow `startHead` /
 *            `endHead` (one of ARROWHEAD_SHAPES per end); table `colWidths` / `rowHeights`
 *            (relative weights; a list of the wrong length draws evenly) and `merges`; link
 *            `artifact`; and the board's `noteTheme` (one of NOTE_THEMES; absent is classic).
 * WHITEBOARD_GUIDE (the end of this file) is the full reference, ops included; where this comment
 * and the guide differ, the guide is right.
 *
 * Layout advice, so nothing overlaps:
 *   - Work on an 8-unit grid; 40 units between neighbouring notes or shapes, 80 between groups.
 *   - Lay a row of notes out at x, x + 240, x + 480… (200 wide + 40 gap); a column at y + 240.
 *   - A section holding a 3×2 grid of 200×200 notes is 40 + 3·200 + 2·40 + 40 = 760 wide and
 *     48 + 2·200 + 40 + 40 = 528 tall. Leave 80 units between sections.
 *   - Flow diagrams read left to right: shapes 240 apart horizontally (160 wide + 80 for the
 *     arrow and its label), 160 apart vertically. Bind arrows to elements rather than points.
 *   - Use at most four colours on a board, each with a meaning (e.g. yellow ideas, red risks).
 *   - Open with a title plus a one-line takeaway under it (an `m` text).
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────
 *
 * The one source of truth for the board body: the app (freebuff/web components/workspace/whiteboard
 * re-exports it) and the server (packages/internal freebuff-artifacts/kinds.ts) both validate with
 * it. zod only: no React, no DOM. The agent's full reference (with its patch ops) is
 * `WHITEBOARD_GUIDE` at the end of this file.
 */

import { z } from 'zod/v4'
import { isSameOriginImagePath } from '../artifact-image-src'
import { ARTIFACT_ID_PATTERN, ARTIFACT_KINDS } from '../artifacts'

export const WHITEBOARD_VERSION = 1 as const

/** Limits. The JSON body is also capped at `MAX_BOARD_BYTES` by `parseBoard`. */
export const MAX_ELEMENTS = 800
export const MAX_BOARD_BYTES = 1_000_000
export const MAX_TEXT = 4_000
export const MAX_STROKE_POINTS = 2_000
const MAX_COORD = 1_000_000
const MAX_SIZE = 20_000

export const COLORS = ['yellow', 'green', 'blue', 'purple', 'red', 'gray'] as const
export type WhiteboardColor = (typeof COLORS)[number]

export const SHAPE_KINDS = [
  'rect',
  'rounded',
  'pill',
  'ellipse',
  'diamond',
  'hexagon',
  'parallelogram',
  'cylinder',
  // Round 3 (additive: every older body still parses): the rest of the flowchart set, a queue,
  // and icon-like shapes for system maps.
  'document',
  'subroutine',
  'queue',
  'triangle',
  'cloud',
  'person',
] as const
export type ShapeKind = (typeof SHAPE_KINDS)[number]

/** The size a new shape of each kind gets when none is given. */
export const SHAPE_DEFAULT_SIZE: Record<ShapeKind, { w: number; h: number }> = {
  rect: { w: 160, h: 80 },
  rounded: { w: 160, h: 80 },
  pill: { w: 160, h: 80 },
  ellipse: { w: 160, h: 80 },
  diamond: { w: 160, h: 120 },
  hexagon: { w: 160, h: 80 },
  parallelogram: { w: 160, h: 80 },
  cylinder: { w: 120, h: 120 },
  document: { w: 160, h: 96 },
  subroutine: { w: 160, h: 80 },
  queue: { w: 160, h: 80 },
  triangle: { w: 140, h: 120 },
  cloud: { w: 176, h: 112 },
  person: { w: 96, h: 136 },
}

export const TEXT_SIZES = ['xs', 's', 'm', 'l', 'xl'] as const
export type TextSize = (typeof TEXT_SIZES)[number]

/** Font size in world units for each text size. Line height is `LINE_HEIGHT` times this. */
export const TEXT_SIZE_PX: Record<TextSize, number> = { xs: 12, s: 14, m: 18, l: 28, xl: 44 }
export const LINE_HEIGHT = 1.3

export const SIDES = ['top', 'right', 'bottom', 'left'] as const
export type Side = (typeof SIDES)[number]

/** Built-in stickers (drawn from the reader's own emoji font: nothing is fetched). */
export const STICKERS = [
  'thumbs-up',
  'thumbs-down',
  'heart',
  'star',
  'check',
  'cross',
  'question',
  'idea',
  'fire',
  'party',
  'eyes',
  'rocket',
] as const
export type StickerName = (typeof STICKERS)[number]
export const STICKER_EMOJI: Record<StickerName, string> = {
  'thumbs-up': '\u{1F44D}',
  'thumbs-down': '\u{1F44E}',
  heart: '\u{2764}\u{FE0F}',
  star: '\u{2B50}',
  check: '\u{2705}',
  cross: '\u{274C}',
  question: '\u{2753}',
  idea: '\u{1F4A1}',
  fire: '\u{1F525}',
  party: '\u{1F389}',
  eyes: '\u{1F440}',
  rocket: '\u{1F680}',
}
export const STICKER_LABEL: Record<StickerName, string> = {
  'thumbs-up': 'Thumbs up',
  'thumbs-down': 'Thumbs down',
  heart: 'Heart',
  star: 'Star',
  check: 'Check',
  cross: 'Cross',
  question: 'Question',
  idea: 'Idea',
  fire: 'Fire',
  party: 'Party',
  eyes: 'Eyes',
  rocket: 'Rocket',
}

/** Table limits. */
export const MAX_TABLE_ROWS = 30
export const MAX_TABLE_COLS = 12
export const MAX_CELL_TEXT = 500
export const MAX_GROUP_DEPTH = 8

const id = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, 'ids are letters, digits, _ and -')
const coord = z.number().finite().min(-MAX_COORD).max(MAX_COORD)
const size = z.number().finite().min(1).max(MAX_SIZE)
const text = z.string().max(MAX_TEXT)
const color = z.enum(COLORS)

/** A custom colour: exactly `#rrggbb`. */
export const HEX_COLOR = /^#[0-9a-fA-F]{6}$/
export const isHexColor = (value: string): boolean => HEX_COLOR.test(value)
/** A fill or stroke override: a board colour name, or a `#rrggbb` hex. */
const paint = z.union([color, z.string().regex(HEX_COLOR, 'a custom colour is #rrggbb')])
export type WhiteboardPaint = string
/** Separate fill and outline overrides (round 4, optional: absent is the element's `color`). */
const paints = { fill: paint.optional(), stroke: paint.optional() }

/** Most votes a note can carry. */
export const MAX_VOTES = 999
/** Longest a timer runs: 24 hours, in seconds. */
export const MAX_TIMER_SECONDS = 86_400

/**
 * Fields every element may carry. `groups` lists the groups an element is in, innermost first
 * (a click selects its outermost group); `locked` stops the editor moving, resizing, editing or
 * deleting it. Both are optional, so every stored v1 body still parses.
 */
const shared = {
  groups: z.array(id).min(1).max(MAX_GROUP_DEPTH).optional(),
  locked: z.boolean().optional(),
  /**
   * Round 5: hidden from the canvas, exports and the public view (the layers panel still lists
   * it, to show it again). A hidden element is not hit, selected, snapped to or searched.
   */
  hidden: z.boolean().optional(),
}

const box = { id, x: coord, y: coord, w: size, h: size, ...shared }

export const noteSchema = z
  .object({
    type: z.literal('note'),
    ...box,
    text,
    color,
    fontSize: z.enum(TEXT_SIZES).optional(),
    ...paints,
    /** A dot-vote tally (round 4): shown as a badge on the note. */
    votes: z.number().int().min(0).max(MAX_VOTES).optional(),
    /** Round 5: the note's height follows its text (grows and shrinks as it is written). */
    autoSize: z.boolean().optional(),
  })
  .strict()

/**
 * A countdown on a shape (round 4): `duration` seconds in all; while it runs `startedAt` is the
 * epoch ms it was (re)started, and `elapsed` is the seconds used before that run. Paused: no
 * `startedAt`. Reset: neither field. It is single-user: each start, pause and reset is a save.
 */
export const timerSchema = z
  .object({
    duration: z.number().int().min(1).max(MAX_TIMER_SECONDS),
    startedAt: z.number().finite().min(0).optional(),
    elapsed: z.number().finite().min(0).max(MAX_TIMER_SECONDS).optional(),
  })
  .strict()

export const shapeSchema = z
  .object({
    type: z.literal('shape'),
    kind: z.enum(SHAPE_KINDS),
    ...box,
    text: text.optional(),
    color,
    fontSize: z.enum(TEXT_SIZES).optional(),
    ...paints,
    timer: timerSchema.optional(),
  })
  .strict()

export const textSchema = z
  .object({
    type: z.literal('text'),
    id,
    x: coord,
    y: coord,
    text,
    size: z.enum(TEXT_SIZES),
    w: size.optional(),
    ...shared,
  })
  .strict()

export const sectionSchema = z
  .object({
    type: z.literal('section'),
    ...box,
    title: z.string().max(200),
    color: color.optional(),
    ...paints,
    /** Notes added or moved into this section take this colour (round 4). */
    noteColor: color.optional(),
    /**
     * Round 5: a kanban column. Notes dropped into it stack top to bottom in reading order, one
     * column wide, so dragging a card between columns snaps it into the column's order.
     */
    stack: z.boolean().optional(),
  })
  .strict()

export const ARROW_HEADS = ['end', 'start', 'both', 'none'] as const
export type ArrowHead = (typeof ARROW_HEADS)[number]
export const ARROW_ROUTINGS = ['curved', 'elbow', 'straight'] as const
/** Round 5: the shape drawn at one end of an arrow. */
export const ARROWHEAD_SHAPES = ['triangle', 'open', 'diamond', 'circle', 'bar', 'none'] as const
export type ArrowheadShape = (typeof ARROWHEAD_SHAPES)[number]
export type ArrowRouting = (typeof ARROW_ROUTINGS)[number]

const boundEnd = z.object({ elementId: id, side: z.enum(SIDES).optional() }).strict()
const pointEnd = z.object({ x: coord, y: coord }).strict()
const arrowEnd = z.union([boundEnd, pointEnd])

export const arrowSchema = z
  .object({
    type: z.literal('arrow'),
    id,
    from: arrowEnd,
    to: arrowEnd,
    label: z.string().max(200).optional(),
    style: z.enum(['solid', 'dashed']),
    /** Which ends carry a head: `end` (absent), `start`, `both` or `none`. */
    head: z.enum(ARROW_HEADS).optional(),
    color: color.optional(),
    /** The line's colour override (round 4): a colour name or `#rrggbb`. */
    stroke: paint.optional(),
    /** `elbow` draws right-angled segments, `straight` one segment; absent (or `curved`) is the curve. */
    routing: z.enum(ARROW_ROUTINGS).optional(),
    /** An elbow's middle segment, moved this far (world units) from where it would sit. */
    bend: z.number().finite().min(-MAX_COORD).max(MAX_COORD).optional(),
    /** Where the label sits along the connector, 0 (start) to 1 (end); absent is 0.5. */
    labelAt: z.number().finite().min(0).max(1).optional(),
    /**
     * Round 5: the head drawn at each end, overriding `head` for that end (`none` draws none).
     * Absent: a triangle where `head` puts one, nothing elsewhere.
     */
    startHead: z.enum(ARROWHEAD_SHAPES).optional(),
    endHead: z.enum(ARROWHEAD_SHAPES).optional(),
    ...shared,
  })
  .strict()

export const strokeSchema = z
  .object({
    type: z.literal('stroke'),
    id,
    points: z.array(z.tuple([coord, coord])).min(1).max(MAX_STROKE_POINTS),
    color,
    width: z.number().finite().min(1).max(48),
    ...shared,
  })
  .strict()

/**
 * `https://…`, or a same-origin path (`isSameOriginImagePath`: nothing that resolves off this
 * origin). https stays valid so stored boards keep parsing; the agent is told never to hotlink
 * (import_artifact_image gives an `/_asset/<id>` ref), the tool flags one, and the views draw it
 * as a placeholder (remote-images.ts).
 */
export function isAllowedImageSrc(src: string): boolean {
  if (src.startsWith('/')) return isSameOriginImagePath(src)
  try {
    return new URL(src).protocol === 'https:'
  } catch {
    return false
  }
}

const fraction = z.number().finite().min(0).max(1)

/**
 * The part of an image shown (round 4): a rectangle in fractions of the whole picture (0-1, from
 * its top-left). The element's box shows just that part; absent shows all of it.
 */
export const cropSchema = z
  .object({ x: fraction, y: fraction, w: fraction.min(0.01), h: fraction.min(0.01) })
  .strict()
  .refine((crop) => crop.x + crop.w <= 1.0001 && crop.y + crop.h <= 1.0001, 'crop must lie inside the image')
export type ImageCrop = z.infer<typeof cropSchema>

export const imageSchema = z
  .object({
    type: z.literal('image'),
    ...box,
    src: z.string().max(2048).refine(isAllowedImageSrc, 'src must be https:// or a same-origin /path'),
    alt: z.string().max(500),
    crop: cropSchema.optional(),
  })
  .strict()

export const stickerSchema = z
  .object({
    type: z.literal('sticker'),
    ...box,
    sticker: z.enum(STICKERS),
    /**
     * The element this sticker is stuck to (round 4): it moves (and is copied) with it. An id
     * the board no longer has is ignored (the sticker is simply free).
     */
    attachedTo: id.optional(),
  })
  .strict()

const cell = z.string().max(MAX_CELL_TEXT)
/** A column's or row's share of the table (round 5): relative weights, so a resize of the whole table keeps them. */
const weight = z.number().finite().min(0.05).max(1000)
/** Most merged regions a table keeps. */
export const MAX_TABLE_MERGES = 60
/**
 * A merged region (round 5): `rows` x `cols` cells from (row, col), drawn as one cell holding the
 * top-left cell's text. Regions that overlap, or reach past the table, are ignored when drawn.
 */
export const tableMergeSchema = z
  .object({
    row: z.number().int().min(0).max(MAX_TABLE_ROWS - 1),
    col: z.number().int().min(0).max(MAX_TABLE_COLS - 1),
    rows: z.number().int().min(1).max(MAX_TABLE_ROWS),
    cols: z.number().int().min(1).max(MAX_TABLE_COLS),
  })
  .strict()
export type TableMerge = z.infer<typeof tableMergeSchema>

/** A simple grid: equal columns and rows; `rows` is rectangular (checked on the board). */
export const tableSchema = z
  .object({
    type: z.literal('table'),
    ...box,
    rows: z.array(z.array(cell).min(1).max(MAX_TABLE_COLS)).min(1).max(MAX_TABLE_ROWS),
    /** The first row is a header (bold, tinted). */
    header: z.boolean().optional(),
    color: color.optional(),
    ...paints,
    /**
     * Round 5 (optional): column widths and row heights as relative weights, one per column or
     * row (absent: equal). A list of the wrong length is ignored, so edits never break a board.
     */
    colWidths: z.array(weight).min(1).max(MAX_TABLE_COLS).optional(),
    rowHeights: z.array(weight).min(1).max(MAX_TABLE_ROWS).optional(),
    merges: z.array(tableMergeSchema).max(MAX_TABLE_MERGES).optional(),
  })
  .strict()

/** `https://…` only: a link card's URL becomes a link the reader can open. */
export function isAllowedLinkUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' && !!parsed.hostname
  } catch {
    return false
  }
}

/**
 * Round 5: a link card that points at another Freebuff artifact. In the workspace a click opens
 * that artifact's tab; anywhere else the card's `url` (the artifact's Freebuff address) is the link.
 */
export const linkArtifactSchema = z
  .object({
    id: z.string().max(64).regex(ARTIFACT_ID_PATTERN, 'an artifact id'),
    kind: z.enum(ARTIFACT_KINDS),
  })
  .strict()
export type LinkArtifact = z.infer<typeof linkArtifactSchema>

/** Where an artifact link card goes outside the workspace: the artifact's Freebuff address. */
export const artifactCardUrl = (artifactId: string) => `https://freebuff.com/#artifact=${artifactId}`

/** A card for a web page: its title and host, drawn locally (no favicon or preview is fetched). */
export const linkSchema = z
  .object({
    type: z.literal('link'),
    ...box,
    url: z.string().max(2048).refine(isAllowedLinkUrl, 'url must be https://'),
    title: z.string().max(200),
    color: color.optional(),
    ...paints,
    /** Round 5: the Freebuff artifact this card stands for (its `url` is `artifactCardUrl(id)`). */
    artifact: linkArtifactSchema.optional(),
  })
  .strict()

export const elementSchema = z.discriminatedUnion('type', [
  noteSchema,
  shapeSchema,
  textSchema,
  sectionSchema,
  arrowSchema,
  strokeSchema,
  imageSchema,
  stickerSchema,
  tableSchema,
  linkSchema,
])

/**
 * Round 5: the board's sticky-note palette. Each colour name stays the same; the theme changes
 * how the six are drawn (on either light or dark), so a whole board can be re-themed at once.
 */
export const NOTE_THEMES = ['classic', 'pastel', 'vivid', 'mono'] as const
export type NoteTheme = (typeof NOTE_THEMES)[number]

export const boardSchema = z
  .object({
    version: z.literal(WHITEBOARD_VERSION),
    title: z.string().max(200),
    elements: z.array(elementSchema).max(MAX_ELEMENTS),
    /** Round 5 (optional; absent is classic). */
    noteTheme: z.enum(NOTE_THEMES).optional(),
  })
  .strict()
  .superRefine((board, ctx) => {
    const types = new Map<string, WhiteboardElement['type']>()
    board.elements.forEach((element, index) => {
      if (types.has(element.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['elements', index, 'id'],
          message: `duplicate id "${element.id}"`,
        })
      }
      types.set(element.id, element.type)
      if (element.type === 'sticker' && element.attachedTo === element.id) {
        ctx.addIssue({ code: 'custom', path: ['elements', index, 'attachedTo'], message: 'a sticker cannot attach to itself' })
      }
      if (element.type === 'table') {
        const width = element.rows[0].length
        element.rows.forEach((row, r) => {
          if (row.length !== width) {
            ctx.addIssue({
              code: 'custom',
              path: ['elements', index, 'rows', r],
              message: `table "${element.id}" row ${r} has ${row.length} cells; every row needs ${width}`,
            })
          }
        })
      }
    })
    board.elements.forEach((element, index) => {
      if (element.type !== 'arrow') return
      for (const end of ['from', 'to'] as const) {
        const target = element[end]
        if (!('elementId' in target)) continue
        const targetType = types.get(target.elementId)
        if (!targetType) {
          ctx.addIssue({
            code: 'custom',
            path: ['elements', index, end, 'elementId'],
            message: `arrow "${element.id}" points at missing element "${target.elementId}"`,
          })
        } else if (targetType === 'arrow' || targetType === 'stroke' || target.elementId === element.id) {
          ctx.addIssue({
            code: 'custom',
            path: ['elements', index, end, 'elementId'],
            message: `arrow "${element.id}" cannot bind to a ${targetType}`,
          })
        }
      }
    })
  })

export type NoteElement = z.infer<typeof noteSchema>
export type ShapeElement = z.infer<typeof shapeSchema>
export type TextElement = z.infer<typeof textSchema>
export type SectionElement = z.infer<typeof sectionSchema>
export type ArrowElement = z.infer<typeof arrowSchema>
export type StrokeElement = z.infer<typeof strokeSchema>
export type ImageElement = z.infer<typeof imageSchema>
export type StickerElement = z.infer<typeof stickerSchema>
export type TableElement = z.infer<typeof tableSchema>
export type LinkElement = z.infer<typeof linkSchema>
export type ArrowEnd = ArrowElement['from']
export type WhiteboardElement = z.infer<typeof elementSchema>
export type WhiteboardBoard = z.infer<typeof boardSchema>

/** Elements drawn as a box with `x, y, w, h`. */
export type BoxElement =
  | NoteElement
  | ShapeElement
  | SectionElement
  | ImageElement
  | StickerElement
  | TableElement
  | LinkElement

export function isBoxElement(element: WhiteboardElement): element is BoxElement {
  return (
    element.type === 'note' ||
    element.type === 'shape' ||
    element.type === 'section' ||
    element.type === 'image' ||
    element.type === 'sticker' ||
    element.type === 'table' ||
    element.type === 'link'
  )
}

export function isBoundEnd(end: ArrowEnd): end is { elementId: string; side?: Side } {
  return 'elementId' in end
}

export type BoardParseResult =
  | { ok: true; board: WhiteboardBoard }
  | { ok: false; errors: string[] }

/** Validates an unknown value (or a JSON string) as a board, including the 1 MB cap. */
export function parseBoard(input: unknown): BoardParseResult {
  let value = input
  let bytes: number
  if (typeof input === 'string') {
    bytes = new TextEncoder().encode(input).length
    if (bytes > MAX_BOARD_BYTES) return { ok: false, errors: [`board is ${bytes} bytes; the cap is ${MAX_BOARD_BYTES}`] }
    try {
      value = JSON.parse(input)
    } catch {
      return { ok: false, errors: ['board is not valid JSON'] }
    }
  }
  const result = boardSchema.safeParse(value)
  if (!result.success) {
    return {
      ok: false,
      errors: result.error.issues.map((issue) => `${issue.path.join('.') || '(board)'}: ${issue.message}`),
    }
  }
  bytes = new TextEncoder().encode(JSON.stringify(result.data)).length
  if (bytes > MAX_BOARD_BYTES) return { ok: false, errors: [`board is ${bytes} bytes; the cap is ${MAX_BOARD_BYTES}`] }
  return { ok: true, board: result.data }
}

// ---- geometry types (not part of the stored body)

export type Point = { x: number; y: number }
export type Rect = { x: number; y: number; w: number; h: number }
export type Viewport = { x: number; y: number; zoom: number }

// ---- the agent's reference

/**
 * The guide's worked example: a small flow with a section of notes under it, laid out the way the
 * guide advises (nothing overlaps; a test keeps it valid and overlap-free).
 */
export const WHITEBOARD_EXAMPLE: WhiteboardBoard = {
  version: 1,
  title: 'Signup flow',
  elements: [
    { type: 'text', id: 'title', x: 0, y: 0, text: 'Signup flow', size: 'xl' },
    { type: 'shape', id: 'visit', kind: 'rounded', x: 0, y: 120, w: 160, h: 80, text: 'Landing page', color: 'blue' },
    { type: 'shape', id: 'form', kind: 'rect', x: 240, y: 120, w: 160, h: 80, text: 'Sign-up form', color: 'blue' },
    { type: 'shape', id: 'valid', kind: 'diamond', x: 480, y: 100, w: 160, h: 120, text: 'Email valid?', color: 'yellow' },
    { type: 'shape', id: 'welcome', kind: 'pill', x: 720, y: 120, w: 160, h: 80, text: 'Welcome', color: 'green' },
    { type: 'arrow', id: 'a1', from: { elementId: 'visit' }, to: { elementId: 'form' }, label: 'Get started', style: 'solid' },
    { type: 'arrow', id: 'a2', from: { elementId: 'form' }, to: { elementId: 'valid' }, style: 'solid' },
    { type: 'arrow', id: 'a3', from: { elementId: 'valid' }, to: { elementId: 'welcome' }, label: 'yes', style: 'solid' },
    {
      type: 'arrow',
      id: 'a4',
      from: { elementId: 'valid', side: 'bottom' },
      to: { elementId: 'form', side: 'bottom' },
      label: 'no',
      style: 'dashed',
    },
    { type: 'section', id: 'questions', x: 0, y: 320, w: 760, h: 288, title: 'Open questions', color: 'gray' },
    { type: 'note', id: 'q1', x: 40, y: 368, w: 200, h: 200, text: 'Do we need email verification on day one?', color: 'yellow' },
    { type: 'note', id: 'q2', x: 280, y: 368, w: 200, h: 200, text: 'Offer Google sign-in?', color: 'yellow' },
    { type: 'note', id: 'q3', x: 520, y: 368, w: 200, h: 200, text: 'Risk: bots filling the form', color: 'red' },
  ],
}

/**
 * The full authoring reference `artifact_guide {kind: "whiteboard"}` returns: the doc comment at
 * the top of this file, for the agent, plus how to edit a stored board.
 */
export const WHITEBOARD_GUIDE = `Whiteboard (kind "whiteboard"): ONE JSON object, declarative data, never HTML. Every object is strict (an unknown key is refused).

{ "version": 1, "title": "..." (<= 200 chars), "elements": [Element, ...] (<= ${MAX_ELEMENTS}, back to front: later entries draw on top), "noteTheme"?: ${NOTE_THEMES.join(' | ')} }
"noteTheme" re-themes every sticky note at once (the colour names stay; absent is classic).

Coordinates are world units (1 unit = 1 px at 100% zoom), x right, y down; x, y is an element's top-left. The canvas is infinite; start near (0, 0).
Every element has a unique "id" (1-64 letters, digits, _ or -, e.g. "note-risk-1"). Keep the ids you read when editing.

Elements, by "type":
- note: { id, x, y, w, h, text, color }. Usually 200x200 for a short phrase, 240x160 for a sentence; keep it under ~25 words.
- shape: { id, kind, x, y, w, h, text?, color }. kind: ${SHAPE_KINDS.join(', ')}. Flowcharts: rect a step, pill start/end, diamond a decision, parallelogram input/output, document a document, subroutine a predefined step, cylinder a database, queue a queue. System maps: cloud a cloud/external service, person a user or actor (its label sits under the figure). Usually 160x80 (diamond 160x120, cylinder 120x120, document 160x96, triangle 140x120, cloud 176x112, person 96x136). Text is centred.
- text: { id, x, y, text, size, w? }. size: xs 12px, s 14, m 18, l 28, xl 44 (line height 1.3x). Without w a line never wraps. A board title is "xl" at the top-left.
- section: { id, x, y, w, h, title, color? }. A titled frame: an element belongs to it when the element's centre is inside it, and moves with it. Put a section BEFORE its members in elements so it draws underneath. Pad 40 inside each edge and 48 at the top for the title.
- arrow: { id, from, to, label?, style: "solid" | "dashed", head?: "end" (default) | "start" | "both" | "none", color?, stroke? }. Each end is { "elementId": "...", "side"?: top|right|bottom|left } (bound: it follows the element; leave side out for the nearest) or { "x", "y" } (a free point). Never bound to an arrow, a stroke or itself. Labels are 1-4 words.
- stroke: { id, points: [[x, y], ...] (1-${MAX_STROKE_POINTS}), color, width (1-48, usually 4) }. A marker sketch; rarely needed.
- image: { id, x, y, w, h, src, alt, crop? }. src is an uploaded "/_asset/<id>" ref: for any picture from the web, call import_artifact_image first and use the ref it returns (read_artifact lists the board's assets). Never hotlink an https:// URL (readers see a placeholder instead of it), and never data: or javascript:. "crop": { "x", "y", "w", "h" } is the part shown, in fractions 0-1 of the whole picture (absent shows it all); keep w/h of the element in the crop's proportions.
- sticker: { id, x, y, w, h, sticker, attachedTo? }. sticker: ${STICKERS.join(', ')}. Usually 56x56; stick a few on a note's corner to vote. "attachedTo": an element id: the sticker moves and copies with that element (an id the board lacks is ignored).
- table: { id, x, y, w, h, rows: [["Name", "Owner"], ["Auth", "Ana"]], header?: true, color? }. Every row has the same number of cells (<= ${MAX_TABLE_COLS} columns, <= ${MAX_TABLE_ROWS} rows, <= ${MAX_CELL_TEXT} chars a cell); columns and rows are equal unless weighted. Size it 140 per column and 40 per row. "colWidths": [1, 2, 1] and "rowHeights" are relative weights, one per column or row (a list of the wrong length is ignored and draws evenly); "merges": [{ "row", "col", "rows", "cols" }] (at most ${MAX_TABLE_MERGES}, counted from 0) draws that block of cells as one, holding the top-left cell's text. Prefer the tableEdit op to keep these in step.
- link: { id, x, y, w, h, url, title, color?, artifact? }. A card for a web page: url is https:// only; usually 280x96. The card shows the title and host only. "artifact": { "id": "<artifact uuid>", "kind": ${ARTIFACT_KINDS.map((k) => `"${k}"`).join(' | ')} } makes it a card for another Freebuff artifact (a click opens it; url is then ${artifactCardUrl('<id>')}): add one with the linkArtifact op.
Optional on every element: "groups": ["group-id", ...] (innermost first; a click selects the whole outermost group, so give elements that belong together one shared id) and "locked": true (the reader's editor will not move, resize, edit or delete it: use it for a template's frame or legend) and "hidden": true (invisible to readers: not drawn, exported or shown on a shared link, and arrows bound to it hide too; the layers panel can show it again. Use it for speaker notes or a draft, never to keep a secret).
Notes and shapes: "fontSize": xs|s|m|l|xl (absent fits the text to the box), and their text may use **bold**, *italic* and lines starting with "- " as bullets.
Arrows: "startHead" / "endHead": ${ARROWHEAD_SHAPES.join(' | ')} is the shape at that end (absent: a triangle where "head" puts one, none elsewhere). "routing": "elbow" draws right angles (good for flowcharts and org charts; absent or "curved" is a curve, "straight" one straight segment) and, without a "bend", routes itself round any box in its way; "bend": a number moves an elbow's middle segment that far (and turns that routing off); "labelAt": 0-1 is where the label sits (absent 0.5).
Notes: "votes": 0-${MAX_VOTES} is a dot-vote tally drawn as a badge; "autoSize": true makes the note's height follow its text in the editor. Sections: "stack": true makes a kanban column (notes dropped in stack top to bottom, one column wide; set it with the stackSection op, which also lays the column out). "noteColor": a colour name that notes the reader adds or drags into the section take in the editor (your addElements and moveElements do not recolour: give such notes that "color" yourself). Shapes: "timer": { "duration": seconds 1-${MAX_TIMER_SECONDS}, "startedAt"?: epoch ms while running, "elapsed"?: seconds used before } turns the shape into a countdown (use the "timer" op to start, pause or reset it).
Colours are names: ${COLORS.join(', ')}. The app maps each to the reader's theme. "fill" and "stroke" (notes, shapes, sections, tables, link cards; "stroke" on arrows) override the fill and the outline separately, each a colour name or a "#rrggbb" hex drawn as is: use names unless asked for an exact colour.
Text fields are at most ${MAX_TEXT} chars; coordinates stay within +-1,000,000 and sizes 1-20,000.

Layout, so nothing overlaps and the board reads well:
- Work on an 8-unit grid. 40 units between neighbouring notes or shapes, 80 between groups or sections.
- A row of 200-wide notes sits at x, x+240, x+480...; a column at y, y+240...
- A section around a grid of C x R notes of 200x200 is 40 + C*200 + (C-1)*40 + 40 wide and 48 + R*200 + (R-1)*40 + 40 tall (3x2: 760 x 528).
- Flows read left to right: shapes 240 apart (160 wide + 80 for the arrow and its label), rows 160 apart. Bind arrows to elements, not points. A decision is a diamond with labelled "yes"/"no" arrows.
- A brainstorm is sections by theme with notes inside; a system map is shapes (cylinders for stores, clouds for outside services, persons for users) joined by labelled arrows, with sections for boundaries (a cloud account, a service).
- Swimlanes: one section per team or actor, stacked edge to edge (each 200 tall, all the same width, no gap), steps inside the lane that does them, elbow arrows between steps across lanes. The "swimlanes" template is a ready start.
- Use at most four colours, each with one meaning (e.g. yellow ideas, green decided, red risks, gray context), and say so in a small text legend when it is not obvious.
- Title the board with an xl text above the content, plus a one-line takeaway under it (an "m" text: what the reader should come away with), and keep the whole board compact: the reader zooms to fit.

Example: ${JSON.stringify(WHITEBOARD_EXAMPLE)}

Editing a stored board: edit_artifact with patch, a list of ops applied in order and then validated as a whole (any failure changes nothing):
- {"op":"addElements","elements":[{...}, ...],"place"?:{"near":"<element id>"} | {"section":"<section id>"}}. A missing id is minted (like "note-3"). With place, leave x and y out: each element is put in the nearest free spot beside that element, or in reading order inside that section (refused when the section is full: grow it first). Without place, x and y are required. Missing sizes default (note 200x200, shape 160x80, diamond 160x120, cylinder 120x120); a missing note colour is yellow, shape colour blue, arrow style solid. Sections are inserted beneath the elements they cover.
- {"op":"updateElement","id":"...","props":{"text":"...","color":"green"}} (merges; null removes an optional field; id and type never change)
- {"op":"removeElements","ids":[...]} (arrows bound to a removed element are removed too, as when the reader deletes it in the editor; a removed section's members stay)
- {"op":"connect","from":"<element id>","to":"<element id>","label"?:"...","style"?:"solid"|"dashed","id"?:"...","fromSide"?:"top"|"right"|"bottom"|"left","toSide"?:...,"routing"?:"curved"|"elbow"|"straight","head"?:"end"|"start"|"both"|"none","color"?:"<colour name>"} (a bound arrow; sides absent are chosen nearest)
- {"op":"tableEdit","id":"<table id>","action":"insertRow"|"deleteRow"|"insertCol"|"deleteCol","at"?:n} (insert before row/column n, or delete row/column n; at absent = the end/last. The table grows or shrinks by one row or column; at least 1 row and 1 column stay; weights and merges shift with it). More actions, each with only its own fields (rows and columns count from 0): "action":"merge","row":r,"col":c,"rows":2,"cols":1 (one cell from there; every merged cell's text is kept, joined into the top-left); "action":"unmerge","row":r,"col":c (splits the merge covering that cell); "action":"resizeCol"|"resizeRow","at":n,"weight":2 (that column's or row's relative weight; the others keep theirs, 1 when none were set); "action":"header","on":true|false (the first row as a header)
- {"op":"vote","id":"<note id>","by"?:1 | "count"?:3} (add to a note's votes, negative to remove, or set them; 0 clears)
- {"op":"tally","ids"?:[...]} (sets each note's votes to the stickers attached to it or sitting on it; ids absent = every note with a sticker)
- {"op":"sortByVotes","ids":[note ids]} (most votes first: the notes swap places so reading order follows the votes; stickers on them come along)
- {"op":"clusterNotes","ids"?:[note ids],"gap"?:80} (groups notes that sit within gap of each other, or share a section, so each cluster selects and moves as one; ids absent = every note)
- {"op":"timer","id":"<shape id>","action":"start"|"pause"|"reset","duration"?:seconds} (adds the countdown to a shape when it has none; duration sets or changes it)
- {"op":"crop","id":"<image id>","crop":{"x":0.1,"y":0,"w":0.8,"h":1}} | "trims":{"left":0.1,"top":0,"right":0.1,"bottom":0} | "reset":true (exactly one: the part shown, in fractions of the whole picture, or trims off each edge (each pair at most 0.95). The box shrinks with the crop so the picture keeps its scale; reset shows the whole picture again at that scale)
- {"op":"setHidden","ids":[...],"hidden":true|false} (hides elements from readers, or shows them again)
- {"op":"setLocked","ids":[...],"locked":true|false} (locks elements against the reader's editor, or unlocks them)
- {"op":"arrowHeads","ids":[arrow ids],"start"?:"${ARROWHEAD_SHAPES.join('"|"')}","end"?:...} (the shape at each end; an end left out keeps its shape; "none" draws nothing)
- {"op":"linkArtifact","artifactId":"<artifact uuid>","kind":"doc"|"slides"|"sheet"|"data"|"whiteboard"|"design","title":"...","x"?:0,"y"?:0,"place"?:{"near":"<element id>"}} (adds a 280x96 card for another Freebuff artifact: x, y is its top-left, or with place it sits 40 to the right of that element, centred on it. artifactId is the artifact's UUID as create_artifact or list_artifacts gave it)
- {"op":"layoutSubtree","root":"<element id>","direction"?:"right"|"down"} (a tidy mind-map tree: everything the root's bound arrows reach, one rank per level, siblings stacked, each parent centred on its children; the root stays put, locked nodes stay)
- {"op":"addChild","parent":"<element id>","text"?:"...","direction"?:"right"|"down"} (mind map: a new node like the parent (a note or shape keeps its type, size and colour) joined to it by an arrow, then the parent's whole tree is laid out again from its root; read the board to find the new id)
- {"op":"attachSticker","ids":[sticker ids]} (attaches each sticker to the element under its centre, so it moves and copies with it, or frees it when it sits on nothing)
- {"op":"stackSection","id":"<section id>","stack":true|false} (makes a section a kanban column and lays its notes out top to bottom in reading order, growing it to fit; false only clears the flag)
- {"op":"noteTheme","theme":"${NOTE_THEMES.join('"|"')}" | null} (re-themes every sticky note; null or "classic" clears it)
- {"op":"moveElements","ids":[...],"dx":240,"dy":0} (a section brings its members; bound arrows follow)
- {"op":"arrange","ids":[...],"mode":"left"|"center"|"right"|"top"|"middle"|"bottom"|"distribute-horizontal"|"distribute-vertical"} (align to the selection's own edge or centre, or even out the gaps of 3+; a group moves as one; locked elements and arrows stay)
- {"op":"tidy","ids":[...],"layout":"grid"|"tree"|"flow"} (lays 2+ elements out afresh from the selection's top-left: grid = a near-square grid in reading order; tree = top-down from the elements nothing points at, following the bound arrows between them; flow = left-to-right ranks by the longest chain of arrows. 40 between neighbours, 80 between ranks, on the 8-unit grid; a group moves as one, a section brings its members, locked elements and arrows stay. Use it after adding many elements instead of computing coordinates)
- {"op":"group","ids":[...]} / {"op":"ungroup","ids":[...]} (group wraps 2+ elements in a new outer group; ungroup removes the outermost group of each)
- {"op":"reorder","ids":[...],"to":"front"|"back"|"forward"|"backward"} or {"op":"reorder","ids":["<one id>"],"index":0} (the drawing order, as the editor's Bring to front / Send to back: front and back move them to the top or bottom, forward and backward one step past their neighbour, keeping their order among themselves; index puts one element at an exact place in elements, 0 = bottom)
- {"op":"applyTemplate","template":"brainstorm"|"flowchart"|"kanban"|"retro"|"user-journey"|"matrix"|"swimlanes"|"swot"|"mind-map"|"roadmap"|"dot-voting","at"?:{"x":0,"y":0}} (adds a ready-made layout: on an empty board with readable ids and the template's title, else below the content, or with its top-left at "at", with fresh ids; then fill it in with updateElement)
- generic {"op":"set"|"insert"|"remove","path":"/elements/3/text","value":...} on a JSON pointer.
read_artifact's summary lists every element by id, each section with its members and each arrow as "A → B (label)". Hidden elements stay in the body, but are invisible to readers.
It ends with a "Checks:" list, the same checks the reader's Checks panel shows: overlaps (two boxes covering each other), cut-off text (a note, shape or table cell whose text does not fit), tiny text (it fits only below 12px), half-in-section (an element straddling a section's edge), dangling arrows (an end on a free point) and duplicate arrows (two joining the same two elements), and low contrast (a #rrggbb line that vanishes on one theme). Each names the ids and a fix: fix every one before you finish (move, resize, shorten, tidy), then read again.`
