/**
 * Round-5 deck edits, pure and shared by the editor and the agent's patch ops: the aspect switch
 * with element reflow, magic-move pairs between two slides, connector geometry, find and
 * replace across a deck, Markdown / outline import, and design-system tokens (from a Design
 * artifact's tokens, with WCAG contrast). Every edit returns a new deck, or its input unchanged
 * when nothing applies (callers compare identity).
 */

import {
  DECK_SPACINGS,
  DESIGN_SIZE,
  ELEMENT_BOUNDS,
  FONT_IDS,
  LIMITS,
  TOKEN_COLOR_ROLES,
  type Deck,
  type DeckAspect,
  type DeckSpacing,
  type FontId,
  type Slide,
  type SlideElement,
  type TokenColorRole,
} from './slides'
import { clampBox, uniqueElementId, type Box } from './slides-elements'
import { uniqueSlideId } from './slides-ops'

const round = (value: number) => Math.round(value * 10) / 10
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

// ---------------------------------------------------------------------------
// Aspect ratio

/**
 * Switch the deck to `aspect` and reflow its free elements to the new canvas width: each is
 * scaled by the width ratio about the vertical line it sat on (a 16:9 box a quarter of the way
 * across stays a quarter of the way across) and kept on the same vertical centre; text sizes
 * scale with it. The layouts reflow by themselves. Undoing restores the exact old deck.
 */
export function setDeckAspect(deck: Deck, aspect: DeckAspect): Deck {
  if (deck.aspect === aspect) return deck
  const factor = DESIGN_SIZE[aspect].width / DESIGN_SIZE[deck.aspect].width
  const slides = deck.slides.map((slide) => {
    if (!slide.elements?.length) return slide
    return { ...slide, elements: slide.elements.map((element) => reflowElement(element, factor)) }
  })
  return { ...deck, aspect, slides }
}

function reflowElement(element: SlideElement, factor: number): SlideElement {
  const w = element.w * factor
  const h = element.type === 'line' || element.type === 'arrow' || element.type === 'connector' ? element.h : element.h * factor
  const cy = element.y + element.h / 2
  const box = clampBox({ x: element.x * factor, y: cy - h / 2, w, h })
  const next = { ...element, ...box } as SlideElement & { size?: number }
  if ('size' in element && typeof element.size === 'number')
    next.size = round(clamp(element.size * factor, ELEMENT_BOUNDS.minFont, ELEMENT_BOUNDS.maxFont))
  return next
}

// ---------------------------------------------------------------------------
// Magic move

export type MagicMove = {
  id: string
  /** Where the element's centre was, relative to where it is now (design px). */
  dx: number
  dy: number
  /** Its old size over its new one. */
  sx: number
  sy: number
  /** Its old rotation (degrees). */
  fromRotation: number
}

/**
 * The free elements a magic-move transition glides: every element on `to` whose id is also on
 * `from` and that moved, resized or turned. Elements only on `to` fade in; only on `from`, out.
 */
export function magicMoves(from: Slide | undefined, to: Slide): MagicMove[] {
  if (!from?.elements?.length || !to.elements?.length) return []
  const before = new Map(from.elements.map((element) => [element.id, element]))
  const out: MagicMove[] = []
  for (const element of to.elements) {
    const old = before.get(element.id)
    if (!old || old.type !== element.type) continue
    const move: MagicMove = {
      id: element.id,
      dx: round(old.x + old.w / 2 - (element.x + element.w / 2)),
      dy: round(old.y + old.h / 2 - (element.y + element.h / 2)),
      sx: element.w ? Math.round((old.w / element.w) * 1000) / 1000 : 1,
      sy: element.h ? Math.round((old.h / element.h) * 1000) / 1000 : 1,
      fromRotation: old.rotation ?? 0,
    }
    if (move.dx || move.dy || move.sx !== 1 || move.sy !== 1 || move.fromRotation !== (element.rotation ?? 0)) out.push(move)
  }
  return out
}

