/**
 * Pure edits and geometry for a slide's free-position elements (text boxes, shapes, lines,
 * arrows, images drawn above the layout). Shared by the editor (drag, resize, rotate, snap,
 * keyboard nudges) and the agent's patch ops. Every edit returns a new deck, or its input
 * unchanged when it cannot apply (callers check identity to tell a no-op).
 */

import {
  DESIGN_SIZE,
  ELEMENT_BOUNDS,
  LIMITS,
  type Deck,
  type DeckAspect,
  type ElementType,
  type Slide,
  type SlideElement,
} from './slides'

export type Box = { x: number; y: number; w: number; h: number }

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))
const round = (value: number) => Math.round(value * 10) / 10

/** A rotation in (-180, 180], rounded to a tenth of a degree; 0 means none. */
export function normaliseRotation(degrees: number): number {
  if (!Number.isFinite(degrees)) return 0
  let value = degrees % 360
  if (value > 180) value -= 360
  if (value <= -180) value += 360
  return round(value) === 0 ? 0 : round(value)
}

/** A box kept inside the schema's bounds, rounded to a tenth of a pixel. */
export function clampBox(box: Box): Box {
  const w = clamp(round(box.w), ELEMENT_BOUNDS.minSize, ELEMENT_BOUNDS.maxSize)
  const h = clamp(round(box.h), ELEMENT_BOUNDS.minSize, ELEMENT_BOUNDS.maxSize)
  return {
    x: clamp(round(box.x), ELEMENT_BOUNDS.min, ELEMENT_BOUNDS.max),
    y: clamp(round(box.y), ELEMENT_BOUNDS.min, ELEMENT_BOUNDS.max),
    w,
    h,
  }
}

/** A fresh element id on the slide: `<type>-1`, `<type>-2`, … Deterministic. */
export function uniqueElementId(slide: Slide, base: string): string {
  const used = new Set((slide.elements ?? []).map((element) => element.id))
  const stem = (base.replace(/-\d+$/, '') || 'element').replace(/[^A-Za-z0-9_-]/g, '').slice(0, LIMITS.idLength - 5) || 'element'
  for (let n = 1; ; n++) {
    const candidate = `${stem}-${n}`
    if (!used.has(candidate)) return candidate
  }
}

/** A new element of `type` centred on the canvas, with the look a person would start from. */
export function defaultElement(type: ElementType, id: string, aspect: DeckAspect, src?: string): SlideElement {
  const canvas = DESIGN_SIZE[aspect]
  const centred = (w: number, h: number) => ({ x: round((canvas.width - w) / 2), y: round((canvas.height - h) / 2), w, h })
  switch (type) {
    case 'text':
      return { id, type, ...centred(360, 64), text: 'Text', size: 28 }
    case 'rect':
      return { id, type, ...centred(240, 140), fill: 'tint', stroke: 'accent', strokeWidth: 2 }
    case 'ellipse':
      return { id, type, ...centred(180, 180), fill: 'tint', stroke: 'accent', strokeWidth: 2 }
    case 'line':
      return { id, type, ...centred(240, 20), stroke: 'ink', strokeWidth: 3 }
    case 'arrow':
      return { id, type, ...centred(240, 24), stroke: 'accent', strokeWidth: 3 }
    case 'image':
      return { id, type, ...centred(320, 200), src: src ?? '/Placeholder.svg', alt: 'Image' }
    case 'icon':
      return { id, type, ...centred(96, 96), icon: 'star', color: 'accent' }
    case 'link':
      return { id, type, ...centred(360, 112), url: 'https://example.com', title: 'Link title' }
    case 'connector':
      // Bound to nothing yet: `connectElements` makes a real one between two elements.
      return { id, type, ...centred(240, 20), from: id, to: id, stroke: 'ink', strokeWidth: 2, head: 'end' }
  }
}

type SlideEdit = (slide: Slide) => Slide

function editSlide(deck: Deck, slideId: string, change: SlideEdit): Deck {
  const index = deck.slides.findIndex((slide) => slide.id === slideId)
  if (index === -1) return deck
  const current = deck.slides[index]
  const next = change(current)
  if (next === current) return deck
  const slides = [...deck.slides]
  slides[index] = next
  return { ...deck, slides }
}

/** The slide with its element list set; an empty list drops the field (an untouched slide stays byte-identical). */
function withElements(slide: Slide, elements: SlideElement[]): Slide {
  const next: Slide = { ...slide }
  if (elements.length) next.elements = elements
  else delete next.elements
  return next
}

export type ElementResult = { ok: true; deck: Deck; id: string } | { ok: false; error: string }

/**
 * Add `element` on top of the slide (an id already used there, or none, gets a fresh one).
 * Refuses an unknown slide or a slide at the element cap.
 */
