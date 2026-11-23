/**
 * Round-5 board edits, shared by the editor and the agent's patch ops (kind-ops-r4/whiteboard.ts):
 * arrowhead shapes, show/hide, artifact link cards, mind-map children and subtree layout, kanban
 * columns that stack their cards, notes that size to their text, partial erasing, recognising a
 * rough sketch as a shape, shape search and a plain account of what an edit changed (for screen
 * readers). Every function takes a valid board and returns a valid one. Pure: no DOM.
 */

import { tableMerges } from './whiteboard-arrange'
import {
  arrowHeadPath,
  center,
  distanceToSegment,
  elementBounds,
  geometryContext,
  NOTE_PADDING,
  rectsIntersect,
  sectionMembers,
  strokeBounds,
  wrapText,
  type GeometryContext,
  type Measure,
} from './whiteboard-geometry'
import { boardIds, mintId } from './whiteboard-ops'
import { plainRichText } from './whiteboard-richtext'
import {
  artifactCardUrl,
  isBoundEnd,
  isBoxElement,
  LINE_HEIGHT,
  MAX_ELEMENTS,
  SHAPE_KINDS,
  TEXT_SIZE_PX,
  type ArrowElement,
  type ArrowheadShape,
  type LinkArtifact,
  type LinkElement,
  type NoteElement,
  type Point,
  type Rect,
  type SectionElement,
  type ShapeKind,
  type StrokeElement,
  type WhiteboardBoard,
  type WhiteboardElement,
} from './whiteboard'

const patch = (board: WhiteboardBoard, fn: (element: WhiteboardElement) => WhiteboardElement): WhiteboardBoard => {
  let changed = false
  const elements = board.elements.map((element) => {
    const next = fn(element)
    if (next !== element) changed = true
    return next
  })
  return changed ? { ...board, elements } : board
}

// ---- arrowheads

/** The shape drawn at each end: an explicit `startHead` / `endHead`, else a triangle where `head` puts one. */
export function arrowHeads(arrow: ArrowElement): { start: ArrowheadShape; end: ArrowheadShape } {
  const head = arrow.head ?? 'end'
  return {
    start: arrow.startHead ?? (head === 'start' || head === 'both' ? 'triangle' : 'none'),
    end: arrow.endHead ?? (head === 'end' || head === 'both' ? 'triangle' : 'none'),
  }
}

/**
 * The fields that draw `start` and `end` heads. `head` is kept in step (so an older reader still
 * draws a head where there is one), and a triangle needs no explicit field.
 */
export function arrowHeadFields(start: ArrowheadShape, end: ArrowheadShape): Pick<ArrowElement, 'head' | 'startHead' | 'endHead'> {
  const head = start !== 'none' && end !== 'none' ? 'both' : start !== 'none' ? 'start' : end !== 'none' ? undefined : 'none'
  return {
    head,
    startHead: start === 'triangle' || start === 'none' ? undefined : start,
    endHead: end === 'triangle' || end === 'none' ? undefined : end,
  }
}

/** Sets the heads of every arrow in `ids` (an end left undefined keeps its shape). */
export function setArrowHeads(
  board: WhiteboardBoard,
  ids: readonly string[],
  ends: { start?: ArrowheadShape; end?: ArrowheadShape },
): WhiteboardBoard {
  const chosen = new Set(ids)
  return patch(board, (element) => {
    if (element.type !== 'arrow' || !chosen.has(element.id)) return element
    const now = arrowHeads(element)
    const fields = arrowHeadFields(ends.start ?? now.start, ends.end ?? now.end)
    const next: ArrowElement = { ...element }
    for (const key of ['head', 'startHead', 'endHead'] as const) {
      const value = fields[key]
      if (value === undefined) delete next[key]
      else (next as Record<string, unknown>)[key] = value
    }
    return JSON.stringify(next) === JSON.stringify(element) ? element : next
  })
}

/**
 * An arrowhead's outline at `tip`, pointing along `angle` (radians, the direction of travel), at
 * `size` world units. `filled` heads are drawn solid; `open` is a stroke only.
 */
