import type {
  Breakpoint,
  Constraints,
  Design,
  DesignBoard,
  DesignNode,
  DesignStyles,
  FrameNode,
  NodeType,
  ResponsiveOverride,
  VariableValue,
} from './design'
import { collectMains } from './design'
import { hasLogic, logicScope, materializeBoardLogic } from './design-logic'
import { findNode, updateBoard } from './design-tree'

/**
 * The one resolve seam for round-4 model fields: shared styles (`textStyle`, `fillStyle`),
 * per-breakpoint overrides (`responsive`) and constraints on absolute children. Everything that
 * draws or reads a design (the renderer, codegen, lint, Present) resolves through here, so a node
 * means the same thing everywhere. Pure: no React, no DOM.
 */

// ---- breakpoints

/** The override keys each node type honours at a breakpoint; any other key is ignored. */
const KEYS_BY_TYPE: Record<NodeType, ReadonlyArray<keyof ResponsiveOverride>> = {
  frame: ['hidden', 'x', 'y', 'w', 'h', 'layout', 'gap', 'padding', 'columns', 'align', 'justify', 'wrap'],
  text: ['hidden', 'x', 'y', 'w', 'style', 'fontSize', 'weight'],
  image: ['hidden', 'x', 'y', 'w', 'h'],
  icon: ['hidden', 'x', 'y'],
  button: ['hidden', 'x', 'y', 'w', 'size'],
  input: ['hidden', 'x', 'y', 'w'],
  divider: ['hidden', 'x', 'y'],
  shape: ['hidden', 'x', 'y', 'w', 'h'],
}

export function overridableKeys(type: NodeType): ReadonlyArray<keyof ResponsiveOverride> {
  return KEYS_BY_TYPE[type]
}

/** The breakpoint a board declares with this id, or null (the board then draws at its base size). */
export function breakpointOf(board: DesignBoard, breakpointId: string | null | undefined): Breakpoint | null {
  if (!breakpointId) return null
  return board.breakpoints?.find((entry) => entry.id === breakpointId) ?? null
}

export type DesignWidthPreview = { boardId: string; width: number }

/** Use the widest authored layout that fits, or the narrowest when all are wider. */
export function breakpointAtWidth(board: DesignBoard, width: number): string | null {
  const widths = [{ id: null, w: board.w }, ...(board.breakpoints ?? [])]
  const fitting = widths.filter((entry) => entry.w <= width).sort((a, b) => b.w - a.w)
  return (fitting[0] ?? widths.sort((a, b) => a.w - b.w)[0]).id
}

/** Every breakpoint id any board declares, in first-seen order (the editor's switcher). */
export function designBreakpoints(design: Design): Breakpoint[] {
  const seen = new Map<string, Breakpoint>()
  for (const board of design.boards) for (const entry of board.breakpoints ?? []) if (!seen.has(entry.id)) seen.set(entry.id, entry)
  return [...seen.values()]
}

/** The node as drawn at `breakpointId`: its override's keys (those its type honours) win. */
export function applyResponsive<T extends DesignNode>(node: T, breakpointId: string | null | undefined): T {
  if (!breakpointId || !node.responsive) return node
  const override = node.responsive[breakpointId]
  if (!override) return node
  const out: Record<string, unknown> = { ...node }
  for (const key of KEYS_BY_TYPE[node.type]) {
    const value = override[key]
    if (value !== undefined) out[key] = value
  }
  return out as T
}

// ---- shared styles

/** The node with its shared style's fields applied (the style wins for the fields it sets). */
export function applyStyles<T extends DesignNode>(node: T, styles: DesignStyles | undefined): T {
  if (node.type === 'text' && node.textStyle !== undefined) {
    const style = styles?.text?.find((entry) => entry.id === node.textStyle)
    if (!style) return node
    const out: Record<string, unknown> = { ...node, style: style.style }
    for (const key of ['fontSize', 'weight', 'lineHeight', 'letterSpacing', 'color'] as const) {
      if (style[key] !== undefined) out[key] = style[key]
    }
    return out as T
  }
  if ((node.type === 'frame' || node.type === 'shape') && node.fillStyle !== undefined) {
    const style = styles?.fills?.find((entry) => entry.id === node.fillStyle)
    if (!style) return node
    const out: Record<string, unknown> = { ...node, fill: style.fill }
    if (style.gradient) out.gradient = style.gradient
    else delete out.gradient
    return out as T
  }
  return node
}

/** A node's style fields baked in and its style reference dropped (detach). */
export function bakeStyles<T extends DesignNode>(node: T, styles: DesignStyles | undefined): T {
  if (!('textStyle' in node) && !('fillStyle' in node)) return node
  const copy = { ...applyStyles(node, styles) } as Record<string, unknown>
  delete copy.textStyle
  delete copy.fillStyle
  return copy as unknown as T
}

export type ResolveContext = { styles?: DesignStyles; breakpoint?: string | null }

/** Styles, then the breakpoint's override (so a phone override can change a styled size). */
export function resolveNode<T extends DesignNode>(node: T, ctx: ResolveContext): T {
  return applyResponsive(applyStyles(node, ctx.styles), ctx.breakpoint)
}

