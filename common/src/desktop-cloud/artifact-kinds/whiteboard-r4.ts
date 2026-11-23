/**
 * Round-4 board edits, pure (no DOM), shared by the editor and the agent's patch ops:
 * dot votes and stickers stuck to elements, clustering notes, a section's note colour, the
 * shape timer, image crops, layer order, lasso selection, keyboard connecting, the list-view
 * outline and the "Ask Buffy" board prompts. Each edit takes a valid board and returns a valid
 * one, or the same board when there is nothing to do.
 */

import { readingOrder } from './whiteboard-layout'
import {
  center,
  elementBounds,
  geometryContext,
  isBindable,
  pointInRect,
  sectionMembers,
  type GeometryContext,
} from './whiteboard-geometry'
import {
  isBoxElement,
  MAX_TIMER_SECONDS,
  MAX_VOTES,
  type ArrowEnd,
  type ImageCrop,
  type ImageElement,
  type NoteElement,
  type Point,
  type Rect,
  type SectionElement,
  type ShapeElement,
  type WhiteboardBoard,
  type WhiteboardColor,
  type WhiteboardElement,
} from './whiteboard'

const byIdOf = (board: WhiteboardBoard) => new Map(board.elements.map((element) => [element.id, element]))

function patchElements(
  board: WhiteboardBoard,
  patch: (element: WhiteboardElement) => WhiteboardElement,
): WhiteboardBoard {
  let changed = false
  const elements = board.elements.map((element) => {
    const next = patch(element)
    if (next !== element) changed = true
    return next
  })
  return changed ? { ...board, elements } : board
}

// ---- votes

const clampVotes = (n: number) => Math.max(0, Math.min(MAX_VOTES, Math.round(n)))

/** Sets a note's votes (0 clears the badge). Anything but a note is left alone. */
export function setVotes(board: WhiteboardBoard, id: string, count: number): WhiteboardBoard {
  const votes = clampVotes(count)
  return patchElements(board, (element) => {
    if (element.id !== id || element.type !== 'note' || (element.votes ?? 0) === votes) return element
    const next: NoteElement = { ...element }
    if (votes === 0) delete next.votes
    else next.votes = votes
    return next
  })
}

/** Adds `by` (negative removes) to a note's votes, never below 0. */
export function addVotes(board: WhiteboardBoard, id: string, by: number): WhiteboardBoard {
  const note = board.elements.find((element) => element.id === id)
  if (note?.type !== 'note') return board
  return setVotes(board, id, (note.votes ?? 0) + by)
}

/**
 * The stickers on each element: attached to it (`attachedTo`), or free with their centre on it
 * (the topmost element there that is not a section). Keyed by element id.
 */
export function stickersOn(board: WhiteboardBoard, ctx: GeometryContext = geometryContext(board.elements)): Map<string, string[]> {
  const out = new Map<string, string[]>()
  const add = (target: string, sticker: string) => {
    const list = out.get(target)
    if (list) list.push(sticker)
    else out.set(target, [sticker])
  }
  for (const element of board.elements) {
    if (element.type !== 'sticker') continue
    if (element.attachedTo !== undefined && ctx.byId.has(element.attachedTo)) {
      add(element.attachedTo, element.id)
      continue
    }
    const target = stickTarget(board.elements, element.id, center(elementBounds(element, ctx)), ctx)
    if (target) add(target.id, element.id)
  }
  return out
}

/** The element a sticker centred at `p` lands on: the topmost box (not a section, sticker or arrow). */
function stickTarget(
  elements: readonly WhiteboardElement[],
  stickerId: string,
  p: Point,
  ctx: GeometryContext,
): WhiteboardElement | null {
  for (let i = elements.length - 1; i >= 0; i--) {
    const element = elements[i]
    if (element.id === stickerId || element.type === 'sticker' || element.type === 'section') continue
    if (element.type === 'arrow' || element.type === 'stroke') continue
    if (pointInRect(p, elementBounds(element, ctx))) return element
  }
  return null
}

