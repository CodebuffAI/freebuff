import { DESIGN_LIMITS, type Design, type DesignBoard, type DesignNode, type DesignNote, type DesignTokens, type FrameNode } from './design'

/**
 * Pure operations on a design: find, update, insert, remove, duplicate and reorder nodes and
 * boards. Every function returns a new design (structural sharing; the input is never mutated)
 * and leaves it valid: ids stay unique, duplicates get fresh ids for their whole subtree.
 */

export type NodeHit = {
  node: DesignNode
  parent: FrameNode | null
  index: number
  depth: number
}

export function* walkNodes(
  root: DesignNode,
  parent: FrameNode | null = null,
  depth = 1,
): Generator<NodeHit> {
  const stack: NodeHit[] = [{ node: root, parent, index: 0, depth }]
  while (stack.length > 0) {
    const hit = stack.pop()!
    yield hit
    if (hit.node.type === 'frame') {
      const frame = hit.node
      for (let i = frame.children.length - 1; i >= 0; i -= 1) {
        stack.push({ node: frame.children[i], parent: frame, index: i, depth: hit.depth + 1 })
      }
    }
  }
}

export function findNode(root: DesignNode, nodeId: string): NodeHit | null {
  for (const hit of walkNodes(root)) if (hit.node.id === nodeId) return hit
  return null
}

export function getBoard(design: Design, boardId: string): DesignBoard | undefined {
  return design.boards.find((board) => board.id === boardId)
}

/** The board holding a node, by id. */
export function boardOfNode(design: Design, nodeId: string): DesignBoard | undefined {
  return design.boards.find((board) => findNode(board.root, nodeId) !== null)
}

/** Root-first chain of nodes ending at `nodeId`, or [] when it is not in the tree. */
export function nodeChain(root: DesignNode, nodeId: string): DesignNode[] {
  const chain: DesignNode[] = []
  const visit = (node: DesignNode): boolean => {
    chain.push(node)
    if (node.id === nodeId) return true
    if (node.type === 'frame') for (const child of node.children) if (visit(child)) return true
    chain.pop()
    return false
  }
  return visit(root) ? chain : []
}

export function countNodes(root: DesignNode): number {
  let count = 0
  for (const _ of walkNodes(root)) count += 1
  return count
}

export function allIds(design: Design): Set<string> {
  const ids = new Set<string>()
  for (const board of design.boards) {
    ids.add(board.id)
    for (const hit of walkNodes(board.root)) ids.add(hit.node.id)
  }
  for (const note of design.notes ?? []) ids.add(note.id)
  for (const page of design.pages ?? []) ids.add(page.id)
  return ids
}

const slug = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'node'

/** A fresh id from `base` not in `taken` (and added to it). */
export function freshId(taken: Set<string>, base: string): string {
  const stem = slug(base)
  let candidate = stem
  for (let n = 2; taken.has(candidate); n += 1) candidate = `${stem}-${n}`
  taken.add(candidate)
  return candidate
}

/** A deep copy of a subtree with every id replaced by a fresh one. */
export function reidSubtree(node: DesignNode, taken: Set<string>): DesignNode {
  const id = freshId(taken, node.id.replace(/-\d+$/, ''))
  if (node.type !== 'frame') return { ...node, id }
  return { ...node, id, children: node.children.map((child) => reidSubtree(child, taken)) }
}

/** Rebuilds the path to `nodeId`, replacing it with `fn(node)` (or removing it when fn returns null). */
function mapNode(
  root: FrameNode,
  nodeId: string,
  fn: (node: DesignNode, parent: FrameNode | null) => DesignNode | DesignNode[] | null,
): FrameNode {
  if (root.id === nodeId) {
    const next = fn(root, null)
    // The root itself can be replaced by a frame only; never removed.
    return next && !Array.isArray(next) && next.type === 'frame' ? next : root
  }
  const visit = (frame: FrameNode): FrameNode | null => {
    const index = frame.children.findIndex((child) => child.id === nodeId)
    if (index !== -1) {
      const result = fn(frame.children[index], frame)
      const replacement = result === null ? [] : Array.isArray(result) ? result : [result]
      const children = [...frame.children]
      children.splice(index, 1, ...replacement)
      return { ...frame, children }
    }
    for (let i = 0; i < frame.children.length; i += 1) {
      const child = frame.children[i]
      if (child.type !== 'frame') continue
      const next = visit(child)
      if (next) {
        const children = [...frame.children]
        children[i] = next
        return { ...frame, children }
      }
    }
    return null
  }
  return visit(root) ?? root
}

