import type { Design, DesignBoard, DesignNode, FrameNode, Interaction, Transition, VariableValue } from './design'
import { templateId } from './design-logic'
import { variantName } from './design-variants'

/**
 * A prototype's state in Present and on a shared link: what the viewer has typed, toggled and
 * clicked. It lives only in the viewer (never saved) and resets when Present closes. Clicks run a
 * node's `interactions` in order: go to a board, go back, open or close an overlay board, toggle
 * / show / hide a node, swap an instance to a variant, set a variable (which `showIf` and `bind`
 * read). Inputs are real controls here and write their value (and a bound variable). Pure.
 */

export type PrototypeState = {
  vars: Record<string, VariableValue>
  /** Node (template) id → hidden, from toggle / show / hide. */
  hidden: Record<string, boolean>
  /** Instance id → the main it draws now (setVariant). */
  variants: Record<string, string>
  /** Drawn input id → what the viewer entered. */
  inputs: Record<string, { value?: string; checked?: boolean }>
  /** The board open as an overlay over the current one. */
  overlay: string | null
  /** Boards visited by navigate, for back. */
  trail: string[]
}

export type PrototypeEffect =
  | { kind: 'navigate'; boardId: string; transition?: Transition }
  | { kind: 'back'; boardId: string }
  | null

export function initialPrototype(design: Design): PrototypeState {
  const vars: Record<string, VariableValue> = {}
  for (const variable of design.variables ?? []) vars[variable.id] = variable.value
  return { vars, hidden: {}, variants: {}, inputs: {}, overlay: null, trail: [] }
}

/**
 * The state after a click on a node with these interactions, plus a navigation the host performs
 * (`currentBoardId` is where the viewer is, for back). Unknown targets are skipped, never thrown.
 */
export function runInteractions(
  design: Design,
  state: PrototypeState,
  interactions: readonly Interaction[],
  currentBoardId: string,
  hiddenNow: (nodeId: string) => boolean,
): { state: PrototypeState; effect: PrototypeEffect } {
  let next = state
  let effect: PrototypeEffect = null
  const boards = new Set(design.boards.map((board) => board.id))
  for (const interaction of interactions) {
    const target = interaction.target
    switch (interaction.action) {
      case 'navigate':
        if (target && boards.has(target)) {
          next = { ...next, overlay: null, trail: [...next.trail, currentBoardId].slice(-40) }
          effect = { kind: 'navigate', boardId: target, transition: interaction.transition }
        }
        break
      case 'back': {
        if (next.overlay) {
          next = { ...next, overlay: null }
          break
        }
        const previous = next.trail.at(-1)
        if (previous) {
          next = { ...next, trail: next.trail.slice(0, -1) }
          effect = { kind: 'back', boardId: previous }
        }
        break
      }
      case 'overlay':
        if (target && boards.has(target)) next = { ...next, overlay: target }
        break
      case 'closeOverlay':
        next = { ...next, overlay: null }
        break
      case 'toggle':
        if (target) next = { ...next, hidden: { ...next.hidden, [target]: !(next.hidden[target] ?? hiddenNow(target)) } }
        break
      case 'show':
        if (target) next = { ...next, hidden: { ...next.hidden, [target]: false } }
        break
      case 'hide':
        if (target) next = { ...next, hidden: { ...next.hidden, [target]: true } }
        break
      case 'setVariant':
        if (target && typeof interaction.value === 'string') next = { ...next, variants: { ...next.variants, [target]: interaction.value } }
        break
      case 'setVariable': {
        if (!target) break
        const variable = design.variables?.find((entry) => entry.id === target)
        if (!variable) break
        const value = interaction.value ?? (variable.type === 'boolean' ? !next.vars[target] : next.vars[target])
        next = { ...next, vars: { ...next.vars, [target]: value } }
        break
      }
    }
  }
  return { state: next, effect }
}

function applyNode(node: DesignNode, state: PrototypeState): DesignNode {
  const key = templateId(node.id)
  let out = node
  const hidden = state.hidden[key] ?? state.hidden[node.id]
  if (hidden !== undefined && hidden !== Boolean(node.hidden)) out = { ...out, hidden: hidden || undefined }
  if (out.type === 'frame') {
    const variant = state.variants[key] ?? state.variants[node.id]
    if (variant && out.instanceOf !== undefined) out = { ...out, instanceOf: variant }
    let changed = false
    const children = out.children.map((child) => {
      const next = applyNode(child, state)
      if (next !== child) changed = true
      return next
    })
    if (changed) out = { ...out, children }
  } else if (out.type === 'input') {
    const entered = state.inputs[node.id]
    if (entered) out = { ...out, ...(entered.value !== undefined ? { value: entered.value } : {}), ...(entered.checked !== undefined ? { checked: entered.checked } : {}) }
  }
  return out
}

/** A board as the prototype shows it now (toggles, variant swaps, entered values). */
export function applyPrototype(board: DesignBoard, state: PrototypeState): DesignBoard {
  if (Object.keys(state.hidden).length === 0 && Object.keys(state.variants).length === 0 && Object.keys(state.inputs).length === 0) return board
  const root = applyNode(board.root, state) as FrameNode
  return root === board.root ? board : { ...board, root }
}

export type InteractionState = 'hover' | 'pressed'

/**
 * The variant an instance shows while hovered or pressed: in its main's variant group, the main
 * named "<Group> / <Variant> Hover" (or "… Pressed"), else "<Group> / Hover" when the main is
 * the group's default. Null when the group has none (the instance just stays as is).
 */
export function stateVariant(mains: ReadonlyMap<string, FrameNode>, mainId: string, which: InteractionState): string | null {
  const main = mains.get(mainId)
  if (!main) return null
  const { group, variant } = variantName(main.name)
  if (variant === null) return null
  const suffix = which === 'hover' ? 'hover' : 'pressed'
  const wanted = new Set([`${variant} ${suffix}`.toLowerCase(), `${variant}:${suffix}`.toLowerCase(), `${variant} / ${suffix}`.toLowerCase()])
  if (variant.toLowerCase() === 'default') wanted.add(suffix)
  for (const other of mains.values()) {
    if (other.id === mainId) continue
    const named = variantName(other.name)
    if (named.variant !== null && named.group.toLowerCase() === group.toLowerCase() && wanted.has(named.variant.toLowerCase())) return other.id
  }
  return null
}