/**
 * Sets each note's votes to the stickers on it. `ids` names the notes (absent: every note that has
 * a sticker on it). A note with none is cleared only when it was named.
 */
export function tallyVotes(board: WhiteboardBoard, ids?: readonly string[]): WhiteboardBoard {
  const on = stickersOn(board)
  const named = ids ? new Set(ids) : null
  return patchElements(board, (element) => {
    if (element.type !== 'note') return element
    const count = on.get(element.id)?.length ?? 0
    if (named ? !named.has(element.id) : count === 0) return element
    const votes = clampVotes(count)
    if ((element.votes ?? 0) === votes) return element
    const next: NoteElement = { ...element }
    if (votes === 0) delete next.votes
    else next.votes = votes
    return next
  })
}

/**
 * Most votes first: the named notes trade places so that reading order (rows top to bottom, left
 * to right) follows their votes (ties keep their order). Stickers on a note move with it.
 */
export function sortByVotes(board: WhiteboardBoard, ids: readonly string[]): WhiteboardBoard {
  const chosen = new Set(ids)
  const notes = board.elements.filter((element): element is NoteElement => element.type === 'note' && chosen.has(element.id) && element.locked !== true)
  if (notes.length < 2) return board
  const slots = readingOrder(notes.map((note) => ({ note, bounds: { x: note.x, y: note.y, w: note.w, h: note.h } }))).map(
    (entry) => ({ x: entry.note.x, y: entry.note.y }),
  )
  const ranked = readingOrder(notes.map((note) => ({ note, bounds: { x: note.x, y: note.y, w: note.w, h: note.h } })))
    .map((entry, order) => ({ note: entry.note, order }))
    .sort((a, b) => (b.note.votes ?? 0) - (a.note.votes ?? 0) || a.order - b.order)
  const deltas = new Map<string, Point>()
  ranked.forEach(({ note }, i) => deltas.set(note.id, { x: slots[i].x - note.x, y: slots[i].y - note.y }))
  const on = stickersOn(board)
  for (const note of notes) {
    const d = deltas.get(note.id)!
    for (const sticker of on.get(note.id) ?? []) if (!deltas.has(sticker)) deltas.set(sticker, d)
  }
  return patchElements(board, (element) => {
    const d = deltas.get(element.id)
    if (!d || (d.x === 0 && d.y === 0) || !isBoxElement(element)) return element
    return { ...element, x: element.x + d.x, y: element.y + d.y }
  })
}

// ---- stickers stuck to elements

/**
 * Attaches each named sticker to the element under its centre (the topmost that is not a
 * section), or frees it when it sits on nothing. Run after a sticker is placed or dragged.
 */
export function attachStickers(
  board: WhiteboardBoard,
  stickerIds: readonly string[],
  ctx: GeometryContext = geometryContext(board.elements),
): WhiteboardBoard {
  const chosen = new Set(stickerIds)
  if (chosen.size === 0) return board
  return patchElements(board, (element) => {
    if (element.type !== 'sticker' || !chosen.has(element.id)) return element
    const target = stickTarget(board.elements, element.id, center(elementBounds(element, ctx)), ctx)
    if (target?.id === element.attachedTo) return element
    const next = { ...element }
    if (target) next.attachedTo = target.id
    else delete next.attachedTo
    return next
  })
}

// ---- clustering notes

/**
 * Notes in clusters: notes in the same (innermost, smallest) section form one cluster; the rest
 * join any note within `gap` of them (edge to edge). Clusters of one are left out. Order: by each
 * cluster's top-left in reading order.
 */