export function updateBoard(
  design: Design,
  boardId: string,
  fn: (board: DesignBoard) => DesignBoard,
): Design {
  let changed = false
  const boards = design.boards.map((board) => {
    if (board.id !== boardId) return board
    const next = fn(board)
    if (next !== board) changed = true
    return next
  })
  return changed ? { ...design, boards } : design
}

/** Replace one board wholesale (the agent's one-board-per-write edit). Appends when new. */
export function replaceBoard(design: Design, board: DesignBoard): Design {
  return design.boards.some((existing) => existing.id === board.id)
    ? updateBoard(design, board.id, () => board)
    : { ...design, boards: [...design.boards, board] }
}

/**
 * Patch a node's fields. Keys set to `undefined` in the patch are removed, so the stored JSON
 * never carries explicit undefined. The node's id and type never change.
 */
export function updateNode(
  design: Design,
  boardId: string,
  nodeId: string,
  patch: Partial<Record<string, unknown>>,
): Design {
  return updateBoard(design, boardId, (board) => ({
    ...board,
    root: mapNode(board.root, nodeId, (node) => {
      const next: Record<string, unknown> = { ...node }
      for (const [key, value] of Object.entries(patch)) {
        if (key === 'id' || key === 'type') continue
        if (value === undefined) delete next[key]
        else next[key] = value
      }
      return next as DesignNode
    }),
  }))
}

export function removeNode(design: Design, boardId: string, nodeId: string): Design {
  return updateBoard(design, boardId, (board) => ({
    ...board,
    root: mapNode(board.root, nodeId, () => null),
  }))
}

/** Duplicates a node next to itself; returns the new design and the copy's id. */
export function duplicateNode(
  design: Design,
  boardId: string,
  nodeId: string,
): { design: Design; nodeId: string | null } {
  const board = getBoard(design, boardId)
  if (!board || board.root.id === nodeId) return { design, nodeId: null }
  const taken = allIds(design)
  let copyId: string | null = null
  const next = updateBoard(design, boardId, (current) => ({
    ...current,
    root: mapNode(current.root, nodeId, (node, parent) => {
      const copy = reidSubtree(node, taken)
      if (parent?.layout === 'absolute') {
        copy.x = (node.x ?? 0) + 16
        copy.y = (node.y ?? 0) + 16
      }
      copyId = copy.id
      return [node, copy]
    }),
  }))
  return { design: next, nodeId: copyId }
}

/** Moves a node among its siblings by `delta` places (clamped). */
export function moveNode(design: Design, boardId: string, nodeId: string, delta: number): Design {
  return updateBoard(design, boardId, (board) => {
    const hit = findNode(board.root, nodeId)
    if (!hit?.parent) return board
    const parentId = hit.parent.id
    const target = Math.max(0, Math.min(hit.parent.children.length - 1, hit.index + delta))
    if (target === hit.index) return board
    const reorder = (frame: FrameNode): FrameNode => {
      const children = [...frame.children]
      const [moved] = children.splice(hit.index, 1)
      children.splice(target, 0, moved)
      return { ...frame, children }
    }
    if (parentId === board.root.id) return { ...board, root: reorder(board.root) }
    return {
      ...board,
      root: mapNode(board.root, parentId, (parent) => reorder(parent as FrameNode)),
    }
  })
}