// ---- constraints

export type Size2 = { w: number; h: number }

const round = (value: number) => Math.round(value * 100) / 100

function constrainAxis(
  pos: number,
  len: number | undefined,
  kind: string | undefined,
  from: number,
  to: number,
): { pos: number; len: number | undefined } {
  const delta = to - from
  switch (kind) {
    case 'right':
    case 'bottom':
      return { pos: round(pos + delta), len }
    case 'leftRight':
    case 'topBottom':
      return len === undefined ? { pos, len } : { pos, len: round(Math.max(1, len + delta)) }
    case 'center':
      return { pos: round(pos + delta / 2), len }
    case 'scale': {
      if (from <= 0) return { pos, len }
      const ratio = to / from
      return { pos: round(pos * ratio), len: len === undefined ? undefined : round(Math.max(1, len * ratio)) }
    }
    default:
      return { pos, len }
  }
}

/**
 * Where an absolute child goes when its parent goes from `from` to `to`, by its constraints
 * (left/top, the default, never move). Only numeric sizes stretch or scale.
 */
export function constrainNode<T extends DesignNode>(node: T, from: Size2, to: Size2, constraints: Constraints | undefined = node.constraints): T {
  if (!constraints || (from.w === to.w && from.h === to.h)) return node
  const record = node as Record<string, unknown>
  const w = typeof record.w === 'number' ? record.w : undefined
  const h = typeof record.h === 'number' ? record.h : undefined
  const hx = constrainAxis(node.x ?? 0, w, constraints.h, from.w, to.w)
  const vy = constrainAxis(node.y ?? 0, h, constraints.v, from.h, to.h)
  const out: Record<string, unknown> = { ...node }
  if (hx.pos !== (node.x ?? 0)) out.x = hx.pos
  if (vy.pos !== (node.y ?? 0)) out.y = vy.pos
  if (hx.len !== undefined && hx.len !== w) out.w = hx.len
  if (vy.len !== undefined && vy.len !== h) out.h = vy.len
  return out as T
}

/** An absolute frame's children moved by their constraints for a resize of the frame. */
export function constrainChildren(frame: FrameNode, from: Size2, to: Size2): FrameNode {
  if (frame.layout !== 'absolute' || (from.w === to.w && from.h === to.h)) return frame
  let changed = false
  const children = frame.children.map((child) => {
    const next = constrainNode(child, from, to)
    if (next !== child) changed = true
    return next
  })
  return changed ? { ...frame, children } : frame
}

const numericSize = (node: DesignNode): Size2 | null => {
  const record = node as Record<string, unknown>
  return typeof record.w === 'number' && typeof record.h === 'number' ? { w: record.w, h: record.h } : null
}

/**
 * Applies a w/h patch to a node and, when it is an absolute frame with a numeric size before and
 * after, moves its children by their constraints (the editor's resize and the inspector's W/H).
 */
export function resizeNodeConstrained(design: Design, boardId: string, nodeId: string, patch: Record<string, unknown>): Design {
  return updateBoard(design, boardId, (board) => {
    const hit = findNode(board.root, nodeId)
    if (!hit) return board
    const before = hit.node
    let after = { ...before, ...patch } as DesignNode
    for (const [key, value] of Object.entries(patch)) if (value === undefined) delete (after as Record<string, unknown>)[key]
    if (after.type === 'frame' && before.type === 'frame') {
      const from = numericSize(before)
      const to = numericSize(after)
      if (from && to) after = constrainChildren(after, from, to)
    }
    return { ...board, root: swapIn(board.root, nodeId, after) as FrameNode }
  })
}

/** A board resize; an absolute root's children follow their constraints. */
export function resizeBoardConstrained(design: Design, boardId: string, w: number, h: number): Design {
  return updateBoard(design, boardId, (board) => ({
    ...board,
    w,
    h,
    root: constrainChildren(board.root, { w: board.w, h: board.h }, { w, h }),
  }))
}

function swapIn(root: DesignNode, nodeId: string, node: DesignNode): DesignNode {
  if (root.id === nodeId) return node
  if (root.type !== 'frame') return root
  let changed = false
  const children = root.children.map((child) => {
    const next = swapIn(child, nodeId, node)
    if (next !== child) changed = true
    return next
  })
  return changed ? { ...root, children } : root
}

// ---- drawing a board at a breakpoint

function materializeNode(node: DesignNode, ctx: ResolveContext, parent: { from: Size2; to: Size2 } | null, self?: { from: Size2; to: Size2 }): DesignNode {
  const styled = applyStyles(node, ctx.styles)
  let out: DesignNode = applyResponsive(styled, ctx.breakpoint)
  if (parent && out.constraints) out = constrainNode(out, parent.from, parent.to)
  const plain = { ...out } as Record<string, unknown>
  delete plain.responsive
  delete plain.textStyle
  delete plain.fillStyle
  out = plain as unknown as DesignNode
  if (out.type !== 'frame') return out
  const sizes = self ?? (() => {
    const from = numericSize(styled)
    const to = numericSize(out)
    return from && to ? { from, to } : null
  })()
  const forChildren = out.layout === 'absolute' && sizes ? sizes : null
  return { ...out, children: out.children.map((child) => materializeNode(child, ctx, forChildren)) }
}