export function addElement(deck: Deck, slideId: string, element: SlideElement): ElementResult {
  const slide = deck.slides.find((item) => item.id === slideId)
  if (!slide) return { ok: false, error: `there is no slide "${slideId}"` }
  const elements = slide.elements ?? []
  if (elements.length >= LIMITS.elements) return { ok: false, error: `a slide has at most ${LIMITS.elements} elements` }
  const id = !element.id || elements.some((item) => item.id === element.id) ? uniqueElementId(slide, element.type) : element.id
  const placed = { ...element, id, ...clampBox(element) } as SlideElement
  if (placed.rotation !== undefined) {
    const rotation = normaliseRotation(placed.rotation)
    if (rotation) placed.rotation = rotation
    else delete placed.rotation
  }
  return { ok: true, id, deck: editSlide(deck, slideId, (current) => withElements(current, [...elements, placed])) }
}

/** Fields a patch may change: anything but the id and the type; `null` clears an optional field. */
export type ElementPatch = { [K in string]?: unknown }

const REQUIRED_FIELDS = new Set(['id', 'type', 'x', 'y', 'w', 'h', 'src', 'alt', 'icon', 'url', 'title', 'from', 'to'])

/**
 * Merge `patch` into one element. Box fields are clamped to the bounds, rotation normalised;
 * `null` deletes an optional field. Unknown fields are copied (the deck's schema refuses them
 * when the caller validates). Returns the input deck for an unknown slide or element, or an
 * edit that changes nothing.
 */
export function updateElement(deck: Deck, slideId: string, elementId: string, patch: ElementPatch): Deck {
  return editSlide(deck, slideId, (slide) => {
    const elements = slide.elements ?? []
    const index = elements.findIndex((element) => element.id === elementId)
    if (index === -1) return slide
    const current = elements[index]
    const next: Record<string, unknown> = { ...current }
    for (const [key, value] of Object.entries(patch)) {
      if (key === 'id' || key === 'type') continue
      if (value === null || value === undefined) {
        if (!REQUIRED_FIELDS.has(key)) delete next[key]
      } else next[key] = value
    }
    const box = clampBox(next as unknown as Box)
    Object.assign(next, box)
    if (typeof next.rotation === 'number') {
      const rotation = normaliseRotation(next.rotation)
      if (rotation) next.rotation = rotation
      else delete next.rotation
    }
    if (JSON.stringify(next) === JSON.stringify(current)) return slide
    const list = [...elements]
    list[index] = next as unknown as SlideElement
    return withElements(slide, list)
  })
}

/** Remove the elements with these ids from the slide (unknown ids are ignored). */
export function removeElements(deck: Deck, slideId: string, ids: readonly string[]): Deck {
  const drop = new Set(ids)
  return editSlide(deck, slideId, (slide) => {
    const elements = slide.elements ?? []
    const kept = elements.filter((element) => !drop.has(element.id))
    return kept.length === elements.length ? slide : withElements(slide, kept)
  })
}

export const ELEMENT_ORDERS = ['front', 'back', 'forward', 'backward'] as const
export type ElementOrder = (typeof ELEMENT_ORDERS)[number]

/** Change one element's stacking: to the front or back, or one step forward or backward. */
export function reorderElement(deck: Deck, slideId: string, elementId: string, to: ElementOrder): Deck {
  return editSlide(deck, slideId, (slide) => {
    const elements = slide.elements ?? []
    const from = elements.findIndex((element) => element.id === elementId)
    if (from === -1) return slide
    const last = elements.length - 1
    const target =
      to === 'front' ? last : to === 'back' ? 0 : to === 'forward' ? Math.min(last, from + 1) : Math.max(0, from - 1)
    if (target === from) return slide
    const list = [...elements]
    const [moved] = list.splice(from, 1)
    list.splice(target, 0, moved)
    return withElements(slide, list)
  })
}

/** Move these elements by (dx, dy), each clamped to the bounds. */
export function moveElements(deck: Deck, slideId: string, ids: readonly string[], dx: number, dy: number): Deck {
  if (!dx && !dy) return deck
  const move = new Set(ids)
  return editSlide(deck, slideId, (slide) => {
    const elements = slide.elements ?? []
    let changed = false
    const list = elements.map((element) => {
      if (!move.has(element.id)) return element
      const box = clampBox({ ...element, x: element.x + dx, y: element.y + dy })
      if (box.x === element.x && box.y === element.y) return element
      changed = true
      return { ...element, x: box.x, y: box.y }
    })
    return changed ? withElements(slide, list) : slide
  })
}

/**
 * Copy these elements on top, offset by `offset` px, under fresh ids. Returns the copies' ids
 * (empty when nothing was copied, e.g. at the element cap).
 */
