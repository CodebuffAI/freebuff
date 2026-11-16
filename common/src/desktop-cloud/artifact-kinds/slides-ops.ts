/**
 * Pure deck edits, shared by the editor UI and the agent's edit_artifact ops (packages/internal kind-ops.ts). Every function
 * returns a new deck and leaves its input untouched; each result still satisfies `deckSchema`
 * when its input did (new slides carry the payload their layout needs, ids stay unique, a deck
 * never drops below one slide or above `LIMITS.slides`).
 */

import {
  LIMITS,
  TEXT_ALIGNS,
  TEXT_COLORS,
  TEXT_SIZES,
  type Deck,
  type DeckTransition,
  type Slide,
  type SlideBuild,
  type SlideLayout,
  type TextElement,
  type TextStyle,
} from './slides'
import { isSameOriginImagePath } from '../artifact-image-src'

const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value))

/** A fresh id not used in the deck: `<base>-2`, `<base>-3`, … (or `slide-N`). Deterministic. */
export function uniqueSlideId(deck: Deck, base = 'slide'): string {
  const used = new Set(deck.slides.map((slide) => slide.id))
  const stem = (base.replace(/-\d+$/, '') || 'slide').slice(0, LIMITS.idLength - 4)
  for (let n = 2; ; n++) {
    const candidate = `${stem}-${n}`
    if (!used.has(candidate)) return candidate
  }
}

const SAMPLE_CHART: NonNullable<Slide['chart']> = {
  type: 'bar',
  x: 'label',
  series: [{ key: 'value', label: 'Value' }],
  data: [
    { label: 'A', value: 3 },
    { label: 'B', value: 5 },
    { label: 'C', value: 4 },
  ],
}

/** A new slide of `layout`, with placeholder text and whatever payload the layout requires. */
export function blankSlide(id: string, layout: SlideLayout = 'title-body'): Slide {
  switch (layout) {
    case 'title':
      return { id, layout, title: 'Title', subtitle: 'Subtitle' }
    case 'section':
      return { id, layout, title: 'Section' }
    case 'two-column':
      return {
        id,
        layout,
        title: 'Title',
        columns: ['- First point', '- First point'],
      }
    case 'image':
      return {
        id,
        layout,
        title: 'Title',
        image: { src: '/Placeholder.svg', alt: 'Image' },
      }
    case 'chart':
      return { id, layout, title: 'Title', chart: SAMPLE_CHART }
    case 'quote':
      return { id, layout, body: 'A sentence worth repeating.', subtitle: 'Someone' }
    case 'blank':
      return { id, layout }
    case 'title-body':
      return { id, layout, title: 'Title', body: '- First point\n- Second point' }
  }
}

/**
 * Switch a slide's layout, keeping its text and filling in any payload the new layout needs
 * (two columns from the body, a sample chart, a placeholder image).
 */
export function withLayout(slide: Slide, layout: SlideLayout): Slide {
  const next: Slide = { ...slide, layout }
  const template = blankSlide(slide.id, layout)
  if (layout === 'two-column' && !next.columns) {
    next.columns = [slide.body ?? '', '']
  }
  if (layout === 'image' && !next.image) next.image = template.image
  if (layout === 'chart' && !next.chart) next.chart = template.chart
  return next
}

/** Insert `slide` (or a blank one) after `afterIndex` (-1 = at the start). */
export function addSlide(
  deck: Deck,
  afterIndex: number,
  layout: SlideLayout = 'title-body',
): { deck: Deck; id: string } {
  if (deck.slides.length >= LIMITS.slides) {
    return { deck, id: deck.slides[clamp(afterIndex, 0, deck.slides.length - 1)].id }
  }
  const id = uniqueSlideId(deck)
  const at = clamp(afterIndex + 1, 0, deck.slides.length)
  const slides = [...deck.slides]
  slides.splice(at, 0, blankSlide(id, layout))
  return { deck: { ...deck, slides }, id }
}