/**
 * A board as drawn at `breakpointId` (its size, overrides, styles and constraints resolved, with
 * the `responsive`/`textStyle`/`fillStyle` keys dropped). A board that does not declare the
 * breakpoint draws at its base size. For drawing and checking only: never stored.
 */
export function materializeBoard(board: DesignBoard, styles: DesignStyles | undefined, breakpointId: string | null | undefined, previewWidth?: number): DesignBoard {
  const breakpoint = breakpointOf(board, breakpointId)
  const w = previewWidth ?? breakpoint?.w ?? board.w
  const h = breakpoint?.h ?? board.h
  const ctx: ResolveContext = { styles, breakpoint: breakpoint?.id ?? null }
  const root = materializeNode(board.root, ctx, null, { from: { w: board.w, h: board.h }, to: { w, h } }) as FrameNode
  return { ...board, w, h, root }
}

/**
 * Every board materialized (see materializeBoard), then its round-5 logic resolved (variables at
 * their values, `variables` winning: a prototype's state; design-logic.ts). Main components keep
 * their style refs for instances.
 */
export function materializeDesign(
  design: Design,
  breakpointId: string | null | undefined,
  variables?: Readonly<Record<string, VariableValue>>,
  preview?: DesignWidthPreview | null,
): Design {
  const boards = design.boards.map((board) =>
    preview?.boardId === board.id
      ? materializeBoard(board, design.styles, breakpointAtWidth(board, preview.width), preview.width)
      : materializeBoard(board, design.styles, breakpointId),
  )
  if (!hasLogic(design)) return { ...design, boards }
  const scope = logicScope(design, variables, collectMains(design.boards))
  return { ...design, boards: boards.map((board) => materializeBoardLogic(board, scope)) }
}

// ---- editing at a breakpoint

/**
 * Splits a node patch for the active breakpoint: keys the type honours there go to the override,
 * the rest (text, colours, names) to the base node. With no breakpoint everything is base.
 */
export function routePatch(
  type: NodeType,
  patch: Record<string, unknown>,
  breakpointId: string | null | undefined,
): { base: Record<string, unknown>; override: Record<string, unknown> } {
  if (!breakpointId) return { base: patch, override: {} }
  const keys = new Set<string>(KEYS_BY_TYPE[type])
  const base: Record<string, unknown> = {}
  const override: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(patch)) (keys.has(key) ? override : base)[key] = value
  return { base, override }
}

/** The node with `override` merged into `responsive[breakpointId]` (undefined deletes a key). */
export function withOverride<T extends DesignNode>(node: T, breakpointId: string, override: Record<string, unknown>): T {
  const current: Record<string, unknown> = { ...(node.responsive?.[breakpointId] ?? {}) }
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) delete current[key]
    else current[key] = value
  }
  const responsive: Record<string, ResponsiveOverride> = { ...(node.responsive ?? {}) }
  if (Object.keys(current).length === 0) delete responsive[breakpointId]
  else responsive[breakpointId] = current as ResponsiveOverride
  const out: Record<string, unknown> = { ...node }
  if (Object.keys(responsive).length === 0) delete out.responsive
  else out.responsive = responsive
  return out as T
}

/**
 * The editor's one write path for a node patch: base fields on the node, breakpoint fields into
 * its override when a breakpoint (one its board declares) is active. Size changes on an absolute
 * frame at the base move its constrained children.
 */
export function patchNodeAt(
  design: Design,
  boardId: string,
  nodeId: string,
  patch: Record<string, unknown>,
  breakpointId: string | null | undefined,
): Design {
  const board = design.boards.find((entry) => entry.id === boardId)
  const hit = board ? findNode(board.root, nodeId) : null
  if (!board || !hit) return design
  const active = breakpointOf(board, breakpointId)?.id ?? null
  const { base, override } = routePatch(hit.node.type, patch, active)
  let next = design
  if (Object.keys(base).length > 0) next = resizeNodeConstrained(next, boardId, nodeId, base)
  if (active && Object.keys(override).length > 0) {
    next = updateBoard(next, boardId, (current) => {
      const found = findNode(current.root, nodeId)
      if (!found) return current
      return { ...current, root: swapIn(current.root, nodeId, withOverride(found.node, active, override)) as FrameNode }
    })
  }
  return next
}

/** Drops a node's override at one breakpoint (or one key of it). */
export function clearOverride(design: Design, boardId: string, nodeId: string, breakpointId: string, key?: keyof ResponsiveOverride): Design {
  return updateBoard(design, boardId, (board) => {
    const hit = findNode(board.root, nodeId)
    if (!hit?.node.responsive?.[breakpointId]) return board
    const patch: Record<string, unknown> = key ? { [key]: undefined } : Object.fromEntries(Object.keys(hit.node.responsive[breakpointId]).map((k) => [k, undefined]))
    return { ...board, root: swapIn(board.root, nodeId, withOverride(hit.node, breakpointId, patch)) as FrameNode }
  })
}
