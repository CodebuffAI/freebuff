import {
  DESIGN_LIMITS,
  type Design,
  type DesignBoard,
  type DesignDataList,
  type DesignNode,
  type DesignVariable,
  type FrameNode,
  type Interaction,
} from './design'

/**
 * Edits for round 5's logic and prototype fields, shared by the editor and the agent's ops:
 * variables (levers), data lists, and the clean-up that keeps references valid when what they
 * name goes away (a removed variable, list, node or board drops the `showIf`, binding,
 * interaction, repeat or focus entry that named it, never leaving the design invalid). Pure.
 */

function mapAllNodes(design: Design, fn: (node: DesignNode, inRepeat: boolean) => DesignNode): Design {
  let changed = false
  const visit = (node: DesignNode, inRepeat: boolean): DesignNode => {
    let next = fn(node, inRepeat)
    if (next.type === 'frame') {
      const nested = inRepeat || next.repeat !== undefined
      let kidsChanged = false
      const children = next.children.map((child) => {
        const out = visit(child, nested)
        if (out !== child) kidsChanged = true
        return out
      })
      if (kidsChanged) next = { ...next, children }
    }
    if (next !== node) changed = true
    return next
  }
  const boards = design.boards.map((board) => {
    const root = visit(board.root, false) as FrameNode
    return root === board.root ? board : { ...board, root }
  })
  return changed ? { ...design, boards } : design
}

function without<T extends object>(value: T, key: keyof T): T {
  const copy = { ...value }
  delete copy[key]
  return copy
}

/** Adds the variable, or replaces the one with its id. Null when the design is at the cap. */
export function setVariable(design: Design, variable: DesignVariable): Design | null {
  const list = design.variables ?? []
  const at = list.findIndex((entry) => entry.id === variable.id)
  if (at === -1 && list.length >= DESIGN_LIMITS.maxVariables) return null
  const next = at === -1 ? [...list, variable] : list.map((entry, index) => (index === at ? variable : entry))
  return { ...design, variables: next }
}

/** A variable's new value (the Props panel's lever moving). */
export function setVariableValue(design: Design, id: string, value: DesignVariable['value']): Design {
  const variables = (design.variables ?? []).map((entry) => (entry.id === id ? { ...entry, value } : entry))
  return { ...design, variables }
}

/** Adds the data list, or replaces the one with its id. Null when the design is at the cap. */
export function setDataList(design: Design, list: DesignDataList): Design | null {
  const lists = design.data ?? []
  const at = lists.findIndex((entry) => entry.id === list.id)
  if (at === -1 && lists.length >= DESIGN_LIMITS.maxDataLists) return null
  const next = at === -1 ? [...lists, list] : lists.map((entry, index) => (index === at ? list : entry))
  return pruneDangling({ ...design, data: next })
}

export function removeVariable(design: Design, id: string): Design {
  const variables = (design.variables ?? []).filter((entry) => entry.id !== id)
  const next: Design = { ...design, variables: variables.length ? variables : undefined }
  if (!next.variables) delete next.variables
  return pruneDangling(next)
}

export function removeDataList(design: Design, id: string): Design {
  const data = (design.data ?? []).filter((entry) => entry.id !== id)
  const next: Design = { ...design, data: data.length ? data : undefined }
  if (!next.data) delete next.data
  return pruneDangling(next)
}

/**
 * Drops every round-5 reference to something that is gone: a `showIf` or binding naming a
 * missing variable (or a row field outside any repeat), a repeat naming a missing list, an
 * interaction naming a missing board, node or variable, a focus entry naming a node no longer on
 * its board. Identity when nothing dangles.
 */
