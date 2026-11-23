import { z } from 'zod/v4'

import { ARTIFACT_DOC_BLOCK_ID_PATTERN, ARTIFACT_KINDS, ARTIFACT_TITLE_MAX_CHARS } from './artifacts'

/**
 * What the user is looking at when they send a chat message: the artifact tab
 * open and focused in that chat's panel, and what is selected in it. The
 * workspace sends it on the run request (`artifactContext`, web's
 * contracts.ts); the agent gets it as a data block ahead of the prompt
 * (web/src/server/desktop-cloud/artifact-view-context.ts), so "this slide",
 * "these cells" or "the selected box" resolve to ids.
 *
 * It is a HINT from the client: the server re-reads the artifact as the run's
 * user (kind, title, revision, access) and never trusts these fields for
 * access. Every string here is user content, framed as data.
 */

export const ARTIFACT_VIEW_MODES = ['editing', 'viewing', 'presenting'] as const
export type ArtifactViewMode = (typeof ARTIFACT_VIEW_MODES)[number]

const id = z.string().min(1).max(200)
/** A quote of selected text: short, the ids are what address it. */
export const ARTIFACT_VIEW_QUOTE_MAX_CHARS = 500
const quote = z.string().max(ARTIFACT_VIEW_QUOTE_MAX_CHARS)
const filterValue = z.union([
  z.string().max(200),
  z.number().finite(),
  z.boolean(),
  z.null(),
  z.array(z.string().max(200)).max(50),
])

/** Free-position slide elements reported at most (a multi-select lists the first ones). */
export const ARTIFACT_VIEW_SLIDE_ELEMENTS_MAX = 12
/** A free element's text excerpt, in characters: enough to recognise it, the id addresses it. */
export const ARTIFACT_VIEW_ELEMENT_TEXT_MAX_CHARS = 120
/** Row/column groups the selection touches, reported at most. */
export const ARTIFACT_VIEW_SHEET_GROUPS_MAX = 8
/** Whiteboard element ids listed at most; `selectedCount` says how many were selected in all. */
export const ARTIFACT_VIEW_WHITEBOARD_IDS_MAX = 50
/** Slides selected together (the grid or the filmstrip) listed at most. */
export const ARTIFACT_VIEW_SLIDE_IDS_MAX = 50
/** A board coordinate or extent the whiteboard viewport reports (board units). */
const VIEWPORT_COORD_MAX = 10_000_000
const viewportNumber = z.number().finite().min(-VIEWPORT_COORD_MAX).max(VIEWPORT_COORD_MAX)
/** The part of the board on screen: its top-left, size (board units) and zoom. */
const whiteboardViewport = z.strictObject({
  x: viewportNumber,
  y: viewportNumber,
  w: viewportNumber.min(0),
  h: viewportNumber.min(0),
  zoom: z.number().finite().min(0.01).max(100),
})

