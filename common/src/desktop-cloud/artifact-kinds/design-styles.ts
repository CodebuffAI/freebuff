import {
  DESIGN_LIMITS,
  FONT_STACKS,
  HEX,
  type Design,
  type DesignNode,
  type DesignStyles,
  type DesignTokens,
  type FillStyleDef,
  type FrameNode,
  type TextStyleDef,
} from './design'
import { bakeStyles } from './design-resolve'
import { findNode, freshId, updateBoard } from './design-tree'

/**
 * Shared named styles (text and fill), design-system starter kits, and token export. Pure: the
 * editor's Styles and Tokens panels and the agent's ops use the same functions.
 */

export type StyleKind = 'text' | 'fill'

const listOf = (styles: DesignStyles | undefined, kind: StyleKind): Array<TextStyleDef | FillStyleDef> =>
  (kind === 'text' ? styles?.text : styles?.fills) ?? []

function withList(design: Design, kind: StyleKind, list: Array<TextStyleDef | FillStyleDef>): Design {
  const styles: DesignStyles = { ...(design.styles ?? {}) }
  if (kind === 'text') {
    if (list.length) styles.text = list as TextStyleDef[]
    else delete styles.text
  } else if (list.length) styles.fills = list as FillStyleDef[]
  else delete styles.fills
  const out: Design = { ...design }
  if (Object.keys(styles).length === 0) delete out.styles
  else out.styles = styles
  return out
}

/** Maps every node of every board (structural sharing where nothing changes). */
function mapNodes(design: Design, fn: (node: DesignNode) => DesignNode): Design {
  const visit = (node: DesignNode): DesignNode => {
    let next = fn(node)
    if (next.type === 'frame') {
      let changed = false
      const children = next.children.map((child) => {
        const out = visit(child)
        if (out !== child) changed = true
        return out
      })
      if (changed) next = { ...next, children }
    }
    return next
  }
  let changed = false
  const boards = design.boards.map((board) => {
    const root = visit(board.root) as FrameNode
    if (root === board.root) return board
    changed = true
    return { ...board, root }
  })
  return changed ? { ...design, boards } : design
}

const refOf = (node: DesignNode, kind: StyleKind): string | undefined =>
  kind === 'text' ? (node.type === 'text' ? node.textStyle : undefined) : node.type === 'frame' || node.type === 'shape' ? node.fillStyle : undefined

/** How many nodes apply this style. */
export function styleUsage(design: Design, kind: StyleKind, id: string): number {
  let count = 0
  mapNodes(design, (node) => {
    if (refOf(node, kind) === id) count += 1
    return node
  })
  return count
}

/** Adds a style, or replaces the one with the same id (every user restyles). */
export function upsertStyle(design: Design, kind: 'text', style: TextStyleDef): Design
export function upsertStyle(design: Design, kind: 'fill', style: FillStyleDef): Design
export function upsertStyle(design: Design, kind: StyleKind, style: TextStyleDef | FillStyleDef): Design
export function upsertStyle(design: Design, kind: StyleKind, style: TextStyleDef | FillStyleDef): Design {
  const list = [...listOf(design.styles, kind)]
  const at = list.findIndex((entry) => entry.id === style.id)
  if (at === -1) {
    if (list.length >= DESIGN_LIMITS.maxStyles) return design
    list.push(style)
  } else list[at] = style
  return withList(design, kind, list)
}

/** Removes a style; its users keep its look (the values are baked in), so nothing dangles. */
export function removeStyle(design: Design, kind: StyleKind, id: string): Design {
  const list = listOf(design.styles, kind)
  if (!list.some((entry) => entry.id === id)) return design
  const baked = mapNodes(design, (node) => (refOf(node, kind) === id ? bakeStyles(node, design.styles) : node))
  return withList(baked, kind, list.filter((entry) => entry.id !== id))
}

/**
 * Applies a style to a node (`styleId` null detaches it: the style's values stay on the node).
 * Unchanged when the node cannot take that kind of style or the style does not exist.
 */