export function clusterNotes(
  board: WhiteboardBoard,
  ids?: readonly string[],
  gap = 80,
): string[][] {
  const chosen = ids ? new Set(ids) : null
  const notes = board.elements.filter((element): element is NoteElement => element.type === 'note' && (!chosen || chosen.has(element.id)))
  const parent = new Map(notes.map((note) => [note.id, note.id]))
  const find = (id: string): string => {
    let root = id
    while (parent.get(root) !== root) root = parent.get(root)!
    parent.set(id, root)
    return root
  }
  const union = (a: string, b: string) => parent.set(find(a), find(b))
  // Same section: the smallest section holding the note's centre.
  const sections = board.elements
    .filter((element): element is SectionElement => element.type === 'section')
    .sort((a, b) => a.w * a.h - b.w * b.h)
  const home = new Map<string, string>()
  for (const note of notes) {
    const c = center(note)
    const section = sections.find((s) => pointInRect(c, s))
    if (section) home.set(note.id, section.id)
  }
  const bySection = new Map<string, string>()
  for (const note of notes) {
    const section = home.get(note.id)
    if (!section) continue
    const first = bySection.get(section)
    if (first) union(note.id, first)
    else bySection.set(section, note.id)
  }
  // Proximity, for notes outside any section.
  const loose = notes.filter((note) => !home.has(note.id))
  for (let i = 0; i < loose.length; i++)
    for (let j = i + 1; j < loose.length; j++)
      if (rectGap(loose[i], loose[j]) <= gap) union(loose[i].id, loose[j].id)
  const groups = new Map<string, NoteElement[]>()
  for (const note of notes) {
    const root = find(note.id)
    const list = groups.get(root)
    if (list) list.push(note)
    else groups.set(root, [note])
  }
  const clusters = [...groups.values()].filter((list) => list.length > 1)
  const ordered = readingOrder(
    clusters.map((list) => ({
      list,
      bounds: list.reduce<Rect>(
        (acc, n) => ({ x: Math.min(acc.x, n.x), y: Math.min(acc.y, n.y), w: 0, h: 0 }),
        { x: Infinity, y: Infinity, w: 0, h: 0 },
      ),
    })),
  )
  return ordered.map((entry) => entry.list.map((note) => note.id))
}

/** Edge to edge distance between two boxes (0 when they overlap). */
export function rectGap(a: Rect, b: Rect): number {
  return Math.hypot(Math.max(0, a.x - (b.x + b.w), b.x - (a.x + a.w)), Math.max(0, a.y - (b.y + b.h), b.y - (a.y + a.h)))
}

// ---- a section's note colour

type ColoredSection = SectionElement & { noteColor: WhiteboardColor }

function colorSections(board: WhiteboardBoard): ColoredSection[] {
  return board.elements
    .filter((element): element is ColoredSection => element.type === 'section' && !!element.noteColor)
    .sort((a, b) => a.w * a.h - b.w * b.h)
}

/**
 * Notes whose centre sits in a section with a `noteColor` take that colour (the smallest such
 * section wins). `ids` limits it to those notes (absent: every note). Locked notes keep theirs.
 * With `before` (the board before a move), a note already in that same section keeps its colour:
 * only a note that arrives in a section takes the section's colour.
 */
export function applySectionNoteColors(
  board: WhiteboardBoard,
  ids?: readonly string[],
  before?: WhiteboardBoard,
): WhiteboardBoard {
  const sections = colorSections(board)
  if (sections.length === 0) return board
  const previous = before ? colorSections(before) : null
  const beforeById = before ? byIdOf(before) : null
  const chosen = ids ? new Set(ids) : null
  return patchElements(board, (element) => {
    if (element.type !== 'note' || element.locked || (chosen && !chosen.has(element.id))) return element
    const section = sections.find((s) => pointInRect(center(element), s))
    if (!section || section.noteColor === element.color) return element
    const was = beforeById?.get(element.id)
    if (previous && was && previous.find((s) => pointInRect(center(was as NoteElement), s))?.id === section.id) return element
    return { ...element, color: section.noteColor }
  })
}

// ---- the shape timer

export type TimerState = 'idle' | 'running' | 'paused' | 'done'

/** Seconds left at `now` (epoch ms), never below 0. */
export function timerRemaining(shape: ShapeElement, now: number): number {
  const timer = shape.timer
  if (!timer) return 0
  const running = timer.startedAt !== undefined ? Math.max(0, (now - timer.startedAt) / 1000) : 0
  return Math.max(0, timer.duration - (timer.elapsed ?? 0) - running)
}