/** Copy the slide with `id` to just after it, under a fresh id. */
export function duplicateSlide(deck: Deck, id: string): { deck: Deck; id: string } {
  const index = deck.slides.findIndex((slide) => slide.id === id)
  if (index === -1 || deck.slides.length >= LIMITS.slides) return { deck, id }
  const copyId = uniqueSlideId(deck, id)
  const copy: Slide = structuredClone({ ...deck.slides[index], id: copyId })
  // A copy continues its original's section; it does not start another one of the same name.
  delete copy.section
  delete copy.sectionDescription
  const slides = [...deck.slides]
  slides.splice(index + 1, 0, copy)
  return { deck: { ...deck, slides }, id: copyId }
}

/**
 * Remove the slide with `id`. The last slide cannot be removed. Returns the id that should be
 * selected next (the slide that took its place, or the new last one).
 */
export function deleteSlide(deck: Deck, id: string): { deck: Deck; selectId: string } {
  const index = deck.slides.findIndex((slide) => slide.id === id)
  if (index === -1 || deck.slides.length <= 1) return { deck, selectId: id }
  const slides = deck.slides.filter((slide) => slide.id !== id)
  return { deck: { ...deck, slides }, selectId: slides[Math.min(index, slides.length - 1)].id }
}

/** Move the slide at `from` so it lands at index `to` (both clamped). */
export function moveSlide(deck: Deck, from: number, to: number): Deck {
  const last = deck.slides.length - 1
  if (from < 0 || from > last) return deck
  const target = clamp(to, 0, last)
  if (target === from) return deck
  const slides = [...deck.slides]
  const [moved] = slides.splice(from, 1)
  slides.splice(target, 0, moved)
  return { ...deck, slides }
}

/**
 * Put the slides in the order of `ids` (the agent's reorder). `ids` must name every slide
 * exactly once; otherwise the deck comes back unchanged and `ok` is false.
 */
export function reorderSlides(deck: Deck, ids: string[]): { deck: Deck; ok: boolean } {
  const byId = new Map(deck.slides.map((slide) => [slide.id, slide]))
  if (ids.length !== deck.slides.length || new Set(ids).size !== ids.length) {
    return { deck, ok: false }
  }
  const slides: Slide[] = []
  for (const id of ids) {
    const slide = byId.get(id)
    if (!slide) return { deck, ok: false }
    slides.push(slide)
  }
  return { deck: { ...deck, slides }, ok: true }
}

/** Replace the slide with `slide.id` wholesale (the agent's per-slide rewrite). */
export function replaceSlide(deck: Deck, slide: Slide): { deck: Deck; ok: boolean } {
  const index = deck.slides.findIndex((s) => s.id === slide.id)
  if (index === -1) return { deck, ok: false }
  const slides = [...deck.slides]
  slides[index] = slide
  return { deck: { ...deck, slides }, ok: true }
}

type TextField = 'title' | 'subtitle' | 'body' | 'notes'

const TEXT_LIMIT: Record<TextField, number> = {
  title: LIMITS.title,
  subtitle: LIMITS.subtitle,
  body: LIMITS.markdown,
  notes: LIMITS.notes,
}

/**
 * Set one text field of one slide, clipped to its cap. An empty string removes the field, so a
 * cleared title does not linger as `""`.
 */
export function setSlideText(deck: Deck, id: string, field: TextField, text: string): Deck {
  const index = deck.slides.findIndex((slide) => slide.id === id)
  if (index === -1) return deck
  const clipped = text.slice(0, TEXT_LIMIT[field])
  const current = deck.slides[index]
  if ((current[field] ?? '') === clipped) return deck
  const next: Slide = { ...current }
  if (clipped === '') delete next[field]
  else next[field] = clipped
  const slides = [...deck.slides]
  slides[index] = next
  return { ...deck, slides }
}

/** Set one of a two-column slide's columns, clipped to the Markdown cap. */
export function setSlideColumn(deck: Deck, id: string, column: 0 | 1, text: string): Deck {
  const index = deck.slides.findIndex((slide) => slide.id === id)
  const current = deck.slides[index]
  if (!current?.columns) return deck
  const clipped = text.slice(0, LIMITS.markdown)
  if (current.columns[column] === clipped) return deck
  const columns: [string, string] = [...current.columns]
  columns[column] = clipped
  const slides = [...deck.slides]
  slides[index] = { ...current, columns }
  return { ...deck, slides }
}