/** Inserts `node` into frame `parentId` at `index` (default: the end). */
export function insertNode(
  design: Design,
  boardId: string,
  parentId: string,
  node: DesignNode,
  index?: number,
): Design {
  const insert = (frame: FrameNode): FrameNode => {
    const children = [...frame.children]
    children.splice(index ?? children.length, 0, node)
    return { ...frame, children }
  }
  return updateBoard(design, boardId, (board) =>
    board.root.id === parentId
      ? { ...board, root: insert(board.root) }
      : {
          ...board,
          root: mapNode(board.root, parentId, (parent) =>
            parent.type === 'frame' ? insert(parent) : parent,
          ),
        },
  )
}

export type MoveTarget = { boardId: string; parentId: string; index: number; x?: number; y?: number }

/**
 * Moves node `nodeId` (on `fromBoardId`) into frame `to.parentId` at `to.index` (an index into
 * the target's children as they are BEFORE the move), on the same or another board. With
 * `copy`, a fresh-id duplicate goes there instead and the original stays. Entering an absolute
 * frame sets x/y (to.x/y, default 0); leaving one drops them. Returns the design unchanged (and
 * null) when the move cannot apply: the root, a frame into its own subtree, a non-frame or an
 * instance target, a full frame, or a move that changes nothing.
 */
export function moveNodeTo(
  design: Design,
  fromBoardId: string,
  nodeId: string,
  to: MoveTarget,
  options: { copy?: boolean } = {},
): { design: Design; nodeId: string | null } {
  const unchanged = { design, nodeId: null }
  const from = getBoard(design, fromBoardId)
  const target = getBoard(design, to.boardId)
  if (!from || !target) return unchanged
  const hit = findNode(from.root, nodeId)
  if (!hit?.parent) return unchanged
  const parentHit = findNode(target.root, to.parentId)
  const parent = parentHit?.node
  if (!parent || parent.type !== 'frame' || parent.instanceOf !== undefined) return unchanged
  if (to.boardId === fromBoardId && findNode(hit.node, to.parentId)) return unchanged
  const sameParent = to.boardId === fromBoardId && hit.parent.id === to.parentId
  if (!sameParent && parent.children.length >= DESIGN_LIMITS.maxChildren) return unchanged
  let index = Math.max(0, Math.min(parent.children.length, Math.round(to.index)))
  if (sameParent && !options.copy) {
    // Removing the node first shifts every later index down by one.
    if (index > hit.index) index -= 1
    if (index === hit.index && parent.layout !== 'absolute') return unchanged
  }
  let moved: DesignNode = options.copy ? reidSubtree(hit.node, allIds(design)) : hit.node
  if (parent.layout === 'absolute') {
    moved = { ...moved, x: Math.round(to.x ?? moved.x ?? 0), y: Math.round(to.y ?? moved.y ?? 0) }
  } else if (moved.x !== undefined || moved.y !== undefined) {
    const { x: _x, y: _y, ...rest } = moved
    moved = rest as DesignNode
  }
  const without = options.copy ? design : removeNode(design, fromBoardId, nodeId)
  return { design: insertNode(without, to.boardId, to.parentId, moved, index), nodeId: moved.id }
}

/** Removes a board and every `linkTo` that pointed at it, so no link dangles. */
export function removeBoard(design: Design, boardId: string): Design {
  const unlink = (node: DesignNode): DesignNode => {
    let next = node
    if ((node.type === 'frame' || node.type === 'button') && node.linkTo === boardId) {
      const { linkTo: _gone, transition: _with, ...rest } = node
      next = rest as DesignNode
    }
    if (next.type === 'frame') next = { ...next, children: next.children.map(unlink) }
    return next
  }
  const next: Design = {
    ...design,
    boards: design.boards.filter((board) => board.id !== boardId).map((board) => ({ ...board, root: unlink(board.root) as FrameNode })),
  }
  // The prototype's start board goes with it (the next board in order starts instead).
  if (next.startBoard === boardId) delete next.startBoard
  return next
}

/** Duplicates a board to its right with fresh ids throughout; returns the copy's id. */
export function duplicateBoard(
  design: Design,
  boardId: string,
): { design: Design; boardId: string | null } {
  const index = design.boards.findIndex((board) => board.id === boardId)
  if (index === -1) return { design, boardId: null }
  const source = design.boards[index]
  const taken = allIds(design)
  const copy: DesignBoard = {
    ...source,
    id: freshId(taken, source.id.replace(/-\d+$/, '')),
    title: `${source.title} copy`.slice(0, 120),
    x: source.x + source.w + BOARD_GAP,
    root: reidSubtree(source.root, taken) as FrameNode,
  }
  const boards = [...design.boards]
  boards.splice(index + 1, 0, copy)
  return { design: { ...design, boards }, boardId: copy.id }
}