export function timerState(shape: ShapeElement, now: number): TimerState {
  const timer = shape.timer
  if (!timer) return 'idle'
  if (timerRemaining(shape, now) <= 0) return 'done'
  if (timer.startedAt !== undefined) return 'running'
  return timer.elapsed ? 'paused' : 'idle'
}

/** "4:05", or "1:02:03" past an hour. Rounded up, so a running timer reads 0:00 only at the end. */
export function formatTimer(seconds: number): string {
  const total = Math.max(0, Math.ceil(seconds - 1e-6))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

export type TimerAction = 'start' | 'pause' | 'reset'

/**
 * A shape's timer after `action` at `now` (epoch ms). Start runs it (from where it was paused,
 * or afresh once done); pause keeps the time used; reset clears it. `duration` (seconds) adds a
 * timer to a shape without one, or changes it (and resets it).
 */
export function updateTimer(
  board: WhiteboardBoard,
  id: string,
  action: TimerAction | null,
  now: number,
  duration?: number,
): WhiteboardBoard {
  return patchElements(board, (element) => {
    if (element.id !== id || element.type !== 'shape') return element
    let timer = element.timer
    if (duration !== undefined) {
      const seconds = Math.max(1, Math.min(MAX_TIMER_SECONDS, Math.round(duration)))
      timer = { duration: seconds }
    }
    if (!timer) timer = { duration: 300 }
    const used = (t: NonNullable<ShapeElement['timer']>) =>
      Math.min(t.duration, (t.elapsed ?? 0) + (t.startedAt !== undefined ? Math.max(0, (now - t.startedAt) / 1000) : 0))
    if (action === 'start') {
      const spent = used(timer)
      timer = spent >= timer.duration ? { duration: timer.duration, startedAt: now } : { ...timer, startedAt: now, ...(spent > 0 ? { elapsed: round1(spent) } : {}) }
      if (spent <= 0) delete timer.elapsed
    } else if (action === 'pause') {
      if (timer.startedAt === undefined) return element.timer === timer ? element : { ...element, timer }
      const spent = used(timer)
      timer = { duration: timer.duration, ...(spent > 0 ? { elapsed: round1(spent) } : {}) }
    } else if (action === 'reset') {
      timer = { duration: timer.duration }
    }
    return { ...element, timer }
  })
}

const round1 = (v: number) => Math.round(v * 10) / 10

// ---- image crop

/** The crop of an image (the whole picture when it has none). */
export const cropOf = (image: ImageElement): ImageCrop => image.crop ?? { x: 0, y: 0, w: 1, h: 1 }

/**
 * Sets an image's crop and resizes its box so the picture keeps its scale: trimming 20% off the
 * left makes the element 20% narrower and moves its left edge in. A crop of the whole picture
 * clears the field.
 */
export function cropImage(image: ImageElement, crop: ImageCrop): ImageElement {
  const clamp = (v: number) => Math.max(0, Math.min(1, v))
  const x = clamp(crop.x)
  const y = clamp(crop.y)
  const w = Math.max(0.01, Math.min(1 - x, crop.w))
  const h = Math.max(0.01, Math.min(1 - y, crop.h))
  const old = cropOf(image)
  // The whole picture's size and top-left in world units, from the current box and crop.
  const fullW = image.w / old.w
  const fullH = image.h / old.h
  const originX = image.x - old.x * fullW
  const originY = image.y - old.y * fullH
  const r3 = (v: number) => Math.round(v * 1000) / 1000
  const next: ImageElement = {
    ...image,
    x: round1(originX + x * fullW),
    y: round1(originY + y * fullH),
    w: Math.max(1, round1(w * fullW)),
    h: Math.max(1, round1(h * fullH)),
  }
  if (x === 0 && y === 0 && w >= 0.9999 && h >= 0.9999) delete next.crop
  else {
    // Rounded separately, x + w could pass 1 (and fail the schema): round the far edge, then the width from it.
    const [cx, cy] = [r3(x), r3(y)]
    next.crop = { x: cx, y: cy, w: Math.max(0.01, r3(Math.min(1, r3(x + w)) - cx)), h: Math.max(0.01, r3(Math.min(1, r3(y + h)) - cy)) }
  }
  return next
}

/** Crop as trims in whole percent from each edge (the editor's crop fields). */
export function cropTrims(crop: ImageCrop): { left: number; top: number; right: number; bottom: number } {
  const pct = (v: number) => Math.round(v * 100)
  return { left: pct(crop.x), top: pct(crop.y), right: pct(1 - crop.x - crop.w), bottom: pct(1 - crop.y - crop.h) }
}

/** The crop for trims in percent from each edge (each 0-95; at least 5% of each side stays). */
export function cropFromTrims(trims: { left: number; top: number; right: number; bottom: number }): ImageCrop {
  const f = (v: number) => Math.max(0, Math.min(95, Number.isFinite(v) ? v : 0)) / 100
  let left = f(trims.left)
  let right = f(trims.right)
  let top = f(trims.top)
  let bottom = f(trims.bottom)
  if (left + right > 0.95) right = Math.max(0, 0.95 - left)
  if (top + bottom > 0.95) bottom = Math.max(0, 0.95 - top)
  return { x: left, y: top, w: 1 - left - right, h: 1 - top - bottom }
}

// ---- layers

export type LayerMove = 'front' | 'back' | 'forward' | 'backward'

/** Moves one element to `index` of the drawing order (0 = bottom), clamped. */
export function moveToIndex(board: WhiteboardBoard, id: string, index: number): WhiteboardBoard {
  const from = board.elements.findIndex((element) => element.id === id)
  if (from === -1) return board
  const to = Math.max(0, Math.min(board.elements.length - 1, Math.round(index)))
  if (to === from) return board
  const elements = [...board.elements]
  const [moved] = elements.splice(from, 1)
  elements.splice(to, 0, moved)
  return { ...board, elements }
}

// ---- lasso

/** Whether `p` is inside the polygon `points` (even-odd). */
export function pointInPolygon(p: Point, points: readonly Point[]): boolean {
  let inside = false
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i]
    const b = points[j]
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y || 1e-9) + a.x) inside = !inside
  }
  return inside
}