/** Each kind's selection, by id. Every field optional: a pane reports what it has. */
export const artifactSelectionSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('doc'),
    tabId: id.optional(),
    blockIndex: z.number().int().min(0).max(100_000).optional(),
    /** The block's hash as read_artifact's outline shows it (doc-blocks.ts `docBlockHash`), for a block op's guard. */
    blockHash: z.string().regex(/^[0-9a-z]{7}$/).optional(),
    /** The block's stable id (doc-block-ids.ts), which the doc's block ops and comment anchors take. */
    blockId: z.string().regex(ARTIFACT_DOC_BLOCK_ID_PATTERN).optional(),
    quote: quote.optional(),
  }),
  z.strictObject({
    kind: z.literal('slides'),
    slideId: id.optional(),
    /** 1-based, as the user sees it. */
    slideNumber: z.number().int().min(1).max(10_000).optional(),
    /** The element on the slide: title, subtitle, body, notes, image, chart… */
    element: z.string().min(1).max(40).optional(),
    quote: quote.optional(),
    /**
     * Free-position elements selected on the slide (text boxes, shapes, lines, arrows, images:
     * the slide's `elements`), by id, with their type and a text excerpt (an image's alt).
     */
    freeElements: z
      .array(
        z.strictObject({
          id: z.string().min(1).max(64),
          /** slides.ts `ELEMENT_TYPES`; a bounded string so a newer type never drops the context. */
          type: z.string().min(1).max(20),
          text: z.string().max(ARTIFACT_VIEW_ELEMENT_TEXT_MAX_CHARS).optional(),
        }),
      )
      .max(ARTIFACT_VIEW_SLIDE_ELEMENTS_MAX)
      .optional(),
    /** Every slide selected (a multi-selection in the grid or filmstrip), by id, in deck order. */
    slideIds: z.array(id).max(ARTIFACT_VIEW_SLIDE_IDS_MAX).optional(),
  }),
  z.strictObject({
    kind: z.literal('sheet'),
    tabId: id.optional(),
    tabName: z.string().max(100).optional(),
    /** A1 notation without the tab: "B2:D9" or "C4". */
    range: z.string().max(40).optional(),
    /**
     * The row/column groups the selected range overlaps, as the tab stores them: rows "3:8"
     * (1-based), columns "C:E"; a collapsed group's lines are hidden in the grid.
     */
    groups: z
      .array(
        z.strictObject({
          axis: z.enum(['row', 'col']),
          range: z.string().min(1).max(20),
          collapsed: z.boolean(),
        }),
      )
      .max(ARTIFACT_VIEW_SHEET_GROUPS_MAX)
      .optional(),
  }),
  z.strictObject({
    kind: z.literal('data'),
    blockId: id.optional(),
    /** The section shown as a tab on a read page. */
    tabId: id.optional(),
    filters: z.record(z.string().max(100), filterValue).optional(),
  }),
  z.strictObject({
    kind: z.literal('whiteboard'),
    elementIds: z.array(id).max(ARTIFACT_VIEW_WHITEBOARD_IDS_MAX).optional(),
    /** How many elements are selected in all (box or lasso), when more than `elementIds` lists. */
    selectedCount: z.number().int().min(0).max(1_000_000).optional(),
    /** The part of the board on screen. */
    viewport: whiteboardViewport.optional(),
  }),
  z.strictObject({
    kind: z.literal('design'),
    pageId: id.optional(),
    boardId: id.optional(),
    /** From the board's root down to the selected node. */
    nodePath: z.array(id).max(40).optional(),
    /** The breakpoint the editor draws and edits at (absent: each board's base width). */
    breakpoint: z
      .strictObject({
        id: z.string().min(1).max(64),
        title: z.string().max(40).optional(),
        width: z.number().finite().min(1).max(100_000).optional(),
      })
      .optional(),
    /** The named style (design.styles) the selected node uses. */
    namedStyle: z
      .strictObject({
        kind: z.enum(['text', 'fill']),
        id: z.string().min(1).max(64),
        name: z.string().max(60).optional(),
      })
      .optional(),
  }),
])
export type ArtifactSelection = z.infer<typeof artifactSelectionSchema>

/**
 * What was cut to fit a cap, in fixed words (never client text): the agent is told so, and the
 * API logs it (`artifact_view_context_truncated`). Ids, the kind and the revision are never cut.
 */
export const ARTIFACT_VIEW_TRUNCATIONS = [
  'title',
  'lastEditedByUserAt',
  'selection',
  'selection.quote',
  'selection.names',
  'selection.lists',
  'selection.filters',
] as const
export type ArtifactViewTruncation = (typeof ARTIFACT_VIEW_TRUNCATIONS)[number]

/** A share link's token (artifacts.ts `ARTIFACT_LINK_TOKEN_PATTERN`). */
const LINK_TOKEN = /^[A-Za-z0-9_-]{43}$/

export const artifactViewContextSchema = z.strictObject({
  artifactId: id,
  kind: z.enum(ARTIFACT_KINDS),
  title: z.string().max(ARTIFACT_TITLE_MAX_CHARS),
  revision: z.number().int().min(1),
  mode: z.enum(ARTIFACT_VIEW_MODES),
  selection: artifactSelectionSchema.nullable().optional(),
  /** Edits in the tab not yet saved: the stored revision lacks them. */
  dirty: z.boolean(),
  /** When this user last edited it in this tab (ISO), null when they have not. */
  lastEditedByUserAt: z.string().max(40).nullable().optional(),
  /**
   * The share link's token the tab was opened with (a link-only artifact): the API seals it
   * (`sealedLinkToken`) before the run is stored, reads the artifact as the user WITH it, and lets
   * this run's read tools use it for this artifact only. Never shown to the model. Body only.
   */
  linkToken: z.string().regex(LINK_TOKEN).optional(),
  /** Set by the API alone (a client's is dropped): `linkToken`, sealed to the run. */
  sealedLinkToken: z.string().min(1).max(400).optional(),
  /** What was cut to fit a cap. Body only. */
  truncated: z.array(z.enum(ARTIFACT_VIEW_TRUNCATIONS)).max(ARTIFACT_VIEW_TRUNCATIONS.length).optional(),
})
export type ArtifactViewContext = z.infer<typeof artifactViewContextSchema>