export function applyStyle(design: Design, boardId: string, nodeId: string, kind: StyleKind, styleId: string | null): Design {
  if (styleId !== null && !listOf(design.styles, kind).some((entry) => entry.id === styleId)) return design
  return updateBoard(design, boardId, (board) => {
    const hit = findNode(board.root, nodeId)
    if (!hit) return board
    const node = hit.node
    const fits = kind === 'text' ? node.type === 'text' : node.type === 'frame' || node.type === 'shape'
    if (!fits) return board
    let next: DesignNode
    if (styleId === null) next = bakeStyles(node, design.styles)
    else next = { ...node, [kind === 'text' ? 'textStyle' : 'fillStyle']: styleId } as DesignNode
    return { ...board, root: swapIn(board.root, nodeId, next) as FrameNode }
  })
}

/** A new style made from a node's current look and applied to it; null id when it cannot be. */
export function styleFromNode(design: Design, boardId: string, nodeId: string, name: string): { design: Design; styleId: string | null; kind: StyleKind | null } {
  const board = design.boards.find((entry) => entry.id === boardId)
  const hit = board ? findNode(board.root, nodeId) : null
  if (!hit) return { design, styleId: null, kind: null }
  const node = bakeStyles(hit.node, design.styles)
  const taken = new Set([...(design.styles?.text ?? []), ...(design.styles?.fills ?? [])].map((entry) => entry.id))
  const label = name.trim().slice(0, 60) || 'Style'
  const id = freshId(taken, slugId(label))
  if (node.type === 'text') {
    if ((design.styles?.text?.length ?? 0) >= DESIGN_LIMITS.maxStyles) return { design, styleId: null, kind: null }
    const style: TextStyleDef = { id, name: label, style: node.style }
    for (const key of ['fontSize', 'weight', 'lineHeight', 'letterSpacing', 'color'] as const) {
      if (node[key] !== undefined) (style as Record<string, unknown>)[key] = node[key]
    }
    return { design: applyStyle(upsertStyle(design, 'text', style), boardId, nodeId, 'text', id), styleId: id, kind: 'text' }
  }
  if ((node.type === 'frame' || node.type === 'shape') && node.fill !== undefined) {
    if ((design.styles?.fills?.length ?? 0) >= DESIGN_LIMITS.maxStyles) return { design, styleId: null, kind: null }
    const style: FillStyleDef = { id, name: label, fill: node.fill, ...(node.gradient ? { gradient: node.gradient } : {}) }
    return { design: applyStyle(upsertStyle(design, 'fill', style), boardId, nodeId, 'fill', id), styleId: id, kind: 'fill' }
  }
  return { design, styleId: null, kind: null }
}