/**
 * The ids a lasso (a closed freehand loop) selects: elements whose centre is inside it. A section
 * needs all four corners inside (as a marquee needs to enclose it).
 */
export function elementsInLasso(
  elements: readonly WhiteboardElement[],
  loop: readonly Point[],
  ctx: GeometryContext,
): string[] {
  if (loop.length < 3) return []
  return elements
    .filter((element) => {
      if (element.hidden) return false
      const r = elementBounds(element, ctx)
      if (element.type === 'section') {
        return [
          { x: r.x, y: r.y },
          { x: r.x + r.w, y: r.y },
          { x: r.x, y: r.y + r.h },
          { x: r.x + r.w, y: r.y + r.h },
        ].every((corner) => pointInPolygon(corner, loop))
      }
      return pointInPolygon(center(r), loop)
    })
    .map((element) => element.id)
}

// ---- keyboard connecting

/**
 * The elements an arrow from `fromId` may go to, nearest first (centre to centre): what Tab and
 * the arrow keys step through when connecting from the keyboard.
 */
export function connectCandidates(board: WhiteboardBoard, fromId: string, ctx: GeometryContext = geometryContext(board.elements)): string[] {
  const from = ctx.byId.get(fromId)
  if (!from || !isBindable(from)) return []
  const origin = center(elementBounds(from, ctx))
  return board.elements
    .filter((element) => element.id !== fromId && !element.hidden && isBindable(element) && element.type !== 'sticker')
    .map((element) => {
      const c = center(elementBounds(element, ctx))
      return { id: element.id, d: Math.hypot(c.x - origin.x, c.y - origin.y) }
    })
    .sort((a, b) => a.d - b.d)
    .map((entry) => entry.id)
}