/**
 * Transport. The context rides the run BODY (`artifactContext`, web's contracts.ts) and, for an
 * API that reads only the header (round 4), a HEADER copy in the round-4 shape, cut to fit. The
 * API takes the body's first and the header's when the body has none that reads
 * (`resolveArtifactViewContext`). An API without the field at all refuses the body with
 * "Invalid cloud run request"; the send then goes again without it (send-commit.ts).
 *
 * Neither copy is ever dropped whole for its size: each field has a cap, and over the copy's cap
 * the lowest-priority parts go first (filters, excerpts, names, lists, then the selection, then
 * the title), each named in `truncated`.
 */
export const ARTIFACT_CONTEXT_HEADER = 'x-freebuff-artifact-context'
/** Encoded header characters accepted (base64 of the JSON, so titles in any script survive). */
export const ARTIFACT_CONTEXT_HEADER_MAX_CHARS = 8000
/** The body copy's JSON characters at most: a view is ids and short excerpts, never a body. */
export const ARTIFACT_CONTEXT_BODY_MAX_CHARS = 16_000
/** Filters a data view carries at most, and the values of one multi-select. */
const FILTER_KEYS_MAX = 40
const FILTER_VALUES_MAX = 50

type Marks = Set<ArtifactViewTruncation>
type Raw = Record<string, unknown>
const isRecord = (value: unknown): value is Raw => !!value && typeof value === 'object' && !Array.isArray(value)
const idOf = (value: unknown, max = 200) => (typeof value === 'string' && value.length >= 1 && value.length <= max ? value : undefined)
/** A string cut to `max` (marked), or undefined for a non-string. */
function clipped(value: unknown, max: number, marks: Marks, mark: ArtifactViewTruncation): string | undefined {
  if (typeof value !== 'string') return undefined
  if (value.length <= max) return value
  marks.add(mark)
  return value.slice(0, max)
}
const intIn = (value: unknown, min: number, max: number) =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : undefined
/** Drops undefined fields, so the strict schema reads the object as written. */
function defined<T extends Raw>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined)) as T
}
/** At most `max` items (marked when cut). */
function capped<T>(items: T[], max: number, marks: Marks, mark: ArtifactViewTruncation): T[] {
  if (items.length <= max) return items
  marks.add(mark)
  return items.slice(0, max)
}