export function arrowheadPath(shape: ArrowheadShape, tip: Point, angle: number, size: number): { d: string; filled: boolean } | null {
  const r = (v: number) => Math.round(v * 10) / 10
  const at = (along: number, across: number) => {
    const x = tip.x - Math.cos(angle) * along - Math.sin(angle) * across
    const y = tip.y - Math.sin(angle) * along + Math.cos(angle) * across
    return `${r(x)} ${r(y)}`
  }
  const spread = size * 0.55
  switch (shape) {
    case 'none':
      return null
    case 'triangle':
      // The same triangle the editor always drew.
      return { d: arrowHeadPath(tip, angle, size), filled: true }
    case 'open':
      return { d: `M${at(size, spread)}L${at(0, 0)}L${at(size, -spread)}`, filled: false }
    case 'diamond':
      return { d: `M${at(0, 0)}L${at(size * 0.6, spread * 0.8)}L${at(size * 1.2, 0)}L${at(size * 0.6, -spread * 0.8)}Z`, filled: true }
    case 'circle': {
      const radius = size * 0.42
      const c = at(radius, 0).split(' ').map(Number) as [number, number]
      return {
        d: `M${r(c[0] - radius)} ${r(c[1])}a${r(radius)} ${r(radius)} 0 1 0 ${r(2 * radius)} 0a${r(radius)} ${r(radius)} 0 1 0 ${r(-2 * radius)} 0Z`,
        filled: true,
      }
    }
    case 'bar':
      return { d: `M${at(size * 0.15, spread)}L${at(size * 0.15, -spread)}`, filled: false }
  }
}

// ---- show / hide

/** Hides (or shows) `ids`. A hidden element is not drawn, hit, exported or shown to link readers. */
export function setHidden(board: WhiteboardBoard, ids: readonly string[], hidden: boolean): WhiteboardBoard {
  const chosen = new Set(ids)
  return patch(board, (element) => {
    if (!chosen.has(element.id) || (element.hidden === true) === hidden) return element
    const next = { ...element }
    if (hidden) next.hidden = true
    else delete next.hidden
    return next
  })
}

/** The elements a reader sees (hidden ones left out). The same array when nothing is hidden. */
export function visibleElements<T extends WhiteboardElement>(elements: readonly T[]): readonly T[] {
  return elements.some((element) => element.hidden) ? elements.filter((element) => !element.hidden) : elements
}

/** A board as a reader sees it: hidden elements and arrows bound to them left out. */
export function visibleBoard(board: WhiteboardBoard): WhiteboardBoard {
  if (!board.elements.some((element) => element.hidden)) return board
  const gone = new Set(board.elements.filter((element) => element.hidden).map((element) => element.id))
  return {
    ...board,
    elements: board.elements.filter((element) => {
      if (gone.has(element.id)) return false
      if (element.type !== 'arrow') return true
      return ![element.from, element.to].some((end) => isBoundEnd(end) && gone.has(end.elementId))
    }),
  }
}

// ---- artifact link cards

export const ARTIFACT_CARD_SIZE = { w: 280, h: 96 } as const

/** A card standing for another Freebuff artifact, centred on `at`. */
export function newArtifactCard(id: string, artifact: LinkArtifact, title: string, at: Point): LinkElement {
  return {
    type: 'link',
    id,
    x: Math.round(at.x - ARTIFACT_CARD_SIZE.w / 2),
    y: Math.round(at.y - ARTIFACT_CARD_SIZE.h / 2),
    w: ARTIFACT_CARD_SIZE.w,
    h: ARTIFACT_CARD_SIZE.h,
    url: artifactCardUrl(artifact.id),
    title: title.trim().slice(0, 200) || 'Untitled',
    artifact: { id: artifact.id, kind: artifact.kind },
  }
}

export const ARTIFACT_KIND_LABEL: Record<LinkArtifact['kind'], string> = {
  doc: 'Doc',
  slides: 'Slides',
  sheet: 'Sheet',
  data: 'Data',
  whiteboard: 'Whiteboard',
  design: 'Design',
}