export function setSlideLayout(deck: Deck, id: string, layout: SlideLayout): Deck {
  const index = deck.slides.findIndex((slide) => slide.id === id)
  if (index === -1 || deck.slides[index].layout === layout) return deck
  const slides = [...deck.slides]
  slides[index] = withLayout(slides[index], layout)
  return { ...deck, slides }
}

export function setDeckTitle(deck: Deck, title: string): Deck {
  const clipped = title.trim().slice(0, LIMITS.title)
  if (clipped === '' || clipped === deck.title) return deck
  return { ...deck, title: clipped }
}

/** Set a slide's image (src, alt and fit). An unsafe or empty src leaves the deck unchanged. */
export function setSlideImage(deck: Deck, id: string, image: NonNullable<Slide['image']>): Deck {
  const index = deck.slides.findIndex((slide) => slide.id === id)
  const src = image.src.trim()
  const safe = src.startsWith('https://') || isSameOriginImagePath(src)
  if (index === -1 || !safe || src.length > LIMITS.src) return deck
  const next: NonNullable<Slide['image']> = { src, alt: image.alt.slice(0, LIMITS.alt) }
  if (image.fit) next.fit = image.fit
  const position = image.position && clampPosition(image.position)
  if (position && (position.x !== 50 || position.y !== 50)) next.position = position
  const slides = [...deck.slides]
  slides[index] = { ...slides[index], image: next }
  return { ...deck, slides }
}

/** Set a slide's chart. The caller hands a spec that already passed `chartSpecSchema`. */
export function setSlideChart(deck: Deck, id: string, chart: NonNullable<Slide['chart']>): Deck {
  const index = deck.slides.findIndex((slide) => slide.id === id)
  if (index === -1) return deck
  const slides = [...deck.slides]
  slides[index] = { ...slides[index], chart }
  return { ...deck, slides }
}

/** Name (or, with an empty name, clear) the section a slide starts. */
export function setSlideSection(deck: Deck, id: string, name: string): Deck {
  const index = deck.slides.findIndex((slide) => slide.id === id)
  if (index === -1) return deck
  const clipped = name.replace(/\s+/g, ' ').trim().slice(0, LIMITS.section)
  const current = deck.slides[index]
  if ((current.section ?? '') === clipped) return deck
  const next: Slide = { ...current }
  if (clipped) next.section = clipped
  else {
    delete next.section
    // A description belongs to the section it describes.
    delete next.sectionDescription
  }
  const slides = [...deck.slides]
  slides[index] = next
  return { ...deck, slides }
}

/**
 * Describe (or, with empty text, stop describing) the section the slide starts. A slide that
 * starts no section takes no description: the deck comes back unchanged.
 */
export function setSectionDescription(deck: Deck, id: string, text: string): Deck {
  const index = deck.slides.findIndex((slide) => slide.id === id)
  if (index === -1) return deck
  const current = deck.slides[index]
  const clipped = text.replace(/[ \t]+/g, ' ').trim().slice(0, LIMITS.sectionDescription)
  if (!current.section && clipped) return deck
  if ((current.sectionDescription ?? '') === clipped) return deck
  const next: Slide = { ...current }
  if (clipped) next.sectionDescription = clipped
  else delete next.sectionDescription
  const slides = [...deck.slides]
  slides[index] = next
  return { ...deck, slides }
}

// ---------------------------------------------------------------------------
// Transitions: a slide may override the deck's present-mode transition.

/** How present mode arrives at the slide at `index`: its own, else the deck's, else fade. */
export function slideTransition(deck: Pick<Deck, 'transition' | 'slides'>, index: number): DeckTransition {
  return deck.slides[index]?.transition ?? deck.transition ?? 'fade'
}

/** Set (or, with `undefined`, clear back to the deck's) one slide's transition. */
export function setSlideTransition(deck: Deck, id: string, transition: DeckTransition | undefined): Deck {
  const index = deck.slides.findIndex((slide) => slide.id === id)
  if (index === -1) return deck
  const current = deck.slides[index]
  if (current.transition === transition) return deck
  const next: Slide = { ...current }
  if (transition) next.transition = transition
  else delete next.transition
  const slides = [...deck.slides]
  slides[index] = next
  return { ...deck, slides }
}

