/**
 * Board edits. Every function takes a valid board and returns a valid one (new ids are unique,
 * no arrow is left pointing at a deleted element), so the editor never emits a board the schema
 * would refuse. Pure: no DOM.
 */

import {
  arrowGeometry,
  geometryContext,
  withSectionMembers,
  type GeometryContext,
  type Measure,
} from './whiteboard-geometry'
import {
  isBoundEnd,
  isBoxElement,
  MAX_ELEMENTS,
  type ArrowElement,
  type ArrowEnd,
  type Point,
  type WhiteboardBoard,
  type WhiteboardElement,
} from './whiteboard'

const round1 = (v: number) => Math.round(v * 10) / 10

/** A fresh id with `prefix`, unique in `taken` (which it then joins). */
export function mintId(prefix: string, taken: Set<string>): string {
  for (;;) {
    const id = `${prefix}-${Math.random().toString(36).slice(2, 8)}`
    if (!taken.has(id)) {
      taken.add(id)
      return id
    }
  }
}

export function boardIds(board: WhiteboardBoard): Set<string> {
  return new Set(board.elements.map((element) => element.id))
}

export function addElements(board: WhiteboardBoard, elements: readonly WhiteboardElement[]): WhiteboardBoard {
  if (elements.length === 0) return board
  const room = Math.max(0, MAX_ELEMENTS - board.elements.length)
  return { ...board, elements: [...board.elements, ...elements.slice(0, room)] }
}

/**
 * Sections go to the back when added, so a new frame drawn around notes sits under them. It is
 * inserted just before the lowest element it covers.
 */
export function addSection(board: WhiteboardBoard, section: WhiteboardElement, ctx: GeometryContext): WhiteboardBoard {
  if (board.elements.length >= MAX_ELEMENTS) return board
  const members = new Set(
    withSectionMembers([...board.elements, section], [section.id], geometryContext([...board.elements, section], ctx.measure)),
  )
  members.delete(section.id)
  const index = board.elements.findIndex((element) => members.has(element.id))
  const elements = [...board.elements]
  elements.splice(index === -1 ? elements.length : index, 0, section)
  return { ...board, elements }
}

/** Merges `patches[id]` into each named element (fields the element type does not have are ignored). */
export function updateElements(
  board: WhiteboardBoard,
  patches: ReadonlyMap<string, Partial<WhiteboardElement>>,
): WhiteboardBoard {
  if (patches.size === 0) return board
  let changed = false
  const elements = board.elements.map((element) => {
    const patch = patches.get(element.id)
    if (!patch) return element
    const next = { ...element } as Record<string, unknown>
    for (const [key, value] of Object.entries(patch)) {
      if (key === 'id' || key === 'type') continue
      if (!(key in element) && !OPTIONAL_KEYS[element.type].includes(key)) continue
      if (value === undefined) delete next[key]
      else next[key] = value
    }
    changed = true
    return next as WhiteboardElement
  })
  return changed ? { ...board, elements } : board
}

const SHARED_OPTIONAL = ['groups', 'locked', 'hidden']

const PAINTS = ['fill', 'stroke']

const OPTIONAL_KEYS: Record<WhiteboardElement['type'], string[]> = {
  note: [...SHARED_OPTIONAL, 'fontSize', ...PAINTS, 'votes', 'autoSize'],
  shape: [...SHARED_OPTIONAL, 'text', 'fontSize', ...PAINTS, 'timer'],
  text: [...SHARED_OPTIONAL, 'w'],
  section: [...SHARED_OPTIONAL, 'color', ...PAINTS, 'noteColor', 'stack'],
  arrow: [...SHARED_OPTIONAL, 'label', 'head', 'color', 'stroke', 'routing', 'bend', 'labelAt', 'startHead', 'endHead'],
  stroke: [...SHARED_OPTIONAL],
  image: [...SHARED_OPTIONAL, 'crop'],
  sticker: [...SHARED_OPTIONAL, 'attachedTo'],
  table: [...SHARED_OPTIONAL, 'header', 'color', ...PAINTS, 'colWidths', 'rowHeights', 'merges'],
  link: [...SHARED_OPTIONAL, 'color', ...PAINTS, 'artifact'],
}