// ---- mind maps

/** Bound arrows as a parent → children map (the arrow's `from` is the parent), in board order. */
export function childMap(board: WhiteboardBoard): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const element of board.elements) {
    if (element.type !== 'arrow' || !isBoundEnd(element.from) || !isBoundEnd(element.to)) continue
    const list = out.get(element.from.elementId) ?? []
    if (!list.includes(element.to.elementId)) list.push(element.to.elementId)
    out.set(element.from.elementId, list)
  }
  return out
}

/** The element an arrow points into `id` from (its parent in a tree), or null. */
export function parentOf(board: WhiteboardBoard, id: string): string | null {
  for (const element of board.elements) {
    if (element.type === 'arrow' && isBoundEnd(element.from) && isBoundEnd(element.to) && element.to.elementId === id) {
      return element.from.elementId
    }
  }
  return null
}

/** The top of `id`'s tree: follow parents until none (or a cycle). */
export function treeRoot(board: WhiteboardBoard, id: string): string {
  const seen = new Set<string>([id])
  let at = id
  for (;;) {
    const parent = parentOf(board, at)
    if (!parent || seen.has(parent)) return at
    seen.add(parent)
    at = parent
  }
}

/** `root` and everything under it (following bound arrows from parent to child), breadth first. */
export function subtreeIds(board: WhiteboardBoard, root: string): string[] {
  const children = childMap(board)
  const out = [root]
  const seen = new Set(out)
  for (let i = 0; i < out.length; i++) {
    for (const child of children.get(out[i]!) ?? []) {
      if (seen.has(child)) continue
      seen.add(child)
      out.push(child)
    }
  }
  return out
}

export const MIND_MAP_GAP_X = 80
export const MIND_MAP_GAP_Y = 24

/**
 * A tidy tree from `root`, left to right (`right`) or top down (`down`): each child sits one rank
 * past its parent, siblings stacked with `MIND_MAP_GAP_Y` (or `MIND_MAP_GAP_X` across) between
 * subtrees, every parent centred on its children. The root stays where it is; locked nodes,
 * sections, arrows and strokes are not moved (their subtrees still are).
 */
export function layoutSubtree(
  board: WhiteboardBoard,
  root: string,
  direction: 'right' | 'down' = 'right',
  ctx: GeometryContext = geometryContext(board.elements),
): WhiteboardBoard {
  const rootEl = ctx.byId.get(root)
  if (!rootEl) return board
  const children = childMap(board)
  const placed = new Map<string, Rect>()
  const across = direction === 'right' ? 'h' : 'w'
  const gap = direction === 'right' ? MIND_MAP_GAP_Y : MIND_MAP_GAP_X
  const seen = new Set<string>()
  const kids = (id: string) =>
    (children.get(id) ?? []).filter((child) => {
      const element = ctx.byId.get(child)
      return element && element.type !== 'arrow' && element.type !== 'stroke' && element.type !== 'section'
    })
  const extent = new Map<string, number>()
  const measureExtent = (id: string): number => {
    if (seen.has(id)) return 0
    seen.add(id)
    const own = elementBounds(ctx.byId.get(id)!, ctx)[across]
    const list = kids(id).filter((child) => !seen.has(child))
    const sum = list.reduce((total, child) => total + measureExtent(child), 0) + Math.max(0, list.length - 1) * gap
    const value = Math.max(own, sum)
    extent.set(id, value)
    return value
  }
  measureExtent(root)
  const visited = new Set<string>()
  const place = (id: string, at: { x: number; y: number }, span: number) => {
    if (visited.has(id)) return
    visited.add(id)
    const bounds = elementBounds(ctx.byId.get(id)!, ctx)
    const rect =
      direction === 'right'
        ? { x: at.x, y: at.y + span / 2 - bounds.h / 2, w: bounds.w, h: bounds.h }
        : { x: at.x + span / 2 - bounds.w / 2, y: at.y, w: bounds.w, h: bounds.h }
    placed.set(id, rect)
    const list = kids(id).filter((child) => extent.has(child) && !visited.has(child))
    const total = list.reduce((sum, child) => sum + extent.get(child)!, 0) + Math.max(0, list.length - 1) * gap
    let cursor = (direction === 'right' ? at.y : at.x) + span / 2 - total / 2
    for (const child of list) {
      const childSpan = extent.get(child)!
      if (direction === 'right') place(child, { x: rect.x + rect.w + MIND_MAP_GAP_X, y: cursor }, childSpan)
      else place(child, { x: cursor, y: rect.y + rect.h + MIND_MAP_GAP_X }, childSpan)
      cursor += childSpan + gap
    }
  }
  const rootBounds = elementBounds(rootEl, ctx)
  const span = extent.get(root) ?? rootBounds[across]
  place(root, direction === 'right' ? { x: rootBounds.x, y: rootBounds.y + rootBounds.h / 2 - span / 2 } : { x: rootBounds.x + rootBounds.w / 2 - span / 2, y: rootBounds.y }, span)
  // The root stays put: shift everything by the root's drift.
  const rootPlaced = placed.get(root)!
  const shift = { x: rootBounds.x - rootPlaced.x, y: rootBounds.y - rootPlaced.y }
  return patch(board, (element) => {
    const rect = placed.get(element.id)
    if (!rect || element.locked || element.id === root) return element
    if (!(isBoxElement(element) || element.type === 'text')) return element
    const x = Math.round(rect.x + shift.x)
    const y = Math.round(rect.y + shift.y)
    return element.x === x && element.y === y ? element : { ...element, x, y }
  })
}

