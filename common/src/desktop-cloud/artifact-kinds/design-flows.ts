import type { Design, DesignNode, Transition } from './design'
import { resolveInstance } from './design-components'
import { collectMains } from './design'
import { boardsOnPage, pagesOf } from './design-pages'

/**
 * Prototype flows: every click-through link in a design (from which node on which board, to which
 * board, with which transition) and the board the prototype starts on. Pure.
 */

export type PrototypeLink = {
  fromBoardId: string
  /** The node carrying `linkTo` (inside an instance: the instance's drawn id `<instance>~<node>`). */
  nodeId: string
  /** A readable label: the layer name, the button label or the node id. */
  label: string
  toBoardId: string
  transition: Transition
  trigger: 'click'
}

const labelOf = (node: DesignNode): string =>
  node.name ?? (node.type === 'button' ? node.label : node.type === 'text' ? node.text.slice(0, 40) : node.id)

/** Every link, board by board in page order, depth first (instances drawn as they would be). */
export function prototypeLinks(design: Design): PrototypeLink[] {
  const mains = collectMains(design.boards)
  const out: PrototypeLink[] = []
  const ordered = pagesOf(design).flatMap((page) => boardsOnPage(design, page.id))
  for (const board of ordered) {
    const visit = (node: DesignNode, depth: number) => {
      if (depth > 40 || node.hidden) return
      if ((node.type === 'frame' || node.type === 'button') && node.linkTo !== undefined) {
        out.push({ fromBoardId: board.id, nodeId: node.id, label: labelOf(node), toBoardId: node.linkTo, transition: node.transition ?? 'instant', trigger: 'click' })
      }
      if (node.type !== 'frame') return
      const shown = node.instanceOf !== undefined ? resolveInstance(node, mains) : node
      if (shown !== node && shown.linkTo !== undefined && node.linkTo === undefined) {
        out.push({ fromBoardId: board.id, nodeId: node.id, label: labelOf(shown), toBoardId: shown.linkTo, transition: shown.transition ?? 'instant', trigger: 'click' })
      }
      for (const child of shown.children) visit(child, depth + 1)
    }
    visit(board.root, 0)
  }
  return out
}

/** Where Present and the device preview start: `startBoard`, else the first board in page order. */
export function startBoardOf(design: Design): string | null {
  if (design.startBoard && design.boards.some((board) => board.id === design.startBoard)) return design.startBoard
  const first = pagesOf(design).flatMap((page) => boardsOnPage(design, page.id))[0]
  return first?.id ?? null
}

/** Sets (or with null clears) the prototype's start board; unchanged for an unknown board. */
export function setStartBoard(design: Design, boardId: string | null): Design {
  if (boardId === null) {
    if (design.startBoard === undefined) return design
    const { startBoard: _gone, ...rest } = design
    return rest
  }
  if (!design.boards.some((board) => board.id === boardId)) return design
  return { ...design, startBoard: boardId }
}

/** Boards no link reaches and that are not the start: dead ends of a flow to review. */
export function unreachableBoards(design: Design): string[] {
  const start = startBoardOf(design)
  const reached = new Set(prototypeLinks(design).map((link) => link.toBoardId))
  return design.boards.filter((board) => board.id !== start && !reached.has(board.id)).map((board) => board.id)
}
