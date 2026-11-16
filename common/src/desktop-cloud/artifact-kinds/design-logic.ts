import {
  DESIGN_LIMITS,
  HEX,
  isSafeImageSrc,
  type BindableKey,
  type Design,
  type DesignBoard,
  type DesignDataList,
  type DesignNode,
  type DesignTokens,
  type FrameNode,
  type VariableValue,
} from './design'
import { INSTANCE_SEP, resolveInstance } from './design-components'

/**
 * Round 5's declarative logic, resolved before anything draws: design variables (the Props
 * panel's levers), `showIf`, `bind`, `{{holes}}` in copy, and `repeat` frames over inline data
 * lists. No code anywhere: every rule is data the schema validates and caps. A design without
 * variables or data lists, and a node without these fields, comes out exactly as it went in.
 *
 *   {{id}}            a variable's value          {{item.field}}  the current repeat row's field
 *   showIf            { variable, equals?, not? }  drawn only while it matches
 *   bind              { text|label|src|alt|fill|color|checked|value|placeholder: "<var id>" | "item.<field>" }
 *   repeat (frame)    { data, limit? }             the children once per row; row 0 keeps the
 *                     template's ids, row i suffixes every id in its copy with `~r<i>`, so a click
 *                     on any copy selects the template (the editor's `~` id convention).
 *
 * Pure: no React, no DOM.
 */

export type LogicScope = {
  vars: Readonly<Record<string, VariableValue>>
  data: ReadonlyMap<string, DesignDataList>
  tokens?: DesignTokens
  /** The repeat row being drawn. */
  item?: Readonly<Record<string, VariableValue>>
  /** Main components, to draw instances inside a repeat with that row. */
  mains?: ReadonlyMap<string, FrameNode>
}

export const REPEAT_SEP = `${INSTANCE_SEP}r`

/** The design's variables at their stored values, with `overrides` (a prototype's state) winning. */
export function logicScope(design: Design, overrides?: Readonly<Record<string, VariableValue>>, mains?: ReadonlyMap<string, FrameNode>): LogicScope {
  const vars: Record<string, VariableValue> = {}
  for (const variable of design.variables ?? []) vars[variable.id] = variable.value
  if (overrides) for (const [key, value] of Object.entries(overrides)) if (Object.hasOwn(vars, key)) vars[key] = value
  return { vars, data: new Map((design.data ?? []).map((list) => [list.id, list])), tokens: design.tokens, mains }
}

/** Whether the design uses any round-5 logic (a fast path: nothing to resolve otherwise). */
export function hasLogic(design: Design): boolean {
  return (design.variables?.length ?? 0) > 0 || (design.data?.length ?? 0) > 0
}

function lookup(ref: string, scope: LogicScope): VariableValue | undefined {
  if (ref.startsWith('item.')) return scope.item?.[ref.slice(5)]
  return Object.hasOwn(scope.vars, ref) ? scope.vars[ref] : undefined
}

const HOLE = /\{\{\s*((?:item\.)?[A-Za-z0-9][A-Za-z0-9_-]{0,63})\s*\}\}/g

/** `{{name}}` holes filled from the scope; a name it does not know stays as written. */
export function fillHoles(text: string, scope: LogicScope): string {
  if (!text.includes('{{')) return text
  return text.replace(HOLE, (whole, name: string) => {
    const value = lookup(name, scope)
    return value === undefined ? whole : String(value)
  })
}

export function hasHoles(text: string | undefined): boolean {
  if (!text) return false
  HOLE.lastIndex = 0
  return HOLE.test(text)
}

/** Whether a `showIf` lets the node draw. */
export function showIfPasses(showIf: DesignNode['showIf'], scope: LogicScope): boolean {
  if (!showIf) return true
  const value = lookup(showIf.variable, scope)
  const match = showIf.equals === undefined ? Boolean(value) : value === showIf.equals
  return showIf.not ? !match : match
}

const TEXT_MAX: Partial<Record<BindableKey, number>> = { text: 2000, label: 80, alt: 300, value: 200, placeholder: 120 }

function colorOk(value: string, tokens: DesignTokens | undefined) {
  return HEX.test(value) || value === 'transparent' || Object.hasOwn(tokens?.colors ?? {}, value)
}