export const BOARD_GAP = 120

export function updateNote(
  design: Design,
  noteId: string,
  fn: (note: DesignNote) => DesignNote | null,
): Design {
  const notes = (design.notes ?? []).flatMap((note) => {
    if (note.id !== noteId) return [note]
    const next = fn(note)
    return next ? [next] : []
  })
  return { ...design, notes }
}

// ---- tokens

/** How many colour fields name a token. */
export function tokenUsage(design: Design, name: string): number {
  let count = 0
  const keys = ['fill', 'stroke', 'color', 'background'] as const
  for (const board of design.boards) {
    if (board.background === name) count += 1
    for (const { node } of walkNodes(board.root)) {
      const record = node as Record<string, unknown>
      for (const key of keys) if (record[key] === name) count += 1
      const gradient = record.gradient as { from?: string; to?: string } | undefined
      if (gradient?.from === name) count += 1
      if (gradient?.to === name) count += 1
    }
  }
  return count
}

export function setTokens(design: Design, tokens: DesignTokens): Design {
  return { ...design, tokens }
}

export function setColorToken(design: Design, name: string, hex: string): Design {
  const tokens: DesignTokens = design.tokens ?? { colors: {} }
  return { ...design, tokens: { ...tokens, colors: { ...tokens.colors, [name]: hex } } }
}

/** Removes a colour token, replacing every reference with its hex so nothing dangles. */
export function removeColorToken(design: Design, name: string): Design {
  const hex = design.tokens?.colors[name]
  if (!design.tokens || hex === undefined) return design
  const { [name]: _removed, ...colors } = design.tokens.colors
  const keys = ['fill', 'stroke', 'color', 'background'] as const
  const swap = (node: DesignNode): DesignNode => {
    const record: Record<string, unknown> = { ...node }
    for (const key of keys) if (record[key] === name) record[key] = hex
    const gradient = record.gradient as { from: string; to: string } | undefined
    if (gradient && (gradient.from === name || gradient.to === name)) {
      record.gradient = { ...gradient, from: gradient.from === name ? hex : gradient.from, to: gradient.to === name ? hex : gradient.to }
    }
    if (node.type === 'frame') record.children = node.children.map(swap)
    return record as DesignNode
  }
  const swapColor = (value: string) => (value === name ? hex : value)
  const styles = design.styles
    ? {
        ...design.styles,
        ...(design.styles.text ? { text: design.styles.text.map((style) => (style.color === name ? { ...style, color: hex } : style)) } : {}),
        ...(design.styles.fills
          ? {
              fills: design.styles.fills.map((style) => ({
                ...style,
                fill: swapColor(style.fill),
                ...(style.gradient ? { gradient: { ...style.gradient, from: swapColor(style.gradient.from), to: swapColor(style.gradient.to) } } : {}),
              })),
            }
          : {}),
      }
    : undefined
  // Round 5: its dark value goes with it; a colour lever holding it keeps the hex.
  const tokens: DesignTokens = { ...design.tokens, colors }
  if (design.tokens.themes?.dark && name in design.tokens.themes.dark) {
    const { [name]: _dark, ...dark } = design.tokens.themes.dark
    tokens.themes = Object.keys(dark).length ? { dark } : undefined
    if (!tokens.themes) delete tokens.themes
  }
  const variables = design.variables?.map((variable) => (variable.type === 'color' && variable.value === name ? { ...variable, value: hex } : variable))
  return {
    ...design,
    ...(styles ? { styles } : {}),
    ...(variables ? { variables } : {}),
    tokens,
    boards: design.boards.map((board) => ({
      ...board,
      background: board.background === name ? hex : board.background,
      root: swap(board.root) as FrameNode,
    })),
  }
}