// ---------------------------------------------------------------------------
// Connectors

type Point = { x: number; y: number }

/** Where the segment from a box's centre towards `towards` leaves the box. */
function exitPoint(box: Box, towards: Point): Point {
  const cx = box.x + box.w / 2
  const cy = box.y + box.h / 2
  const dx = towards.x - cx
  const dy = towards.y - cy
  if (!dx && !dy) return { x: cx, y: cy }
  const tx = dx ? box.w / 2 / Math.abs(dx) : Infinity
  const ty = dy ? box.h / 2 / Math.abs(dy) : Infinity
  const t = Math.min(tx, ty, 1)
  return { x: round(cx + dx * t), y: round(cy + dy * t) }
}

export type ConnectorLine = { x1: number; y1: number; x2: number; y2: number; bound: boolean }

/**
 * A connector's line on its slide: from the edge of its `from` element to the edge of its `to`
 * element (centre to centre, clipped at each box). With an end's element gone (deleted, or a
 * merge removed it) it falls back to a line across its own box, `bound: false`.
 */
export function connectorLine(slide: Slide, connector: Extract<SlideElement, { type: 'connector' }>): ConnectorLine {
  const find = (id: string) => slide.elements?.find((element) => element.id === id && element.type !== 'connector')
  const a = find(connector.from)
  const b = find(connector.to)
  if (!a || !b || a === b) {
    const mid = connector.y + connector.h / 2
    return { x1: connector.x, y1: mid, x2: connector.x + connector.w, y2: mid, bound: false }
  }
  const ca = { x: a.x + a.w / 2, y: a.y + a.h / 2 }
  const cb = { x: b.x + b.w / 2, y: b.y + b.h / 2 }
  const start = exitPoint(a, cb)
  const end = exitPoint(b, ca)
  return { x1: start.x, y1: start.y, x2: end.x, y2: end.y, bound: true }
}

/** A connector's stored box from its line (what is drawn if an end later goes missing). */
export function connectorBox(line: Pick<ConnectorLine, 'x1' | 'y1' | 'x2' | 'y2'>): Box {
  const x = Math.min(line.x1, line.x2)
  const y = Math.min(line.y1, line.y2)
  return clampBox({ x, y, w: Math.max(1, Math.abs(line.x2 - line.x1)), h: Math.max(1, Math.abs(line.y2 - line.y1)) })
}

export type ConnectResult = { ok: true; deck: Deck; id: string } | { ok: false; error: string }

/** Add a connector from one element to another on a slide (an arrow at `to` by default). */
export function connectElements(
  deck: Deck,
  slideId: string,
  from: string,
  to: string,
  look: { head?: 'none' | 'end' | 'both'; stroke?: Extract<SlideElement, { type: 'connector' }>['stroke']; id?: string } = {},
): ConnectResult {
  const index = deck.slides.findIndex((slide) => slide.id === slideId)
  const slide = deck.slides[index]
  if (!slide) return { ok: false, error: `there is no slide "${slideId}"` }
  const elements = slide.elements ?? []
  if (from === to) return { ok: false, error: 'a connector joins two different elements' }
  for (const id of [from, to]) {
    const element = elements.find((item) => item.id === id)
    if (!element) return { ok: false, error: `slide "${slideId}" has no element "${id}"` }
    if (element.type === 'connector') return { ok: false, error: `"${id}" is a connector; connect boxes, shapes, text or images` }
  }
  if (elements.length >= LIMITS.elements) return { ok: false, error: `a slide has at most ${LIMITS.elements} elements` }
  const id = look.id && !elements.some((item) => item.id === look.id) ? look.id : uniqueElementId(slide, 'connector')
  const draft: Extract<SlideElement, { type: 'connector' }> = {
    id,
    type: 'connector',
    x: 0,
    y: 0,
    w: 1,
    h: 1,
    from,
    to,
    stroke: look.stroke ?? 'ink',
    strokeWidth: 2,
    head: look.head ?? 'end',
  }
  const withDraft: Slide = { ...slide, elements: [...elements, draft] }
  const placed = { ...draft, ...connectorBox(connectorLine(withDraft, draft)) }
  const slides = [...deck.slides]
  // Connectors go to the back so they never cover what they join.
  slides[index] = { ...slide, elements: [placed, ...elements] }
  return { ok: true, deck: { ...deck, slides }, id }
}