/** A new node like `like` (a note, shape or text keeps its type, kind, size and colour), empty. */
function nodeLike(like: WhiteboardElement, id: string, at: Point): WhiteboardElement {
  if (like.type === 'note') {
    const { votes: _v, groups: _g, locked: _l, hidden: _h, ...rest } = like
    return { ...rest, id, x: Math.round(at.x), y: Math.round(at.y), text: '' }
  }
  if (like.type === 'shape') {
    const { timer: _t, groups: _g, locked: _l, hidden: _h, ...rest } = like
    return { ...rest, id, x: Math.round(at.x), y: Math.round(at.y), text: '' }
  }
  return { type: 'shape', kind: 'rounded', id, x: Math.round(at.x), y: Math.round(at.y), w: 160, h: 64, text: '', color: 'blue' }
}

/**
 * Mind map: a new child of `parentId` (one rank past it, joined by a curved arrow), then the
 * parent's whole tree laid out again from its root. `text` fills the child. Null when the board
 * is full or `parentId` cannot have children (an arrow, a stroke, a section, a sticker).
 */
export function addMindMapChild(
  board: WhiteboardBoard,
  parentId: string,
  options: { text?: string; direction?: 'right' | 'down'; ctx?: GeometryContext } = {},
): { board: WhiteboardBoard; id: string } | null {
  const ctx = options.ctx ?? geometryContext(board.elements)
  const parent = ctx.byId.get(parentId)
  if (!parent || !(isBoxElement(parent) || parent.type === 'text') || parent.type === 'section' || parent.type === 'sticker') return null
  if (board.elements.length + 2 > MAX_ELEMENTS) return null
  const direction = options.direction ?? 'right'
  const taken = boardIds(board)
  const id = mintId(parent.type === 'note' ? 'note' : 'node', taken)
  taken.add(id)
  const bounds = elementBounds(parent, ctx)
  const at = direction === 'right' ? { x: bounds.x + bounds.w + MIND_MAP_GAP_X, y: bounds.y } : { x: bounds.x, y: bounds.y + bounds.h + MIND_MAP_GAP_X }
  const child = nodeLike(parent, id, at)
  if (options.text !== undefined && 'text' in child) (child as { text: string }).text = options.text.slice(0, 4000)
  const arrow: ArrowElement = {
    type: 'arrow',
    id: mintId('arrow', taken),
    from: { elementId: parentId, side: direction === 'right' ? 'right' : 'bottom' },
    to: { elementId: id, side: direction === 'right' ? 'left' : 'top' },
    style: 'solid',
    head: 'none',
  }
  const grown: WhiteboardBoard = { ...board, elements: [...board.elements, child, arrow] }
  const root = treeRoot(grown, parentId)
  return { board: layoutSubtree(grown, root, direction, geometryContext(grown.elements, ctx.measure)), id }
}