/** One kind's selection, field by field: unknown fields dropped, each value capped. Null when it does not read. */
function normalizeSelection(raw: unknown, marks: Marks): ArtifactSelection | null {
  if (!isRecord(raw)) return null
  let selection: Raw | null = null
  switch (raw.kind) {
    case 'doc':
      selection = {
        kind: 'doc',
        tabId: idOf(raw.tabId),
        blockIndex: intIn(raw.blockIndex, 0, 100_000),
        blockHash: typeof raw.blockHash === 'string' && /^[0-9a-z]{7}$/.test(raw.blockHash) ? raw.blockHash : undefined,
        blockId: typeof raw.blockId === 'string' && ARTIFACT_DOC_BLOCK_ID_PATTERN.test(raw.blockId) ? raw.blockId : undefined,
        quote: clipped(raw.quote, ARTIFACT_VIEW_QUOTE_MAX_CHARS, marks, 'selection.quote'),
      }
      break
    case 'slides':
      selection = {
        kind: 'slides',
        slideId: idOf(raw.slideId),
        slideNumber: intIn(raw.slideNumber, 1, 10_000),
        element: idOf(raw.element, 40),
        quote: clipped(raw.quote, ARTIFACT_VIEW_QUOTE_MAX_CHARS, marks, 'selection.quote'),
        freeElements: Array.isArray(raw.freeElements)
          ? capped(
              raw.freeElements.flatMap((element) => {
                if (!isRecord(element) || !idOf(element.id, 64) || !idOf(element.type, 20)) return []
                return [defined({ id: element.id as string, type: element.type as string, text: clipped(element.text, ARTIFACT_VIEW_ELEMENT_TEXT_MAX_CHARS, marks, 'selection.quote') })]
              }),
              ARTIFACT_VIEW_SLIDE_ELEMENTS_MAX,
              marks,
              'selection.lists',
            )
          : undefined,
        slideIds: Array.isArray(raw.slideIds)
          ? capped(raw.slideIds.filter((value): value is string => !!idOf(value)), ARTIFACT_VIEW_SLIDE_IDS_MAX, marks, 'selection.lists')
          : undefined,
      }
      break
    case 'sheet':
      selection = {
        kind: 'sheet',
        tabId: idOf(raw.tabId),
        tabName: clipped(raw.tabName, 100, marks, 'selection.names'),
        range: idOf(raw.range, 40),
        groups: Array.isArray(raw.groups)
          ? capped(
              raw.groups.flatMap((group) =>
                isRecord(group) && (group.axis === 'row' || group.axis === 'col') && idOf(group.range, 20) && typeof group.collapsed === 'boolean'
                  ? [{ axis: group.axis, range: group.range as string, collapsed: group.collapsed }]
                  : [],
              ),
              ARTIFACT_VIEW_SHEET_GROUPS_MAX,
              marks,
              'selection.lists',
            )
          : undefined,
      }
      break
    case 'data': {
      let filters: Record<string, string | number | boolean | null | string[]> | undefined
      if (isRecord(raw.filters)) {
        filters = {}
        for (const [key, value] of capped(Object.entries(raw.filters), FILTER_KEYS_MAX, marks, 'selection.filters')) {
          const name = clipped(key, 100, marks, 'selection.filters')!
          if (typeof value === 'string') filters[name] = clipped(value, 200, marks, 'selection.filters')!
          else if ((typeof value === 'number' && Number.isFinite(value)) || typeof value === 'boolean' || value === null) filters[name] = value
          else if (Array.isArray(value))
            filters[name] = capped(value.filter((item): item is string => typeof item === 'string'), FILTER_VALUES_MAX, marks, 'selection.filters').map(
              (item) => clipped(item, 200, marks, 'selection.filters')!,
            )
        }
      }
      selection = { kind: 'data', blockId: idOf(raw.blockId), tabId: idOf(raw.tabId), filters }
      break
    }
    case 'whiteboard': {
      const ids = Array.isArray(raw.elementIds) ? raw.elementIds.filter((value): value is string => !!idOf(value)) : undefined
      const elementIds = ids && capped(ids, ARTIFACT_VIEW_WHITEBOARD_IDS_MAX, marks, 'selection.lists')
      const selectedCount = intIn(raw.selectedCount, 0, 1_000_000) ?? (ids && elementIds && ids.length > elementIds.length ? Math.min(ids.length, 1_000_000) : undefined)
      const viewport = whiteboardViewport.safeParse(isRecord(raw.viewport) ? defined({ x: raw.viewport.x, y: raw.viewport.y, w: raw.viewport.w, h: raw.viewport.h, zoom: raw.viewport.zoom }) : undefined)
      selection = { kind: 'whiteboard', elementIds, selectedCount, viewport: viewport.success ? viewport.data : undefined }
      break
    }
    case 'design': {
      const path = Array.isArray(raw.nodePath) ? raw.nodePath.filter((value): value is string => !!idOf(value)) : undefined
      const breakpoint = isRecord(raw.breakpoint) && idOf(raw.breakpoint.id, 64)
        ? defined({
            id: raw.breakpoint.id as string,
            title: clipped(raw.breakpoint.title, 40, marks, 'selection.names'),
            width: typeof raw.breakpoint.width === 'number' && Number.isFinite(raw.breakpoint.width) && raw.breakpoint.width >= 1 && raw.breakpoint.width <= 100_000 ? raw.breakpoint.width : undefined,
          })
        : undefined
      const namedStyle = isRecord(raw.namedStyle) && (raw.namedStyle.kind === 'text' || raw.namedStyle.kind === 'fill') && idOf(raw.namedStyle.id, 64)
        ? defined({ kind: raw.namedStyle.kind, id: raw.namedStyle.id as string, name: clipped(raw.namedStyle.name, 60, marks, 'selection.names') })
        : undefined
      // Root down to the selected node: a cut keeps the selected end.
      if (path && path.length > 40) marks.add('selection.lists')
      selection = { kind: 'design', pageId: idOf(raw.pageId), boardId: idOf(raw.boardId), nodePath: path?.slice(-40), breakpoint, namedStyle }
      break
    }
  }
  if (!selection) return null
  const parsed = artifactSelectionSchema.safeParse(defined(selection))
  return parsed.success ? parsed.data : null
}