// ---------------------------------------------------------------------------
// Find and replace

export type DeckTextField =
  | 'title'
  | 'subtitle'
  | 'body'
  | 'column0'
  | 'column1'
  | 'notes'
  | 'section'
  | 'sectionDescription'
  | 'imageAlt'
  | 'element'

export type FindOptions = { matchCase?: boolean; wholeWord?: boolean; includeNotes?: boolean }

export type DeckMatch = {
  slideId: string
  slideIndex: number
  field: DeckTextField
  /** The free element the text is in (`field` "element": its text, alt, label, title or description). */
  elementId?: string
  elementField?: 'text' | 'alt' | 'label' | 'title' | 'description'
  /** Character offset in that field's text, and the match's length. */
  start: number
  length: number
  /** The match with a little context, for the list. */
  excerpt: string
}

type TextSlot = {
  field: DeckTextField
  elementId?: string
  elementField?: DeckMatch['elementField']
  max: number
  get: (slide: Slide) => string | undefined
  set: (slide: Slide, text: string) => Slide
}

const ELEMENT_TEXT_FIELDS: Array<{ key: NonNullable<DeckMatch['elementField']>; max: number }> = [
  { key: 'text', max: LIMITS.elementText },
  { key: 'alt', max: LIMITS.alt },
  { key: 'label', max: LIMITS.alt },
  { key: 'title', max: LIMITS.linkTitle },
  { key: 'description', max: LIMITS.linkDescription },
]