/** Whether an element takes separate fill and outline overrides (`fill`/`stroke`). */
export function supportsPaint(element: WhiteboardElement): 'both' | 'stroke' | null {
  if (element.type === 'arrow') return 'stroke'
  return OPTIONAL_KEYS[element.type].includes('fill') ? 'both' : null
}

/** Whether an element takes a board colour (for the colour picker to know what applies). */
export function supportsColor(element: WhiteboardElement): boolean {
  return element.type !== 'text' && element.type !== 'image' && element.type !== 'sticker'
}

function translate(element: WhiteboardElement, dx: number, dy: number): WhiteboardElement {
  if (isBoxElement(element) || element.type === 'text') {
    return { ...element, x: round1(element.x + dx), y: round1(element.y + dy) }
  }
  if (element.type === 'stroke') {
    return { ...element, points: element.points.map(([x, y]) => [round1(x + dx), round1(y + dy)] as [number, number]) }
  }
  const move = (end: ArrowEnd): ArrowEnd => (isBoundEnd(end) ? end : { x: round1(end.x + dx), y: round1(end.y + dy) })
  return { ...element, from: move(element.from), to: move(element.to) }
}

/**
 * Moves `ids` (and the members of any section among them) by (dx, dy). Bound arrow ends follow
 * their elements without being written; a free arrow end moves only when its arrow is moved.
 */
export function moveElements(
  board: WhiteboardBoard,
  ids: readonly string[],
  dx: number,
  dy: number,
  ctx: GeometryContext = geometryContext(board.elements),
): WhiteboardBoard {
  if (ids.length === 0 || (dx === 0 && dy === 0)) return board
  const moving = new Set(withSectionMembers(board.elements, ids, ctx))
  return {
    ...board,
    elements: board.elements.map((element) => (moving.has(element.id) ? translate(element, dx, dy) : element)),
  }
}

/** Moves exactly `ids` (the caller already expanded sections), for a drag in progress. */
export function translateElements(
  board: WhiteboardBoard,
  ids: ReadonlySet<string>,
  dx: number,
  dy: number,
): WhiteboardBoard {
  if (ids.size === 0 || (dx === 0 && dy === 0)) return board
  return {
    ...board,
    elements: board.elements.map((element) => (ids.has(element.id) ? translate(element, dx, dy) : element)),
  }
}

/** Arrow ends bound to an element outside `keep` become free points where they are drawn now. */
function freeEndsOutside(
  arrow: ArrowElement,
  keep: (id: string) => boolean,
  ctx: GeometryContext,
): ArrowElement {
  const fromGone = isBoundEnd(arrow.from) && !keep(arrow.from.elementId)
  const toGone = isBoundEnd(arrow.to) && !keep(arrow.to.elementId)
  if (!fromGone && !toGone) return arrow
  const geometry = arrowGeometry(arrow, ctx)
  return {
    ...arrow,
    from: fromGone ? { x: round1(geometry.start.x), y: round1(geometry.start.y) } : arrow.from,
    to: toGone ? { x: round1(geometry.end.x), y: round1(geometry.end.y) } : arrow.to,
  }
}

/**
 * Deletes `ids`. Arrows bound to a deleted element go with it (round 4: the same as the agent's
 * `removeElements`, so the editor and the agent agree; undo brings both back). Stickers attached
 * to a deleted element stay where they are, unattached.
 */
export function deleteElements(
  board: WhiteboardBoard,
  ids: readonly string[],
  _measure?: Measure,
): WhiteboardBoard {
  if (ids.length === 0) return board
  const gone = new Set(ids)
  const bound = (end: ArrowEnd) => isBoundEnd(end) && gone.has(end.elementId)
  const elements = board.elements
    .filter((element) => !gone.has(element.id) && !(element.type === 'arrow' && (bound(element.from) || bound(element.to))))
    .map((element) => (element.type === 'sticker' && element.attachedTo && gone.has(element.attachedTo) ? detach(element) : element))
  return { ...board, elements }
}

/** A sticker without its `attachedTo`. */
function detach<T extends WhiteboardElement>(element: T): T {
  if (element.type !== 'sticker' || element.attachedTo === undefined) return element
  const next = { ...element }
  delete (next as { attachedTo?: string }).attachedTo
  return next
}

/**
 * The elements to copy for `ids` (sections bring their members), in board order, with arrow ends
 * bound outside the copy freed. Self-contained: it can be pasted into any board.
 */