/** Mind map: a sibling after `nodeId` (a child of its parent); a root gets a child instead. */
export function addMindMapSibling(
  board: WhiteboardBoard,
  nodeId: string,
  options: { text?: string; direction?: 'right' | 'down'; ctx?: GeometryContext } = {},
): { board: WhiteboardBoard; id: string } | null {
  const parent = parentOf(board, nodeId)
  return addMindMapChild(board, parent ?? nodeId, options)
}

// ---- kanban columns (sections that stack their cards)

export const STACK_PAD = 40
export const STACK_GAP = 40
const SECTION_TOP = 48

/** A column's cards in reading order: the notes whose centre is inside it, top to bottom. */
function stackCards(board: WhiteboardBoard, section: SectionElement, ctx: GeometryContext): NoteElement[] {
  const members = new Set(sectionMembers(board.elements, section, ctx))
  return board.elements
    .filter((element): element is NoteElement => element.type === 'note' && members.has(element.id) && !element.hidden)
    .sort((a, b) => a.y + a.h / 2 - (b.y + b.h / 2) || a.x - b.x)
}

/** Lays one column's cards out top to bottom at the column's padding (none wider than it); the column grows to hold them. */
export function restackSection(board: WhiteboardBoard, sectionId: string, ctx: GeometryContext = geometryContext(board.elements)): WhiteboardBoard {
  const section = ctx.byId.get(sectionId)
  if (!section || section.type !== 'section') return board
  const cards = stackCards(board, section, ctx)
  const places = new Map<string, { x: number; y: number; w: number }>()
  let y = section.y + SECTION_TOP
  const inner = Math.max(40, section.w - 2 * STACK_PAD)
  for (const card of cards) {
    places.set(card.id, { x: section.x + STACK_PAD, y, w: Math.min(card.w, inner) })
    y += card.h + STACK_GAP
  }
  const needed = Math.round(y - STACK_GAP + STACK_PAD - section.y)
  return patch(board, (element) => {
    if (element.id === sectionId && element.type === 'section') {
      return needed > element.h ? { ...element, h: needed } : element
    }
    const at = places.get(element.id)
    if (!at || element.type !== 'note' || element.locked) return element
    const x = Math.round(at.x)
    const yy = Math.round(at.y)
    const ww = Math.round(at.w)
    return element.x === x && element.y === yy && element.w === ww ? element : { ...element, x, y: yy, w: ww }
  })
}

/**
 * After an edit: every stacking column whose cards changed (one joined, left, moved or resized)
 * is laid out again, so a card dragged between columns snaps into that column's order.
 */
export function restackSections(previous: WhiteboardBoard, next: WhiteboardBoard, measure?: Measure): WhiteboardBoard {
  if (!next.elements.some((element) => element.type === 'section' && element.stack)) return next
  const before = new Map(previous.elements.map((element) => [element.id, element]))
  const ctx = geometryContext(next.elements, measure)
  let out = next
  for (const section of next.elements) {
    if (section.type !== 'section' || !section.stack) continue
    const cards = stackCards(next, section, ctx)
    const prevSection = before.get(section.id)
    const prevCards =
      prevSection?.type === 'section' ? stackCards(previous, prevSection, geometryContext(previous.elements, measure)) : []
    const changed =
      !prevSection ||
      prevSection.type !== 'section' ||
      !prevSection.stack ||
      cards.length !== prevCards.length ||
      cards.some((card) => before.get(card.id) !== card) ||
      cards.some((card, i) => prevCards[i]?.id !== card.id)
    if (changed) out = restackSection(out, section.id, geometryContext(out.elements, measure))
  }
  return out
}