export function pruneDangling(design: Design): Design {
  const variables = new Set((design.variables ?? []).map((entry) => entry.id))
  const lists = new Map((design.data ?? []).map((entry) => [entry.id, entry]))
  const boards = new Set(design.boards.map((board) => board.id))
  const nodes = new Set<string>()
  const instances = new Set<string>()
  const mains = new Set<string>()
  for (const board of design.boards) {
    const stack: DesignNode[] = [board.root]
    while (stack.length) {
      const node = stack.pop()!
      nodes.add(node.id)
      if (node.type === 'frame') {
        if (node.instanceOf !== undefined) instances.add(node.id)
        if (node.component) mains.add(node.id)
        stack.push(...node.children)
      }
    }
  }
  const keep = (interaction: Interaction): boolean => {
    const { action, target } = interaction
    if (action === 'back' || action === 'closeOverlay') return true
    if (target === undefined) return false
    if (action === 'navigate' || action === 'overlay') return boards.has(target)
    if (action === 'setVariable') return variables.has(target)
    if (action === 'setVariant') return instances.has(target) && typeof interaction.value === 'string' && mains.has(interaction.value)
    return nodes.has(target)
  }
  let next = mapAllNodes(design, (node, inRepeat) => {
    let out = node
    if (out.showIf && !variables.has(out.showIf.variable)) out = without(out, 'showIf')
    if (out.bind) {
      const entries = Object.entries(out.bind).filter(([, ref]) => ref !== undefined && (ref.startsWith('item.') ? inRepeat || insideMain(design, node.id) : variables.has(ref)))
      if (entries.length !== Object.keys(out.bind).length) out = entries.length ? { ...out, bind: Object.fromEntries(entries) } : without(out, 'bind')
    }
    if (out.interactions) {
      const kept = out.interactions.filter(keep)
      if (kept.length !== out.interactions.length) out = kept.length ? { ...out, interactions: kept } : without(out, 'interactions')
    }
    if (out.type === 'frame' && out.repeat && !lists.has(out.repeat.data)) out = without(out as FrameNode, 'repeat')
    return out
  })
  // A repeat that went away leaves "item." bindings outside any repeat: a second pass drops them.
  if (next !== design) next = pruneDangling(next)
  const boardsNext = next.boards.map((board): DesignBoard => {
    if (!board.focusOrder) return board
    const onBoard = new Set<string>()
    const stack: DesignNode[] = [board.root]
    while (stack.length) {
      const node = stack.pop()!
      onBoard.add(node.id)
      if (node.type === 'frame') stack.push(...node.children)
    }
    const order = board.focusOrder.filter((id) => onBoard.has(id))
    if (order.length === board.focusOrder.length) return board
    return order.length ? { ...board, focusOrder: order } : without(board, 'focusOrder')
  })
  const changedBoards = boardsNext.some((board, index) => board !== next.boards[index])
  return changedBoards ? { ...next, boards: boardsNext } : next
}

function insideMain(design: Design, nodeId: string): boolean {
  for (const board of design.boards) {
    const walk = (node: DesignNode, inMain: boolean): boolean | null => {
      if (node.id === nodeId) return inMain
      if (node.type !== 'frame') return null
      for (const child of node.children) {
        const found = walk(child, inMain || Boolean(node.component))
        if (found !== null) return found
      }
      return null
    }
    const found = walk(board.root, false)
    if (found !== null) return found
  }
  return false
}

/** The nodes on a board a prototype viewer can reach with the keyboard, in layer order. */
export function interactiveNodes(board: DesignBoard): DesignNode[] {
  const out: DesignNode[] = []
  const visit = (node: DesignNode) => {
    const live = Boolean(node.interactions?.length) || node.type === 'input' || ((node.type === 'button' || node.type === 'frame') && node.linkTo !== undefined)
    if (live) out.push(node)
    if (node.type === 'frame') node.children.forEach(visit)
  }
  visit(board.root)
  return out
}

/** The board's keyboard order: its `focusOrder` first, then any other interactive node in layer order. */
export function focusSequence(board: DesignBoard): DesignNode[] {
  const live = interactiveNodes(board)
  const byId = new Map(live.map((node) => [node.id, node]))
  const ordered = (board.focusOrder ?? []).flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []))
  const seen = new Set(ordered.map((node) => node.id))
  return [...ordered, ...live.filter((node) => !seen.has(node.id))]
}