/** The text of a slide a person reads, slot by slot (ids, URLs and colours are never matched). */
function textSlots(slide: Slide, includeNotes: boolean): TextSlot[] {
  const plain = (field: 'title' | 'subtitle' | 'body' | 'notes' | 'section' | 'sectionDescription', max: number): TextSlot => ({
    field,
    max,
    get: (s) => s[field],
    set: (s, text) => ({ ...s, [field]: text }),
  })
  const slots: TextSlot[] = [
    plain('title', LIMITS.title),
    plain('subtitle', LIMITS.subtitle),
    plain('body', LIMITS.markdown),
    ...[0, 1].map(
      (column): TextSlot => ({
        field: column === 0 ? 'column0' : 'column1',
        max: LIMITS.markdown,
        get: (s) => s.columns?.[column],
        set: (s, text) => {
          if (!s.columns) return s
          const columns: [string, string] = [...s.columns]
          columns[column] = text
          return { ...s, columns }
        },
      }),
    ),
    {
      field: 'imageAlt',
      max: LIMITS.alt,
      get: (s) => s.image?.alt,
      set: (s, text) => (s.image ? { ...s, image: { ...s.image, alt: text } } : s),
    },
    plain('section', LIMITS.section),
    plain('sectionDescription', LIMITS.sectionDescription),
  ]
  if (includeNotes) slots.push(plain('notes', LIMITS.notes))
  for (const element of slide.elements ?? []) {
    for (const { key, max } of ELEMENT_TEXT_FIELDS) {
      if (typeof (element as Record<string, unknown>)[key] !== 'string') continue
      slots.push({
        field: 'element',
        elementId: element.id,
        elementField: key,
        max,
        get: (s) => {
          const found = s.elements?.find((item) => item.id === element.id) as Record<string, unknown> | undefined
          return typeof found?.[key] === 'string' ? (found[key] as string) : undefined
        },
        set: (s, text) => ({
          ...s,
          elements: s.elements?.map((item) => (item.id === element.id ? ({ ...item, [key]: text } as SlideElement) : item)),
        }),
      })
    }
  }
  return slots
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function matcher(query: string, options: FindOptions): RegExp | null {
  if (!query) return null
  const core = escapeRegExp(query)
  return new RegExp(options.wholeWord ? `(?<![\\p{L}\\p{N}_])${core}(?![\\p{L}\\p{N}_])` : core, `gu${options.matchCase ? '' : 'i'}`)
}

/** Every match of `query` in the deck's text, slide by slide in reading order. */
export function findInDeck(deck: Deck, query: string, options: FindOptions = {}): DeckMatch[] {
  const pattern = matcher(query, options)
  if (!pattern) return []
  const includeNotes = options.includeNotes !== false
  const out: DeckMatch[] = []
  deck.slides.forEach((slide, slideIndex) => {
    for (const slot of textSlots(slide, includeNotes)) {
      const text = slot.get(slide)
      if (!text) continue
      for (const match of text.matchAll(pattern)) {
        const start = match.index ?? 0
        const from = Math.max(0, start - 24)
        const to = Math.min(text.length, start + match[0].length + 24)
        out.push({
          slideId: slide.id,
          slideIndex,
          field: slot.field,
          ...(slot.elementId ? { elementId: slot.elementId, elementField: slot.elementField } : {}),
          start,
          length: match[0].length,
          excerpt: `${from > 0 ? '…' : ''}${text.slice(from, to).replace(/\s+/g, ' ')}${to < text.length ? '…' : ''}`,
        })
        if (out.length >= 500) return
      }
    }
  })
  return out
}

export type ReplaceResult = { deck: Deck; replaced: number; skipped: number }

/**
 * Replace matches of `query` with `replacement`: every match, or only `only` (one match from
 * `findInDeck`, by slide, field, element and offset). A field the replacement would push past its
 * cap is left alone and counted in `skipped`; a title or other single-line field never gets a
 * newline. One deck out, so one undo step.
 */
export function replaceInDeck(
  deck: Deck,
  query: string,
  replacement: string,
  options: FindOptions = {},
  only?: Pick<DeckMatch, 'slideId' | 'field' | 'elementId' | 'elementField' | 'start'>,
): ReplaceResult {
  const pattern = matcher(query, options)
  if (!pattern) return { deck, replaced: 0, skipped: 0 }
  const includeNotes = options.includeNotes !== false
  let replaced = 0
  let skipped = 0
  const slides = deck.slides.map((slide) => {
    if (only && only.slideId !== slide.id) return slide
    let next = slide
    for (const slot of textSlots(slide, includeNotes)) {
      if (only && (only.field !== slot.field || only.elementId !== slot.elementId || only.elementField !== slot.elementField)) continue
      const text = slot.get(next)
      if (!text) continue
      const single = ['title', 'subtitle', 'section', 'imageAlt'].includes(slot.field) || slot.elementField === 'title'
      const value = single ? replacement.replace(/\s*\n\s*/g, ' ') : replacement
      let count = 0
      const result = text.replace(pattern, (match, ...rest) => {
        const offset = rest[rest.length - 2] as number
        if (only && offset !== only.start) return match
        count++
        return value
      })
      if (!count) continue
      if (result.length > slot.max) {
        skipped += count
        continue
      }
      replaced += count
      next = slot.set(next, result)
    }
    return next
  })
  return replaced ? { deck: { ...deck, slides }, replaced, skipped } : { deck, replaced: 0, skipped }
}

// ---------------------------------------------------------------------------
// Import: Markdown deck or a pasted outline

const BULLET = /^(\s*)(?:[-*+]|\d{1,9}[.)])\s+(.*)$/

function clip(text: string, max: number): string {
  const one = text.trim()
  return one.length > max ? `${one.slice(0, max - 1).trimEnd()}…` : one
}