// ---------------------------------------------------------------------------
// Several slides at once (the filmstrip's multi-select).

/** Remove the slides with these ids; at least one slide always stays (the first not removed, else the first). */
export function deleteSlides(deck: Deck, ids: readonly string[]): { deck: Deck; selectId: string } {
  const drop = new Set(ids)
  const first = deck.slides.findIndex((slide) => drop.has(slide.id))
  if (first === -1) return { deck, selectId: deck.slides[0].id }
  let slides = deck.slides.filter((slide) => !drop.has(slide.id))
  // Never empty: keep the first selected slide.
  if (!slides.length) slides = [deck.slides[first]]
  if (slides.length === deck.slides.length) return { deck, selectId: deck.slides[first].id }
  return { deck: { ...deck, slides }, selectId: slides[Math.min(first, slides.length - 1)].id }
}

/** Copy the slides with these ids, as one block after the last of them, in deck order. */
export function duplicateSlides(deck: Deck, ids: readonly string[]): { deck: Deck; ids: string[] } {
  const chosen = deck.slides.filter((slide) => ids.includes(slide.id))
  if (!chosen.length || deck.slides.length + chosen.length > LIMITS.slides) return { deck, ids: [] }
  let working = deck
  const copies: Slide[] = []
  for (const slide of chosen) {
    const copyId = uniqueSlideId(working, slide.id)
    const copy: Slide = structuredClone({ ...slide, id: copyId })
    delete copy.section
    delete copy.sectionDescription
    copies.push(copy)
    working = { ...working, slides: [...working.slides, copy] }
  }
  const last = Math.max(...chosen.map((slide) => deck.slides.indexOf(slide)))
  const slides = [...deck.slides]
  slides.splice(last + 1, 0, ...copies)
  return { deck: { ...deck, slides }, ids: copies.map((copy) => copy.id) }
}

/**
 * Move the slides with these ids one place earlier (-1) or later (1), as a block in their deck
 * order (gathered next to the first of them). Unchanged when the block is already at that end.
 */
export function moveSlides(deck: Deck, ids: readonly string[], direction: -1 | 1): Deck {
  const chosen = new Set(ids)
  const indices = deck.slides.flatMap((slide, index) => (chosen.has(slide.id) ? [index] : []))
  if (!indices.length) return deck
  const block = indices.map((index) => deck.slides[index])
  const rest = deck.slides.filter((slide) => !chosen.has(slide.id))
  // Where the block starts among the other slides, then one place along.
  const before = deck.slides.slice(0, indices[0]).filter((slide) => !chosen.has(slide.id)).length
  const at = before + direction
  if (at < 0 || at > rest.length) return deck
  const slides = [...rest]
  slides.splice(at, 0, ...block)
  if (slides.every((slide, index) => slide === deck.slides[index])) return deck
  return { ...deck, slides }
}

/**
 * Make these slides one section named `name`: the first of them starts it, the others stop
 * starting sections of their own.
 */
export function sectionForSlides(deck: Deck, ids: readonly string[], name: string): Deck {
  const chosen = deck.slides.filter((slide) => ids.includes(slide.id))
  if (!chosen.length) return deck
  let next = setSlideSection(deck, chosen[0].id, name)
  for (const slide of chosen.slice(1)) next = setSlideSection(next, slide.id, '')
  return next
}

const DECK_STYLE_KEYS = ['theme', 'accent', 'transition', 'fonts', 'footer', 'slideNumbers', 'tokens'] as const
export type DeckStyle = Partial<Pick<Deck, (typeof DECK_STYLE_KEYS)[number]>>

/**
 * The deck's look: theme, accent, present-mode transition, fonts, footer text and slide numbers.
 * `undefined` clears a field (back to its default); `slideNumbers: true` is the default, so it
 * clears too; fonts with neither role set clear; footer text is clipped to its cap.
 */