/** The lowest-priority parts of a selection first; each step returns null when it has nothing to cut. */
const SELECTION_CUTS: Array<[ArtifactViewTruncation, (selection: ArtifactSelection) => ArtifactSelection | null]> = [
  ['selection.filters', (s) => (s.kind === 'data' && s.filters && Object.values(s.filters).some((v) => Array.isArray(v) && v.length > 5)
    ? { ...s, filters: Object.fromEntries(Object.entries(s.filters).map(([k, v]) => [k, Array.isArray(v) ? v.slice(0, 5) : v])) }
    : null)],
  ['selection.filters', (s) => {
    if (s.kind !== 'data' || !s.filters) return null
    const keys = Object.keys(s.filters)
    if (!keys.length) return null
    // One filter fewer, from the end: the caller repeats until the copy fits.
    const filters = Object.fromEntries(Object.entries(s.filters).slice(0, keys.length - 1))
    return defined({ ...s, filters: keys.length > 1 ? filters : undefined })
  }],
  ['selection.quote', (s) => (s.kind === 'doc' && s.quote !== undefined ? defined({ ...s, quote: undefined })
    : s.kind === 'slides' && (s.quote !== undefined || s.freeElements?.some((e) => e.text !== undefined))
      ? defined({ ...s, quote: undefined, freeElements: s.freeElements?.map(({ id, type }) => ({ id, type })) })
      : null)],
  ['selection.names', (s) => (s.kind === 'sheet' && s.tabName !== undefined ? defined({ ...s, tabName: undefined })
    : s.kind === 'design' && (s.breakpoint?.title !== undefined || s.namedStyle?.name !== undefined)
      ? defined({ ...s, breakpoint: s.breakpoint && defined({ ...s.breakpoint, title: undefined }), namedStyle: s.namedStyle && defined({ ...s.namedStyle, name: undefined }) })
      : null)],
  ['selection.lists', (s) => {
    if (s.kind === 'whiteboard' && (s.elementIds?.length ?? 0) > 10)
      return { ...s, elementIds: s.elementIds!.slice(0, 10), selectedCount: s.selectedCount ?? s.elementIds!.length }
    if (s.kind === 'design' && (s.nodePath?.length ?? 0) > 8) return { ...s, nodePath: s.nodePath!.slice(-8) }
    if (s.kind === 'sheet' && s.groups?.length) return defined({ ...s, groups: undefined })
    if (s.kind === 'slides' && (s.freeElements?.length ?? 0) > 3) return { ...s, freeElements: s.freeElements!.slice(0, 3) }
    if (s.kind === 'slides' && (s.slideIds?.length ?? 0) > 10) return { ...s, slideIds: s.slideIds!.slice(0, 10) }
    return null
  }],
]

/**
 * The context cut to `fits`, lowest priority first, each cut named in `truncated` (unless
 * `markTruncated` is false: the header's round-4 shape has no such field). Deterministic.
 */
function fitArtifactViewContext(
  context: ArtifactViewContext,
  fits: (context: ArtifactViewContext) => boolean,
  marks: Marks,
): ArtifactViewContext {
  const withMarks = (next: ArtifactViewContext) =>
    marks.size ? { ...next, truncated: ARTIFACT_VIEW_TRUNCATIONS.filter((mark) => marks.has(mark)) } : next
  let current = withMarks(context)
  if (fits(current)) return current
  for (const [mark, cut] of SELECTION_CUTS) {
    for (let next = current.selection ? cut(current.selection) : null; next; next = current.selection ? cut(current.selection) : null) {
      marks.add(mark)
      current = withMarks({ ...current, selection: next })
      if (fits(current)) return current
    }
  }
  if (current.selection) {
    marks.add('selection')
    current = withMarks({ ...current, selection: { kind: current.selection.kind } as ArtifactSelection })
    if (fits(current)) return current
  }
  if (current.lastEditedByUserAt) {
    marks.add('lastEditedByUserAt')
    current = withMarks({ ...current, lastEditedByUserAt: null })
    if (fits(current)) return current
  }
  // The server re-reads the title as the run user: the client's copy is the last to go.
  marks.add('title')
  return withMarks({ ...current, title: '' })
}

/**
 * Any value as a view context, tolerantly: unknown fields dropped, each field capped (cut, never
 * a failure), the whole within `maxChars` of JSON. Null only without an id, kind and revision to
 * address. A client's `sealedLinkToken` is never kept.
 */