type Draft = { layout: Slide['layout']; title?: string; subtitle?: string; body: string[]; notes: string[]; section?: string }

function finish(drafts: Draft[], deck: Pick<Deck, 'slides'>): Slide[] {
  let ids: Pick<Deck, 'slides'> = { slides: [...deck.slides] }
  const out: Slide[] = []
  for (const draft of drafts) {
    const body = draft.body.join('\n').replace(/\n{3,}/g, '\n\n').trim()
    if (!draft.title && !body && !draft.subtitle) continue
    const base = (draft.title ?? 'slide')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'slide'
    const id = ids.slides.some((slide) => slide.id === base) ? uniqueSlideId(ids as Deck, base) : base
    let layout = draft.layout
    if (layout === 'title-body' && !body) layout = draft.subtitle ? 'title' : 'section'
    const slide: Slide = { id, layout }
    if (draft.title) slide.title = clip(draft.title, LIMITS.title)
    if (draft.subtitle) slide.subtitle = clip(draft.subtitle, LIMITS.subtitle)
    if (body && layout !== 'title' && layout !== 'section') slide.body = body.slice(0, LIMITS.markdown)
    if (draft.notes.length) slide.notes = draft.notes.join('\n').trim().slice(0, LIMITS.notes)
    if (draft.section) slide.section = clip(draft.section, LIMITS.section)
    out.push(slide)
    ids = { slides: [...ids.slides, slide] }
    if (ids.slides.length >= LIMITS.slides) break
  }
  return out
}

/**
 * Slides from pasted text, two shapes:
 * - a Markdown deck: `---` between slides, or a `#` / `##` heading per slide. `#` starts a
 *   section (a section slide), `##` a title-and-body slide; a heading straight under a `#`
 *   becomes its subtitle; `> text` makes a quote slide (a `-- name` line its attribution);
 *   lines after `Notes:` (or `???`) are the speaker notes; everything else is the body.
 * - a plain outline (no headings, no `---`): each top-level line or bullet is a slide title and
 *   the indented bullets under it its body.
 * Ids are made from the titles, unique in `deck`. Caps are kept (text is clipped).
 */