// ---- notes that size to their text

export const AUTO_NOTE_MIN_H = 80

/** The height a note's text needs at its font (an auto-fitted note is measured at 16). */
export function noteTextHeight(note: NoteElement, measure: Measure): number {
  const fontSize = note.fontSize ? TEXT_SIZE_PX[note.fontSize] : 16
  const lines = plainRichText(note.text)
    .split('\n')
    .flatMap((line) => wrapText(line, fontSize, note.w - 2 * NOTE_PADDING, measure))
  return Math.ceil(Math.max(1, lines.length) * fontSize * LINE_HEIGHT + 2 * NOTE_PADDING)
}

/** Every `autoSize` note whose text, width or font changed (or that just turned it on) takes the height its text needs. */
export function autoSizeNotes(previous: WhiteboardBoard, next: WhiteboardBoard, measure: Measure): WhiteboardBoard {
  if (!next.elements.some((element) => element.type === 'note' && element.autoSize)) return next
  const before = new Map(previous.elements.map((element) => [element.id, element]))
  return patch(next, (element) => {
    if (element.type !== 'note' || !element.autoSize || element.locked) return element
    const old = before.get(element.id)
    if (old === element) return element
    if (old?.type === 'note' && old.autoSize && old.text === element.text && old.w === element.w && old.fontSize === element.fontSize) return element
    const h = Math.max(AUTO_NOTE_MIN_H, noteTextHeight(element, measure))
    return h === element.h ? element : { ...element, h }
  })
}

/** What the editor applies to each finished edit: auto-sized notes, then stacking columns. */
export function settleBoard(previous: WhiteboardBoard, next: WhiteboardBoard, measure: Measure): WhiteboardBoard {
  return restackSections(previous, autoSizeNotes(previous, next, measure), measure)
}

// ---- partial erasing

/**
 * Erases the part of `stroke` within `radius` of `at`: the points outside are kept as one stroke
 * per unbroken run (the first keeps the id, the others get fresh ones from `taken`). Returns null
 * when nothing was erased, or [] when all of it was.
 */
export function eraseStrokeAt(stroke: StrokeElement, at: Point, radius: number, taken: Set<string>): StrokeElement[] | null {
  const runs: Array<Array<[number, number]>> = []
  let run: Array<[number, number]> = []
  let erased = false
  const pts = stroke.points
  for (let i = 0; i < pts.length; i++) {
    const [x, y] = pts[i]!
    const near = Math.hypot(x - at.x, y - at.y) <= radius + stroke.width / 2
    const prev = pts[i - 1]
    const segmentNear = prev ? distanceToSegment(at, { x: prev[0], y: prev[1] }, { x, y }) <= radius + stroke.width / 2 : false
    if (near) {
      erased = true
      if (run.length) runs.push(run)
      run = []
      continue
    }
    if (segmentNear && run.length) {
      erased = true
      runs.push(run)
      run = []
    }
    run.push([x, y])
  }
  if (run.length) runs.push(run)
  if (!erased) return null
  const kept = runs.filter((points) => points.length >= 2)
  return kept.map((points, i) => {
    const id = i === 0 ? stroke.id : mintId('stroke', taken)
    taken.add(id)
    return { ...stroke, id, points }
  })
}

/** Erases around `at` from every stroke in `ids` (partial eraser). The board itself when nothing changed. */
export function eraseStrokes(board: WhiteboardBoard, at: Point, radius: number, ids?: ReadonlySet<string>): WhiteboardBoard {
  const taken = boardIds(board)
  let changed = false
  const elements = board.elements.flatMap((element) => {
    if (element.type !== 'stroke' || element.locked || element.hidden || (ids && !ids.has(element.id))) return [element]
    const bounds = strokeBounds(element.points, element.width)
    if (!rectsIntersect(bounds, { x: at.x - radius, y: at.y - radius, w: 2 * radius, h: 2 * radius })) return [element]
    const pieces = eraseStrokeAt(element, at, radius, taken)
    if (!pieces) return [element]
    changed = true
    return pieces
  })
  if (!changed) return board
  const present = new Set(elements.map((element) => element.id))
  // An arrow bound to a fully erased stroke cannot exist (arrows never bind to strokes), so nothing else to sweep.
  return { ...board, elements: elements.filter((element) => present.has(element.id)) }
}