/**
 * The candidate in a direction from `fromId` (for arrow keys while connecting): the nearest whose
 * centre lies within 60° of that direction, or null.
 */
export function candidateInDirection(
  board: WhiteboardBoard,
  currentId: string,
  candidates: readonly string[],
  direction: 'left' | 'right' | 'up' | 'down',
  ctx: GeometryContext = geometryContext(board.elements),
): string | null {
  const current = ctx.byId.get(currentId)
  if (!current) return null
  const o = center(elementBounds(current, ctx))
  const want = { left: Math.PI, right: 0, up: -Math.PI / 2, down: Math.PI / 2 }[direction]
  let best: { id: string; score: number } | null = null
  for (const id of candidates) {
    if (id === currentId) continue
    const element = ctx.byId.get(id)
    if (!element) continue
    const c = center(elementBounds(element, ctx))
    const dx = c.x - o.x
    const dy = c.y - o.y
    if (dx === 0 && dy === 0) continue
    let off = Math.abs(Math.atan2(dy, dx) - want)
    if (off > Math.PI) off = 2 * Math.PI - off
    if (off > Math.PI / 3) continue
    const score = Math.hypot(dx, dy) * (1 + off)
    if (!best || score < best.score) best = { id, score }
  }
  return best?.id ?? null
}

// ---- the list-view outline

export type OutlineItem = { id: string; type: WhiteboardElement['type']; label: string; detail?: string; href?: string }
export type OutlineSection = { id: string | null; title: string; items: OutlineItem[] }