export function setDeckStyle(deck: Deck, style: DeckStyle): Deck {
  const wanted: Record<string, unknown> = { ...style }
  if ('footer' in wanted && typeof wanted.footer === 'string') wanted.footer = (wanted.footer as string).replace(/\s+/g, ' ').slice(0, LIMITS.footer)
  if ('slideNumbers' in wanted && wanted.slideNumbers === true) wanted.slideNumbers = undefined
  if ('fonts' in wanted && wanted.fonts) {
    const fonts = { ...(wanted.fonts as NonNullable<Deck['fonts']>) }
    if (!fonts.heading) delete fonts.heading
    if (!fonts.body) delete fonts.body
    wanted.fonts = fonts.heading || fonts.body ? fonts : undefined
  }
  const next: Deck = { ...deck }
  let changed = false
  for (const key of DECK_STYLE_KEYS) {
    if (!(key in wanted) || JSON.stringify(wanted[key]) === JSON.stringify(deck[key])) continue
    changed = true
    if (wanted[key] === undefined) delete next[key]
    else (next as Record<string, unknown>)[key] = wanted[key]
  }
  return changed ? next : deck
}

/** The footer a content slide shows: its text (absent: the deck title) and whether it numbers. */
export function deckFooter(deck: Pick<Deck, 'title' | 'footer' | 'slideNumbers'>): { text: string; numbers: boolean } {
  return { text: deck.footer ?? deck.title, numbers: deck.slideNumbers !== false }
}

// ---------------------------------------------------------------------------
// Element styles: a slide's title, subtitle or body, restyled from the theme's roles.

/** The text elements a layout draws, in reading order (what the style picker offers). */
export function stylableElements(layout: SlideLayout): TextElement[] {
  switch (layout) {
    case 'title':
    case 'section':
    case 'image':
      return ['title', 'subtitle']
    case 'title-body':
    case 'two-column':
    case 'chart':
      return ['title', 'body']
    case 'quote':
      return ['body', 'subtitle']
    case 'blank':
      return ['body']
  }
}

/** A style patch: a value sets that field, `null` clears it; `null` for the whole clears all. */
export type TextStylePatch = { [K in keyof TextStyle]?: TextStyle[K] | null }

const validStyleValue = (key: keyof TextStyle, value: unknown) =>
  (key === 'size' && (TEXT_SIZES as readonly unknown[]).includes(value)) ||
  (key === 'align' && (TEXT_ALIGNS as readonly unknown[]).includes(value)) ||
  (key === 'color' && (TEXT_COLORS as readonly unknown[]).includes(value))

/**
 * Merge `patch` into one element's style. Empty styles (and an empty `style`) are removed, so
 * a reset slide is byte-for-byte what it was before it was styled. Unknown values are ignored.
 */
export function setElementStyle(deck: Deck, id: string, element: TextElement, patch: TextStylePatch | null): Deck {
  const index = deck.slides.findIndex((slide) => slide.id === id)
  if (index === -1) return deck
  const current = deck.slides[index]
  const style: TextStyle = patch === null ? {} : { ...current.style?.[element] }
  if (patch) {
    for (const key of ['size', 'align', 'color'] as const) {
      if (!(key in patch)) continue
      const value = patch[key]
      if (value === null || value === undefined) delete style[key]
      else if (validStyleValue(key, value)) (style as Record<string, unknown>)[key] = value
    }
  }
  // `md` is the layout's own size: storing it would only make the body differ from unstyled.
  if (style.size === 'md') delete style.size
  const all = { ...current.style }
  if (Object.keys(style).length) all[element] = style
  else delete all[element]
  const next: Slide = { ...current }
  if (Object.keys(all).length) next.style = all
  else delete next.style
  if (JSON.stringify(next.style) === JSON.stringify(current.style)) return deck
  const slides = [...deck.slides]
  slides[index] = next
  return { ...deck, slides }
}

// ---------------------------------------------------------------------------
// Builds: present mode reveals a slide's top-level bullets one per click.

/** Layouts whose body can hold bullets to build. */
export const BUILDABLE_LAYOUTS: readonly SlideLayout[] = ['title-body', 'two-column', 'blank']