const slugId = (label: string) => {
  const base = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
  return /^[a-z0-9]/.test(base) ? base : 'style'
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

// ---- design-system starter kits

export type StarterKit = {
  id: string
  label: string
  description: string
  tokens: DesignTokens & { fonts: NonNullable<DesignTokens['fonts']> }
  text: TextStyleDef[]
}

/** Three tasteful token sets with a matching type scale, for the user or the agent to apply. */
export const STARTER_KITS: StarterKit[] = [
  {
    id: 'clean',
    label: 'Clean product',
    description: 'Neutral greys, one indigo accent, a tight geometric type scale. SaaS and dashboards.',
    tokens: {
      colors: {
        background: '#ffffff', surface: '#f8fafc', text: '#0f172a', muted: '#64748b', border: '#e2e8f0',
        primary: '#4f46e5', 'on-primary': '#ffffff', accent: '#0ea5e9',
      },
      fonts: { heading: 'geometric', body: 'system' },
      radius: 10,
      spacingUnit: 8,
    },
    text: [
      { id: 'display', name: 'Display', style: 'display', fontSize: 60, weight: 700, color: 'text' },
      { id: 'heading', name: 'Heading', style: 'h2', fontSize: 32, weight: 700, color: 'text' },
      { id: 'title', name: 'Title', style: 'h3', fontSize: 20, weight: 600, color: 'text' },
      { id: 'body', name: 'Body', style: 'body', fontSize: 16, color: 'text' },
      { id: 'meta', name: 'Meta', style: 'small', fontSize: 14, color: 'muted' },
    ],
  },
  {
    id: 'editorial',
    label: 'Editorial',
    description: 'Warm paper, ink text and a serif display face. Blogs, magazines and long reads.',
    tokens: {
      colors: {
        background: '#fbf8f3', surface: '#f3ede3', text: '#1c1917', muted: '#78716c', border: '#e7e0d4',
        primary: '#9a3412', 'on-primary': '#fffaf5', accent: '#166534',
      },
      fonts: { heading: 'didone', body: 'serif' },
      radius: 4,
      spacingUnit: 8,
    },
    text: [
      { id: 'display', name: 'Display', style: 'display', fontSize: 72, weight: 600, lineHeight: 1.02, color: 'text' },
      { id: 'heading', name: 'Heading', style: 'h2', fontSize: 36, weight: 600, color: 'text' },
      { id: 'title', name: 'Title', style: 'h3', fontSize: 22, weight: 600, color: 'text' },
      { id: 'body', name: 'Body', style: 'body', fontSize: 18, lineHeight: 1.7, color: 'text' },
      { id: 'meta', name: 'Meta', style: 'caption', fontSize: 12, color: 'muted' },
    ],
  },
  {
    id: 'playful',
    label: 'Playful',
    description: 'Soft violet and coral on cream, rounded type and big radii. Consumer apps and launches.',
    tokens: {
      colors: {
        background: '#fffdf7', surface: '#f5f0ff', text: '#2e1065', muted: '#6b5b95', border: '#e9e1fb',
        primary: '#7c3aed', 'on-primary': '#ffffff', accent: '#f97362',
      },
      fonts: { heading: 'rounded', body: 'rounded' },
      radius: 16,
      spacingUnit: 8,
    },
    text: [
      { id: 'display', name: 'Display', style: 'display', fontSize: 64, weight: 800, color: 'text' },
      { id: 'heading', name: 'Heading', style: 'h2', fontSize: 34, weight: 700, color: 'text' },
      { id: 'title', name: 'Title', style: 'h3', fontSize: 20, weight: 700, color: 'text' },
      { id: 'body', name: 'Body', style: 'body', fontSize: 16, color: 'text' },
      { id: 'meta', name: 'Meta', style: 'small', fontSize: 14, color: 'muted' },
    ],
  },
]

export const STARTER_KIT_IDS = STARTER_KITS.map((kit) => kit.id)

/**
 * Applies a kit: its colour tokens join (and win over) the design's, its fonts, radius and spacing
 * replace the design's, and its text styles replace same-id styles (others are kept), so every
 * node using "heading" restyles. Null when there is no such kit.
 */
export function applyStarterKit(design: Design, kitId: string): Design | null {
  const kit = STARTER_KITS.find((entry) => entry.id === kitId)
  if (!kit) return null
  const colors = { ...(design.tokens?.colors ?? {}), ...kit.tokens.colors }
  const kitIds = new Set(kit.text.map((style) => style.id))
  const others = (design.styles?.text ?? []).filter((style) => !kitIds.has(style.id))
  const text = [...kit.text, ...others].slice(0, DESIGN_LIMITS.maxStyles)
  const tokens: DesignTokens = { ...(design.tokens ?? { colors: {} }), colors, fonts: kit.tokens.fonts, radius: kit.tokens.radius, spacingUnit: kit.tokens.spacingUnit }
  if (Object.keys(colors).length > DESIGN_LIMITS.maxTokens) return null
  return { ...design, tokens, styles: { ...(design.styles ?? {}), text } }
}

// ---- token export

const hexOf = (value: string | undefined, tokens: DesignTokens | undefined): string | undefined =>
  value === undefined ? undefined : HEX.test(value) || value === 'transparent' ? value : tokens?.colors[value]

const cssName = (value: string) => value.toLowerCase().replace(/[^a-z0-9-]+/g, '-')

/** The tokens and text styles as CSS custom properties on :root. */
export function tokensToCss(design: Design): string {
  const tokens = design.tokens
  const lines: string[] = [':root {']
  for (const [name, hex] of Object.entries(tokens?.colors ?? {})) lines.push(`  --color-${name}: ${hex};`)
  if (tokens?.fonts) {
    lines.push(`  --font-heading: ${FONT_STACKS[tokens.fonts.heading].stack};`)
    lines.push(`  --font-body: ${FONT_STACKS[tokens.fonts.body].stack};`)
  }
  if (tokens?.radius !== undefined) lines.push(`  --radius: ${tokens.radius}px;`)
  if (tokens?.spacingUnit !== undefined) lines.push(`  --space: ${tokens.spacingUnit}px;`)
  for (const style of design.styles?.text ?? []) {
    const name = cssName(style.id)
    if (style.fontSize !== undefined) lines.push(`  --text-${name}-size: ${style.fontSize}px;`)
    if (style.weight !== undefined) lines.push(`  --text-${name}-weight: ${style.weight};`)
    if (style.lineHeight !== undefined) lines.push(`  --text-${name}-line-height: ${style.lineHeight};`)
  }
  for (const style of design.styles?.fills ?? []) {
    const hex = hexOf(style.fill, tokens)
    if (hex) lines.push(`  --fill-${cssName(style.id)}: ${style.fill === hex ? hex : `var(--color-${style.fill})`};`)
  }
  lines.push('}')
  return `${lines.join('\n')}\n`
}

/** The tokens and styles as a JSON document (W3C design-tokens-like: { $value, $type }). */
export function tokensToJson(design: Design): string {
  const tokens = design.tokens
  const out: Record<string, unknown> = {
    color: Object.fromEntries(Object.entries(tokens?.colors ?? {}).map(([name, hex]) => [name, { $value: hex, $type: 'color' }])),
  }
  if (tokens?.fonts) {
    out.font = {
      heading: { $value: FONT_STACKS[tokens.fonts.heading].stack, $type: 'fontFamily' },
      body: { $value: FONT_STACKS[tokens.fonts.body].stack, $type: 'fontFamily' },
    }
  }
  if (tokens?.radius !== undefined) out.radius = { $value: `${tokens.radius}px`, $type: 'dimension' }
  if (tokens?.spacingUnit !== undefined) out.space = { $value: `${tokens.spacingUnit}px`, $type: 'dimension' }
  if (design.styles?.text?.length) {
    out.typography = Object.fromEntries(
      design.styles.text.map((style) => [
        style.id,
        {
          $type: 'typography',
          $value: {
            ...(style.fontSize !== undefined ? { fontSize: `${style.fontSize}px` } : {}),
            ...(style.weight !== undefined ? { fontWeight: style.weight } : {}),
            ...(style.lineHeight !== undefined ? { lineHeight: style.lineHeight } : {}),
            ...(style.color !== undefined ? { color: hexOf(style.color, tokens) ?? style.color } : {}),
          },
          $description: style.name,
        },
      ]),
    )
  }
  return `${JSON.stringify(out, null, 2)}\n`
}

/** A Tailwind `theme.extend` snippet (tailwind.config.js) for the tokens and text styles. */
export function tokensToTailwind(design: Design): string {
  const tokens = design.tokens
  const theme: Record<string, unknown> = { colors: { ...(tokens?.colors ?? {}) } }
  if (tokens?.fonts) {
    theme.fontFamily = {
      heading: FONT_STACKS[tokens.fonts.heading].stack.split(/,\s*/),
      body: FONT_STACKS[tokens.fonts.body].stack.split(/,\s*/),
    }
  }
  if (tokens?.radius !== undefined) theme.borderRadius = { DEFAULT: `${tokens.radius}px` }
  if (tokens?.spacingUnit !== undefined) theme.spacing = { unit: `${tokens.spacingUnit}px` }
  if (design.styles?.text?.length) {
    theme.fontSize = Object.fromEntries(
      design.styles.text
        .filter((style) => style.fontSize !== undefined)
        .map((style) => [
          style.id,
          [`${style.fontSize}px`, { ...(style.lineHeight !== undefined ? { lineHeight: String(style.lineHeight) } : {}), ...(style.weight !== undefined ? { fontWeight: String(style.weight) } : {}) }],
        ]),
    )
  }
  return `/** @type {import('tailwindcss').Config} */\nmodule.exports = {\n  theme: {\n    extend: ${JSON.stringify(theme, null, 2).replace(/\n/g, '\n    ')},\n  },\n}\n`
}