export function normalizeArtifactViewContext(value: unknown, maxChars = ARTIFACT_CONTEXT_BODY_MAX_CHARS): ArtifactViewContext | null {
  if (!isRecord(value)) return null
  const artifactId = idOf(value.artifactId)
  const kind = ARTIFACT_KINDS.find((known) => known === value.kind)
  const revision = intIn(value.revision, 1, Number.MAX_SAFE_INTEGER)
  if (!artifactId || !kind || !revision) return null
  const marks: Marks = new Set(
    Array.isArray(value.truncated) ? ARTIFACT_VIEW_TRUNCATIONS.filter((mark) => (value.truncated as unknown[]).includes(mark)) : [],
  )
  let selection: ArtifactSelection | null = null
  if (value.selection !== undefined && value.selection !== null) {
    selection = normalizeSelection(value.selection, marks)
    if (!selection) marks.add('selection')
  }
  const context: ArtifactViewContext = defined({
    artifactId,
    kind,
    title: typeof value.title === 'string' ? clipped(value.title, ARTIFACT_TITLE_MAX_CHARS, marks, 'title')! : '',
    revision,
    mode: ARTIFACT_VIEW_MODES.find((mode) => mode === value.mode) ?? 'viewing',
    selection,
    dirty: value.dirty === true,
    lastEditedByUserAt: typeof value.lastEditedByUserAt === 'string' && value.lastEditedByUserAt.length <= 40 ? value.lastEditedByUserAt : null,
    linkToken: typeof value.linkToken === 'string' && LINK_TOKEN.test(value.linkToken) ? value.linkToken : undefined,
  })
  const fitted = fitArtifactViewContext(context, (next) => JSON.stringify(next).length <= maxChars, marks)
  // The run body's schema is strict: whatever this returns must read there, or a run would fail on it.
  const checked = artifactViewContextSchema.safeParse(fitted)
  return checked.success ? checked.data : null
}

/**
 * The context as a stored copy keeps it (a saved draft, a queued message): never a link token,
 * which lives in memory only (artifact-handoff.ts). A send from a stored copy reads as the user.
 */
export function withoutLinkToken<T extends ArtifactViewContext | null | undefined>(context: T): T {
  if (!context || (context.linkToken === undefined && context.sealedLinkToken === undefined)) return context
  const { linkToken: _token, sealedLinkToken: _sealed, ...rest } = context
  return rest as T
}

const base64 = (text: string) => {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

/**
 * The header copy: the round-4 shape (no link token, no `truncated`, no sealed token), cut to the
 * header's cap. Null only for a context with nothing to address.
 */
export function encodeArtifactViewContext(context: unknown): string | null {
  const normalized = normalizeArtifactViewContext(context)
  if (!normalized) return null
  const { linkToken: _token, sealedLinkToken: _sealed, truncated: _marks, ...legacy } = normalized
  // Round-5 selection fields stay out of the round-4 header: only the body carries them.
  if (legacy.selection?.kind === 'slides' && legacy.selection.slideIds) legacy.selection = defined({ ...legacy.selection, slideIds: undefined })
  if (legacy.selection?.kind === 'whiteboard' && legacy.selection.viewport) legacy.selection = defined({ ...legacy.selection, viewport: undefined })
  const fitted = fitArtifactViewContext(legacy, (next) => base64(JSON.stringify(next)).length <= ARTIFACT_CONTEXT_HEADER_MAX_CHARS, new Set())
  const { truncated: _cut, ...shape } = fitted
  const encoded = base64(JSON.stringify(shape))
  return encoded.length <= ARTIFACT_CONTEXT_HEADER_MAX_CHARS ? encoded : null
}

/** The header's context, or null for an absent, oversized or malformed one (a send never fails on it). */
export function decodeArtifactViewContext(header: string | null | undefined): ArtifactViewContext | null {
  if (!header || header.length > ARTIFACT_CONTEXT_HEADER_MAX_CHARS || !/^[A-Za-z0-9+/]*={0,2}$/.test(header)) return null
  try {
    const binary = atob(header)
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
    return normalizeArtifactViewContext(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)))
  } catch {
    return null
  }
}

/**
 * The run's context as the API reads it: the body's when it reads, else the header's; null when
 * neither does (never a failed run). The caller seals any `linkToken` before storing the run.
 */
export function resolveArtifactViewContext(input: {
  body: unknown
  header: string | null | undefined
}): { context: ArtifactViewContext; source: 'body' | 'header' } | null {
  const fromBody = input.body === undefined ? null : normalizeArtifactViewContext(input.body)
  if (fromBody) return { context: fromBody, source: 'body' }
  const fromHeader = decodeArtifactViewContext(input.header)
  return fromHeader ? { context: fromHeader, source: 'header' } : null
}