// ---- recognising a sketch

export type RecognizedShape =
  | { kind: 'rect' | 'ellipse'; rect: Rect }
  | { kind: 'arrow'; from: Point; to: Point }

/**
 * A rough marker stroke as the shape it was meant to be, or null when it is not clearly one: a
 * closed loop whose points hug its box's edges is a rectangle, one that keeps an even distance
 * from its centre is an ellipse, and an open, nearly straight stroke is an arrow.
 */
export function recognizeStroke(points: readonly Point[]): RecognizedShape | null {
  if (points.length < 6) return null
  let x1 = Infinity
  let y1 = Infinity
  let x2 = -Infinity
  let y2 = -Infinity
  for (const p of points) {
    x1 = Math.min(x1, p.x)
    y1 = Math.min(y1, p.y)
    x2 = Math.max(x2, p.x)
    y2 = Math.max(y2, p.y)
  }
  const w = x2 - x1
  const h = y2 - y1
  const diag = Math.hypot(w, h)
  if (diag < 32) return null
  const first = points[0]!
  const last = points[points.length - 1]!
  const gap = Math.hypot(last.x - first.x, last.y - first.y)
  if (gap > diag * 0.22) {
    // Open: an arrow when every point stays near the line from start to end.
    const length = gap
    if (length < 40) return null
    const worst = Math.max(...points.map((p) => distanceToSegment(p, first, last)))
    return worst <= Math.max(6, length * 0.08) ? { kind: 'arrow', from: first, to: last } : null
  }
  if (w < 24 || h < 24) return null
  const rect = { x: Math.round(x1), y: Math.round(y1), w: Math.round(w), h: Math.round(h) }
  const tolerance = Math.max(6, Math.min(w, h) * 0.12)
  const nearEdge = points.filter(
    (p) => Math.min(Math.abs(p.x - x1), Math.abs(p.x - x2), Math.abs(p.y - y1), Math.abs(p.y - y2)) <= tolerance,
  ).length
  const c = center(rect)
  const deviation =
    points.reduce((sum, p) => sum + Math.abs(Math.hypot((p.x - c.x) / (w / 2), (p.y - c.y) / (h / 2)) - 1), 0) / points.length
  if (nearEdge / points.length >= 0.9 && deviation > 0.08) return { kind: 'rect', rect }
  if (deviation <= 0.14) return { kind: 'ellipse', rect }
  return null
}

// ---- shape library search

const SHAPE_ALIASES: Record<ShapeKind, string> = {
  rect: 'rectangle box square step process',
  rounded: 'rounded rectangle card box',
  pill: 'pill terminal start end capsule stadium',
  ellipse: 'ellipse circle oval',
  diamond: 'diamond decision rhombus choice question',
  hexagon: 'hexagon preparation',
  parallelogram: 'parallelogram input output io data',
  cylinder: 'cylinder database db store storage',
  document: 'document doc page file report',
  subroutine: 'subroutine predefined process function',
  queue: 'queue stream buffer pipe',
  triangle: 'triangle warning delta',
  cloud: 'cloud service external internet',
  person: 'person user actor human people',
}

/** Shape kinds matching `query` (by name or by what they stand for), best matches first. */
export function searchShapes(query: string): ShapeKind[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return [...SHAPE_KINDS]
  return SHAPE_KINDS.map((kind) => {
    const haystack = `${kind} ${SHAPE_ALIASES[kind]}`.split(' ')
    let score = 0
    for (const word of words) {
      if (haystack[0]!.startsWith(word)) score += 3
      else if (haystack.some((entry) => entry.startsWith(word))) score += 2
      else if (haystack.some((entry) => entry.includes(word))) score += 1
      else return { kind, score: -1 }
    }
    return { kind, score }
  })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.kind)
}