export function slidesFromText(text: string, deck: Pick<Deck, 'slides'> = { slides: [] }): Slide[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const markdownDeck = lines.some((line) => /^#{1,3}\s+\S/.test(line) || /^-{3,}\s*$/.test(line))
  const drafts: Draft[] = []
  if (!markdownDeck) {
    let current: Draft | null = null
    for (const raw of lines) {
      if (!raw.trim()) continue
      const bullet = BULLET.exec(raw)
      const indent = (bullet ? bullet[1] : (/^\s*/.exec(raw)?.[0] ?? '')).replace(/\t/g, '  ').length
      const content = bullet ? bullet[2] : raw.trim()
      if (indent === 0 || !current) {
        current = { layout: 'title-body', title: content, body: [], notes: [] }
        drafts.push(current)
      } else {
        const depth = Math.max(0, Math.floor(indent / 2) - 1)
        current.body.push(`${'  '.repeat(depth)}- ${content}`)
      }
    }
    return finish(drafts, deck)
  }
  let current: Draft | null = null
  let inNotes = false
  let fenced = false
  const start = (draft: Draft) => {
    current = draft
    inNotes = false
    drafts.push(draft)
  }
  for (const raw of lines) {
    const line = raw.trimEnd()
    if (/^(```|~~~)/.test(line.trim())) fenced = !fenced
    if (!fenced && /^-{3,}\s*$/.test(line)) {
      current = null
      inNotes = false
      continue
    }
    const heading = fenced ? null : /^(#{1,3})\s+(.*)$/.exec(line)
    if (heading) {
      const level = heading[1].length
      const words = heading[2].trim()
      const draft = current as Draft | null
      if (draft && level > 1 && draft.layout === 'section' && !draft.subtitle && !draft.body.length) {
        draft.subtitle = words
        continue
      }
      if (draft && !draft.title && !draft.body.length) {
        draft.title = words
        if (level === 1) {
          draft.layout = 'section'
          draft.section = words
        }
        continue
      }
      start(level === 1 ? { layout: 'section', title: words, section: words, body: [], notes: [] } : { layout: 'title-body', title: words, body: [], notes: [] })
      continue
    }
    if (!fenced && /^(notes?:|\?\?\?)/i.test(line.trim())) {
      if (!current) start({ layout: 'title-body', body: [], notes: [] })
      inNotes = true
      const rest = line.trim().replace(/^(notes?:|\?\?\?)/i, '').trim()
      if (rest) (current as unknown as Draft).notes.push(rest)
      continue
    }
    if (!current) {
      if (!line.trim()) continue
      start({ layout: 'title-body', body: [], notes: [] })
    }
    const draft = current as unknown as Draft
    if (inNotes) {
      draft.notes.push(line)
      continue
    }
    const quote = fenced ? null : /^>\s?(.*)$/.exec(line)
    if (quote && (draft.layout === 'title-body' || draft.layout === 'quote') && !draft.body.some((item) => item.trim() && !item.startsWith('>'))) {
      draft.layout = 'quote'
      draft.body.push(quote[1])
      continue
    }
    const by = /^\s*(?:--|—|–)\s*(.+)$/.exec(line)
    if (draft.layout === 'quote' && by) {
      draft.subtitle = by[1]
      continue
    }
    draft.body.push(line)
  }
  return finish(drafts, deck)
}

/** Put imported slides in the deck: after slide `afterIndex` (-1: first), or instead of every slide. */
export function importSlides(deck: Deck, slides: readonly Slide[], mode: 'insert' | 'replace', afterIndex = deck.slides.length - 1): Deck {
  if (!slides.length) return deck
  if (mode === 'replace') return { ...deck, slides: slides.slice(0, LIMITS.slides) }
  const room = LIMITS.slides - deck.slides.length
  if (room <= 0) return deck
  const at = clamp(afterIndex + 1, 0, deck.slides.length)
  const next = [...deck.slides]
  next.splice(at, 0, ...slides.slice(0, room))
  return { ...deck, slides: next }
}

// ---------------------------------------------------------------------------
// Design-system tokens

export type DeckTokens = NonNullable<Deck['tokens']>

const HEX6 = /^#[0-9a-fA-F]{6}$/
const HEX3 = /^#[0-9a-fA-F]{3}$/

/** A colour as #rrggbb (from #rgb, #rrggbb or #rrggbbaa), or null. */
export function normaliseHex(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (HEX6.test(text)) return text.toLowerCase()
  if (HEX3.test(text)) return `#${[...text.slice(1)].map((c) => c + c).join('')}`.toLowerCase()
  if (/^#[0-9a-fA-F]{8}$/.test(text)) return text.slice(0, 7).toLowerCase()
  return null
}

/** Relative luminance of a #rrggbb colour (WCAG 2). */
function luminance(hex: string): number {
  const channel = (offset: number) => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5)
}

/** The WCAG contrast ratio of two #rrggbb colours (1 to 21), rounded to a hundredth. */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100
}

/** `a` mixed into `b` at `share` (0-1), as #rrggbb (CSS color-mix in srgb). */
export function mixHex(a: string, b: string, share: number): string {
  const part = (hex: string, offset: number) => parseInt(hex.slice(offset, offset + 2), 16)
  const out = [1, 3, 5].map((offset) => Math.round(part(a, offset) * share + part(b, offset) * (1 - share)))
  return `#${out.map((value) => value.toString(16).padStart(2, '0')).join('')}`
}

/**
 * A deck's colour roles as #rrggbb for one app palette: the deck's tokens where it has them, else
 * the app's light or dark theme (approximately: the slide CSS draws app tokens, which this file
 * cannot read). `tint` is the accent at 16% over the paper, as the canvas mixes it.
 */
export function deckPalette(deck: Pick<Deck, 'tokens'>, mode: 'light' | 'dark'): Record<TokenColorRole, string> {
  const app =
    mode === 'light'
      ? { ink: '#1a1a1d', soft: '#5c5c66', accent: '#507e35', paper: '#ffffff' }
      : { ink: '#ebebeb', soft: '#9e9e9e', accent: '#a7d78e', paper: '#171717' }
  const colors = deck.tokens?.colors ?? {}
  const ink = colors.ink ?? app.ink
  const soft = colors.soft ?? app.soft
  const accent = colors.accent ?? app.accent
  const paper = colors.paper ?? app.paper
  return { ink, soft, accent, paper, tint: colors.tint ?? mixHex(accent, paper, 0.16) }
}

/** Whether a deck's palette is fixed by its tokens (ink and paper both set): then it looks the same in light and dark. */
export const tokensFixPalette = (deck: Pick<Deck, 'tokens'>) => Boolean(deck.tokens?.colors?.ink && deck.tokens.colors.paper)

/**
 * A deck token set from a Design artifact's `tokens` (design.ts: named hex colours, fonts,
 * spacingUnit): `text` → ink, `muted` → soft, `primary` (else `brand`, `accent`) → accent,
 * `background` (else `surface`) → paper, `surface` → tint; its heading and body fonts; a spacing
 * unit of 6 or less → compact, 12 or more → roomy. Unknown or malformed parts are skipped, so
 * any JSON is safe to pass (a pasted tokens.json too: `{ "colors": {...}, "fonts": {...} }`).
 */
export function tokensFromDesign(
  source: unknown,
  name?: string,
): { tokens: DeckTokens; fonts?: { heading?: FontId; body?: FontId } } | null {
  if (!source || typeof source !== 'object') return null
  const record = source as Record<string, unknown>
  const inner = record.tokens && typeof record.tokens === 'object' ? (record.tokens as Record<string, unknown>) : record
  const colors = inner.colors && typeof inner.colors === 'object' ? (inner.colors as Record<string, unknown>) : {}
  const pick = (...names: string[]) => {
    for (const key of names) {
      const hex = normaliseHex(colors[key])
      if (hex) return hex
    }
    return undefined
  }
  const mapped: Partial<Record<TokenColorRole, string>> = {
    ink: pick('ink', 'text', 'foreground', 'on-background'),
    soft: pick('soft', 'muted', 'text-muted', 'secondary-text'),
    accent: pick('accent', 'primary', 'brand'),
    paper: pick('paper', 'background', 'bg'),
    tint: pick('tint', 'surface', 'primary-container'),
  }
  const tokenColors: NonNullable<DeckTokens['colors']> = {}
  for (const role of TOKEN_COLOR_ROLES) if (mapped[role]) tokenColors[role] = mapped[role]
  const tokens: DeckTokens = {}
  const label = typeof name === 'string' && name.trim() ? name : typeof inner.name === 'string' ? inner.name : undefined
  if (label?.trim()) tokens.name = clip(label, LIMITS.tokenName)
  if (Object.keys(tokenColors).length) tokens.colors = tokenColors
  const unit = typeof inner.spacingUnit === 'number' ? inner.spacingUnit : undefined
  const spacing = typeof inner.spacing === 'string' && (DECK_SPACINGS as readonly string[]).includes(inner.spacing) ? (inner.spacing as DeckSpacing) : undefined
  if (spacing) tokens.spacing = spacing
  else if (unit !== undefined) tokens.spacing = unit <= 6 ? 'compact' : unit >= 12 ? 'roomy' : 'normal'
  const fontsIn = inner.fonts && typeof inner.fonts === 'object' ? (inner.fonts as Record<string, unknown>) : {}
  const font = (value: unknown) => (typeof value === 'string' && (FONT_IDS as readonly string[]).includes(value) ? (value as FontId) : undefined)
  const fonts = { heading: font(fontsIn.heading), body: font(fontsIn.body) }
  if (!tokens.colors && !tokens.spacing && !fonts.heading && !fonts.body) return null
  return {
    tokens,
    ...(fonts.heading || fonts.body ? { fonts: { ...(fonts.heading ? { heading: fonts.heading } : {}), ...(fonts.body ? { body: fonts.body } : {}) } } : {}),
  }
}

/**
 * Install a token set on the deck (null removes it): its colours and spacing, and its fonts when
 * it names any. One deck out, so one undo step.
 */
export function setDeckTokens(deck: Deck, tokens: DeckTokens | null, fonts?: { heading?: FontId; body?: FontId }): Deck {
  const next: Deck = { ...deck }
  if (tokens && Object.keys(tokens).length) next.tokens = tokens
  else delete next.tokens
  if (fonts && (fonts.heading || fonts.body)) next.fonts = { ...deck.fonts, ...fonts }
  return JSON.stringify(next) === JSON.stringify(deck) ? deck : next
}

// ---------------------------------------------------------------------------
// Reading order

/**
 * A slide's free elements in the order a screen reader (and an export) reads them: those with a
 * `readOrder`, lowest first, then the rest back to front (their stacking order). Connectors are
 * left out: they say nothing on their own.
 */
export function slideReadingOrder(slide: Slide): SlideElement[] {
  const elements = (slide.elements ?? []).filter((element) => element.type !== 'connector')
  const numbered = elements.filter((element) => element.readOrder !== undefined).sort((a, b) => (a.readOrder ?? 0) - (b.readOrder ?? 0))
  return [...numbered, ...elements.filter((element) => element.readOrder === undefined)]
}

/** Number every listed element's `readOrder` 1..n in that order; the others lose theirs. */
export function setReadingOrder(deck: Deck, slideId: string, ids: readonly string[]): Deck {
  const index = deck.slides.findIndex((slide) => slide.id === slideId)
  const slide = deck.slides[index]
  if (!slide?.elements?.length) return deck
  const position = new Map(ids.map((id, i) => [id, i + 1]))
  let changed = false
  const elements = slide.elements.map((element) => {
    const at = position.get(element.id)
    if (at === element.readOrder) return element
    changed = true
    const next = { ...element }
    if (at === undefined) delete next.readOrder
    else next.readOrder = at
    return next
  })
  if (!changed) return deck
  const slides = [...deck.slides]
  slides[index] = { ...slide, elements }
  return { ...deck, slides }
}

/**
 * Set the click builds of a slide's free elements: `groups[i]` appear together on click i+1 after
 * the bullets; elements in no group arrive with the slide.
 */
export function setElementBuilds(deck: Deck, slideId: string, groups: ReadonlyArray<readonly string[]>): Deck {
  const index = deck.slides.findIndex((slide) => slide.id === slideId)
  const slide = deck.slides[index]
  if (!slide?.elements?.length) return deck
  const position = new Map<string, number>()
  groups.forEach((group, i) => group.forEach((id) => position.set(id, i + 1)))
  let changed = false
  const elements = slide.elements.map((element) => {
    const at = position.get(element.id)
    if (at === element.build) return element
    changed = true
    const next = { ...element }
    if (at === undefined) delete next.build
    else next.build = at
    return next
  })
  if (!changed) return deck
  const slides = [...deck.slides]
  slides[index] = { ...slide, elements }
  return { ...deck, slides }
}

/** A slide's element build groups in click order (the inverse of `setElementBuilds`). */
export function elementBuildGroups(slide: Slide): string[][] {
  const byStep = new Map<number, string[]>()
  for (const element of slide.elements ?? []) if (element.build) byStep.set(element.build, [...(byStep.get(element.build) ?? []), element.id])
  return [...byStep.entries()].sort(([a], [b]) => a - b).map(([, ids]) => ids)
}