const flat = (text: string, max = 120) => {
  const value = text.replace(/\s+/g, ' ').trim()
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

/** One element as a line of the outline (its text, or what it is). */
export function outlineItem(element: WhiteboardElement, byId: ReadonlyMap<string, WhiteboardElement>): OutlineItem {
  const base = { id: element.id, type: element.type }
  switch (element.type) {
    case 'note':
      return { ...base, label: flat(element.text) || 'Empty note', detail: element.votes ? `${element.votes} vote${element.votes === 1 ? '' : 's'}` : undefined }
    case 'shape':
      return { ...base, label: flat(element.text ?? '') || `A ${element.kind}`, detail: element.timer ? 'Timer' : undefined }
    case 'text':
      return { ...base, label: flat(element.text) || 'Empty text' }
    case 'section':
      return { ...base, label: element.title || 'Untitled section' }
    case 'image':
      return { ...base, label: element.alt || 'Image' }
    case 'sticker':
      return { ...base, label: `${element.sticker} sticker` }
    case 'table':
      return { ...base, label: flat(element.rows[0]?.join(' | ') ?? '') || 'Table', detail: `${element.rows.length}×${element.rows[0]?.length ?? 0} table` }
    case 'link':
      return { ...base, label: element.title || element.url, href: element.url }
    case 'stroke':
      return { ...base, label: 'Sketch' }
    case 'arrow': {
      const end = (e: ArrowEnd) => {
        if (!('elementId' in e)) return 'a point'
        const target = byId.get(e.elementId)
        return target ? outlineItem(target, byId).label : 'a point'
      }
      return { ...base, label: `${flat(end(element.from), 40)} → ${flat(end(element.to), 40)}`, detail: element.label }
    }
  }
}

/**
 * The board as a list, for a reader who cannot use the canvas: each section (largest first, so a
 * nested one follows its parent) with its members in reading order, then everything outside a
 * section, then the arrows.
 */
export function boardOutline(board: WhiteboardBoard, ctx: GeometryContext = geometryContext(board.elements)): OutlineSection[] {
  const byId = byIdOf(board)
  const placed = new Set<string>()
  const sections = board.elements
    .filter((element): element is SectionElement => element.type === 'section')
    .sort((a, b) => b.w * b.h - a.w * a.h)
  const ordered = (elements: readonly WhiteboardElement[]) =>
    readingOrder(elements.map((element) => ({ element, bounds: elementBounds(element, ctx) }))).map((entry) => entry.element)
  // Each element is listed under the smallest section holding it.
  const smallest = new Map<string, string>()
  for (const section of [...sections].reverse()) {
    for (const id of sectionMembers(board.elements, section, ctx)) {
      const member = byId.get(id)
      if (!member || member.type === 'arrow' || smallest.has(id)) continue
      smallest.set(id, section.id)
    }
  }
  const out: OutlineSection[] = sections.map((section) => {
    const members = board.elements.filter((element) => smallest.get(element.id) === section.id)
    for (const member of members) placed.add(member.id)
    return { id: section.id, title: section.title || 'Untitled section', items: ordered(members).map((m) => outlineItem(m, byId)) }
  })
  const rest = board.elements.filter((element) => element.type !== 'section' && element.type !== 'arrow' && !placed.has(element.id))
  if (rest.length) out.push({ id: null, title: 'Outside sections', items: ordered(rest).map((m) => outlineItem(m, byId)) })
  const arrows = board.elements.filter((element) => element.type === 'arrow')
  if (arrows.length) out.push({ id: null, title: 'Connections', items: arrows.map((m) => outlineItem(m, byId)) })
  return out
}

// ---- "Ask Buffy" about the whole board

/**
 * Characters an ask's element list may use: the chat quote is clipped at 4,000, so the list stays
 * under it and names any elements it had no room for by id alone.
 */
export const ASK_TEXT_BUDGET = 3_000

/** The board's elements as quoted lines with their ids, for an ask (data, never instructions). */
function quotedElements(board: WhiteboardBoard, filter: (element: WhiteboardElement) => boolean): string[] {
  const byId = byIdOf(board)
  const lines: string[] = []
  let used = 0
  const chosen = board.elements.filter(filter)
  let shown = 0
  for (const element of chosen) {
    const item = outlineItem(element, byId)
    const line = `- [${element.id}] ${element.type}: “${flat(item.label, 80)}”${item.detail ? ` (${flat(item.detail, 40)})` : ''}`
    if (used + line.length + 1 > ASK_TEXT_BUDGET) break
    lines.push(line)
    used += line.length + 1
    shown++
  }
  if (shown < chosen.length) {
    const rest = chosen.slice(shown).map((element) => element.id)
    let tail = `- …and ${rest.length} more: `
    for (const id of rest) {
      if (tail.length + id.length + 2 > 480) {
        tail += '…'
        break
      }
      tail += `${id}, `
    }
    lines.push(tail.replace(/, $/, ''))
  }
  return lines
}

/** "Summarise this board": every element with its id, so the answer can point at them. */
export function summarizeBoardAsk(board: WhiteboardBoard): { elementIds: string[]; text: string } {
  const ids = board.elements.filter((element) => element.type !== 'stroke').map((element) => element.id)
  return {
    elementIds: ids,
    text: [
      `Summarise the whiteboard “${board.title}”: the main themes, decisions and open questions, naming element ids in [brackets].`,
      'Its elements:',
      ...quotedElements(board, (element) => element.type !== 'stroke'),
    ].join('\n'),
  }
}

/** "Cluster notes": the notes (all, or the selected ones) with their ids, asking for themed groups. */
export function clusterNotesAsk(board: WhiteboardBoard, ids?: readonly string[]): { elementIds: string[]; text: string } {
  const chosen = ids && ids.length ? new Set(ids) : null
  const isNote = (element: WhiteboardElement) => element.type === 'note' && (!chosen || chosen.has(element.id))
  const noteIds = board.elements.filter(isNote).map((element) => element.id)
  return {
    elementIds: noteIds,
    text: [
      `Cluster these ${noteIds.length} sticky notes on “${board.title}” into themes: give each theme a name and list its note ids, then offer to move them into one section per theme.`,
      ...quotedElements(board, isNote),
    ].join('\n'),
  }
}