// ---- describing an edit (screen-reader announcements)

const NOUN: Record<WhiteboardElement['type'], string> = {
  note: 'note',
  shape: 'shape',
  text: 'text',
  section: 'section',
  arrow: 'arrow',
  stroke: 'sketch',
  image: 'image',
  sticker: 'sticker',
  table: 'table',
  link: 'link card',
}

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`

function label(element: WhiteboardElement | undefined): string {
  if (!element) return 'a point'
  const text =
    element.type === 'note' || element.type === 'text'
      ? element.text
      : element.type === 'shape'
        ? element.text ?? ''
        : element.type === 'section' || element.type === 'link'
          ? element.title
          : ''
  const clean = plainRichText(text).replace(/\s+/g, ' ').trim()
  return clean ? `"${clean.length > 40 ? `${clean.slice(0, 39)}…` : clean}"` : `a ${NOUN[element.type]}`
}

/**
 * One plain sentence for what changed between two boards (added, removed, connected, moved,
 * edited), for a polite live region; null when nothing a reader would notice changed.
 */
export function describeChange(previous: WhiteboardBoard, next: WhiteboardBoard): string | null {
  if (previous === next) return null
  const before = new Map(previous.elements.map((element) => [element.id, element]))
  const after = new Map(next.elements.map((element) => [element.id, element]))
  const added = next.elements.filter((element) => !before.has(element.id))
  const removed = previous.elements.filter((element) => !after.has(element.id))
  const parts: string[] = []
  const arrows = added.filter((element): element is ArrowElement => element.type === 'arrow')
  for (const arrow of arrows.slice(0, 2)) {
    const end = (e: ArrowElement['from']) => (isBoundEnd(e) ? label(after.get(e.elementId)) : 'a point')
    parts.push(`Connected ${end(arrow.from)} to ${end(arrow.to)}`)
  }
  const others = added.filter((element) => element.type !== 'arrow')
  if (others.length === 1) parts.push(`Added ${label(others[0])}`)
  else if (others.length > 1) parts.push(`Added ${plural(others.length, 'element')}`)
  if (removed.length === 1) parts.push(`Removed ${label(removed[0])}`)
  else if (removed.length > 1) parts.push(`Removed ${plural(removed.length, 'element')}`)
  let moved = 0
  let edited = 0
  let lastMoved: WhiteboardElement | undefined
  for (const element of next.elements) {
    const old = before.get(element.id)
    if (!old || old === element) continue
    const a = 'x' in old ? `${old.x},${old.y}` : ''
    const b = 'x' in element ? `${element.x},${element.y}` : ''
    const geometryOnly =
      JSON.stringify({ ...old, x: 0, y: 0, w: 0, h: 0 }) === JSON.stringify({ ...element, x: 0, y: 0, w: 0, h: 0 })
    if (a !== b && geometryOnly) {
      moved++
      lastMoved = element
    } else if (element.type !== 'arrow') edited++
  }
  if (moved === 1 && !added.length) parts.push(`Moved ${label(lastMoved)}`)
  else if (moved > 1 && !added.length) parts.push(`Moved ${plural(moved, 'element')}`)
  if (edited === 1 && !added.length && !removed.length && !moved) {
    const changedOne = next.elements.find((element) => before.get(element.id) && before.get(element.id) !== element && element.type !== 'arrow')
    parts.push(`Changed ${label(changedOne)}`)
  } else if (edited > 1 && !added.length && !removed.length) parts.push(`Changed ${plural(edited, 'element')}`)
  if (!parts.length && previous.title !== next.title) parts.push(`Renamed the board "${next.title}"`)
  return parts.length ? `${parts.join('. ')}.` : null
}

/** The merged regions of a table, for drawing (re-exported for the editor). */
export { tableMerges }