export function copyFragment(
  board: WhiteboardBoard,
  ids: readonly string[],
  ctx: GeometryContext = geometryContext(board.elements),
): WhiteboardElement[] {
  const chosen = new Set(withSectionMembers(board.elements, ids, ctx))
  return board.elements
    .filter((element) => chosen.has(element.id))
    .map((element) =>
      element.type === 'arrow'
        ? freeEndsOutside(element, (id) => chosen.has(id), ctx)
        : element.type === 'sticker' && element.attachedTo && !chosen.has(element.attachedTo)
          ? detach(element)
          : element,
    )
}

/**
 * Pastes a fragment offset by (dx, dy) with fresh ids (arrows re-pointed at the copies). Returns
 * the board and the new ids, which become the selection.
 */
export function pasteFragment(
  board: WhiteboardBoard,
  fragment: readonly WhiteboardElement[],
  dx: number,
  dy: number,
): { board: WhiteboardBoard; ids: string[] } {
  const existing = boardIds(board)
  const taken = new Set(existing)
  const idMap = new Map<string, string>()
  for (const element of fragment) idMap.set(element.id, mintId(element.type, taken))
  // Copies form their own groups: a pasted group is a new group, never a member of the original.
  const groupMap = new Map<string, string>()
  const regroup = (groups: string[] | undefined) => {
    if (!groups) return undefined
    return groups.map((group) => {
      let next = groupMap.get(group)
      if (!next) {
        next = mintId('group', taken)
        groupMap.set(group, next)
      }
      return next
    })
  }
  const copies = fragment.map((element) => {
    const renamed = { ...element, id: idMap.get(element.id)! } as WhiteboardElement
    if (element.groups) renamed.groups = regroup(element.groups)
    const moved = translate(renamed, dx, dy)
    if (moved.type === 'sticker' && moved.attachedTo !== undefined) {
      const target = idMap.get(moved.attachedTo)
      return target ? { ...moved, attachedTo: target } : detach(moved)
    }
    if (moved.type !== 'arrow') return moved
    const remap = (end: ArrowEnd): ArrowEnd => {
      if (!isBoundEnd(end)) return end
      const target = idMap.get(end.elementId)
      return target ? { ...end, elementId: target } : end
    }
    return { ...moved, from: remap(moved.from), to: remap(moved.to) }
  })
  const room = Math.max(0, MAX_ELEMENTS - board.elements.length)
  const kept = copies.slice(0, room)
  const keptIds = new Set(kept.map((element) => element.id))
  // An arrow whose bound copy did not fit is dropped rather than left dangling.
  const valid = kept.filter(
    (element) =>
      element.type !== 'arrow' ||
      [element.from, element.to].every((end) => !isBoundEnd(end) || keptIds.has(end.elementId) || existing.has(end.elementId)),
  )
  return { board: { ...board, elements: [...board.elements, ...valid] }, ids: valid.map((element) => element.id) }
}

export type ReorderDirection = 'forward' | 'backward' | 'front' | 'back'

/** Moves `ids` one step (or all the way) up or down the drawing order, keeping their relative order. */
export function reorder(board: WhiteboardBoard, ids: readonly string[], direction: ReorderDirection): WhiteboardBoard {
  const chosen = new Set(ids)
  if (chosen.size === 0) return board
  const elements = [...board.elements]
  if (direction === 'front' || direction === 'back') {
    const picked = elements.filter((element) => chosen.has(element.id))
    const rest = elements.filter((element) => !chosen.has(element.id))
    return { ...board, elements: direction === 'front' ? [...rest, ...picked] : [...picked, ...rest] }
  }
  if (direction === 'forward') {
    for (let i = elements.length - 2; i >= 0; i--) {
      if (chosen.has(elements[i].id) && !chosen.has(elements[i + 1].id)) {
        ;[elements[i], elements[i + 1]] = [elements[i + 1], elements[i]]
      }
    }
  } else {
    for (let i = 1; i < elements.length; i++) {
      if (chosen.has(elements[i].id) && !chosen.has(elements[i - 1].id)) {
        ;[elements[i], elements[i - 1]] = [elements[i - 1], elements[i]]
      }
    }
  }
  return { ...board, elements }
}

// ---- describing a selection for the chat