/** Turn a slide's build on or off (`undefined`). A layout without a body cannot build. */
export function setSlideBuild(deck: Deck, id: string, build: SlideBuild | undefined): Deck {
  const index = deck.slides.findIndex((slide) => slide.id === id)
  if (index === -1) return deck
  const current = deck.slides[index]
  const wanted = build && BUILDABLE_LAYOUTS.includes(current.layout) ? build : undefined
  if (current.build === wanted) return deck
  const next: Slide = { ...current }
  if (wanted) next.build = wanted
  else delete next.build
  const slides = [...deck.slides]
  slides[index] = next
  return { ...deck, slides }
}

/**
 * The top-level list items in a Markdown body (the bullets a build reveals): lines that start
 * a `-`, `*`, `+` or `1.` item with no indent, outside fenced code. Matches how GFM renders
 * them as direct children of a top-level list.
 */
export function bulletCount(markdown: string | undefined): number {
  if (!markdown) return 0
  let fenced = false
  let count = 0
  for (const line of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    if (/^(```|~~~)/.test(line.trimStart())) fenced = !fenced
    else if (!fenced && /^(?:[-*+]|\d{1,9}[.)])[ \t]+\S/.test(line)) count++
  }
  return count
}

/** Every list item in a Markdown body, nested ones too (what an `all` build reveals), outside code. */
export function listItemCount(markdown: string | undefined): number {
  if (!markdown) return 0
  let fenced = false
  let count = 0
  for (const line of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    if (/^(```|~~~)/.test(line.trimStart())) fenced = !fenced
    else if (!fenced && /^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+\S/.test(line)) count++
  }
  return count
}

/** The clicks a slide's bullet build takes (0: its text arrives whole). */
export function bulletSteps(slide: Slide): number {
  if (!slide.build || !BUILDABLE_LAYOUTS.includes(slide.layout)) return 0
  const count = slide.build === 'all' ? listItemCount : bulletCount
  if (slide.layout === 'two-column') return count(slide.columns?.[0]) + count(slide.columns?.[1])
  return count(slide.body)
}

/** The distinct build numbers of a slide's free elements, in order (each one click, after the bullets). */
export function elementBuildNumbers(slide: Slide): number[] {
  return [...new Set((slide.elements ?? []).flatMap((element) => (element.build ? [element.build] : [])))].sort((a, b) => a - b)
}

/**
 * The step at which a free element shows (1-based, counting the bullets first), or 0 when it
 * arrives with the slide.
 */
export function elementBuildStep(slide: Slide, element: { build?: number }): number {
  if (!element.build) return 0
  return bulletSteps(slide) + elementBuildNumbers(slide).indexOf(element.build) + 1
}

/** How many clicks a slide's build takes (0: none, the slide arrives whole): bullets, then elements. */
export function buildSteps(slide: Slide): number {
  return bulletSteps(slide) + elementBuildNumbers(slide).length
}

/** A cover-fit picture's focus point, clamped to 0-100 and rounded to a tenth. */
export function clampPosition(position: { x: number; y: number }): { x: number; y: number } {
  const one = (value: number) => (Number.isFinite(value) ? Math.round(clamp(value, 0, 100) * 10) / 10 : 50)
  return { x: one(position.x), y: one(position.y) }
}

export type DeckSection = { name: string | null; description: string | null; start: number; end: number }

/** Slides grouped by the sections they start: slides before the first named one are unnamed. */
export function deckSections(deck: Deck): DeckSection[] {
  const out: DeckSection[] = []
  deck.slides.forEach((slide, index) => {
    if (index === 0 || slide.section)
      out.push({
        name: slide.section ?? null,
        description: slide.section ? (slide.sectionDescription ?? null) : null,
        start: index,
        end: index + 1,
      })
    else out[out.length - 1].end = index + 1
  })
  return out
}

// ---------------------------------------------------------------------------
// Deep links: `#slide-7` is the seventh slide (1-based, as people count).

export function slideHash(index: number): string {
  return `#slide-${index + 1}`
}

/** The 0-based index a `#slide-N` hash points at, clamped to the deck, or null. */
export function parseSlideHash(hash: string, count: number): number | null {
  const match = /^#slide-(\d{1,4})$/.exec(hash)
  if (!match || count < 1) return null
  return clamp(Number(match[1]) - 1, 0, count - 1)
}