/** One node's showIf, bindings and holes resolved (its children untouched). */
export function applyNodeLogic<T extends DesignNode>(node: T, scope: LogicScope): T {
  let out: Record<string, unknown> | null = null
  const set = (key: string, value: unknown) => {
    out ??= { ...node }
    out[key] = value
  }
  if (node.showIf && !showIfPasses(node.showIf, scope)) set('hidden', true)
  for (const key of ['text', 'label', 'alt', 'value', 'placeholder'] as const) {
    const current = (node as Record<string, unknown>)[key]
    if (typeof current === 'string' && current.includes('{{')) set(key, fillHoles(current, scope).slice(0, TEXT_MAX[key]))
  }
  if (node.type === 'frame' && node.overrides) {
    let changed = false
    const overrides: NonNullable<FrameNode['overrides']> = {}
    for (const [id, override] of Object.entries(node.overrides)) {
      const next = { ...override }
      for (const key of ['text', 'label', 'alt'] as const) {
        const value = next[key]
        if (typeof value === 'string' && value.includes('{{')) {
          next[key] = fillHoles(value, scope).slice(0, TEXT_MAX[key])
          changed = true
        }
      }
      overrides[id] = next
    }
    if (changed) set('overrides', overrides)
  }
  for (const [key, ref] of Object.entries(node.bind ?? {}) as Array<[BindableKey, string | undefined]>) {
    if (ref === undefined) continue
    const value = lookup(ref, scope)
    if (value === undefined) continue
    if (key === 'checked') {
      if (node.type === 'input') set('checked', Boolean(value))
    } else if (key === 'src') {
      if (node.type === 'image' && typeof value === 'string' && isSafeImageSrc(value)) {
        set('src', value)
        set('placeholder', undefined)
      }
    } else if (key === 'fill' || key === 'color') {
      if (typeof value === 'string' && colorOk(value, scope.tokens) && key in fieldOwners && fieldOwners[key].includes(node.type)) set(key, value)
    } else if (fieldOwners[key].includes(node.type)) {
      set(key, String(value).slice(0, TEXT_MAX[key]))
    }
  }
  if (!out) return node
  const result = out as Record<string, unknown>
  for (const key of Object.keys(result)) if (result[key] === undefined) delete result[key]
  return result as T
}

/** Which node types carry each bindable field. */
const fieldOwners: Record<BindableKey, ReadonlyArray<DesignNode['type']>> = {
  text: ['text'],
  label: ['button', 'input'],
  src: ['image'],
  alt: ['image'],
  fill: ['frame', 'shape'],
  color: ['text', 'icon', 'divider'],
  checked: ['input'],
  value: ['input'],
  placeholder: ['input'],
}

function suffixIds(node: DesignNode, suffix: string): DesignNode {
  if (!suffix) return node
  const id = `${node.id}${suffix}`
  if (node.type !== 'frame') return { ...node, id }
  return { ...node, id, children: node.children.map((child) => suffixIds(child, suffix)) }
}

/**
 * A subtree with its logic resolved: each node's showIf, bindings and holes, and every repeat
 * expanded into one copy of its children per row (at most the list's rows and `limit`).
 */
export function expandLogicTree(node: DesignNode, scope: LogicScope, depth = 0): DesignNode {
  const resolved = applyNodeLogic(node, scope)
  if (resolved.type !== 'frame' || depth > DESIGN_LIMITS.maxDepth * 2) return resolved
  // Inside a repeat, an instance draws now, with this row (holes in its main see `item`).
  if (resolved.instanceOf !== undefined && scope.item && scope.mains) {
    const drawn = resolveInstance(resolved, scope.mains)
    return { ...drawn, instanceOf: undefined, children: drawn.children.map((child) => expandLogicTree(child, scope, depth + 1)) }
  }
  if (resolved.repeat && resolved.instanceOf === undefined) {
    const list = scope.data.get(resolved.repeat.data)
    const { repeat, ...frame } = resolved
    if (!list) return { ...frame, children: resolved.children.map((child) => expandLogicTree(child, scope, depth + 1)) }
    const rows = list.rows.slice(0, Math.min(repeat.limit ?? DESIGN_LIMITS.maxDataRows, DESIGN_LIMITS.maxDataRows))
    const children: DesignNode[] = []
    rows.forEach((row, index) => {
      const inner: LogicScope = { ...scope, item: row }
      for (const child of resolved.children) {
        const copy = expandLogicTree(child, inner, depth + 1)
        children.push(index === 0 ? copy : suffixIds(copy, `${REPEAT_SEP}${index}`))
      }
    })
    return { ...frame, children }
  }
  if (resolved.children.length === 0) return resolved
  let changed = resolved !== node
  const children = resolved.children.map((child) => {
    const next = expandLogicTree(child, scope, depth + 1)
    if (next !== child) changed = true
    return next
  })
  return changed ? { ...resolved, children } : node
}

/** A board with its logic resolved (for drawing, checking and code only: never stored). */
export function materializeBoardLogic(board: DesignBoard, scope: LogicScope): DesignBoard {
  const root = expandLogicTree(board.root, scope) as FrameNode
  return root === board.root ? board : { ...board, root }
}

/** Every board's logic resolved; the identity when the design declares no variables or data. */
export function materializeLogic(design: Design, overrides?: Readonly<Record<string, VariableValue>>): Design {
  if (!hasLogic(design)) return design
  const scope = logicScope(design, overrides)
  return { ...design, boards: design.boards.map((board) => materializeBoardLogic(board, scope)) }
}

/** The template id a drawn node came from: a repeat copy's `~r<i>` suffixes dropped. */
export function templateId(drawnId: string): string {
  return drawnId.replace(/~r\d+(?=~|$)/g, '')
}

// ---- themes

/** The tokens a board draws with: its theme's colour values over the base ones. */
export function themedTokens(tokens: DesignTokens | undefined, theme: 'light' | 'dark' | undefined): DesignTokens | undefined {
  if (!tokens || theme !== 'dark' || !tokens.themes?.dark) return tokens
  return { ...tokens, colors: { ...tokens.colors, ...tokens.themes.dark } }
}

/** The variables a board's Props panel lists: design-wide ones and that board's own. */
export function boardVariables(design: Design, boardId: string | null) {
  return (design.variables ?? []).filter((variable) => variable.board === undefined || variable.board === boardId)
}