const quote = (text: string) => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > 80 ? `“${flat.slice(0, 79)}…”` : `“${flat}”`
}

function labelOf(element: WhiteboardElement | undefined): string {
  if (!element) return 'a point'
  switch (element.type) {
    case 'note':
    case 'text':
      return element.text.trim() ? quote(element.text) : `an empty ${element.type}`
    case 'shape':
      return element.text?.trim() ? quote(element.text) : `a ${element.kind}`
    case 'section':
      return `section ${quote(element.title || 'Untitled')}`
    case 'image':
      return `image ${quote(element.alt || 'untitled')}`
    case 'link':
      return `link ${quote(element.title || element.url)}`
    case 'sticker':
      return `a ${element.sticker} sticker`
    case 'table':
      return `a ${element.rows.length}×${element.rows[0]?.length ?? 0} table`
    default:
      return `a ${element.type}`
  }
}

const NOUN: Record<WhiteboardElement['type'], [string, string]> = {
  note: ['note', 'notes'],
  shape: ['shape', 'shapes'],
  text: ['text', 'texts'],
  section: ['section', 'sections'],
  arrow: ['arrow', 'arrows'],
  stroke: ['sketch', 'sketches'],
  image: ['image', 'images'],
  sticker: ['sticker', 'stickers'],
  table: ['table', 'tables'],
  link: ['link card', 'link cards'],
}

/**
 * A plain-text account of the selection for the agent: a count line, then one line per element
 * (at most 40). It is data the agent reads, never instructions. `withIds` (Ask Buffy) ends each
 * line with the element's id, so the agent can edit exactly those; a comment's quote leaves them out.
 */
export function describeSelection(board: WhiteboardBoard, ids: readonly string[], options: { withIds?: boolean } = {}): string {
  const byId = new Map(board.elements.map((element) => [element.id, element]))
  const picked = ids.map((id) => byId.get(id)).filter((element): element is WhiteboardElement => !!element)
  if (picked.length === 0) return ''
  const counts = new Map<WhiteboardElement['type'], number>()
  for (const element of picked) counts.set(element.type, (counts.get(element.type) ?? 0) + 1)
  const head = [...counts]
    .map(([type, count]) => `${count} ${NOUN[type][count === 1 ? 0 : 1]}`)
    .join(', ')
  const lines = picked.slice(0, 40).map((element) => (options.withIds ? `${describeLine(element)} [id ${element.id}]` : describeLine(element)))
  const more = picked.length > 40 ? [`- …and ${picked.length - 40} more`] : []
  return [`${head} on “${board.title}”:`, ...lines, ...more].join('\n')

  function describeLine(element: WhiteboardElement): string {
    switch (element.type) {
      case 'note':
        return `- note ${labelOf(element)} (${element.color}${element.votes ? `, ${element.votes} vote${element.votes === 1 ? '' : 's'}` : ''})`
      case 'shape':
        return `- ${element.kind} ${labelOf(element)}${element.timer ? ` (a ${Math.round(element.timer.duration / 60) || 1} min timer)` : ''}`
      case 'text':
        return `- text ${labelOf(element)}`
      case 'section':
        return `- ${labelOf(element)}`
      case 'image':
      case 'sticker':
        return `- ${labelOf(element)}`
      case 'link':
        return `- ${labelOf(element)} (${element.url})`
      case 'table': {
        const head = element.rows[0].map((cell) => cell.trim()).filter(Boolean).join(' | ')
        return `- ${labelOf(element)}${head ? `: ${quote(head)}` : ''}`
      }
      case 'stroke':
        return `- a ${element.color} marker sketch`
      case 'arrow': {
        const end = (e: ArrowEnd) => (isBoundEnd(e) ? labelOf(byId.get(e.elementId)) : 'a point')
        const label = element.label ? ` labelled ${quote(element.label)}` : ''
        return `- arrow from ${end(element.from)} to ${end(element.to)}${label}`
      }
    }
  }
}

/** The world point at the centre of a list of points (the paste target when nothing better is known). */
export function centroid(points: readonly Point[]): Point {
  if (points.length === 0) return { x: 0, y: 0 }
  const sum = points.reduce((acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y }), { x: 0, y: 0 })
  return { x: sum.x / points.length, y: sum.y / points.length }
}
