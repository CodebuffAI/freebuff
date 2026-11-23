import { DESIGN_LIMITS, type Design, type DesignBoard, type DesignNote, type DesignPage } from './design'
import { BOARD_GAP, allIds, freshId } from './design-tree'
import { detachInstancesOf, mainsInSubtree, removeBoardDetaching } from './design-components'

/**
 * Pages: each page is its own canvas of boards and notes. A design without `pages` (every v1
 * body) has ONE implicit page, and a board or note without `page` sits on the first page, so
 * old bodies keep working untouched. These helpers are the only place that fallback lives.
 * Whenever they rewrite `pages` they stamp every board and note with its page first, so a
 * reorder or removal never silently moves a page-less board onto another page.
 */

/** The id the implicit page of a page-less design goes by in the editor (never stored). */
export const IMPLICIT_PAGE_ID = 'page-1'

export function pagesOf(design: Design): DesignPage[] {
  return design.pages && design.pages.length > 0 ? design.pages : [{ id: IMPLICIT_PAGE_ID, title: 'Page 1' }]
}

/** The page a board or note sits on. */
export function pageOf(design: Design, item: { page?: string }): string {
  const pages = pagesOf(design)
  if (item.page && pages.some((page) => page.id === item.page)) return item.page
  return pages[0].id
}

export function boardsOnPage(design: Design, pageId: string): DesignBoard[] {
  return design.boards.filter((board) => pageOf(design, board) === pageId)
}

export function notesOnPage(design: Design, pageId: string): DesignNote[] {
  return (design.notes ?? []).filter((note) => pageOf(design, note) === pageId)
}

/** The design as one page sees it (the canvas draws only these boards and notes). */
export function pageView(design: Design, pageId: string): Design {
  if (!design.pages) return design
  return { ...design, boards: boardsOnPage(design, pageId), notes: notesOnPage(design, pageId) }
}

/** Pages declared explicitly, with every board and note stamped with its page. */
function materialise(design: Design): Design {
  const taken = allIds(design)
  const pages = design.pages && design.pages.length > 0 ? design.pages : [{ id: freshId(taken, IMPLICIT_PAGE_ID), title: 'Page 1' }]
  const first = pages[0].id
  const ids = new Set(pages.map((page) => page.id))
  const stamp = <T extends { page?: string }>(item: T): T => (item.page && ids.has(item.page) ? item : { ...item, page: first })
  return {
    ...design,
    pages,
    boards: design.boards.map(stamp),
    ...(design.notes ? { notes: design.notes.map(stamp) } : {}),
  }
}

/** Adds a page after `after` (default: the end); returns its id, or null at the page limit. */
export function addPage(
  design: Design,
  title?: string,
  options: { id?: string; after?: string } = {},
): { design: Design; pageId: string | null } {
  const base = materialise(design)
  const pages = base.pages!
  if (pages.length >= DESIGN_LIMITS.maxPages) return { design, pageId: null }
  const taken = allIds(base)
  if (options.id !== undefined && taken.has(options.id)) return { design, pageId: null }
  const pageId = options.id ?? freshId(taken, `page-${pages.length + 1}`)
  const page: DesignPage = { id: pageId, title: (title?.trim() || `Page ${pages.length + 1}`).slice(0, 80) }
  const at = options.after === undefined ? pages.length : pages.findIndex((entry) => entry.id === options.after) + 1
  const next = [...pages]
  next.splice(at <= 0 ? pages.length : at, 0, page)
  return { design: { ...base, pages: next }, pageId }
}

export function renamePage(design: Design, pageId: string, title: string): Design {
  const trimmed = title.trim().slice(0, 80)
  if (!trimmed) return design
  const base = materialise(design)
  const pages = base.pages!
  const page = pages.find((entry) => entry.id === pageId) ?? (pageId === IMPLICIT_PAGE_ID && !design.pages ? pages[0] : undefined)
  if (!page || page.title === trimmed) return design
  return { ...base, pages: pages.map((entry) => (entry === page ? { ...entry, title: trimmed } : entry)) }
}

/**
 * Removes a page with its boards and notes (links into them are dropped and instances of main
 * components on them are detached, so nothing dangles). The last page cannot be removed.
 */
export function removePage(design: Design, pageId: string): Design {
  const pages = pagesOf(design)
  if (pages.length <= 1 || !pages.some((page) => page.id === pageId)) return design
  let next = materialise(design)
  const doomed = next.boards.filter((board) => board.page === pageId)
  const mains = doomed.flatMap((board) => mainsInSubtree(board.root))
  next = detachInstancesOf(next, mains)
  for (const board of doomed) next = removeBoardDetaching(next, board.id)
  return {
    ...next,
    pages: next.pages!.filter((page) => page.id !== pageId),
    ...(next.notes ? { notes: next.notes.filter((note) => note.page !== pageId) } : {}),
  }
}

/** Moves a page to `index` in the page list. */
export function movePage(design: Design, pageId: string, index: number): Design {
  if (!design.pages) return design
  const from = design.pages.findIndex((page) => page.id === pageId)
  const to = Math.max(0, Math.min(design.pages.length - 1, index))
  if (from === -1 || from === to) return design
  const base = materialise(design)
  const pages = [...base.pages!]
  const [page] = pages.splice(from, 1)
  pages.splice(to, 0, page)
  return { ...base, pages }
}

/** Where a new board goes on a page: right of that page's rightmost board on its top row. */
export function placeOnPage(design: Design, pageId: string, gap = BOARD_GAP): { x: number; y: number } {
  const boards = boardsOnPage(design, pageId)
  if (boards.length === 0) return { x: 0, y: 0 }
  const top = Math.min(...boards.map((board) => board.y))
  const row = boards.filter((board) => board.y < top + 200)
  const right = Math.max(...row.map((board) => board.x + board.w))
  return { x: Math.round(right + gap), y: Math.round(top) }
}

/** Moves a board to another page, placed in free space there. */
export function moveBoardToPage(design: Design, boardId: string, pageId: string): Design {
  const board = design.boards.find((entry) => entry.id === boardId)
  if (!board || !pagesOf(design).some((page) => page.id === pageId) || pageOf(design, board) === pageId) return design
  const base = materialise(design)
  const at = placeOnPage(base, pageId)
  return { ...base, boards: base.boards.map((entry) => (entry.id === boardId ? { ...entry, page: pageId, ...at } : entry)) }
}

/** The page to show after an edit: `current` when it still exists, else the first page. */
export function reconcilePage(design: Design, current: string | null): string {
  const pages = pagesOf(design)
  return current && pages.some((page) => page.id === current) ? current : pages[0].id
}