export function duplicateElements(
  deck: Deck,
  slideId: string,
  ids: readonly string[],
  offset = 16,
): { deck: Deck; ids: string[] } {
  const slide = deck.slides.find((item) => item.id === slideId)
  if (!slide) return { deck, ids: [] }
  const elements = slide.elements ?? []
  const sources = elements.filter((element) => ids.includes(element.id))
  if (!sources.length || elements.length + sources.length > LIMITS.elements) return { deck, ids: [] }
  let working: Slide = slide
  const copies: SlideElement[] = []
  for (const source of sources) {
    const id = uniqueElementId(working, source.id)
    const box = clampBox({ ...source, x: source.x + offset, y: source.y + offset })
    const copy = { ...structuredClone(source), id, x: box.x, y: box.y } as SlideElement
    copies.push(copy)
    working = withElements(working, [...(working.elements ?? []), copy])
  }
  return { deck: editSlide(deck, slideId, () => working), ids: copies.map((copy) => copy.id) }
}

// ---------------------------------------------------------------------------
// Geometry for the editor's handles.

export const RESIZE_HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const
export type ResizeHandle = (typeof RESIZE_HANDLES)[number]

/**
 * A box resized by dragging `handle` by (dx, dy) in design pixels (unrotated). `keepRatio`
 * scales both sides from a corner. The opposite edge stays put; a side never drops below `min`.
 */
export function resizeBox(box: Box, handle: ResizeHandle, dx: number, dy: number, keepRatio = false, min = 8): Box {
  let { x, y, w, h } = box
  const west = handle.includes('w')
  const east = handle.includes('e')
  const north = handle.includes('n')
  const south = handle.includes('s')
  if (east) w = Math.max(min, box.w + dx)
  if (west) w = Math.max(min, box.w - dx)
  if (south) h = Math.max(min, box.h + dy)
  if (north) h = Math.max(min, box.h - dy)
  if (keepRatio && (east || west) && (north || south) && box.w > 0 && box.h > 0) {
    const scale = Math.max(w / box.w, h / box.h)
    w = Math.max(min, box.w * scale)
    h = Math.max(min, box.h * scale)
  }
  if (west) x = box.x + box.w - w
  if (north) y = box.y + box.h - h
  return clampBox({ x, y, w, h })
}

/**
 * The rotation (degrees, clockwise from upright) for a rotate handle dragged to `pointer`
 * around `centre`; `snap` rounds to 15° steps.
 */
export function rotationAt(centre: { x: number; y: number }, pointer: { x: number; y: number }, snap = false): number {
  const degrees = (Math.atan2(pointer.y - centre.y, pointer.x - centre.x) * 180) / Math.PI + 90
  return normaliseRotation(snap ? Math.round(degrees / 15) * 15 : degrees)
}

export type SnapGuide = { axis: 'x' | 'y'; at: number }

/**
 * Snap a moving box to the canvas's edges and centre lines and to other boxes' edges and
 * centres, within `threshold` design px. Returns the corrected offset and the guides to draw.
 */
export function snapBox(
  box: Box,
  others: readonly Box[],
  canvas: { width: number; height: number },
  threshold = 6,
): { dx: number; dy: number; guides: SnapGuide[] } {
  const targetsX = [0, canvas.width / 2, canvas.width]
  const targetsY = [0, canvas.height / 2, canvas.height]
  for (const other of others) {
    targetsX.push(other.x, other.x + other.w / 2, other.x + other.w)
    targetsY.push(other.y, other.y + other.h / 2, other.y + other.h)
  }
  const best = (edges: number[], targets: number[]) => {
    let found: { delta: number; at: number } | null = null
    for (const edge of edges)
      for (const target of targets) {
        const delta = target - edge
        if (Math.abs(delta) <= threshold && (!found || Math.abs(delta) < Math.abs(found.delta))) found = { delta, at: target }
      }
    return found
  }
  const sx = best([box.x, box.x + box.w / 2, box.x + box.w], targetsX)
  const sy = best([box.y, box.y + box.h / 2, box.y + box.h], targetsY)
  const guides: SnapGuide[] = []
  if (sx) guides.push({ axis: 'x', at: sx.at })
  if (sy) guides.push({ axis: 'y', at: sy.at })
  return { dx: sx?.delta ?? 0, dy: sy?.delta ?? 0, guides }
}

/** An element that carries text: a text box, or a rectangle or ellipse with a label. */
export type TextualElement = Extract<SlideElement, { type: 'text' | 'rect' | 'ellipse' }>

/** Whether an element carries text (a text box, or a shape with a label). */
export function elementHasText(element: SlideElement): element is TextualElement {
  return element.type === 'text' || element.type === 'rect' || element.type === 'ellipse'
}
