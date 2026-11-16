import { describe, expect, test } from 'bun:test'

import { DESIGN_EXAMPLE, DESIGN_GUIDE, designSchema, validateDesign, type Design, type DesignNode, type FrameNode, type ShapeNode } from './design'
import { boardToHtml, boardToReact } from './design-codegen'
import { copyNodes, parseClipboard, pasteNodes } from './design-clipboard'
import { prototypeLinks, setStartBoard, startBoardOf, unreachableBoards } from './design-flows'
import {
  applyResponsive,
  applyStyles,
  clearOverride,
  constrainNode,
  designBreakpoints,
  materializeBoard,
  patchNodeAt,
  resizeBoardConstrained,
  resizeNodeConstrained,
  routePatch,
} from './design-resolve'
import {
  STARTER_KITS,
  applyStarterKit,
  applyStyle,
  removeStyle,
  styleFromNode,
  styleUsage,
  tokensToCss,
  tokensToJson,
  tokensToTailwind,
  upsertStyle,
} from './design-styles'
import { findNode, removeBoard, removeColorToken } from './design-tree'
import { polygonPoints, shapeGeometry, starPoints } from './design-vector'

const ok = (value: unknown): Design => {
  const result = validateDesign(value)
  if (!result.ok) throw new Error(result.errors.join('; '))
  return result.design
}
const node = (design: Design, boardId: string, nodeId: string) => findNode(design.boards.find((b) => b.id === boardId)!.root, nodeId)!.node

/** A small design that uses every round-4 field. */
const R4: Design = ok({
  version: 1,
  title: 'R4',
  tokens: { colors: { text: '#111111', primary: '#4f46e5', muted: '#666666', background: '#ffffff' } },
  styles: {
    text: [{ id: 'heading', name: 'Heading', style: 'h2', fontSize: 36, weight: 700, color: 'text' }],
    fills: [{ id: 'brand', name: 'Brand', fill: 'primary', gradient: { from: 'primary', to: '#000000' } }],
  },
  startBoard: 'b',
  boards: [
    {
      id: 'a', title: 'Home', x: 0, y: 0, w: 1000, h: 600,
      breakpoints: [{ id: 'mobile', title: 'Mobile', w: 400, h: 800 }],
      guides: { x: [120], y: [64] },
      layoutGrid: { columns: 12, gutter: 24, margin: 80 },
      root: {
        type: 'frame', id: 'a-root', layout: 'absolute', children: [
          { type: 'frame', id: 'row', layout: 'stack-h', x: 0, y: 0, w: 1000, h: 80, wrap: true, rowGap: 12, justify: 'evenly', fillStyle: 'brand',
            constraints: { h: 'leftRight' },
            responsive: { mobile: { layout: 'stack-v', gap: 8, style: 'h1' } }, children: [
              { type: 'text', id: 'title', text: 'Hello', style: 'body', textStyle: 'heading', responsive: { mobile: { fontSize: 24 } } },
              { type: 'button', id: 'go', label: 'Go', variant: 'primary', linkTo: 'b', transition: 'slide-left' },
            ] },
          { type: 'shape', id: 'badge', kind: 'star', sides: 5, innerRatio: 0.4, w: 40, h: 40, x: 900, y: 500, fill: 'primary', constraints: { h: 'right', v: 'bottom' } },
          { type: 'shape', id: 'hex', kind: 'polygon', sides: 6, w: 60, h: 60, x: 470, y: 270, constraints: { h: 'center', v: 'center' } },
          { type: 'shape', id: 'pen', kind: 'path', vertices: [[0, 0], [0.5, 1], [1, 0]], closed: false, w: 100, h: 50, x: 0, y: 300, stroke: 'text', strokeWidth: 3, constraints: { h: 'scale' } },
          { type: 'shape', id: 'arrow', kind: 'arrow', w: 120, h: 20, x: 10, y: 400, stroke: 'text' },
        ] },
    },
    { id: 'b', title: 'Detail', x: 1120, y: 0, w: 400, h: 800, root: { type: 'frame', id: 'b-root', layout: 'stack-v', children: [
      { type: 'button', id: 'back', label: 'Back', variant: 'ghost', linkTo: 'a' },
    ] } },
    { id: 'c', title: 'Orphan', x: 1600, y: 0, w: 400, h: 800, root: { type: 'frame', id: 'c-root', layout: 'stack-v', children: [] } },
  ],
})

describe('round-4 schema', () => {
  test('a pre-round-4 body parses unchanged', () => {
    const original = JSON.parse(JSON.stringify(DESIGN_EXAMPLE))
    expect(designSchema.parse(original)).toEqual(original)
    expect(validateDesign(original).ok).toBe(true)
  })

  test('the round-4 fixture validates and round-trips byte-identical', () => {
    const json = JSON.stringify(R4)
    expect(JSON.stringify(designSchema.parse(JSON.parse(json)))).toBe(json)
  })

  test('refuses dangling style refs, a missing start board, a path without vertices, duplicate breakpoints', () => {
    const broken = JSON.parse(JSON.stringify(R4))
    broken.boards[0].root.children[0].children[0].textStyle = 'nope'
    broken.boards[0].root.children[0].fillStyle = 'gone'
    broken.startBoard = 'zzz'
    broken.boards[0].root.children[3] = { type: 'shape', id: 'pen', kind: 'path', w: 10, h: 10 }
    broken.boards[0].breakpoints.push({ id: 'mobile', title: 'Again', w: 300 })
    const result = validateDesign(broken)
    expect(result.ok).toBe(false)
    const text = result.ok ? '' : result.errors.join('\n')
    expect(text).toContain('no text style "nope"')
    expect(text).toContain('no fill style "gone"')
    expect(text).toContain('startBoard: no board "zzz"')
    expect(text).toContain('needs "vertices"')
    expect(text).toContain('duplicate id "mobile"')
  })

  test('an override naming an undeclared breakpoint is allowed and ignored', () => {
    const body = JSON.parse(JSON.stringify(R4))
    body.boards[1].root.children[0].responsive = { tablet: { hidden: true } }
    expect(validateDesign(body).ok).toBe(true)
    const drawn = materializeBoard(ok(body).boards[1], undefined, 'tablet')
    expect(drawn.root.children[0].hidden).toBeUndefined()
  })

  test('the image src message names /_asset/', () => {
    const result = validateDesign({ ...DESIGN_EXAMPLE, boards: [{ ...DESIGN_EXAMPLE.boards[0], root: { type: 'frame', id: 'r', layout: 'stack-v', children: [{ type: 'image', id: 'i', alt: '', src: 'http://x' }] } }] })
    expect(result.ok ? '' : result.errors.join()).toContain('/_asset/')
  })
})

describe('breakpoints', () => {
  test('applyResponsive applies only the keys the type honours', () => {
    const frame = node(R4, 'a', 'row') as FrameNode
    const at = applyResponsive(frame, 'mobile')
    expect(at.layout).toBe('stack-v')
    expect(at.gap).toBe(8)
    expect((at as Record<string, unknown>).style).toBeUndefined()
    expect(applyResponsive(frame, null)).toBe(frame)
    expect(applyResponsive(frame, 'tablet')).toBe(frame)
  })

  test('materializeBoard sizes the board, applies overrides, styles and constraints, and drops the refs', () => {
    const drawn = materializeBoard(R4.boards[0], R4.styles, 'mobile')
    expect([drawn.w, drawn.h]).toEqual([400, 800])
    const row = drawn.root.children[0] as FrameNode
    expect(row.layout).toBe('stack-v')
    expect(row.w).toBe(400) // leftRight: 1000 + (400 - 1000)
    expect(row.fill).toBe('primary')
    expect(row.responsive).toBeUndefined()
    expect(row.fillStyle).toBeUndefined()
    const title = row.children[0] as Extract<DesignNode, { type: 'text' }>
    expect([title.style, title.fontSize, title.weight]).toEqual(['h2', 24, 700])
    const badge = drawn.root.children[1]
    expect([badge.x, badge.y]).toEqual([300, 700]) // right/bottom: moved by the deltas
    const hex = drawn.root.children[2]
    expect([hex.x, hex.y]).toEqual([170, 370]) // center: half the deltas
    const pen = drawn.root.children[3] as ShapeNode
    expect([pen.x, pen.w]).toEqual([0, 40]) // scale: 0.4×
    // A board without the breakpoint draws at its base size.
    expect(materializeBoard(R4.boards[1], R4.styles, 'mobile').w).toBe(400)
    expect(designBreakpoints(R4).map((entry) => entry.id)).toEqual(['mobile'])
  })

  test('routePatch splits base and override keys; patchNodeAt writes the override and undo-friendly clears', () => {
    expect(routePatch('text', { text: 'Hi', fontSize: 20 }, 'mobile')).toEqual({ base: { text: 'Hi' }, override: { fontSize: 20 } })
    expect(routePatch('text', { fontSize: 20 }, null)).toEqual({ base: { fontSize: 20 }, override: {} })
    const next = patchNodeAt(R4, 'a', 'title', { text: 'Hey', fontSize: 18, weight: 800 }, 'mobile')
    const title = node(next, 'a', 'title') as Extract<DesignNode, { type: 'text' }>
    expect(title.text).toBe('Hey')
    expect(title.weight).toBeUndefined()
    expect(title.responsive).toEqual({ mobile: { fontSize: 18, weight: 800 } })
    expect(validateDesign(next).ok).toBe(true)
    // A breakpoint the board does not declare edits the base.
    const base = patchNodeAt(R4, 'b', 'back', { w: 200 }, 'mobile')
    expect(node(base, 'b', 'back')).toMatchObject({ w: 200 })
    expect(node(base, 'b', 'back').responsive).toBeUndefined()
    const cleared = clearOverride(next, 'a', 'title', 'mobile')
    expect(node(cleared, 'a', 'title').responsive).toBeUndefined()
    expect(node(clearOverride(next, 'a', 'title', 'mobile', 'weight'), 'a', 'title').responsive).toEqual({ mobile: { fontSize: 18 } })
  })
})

describe('constraints', () => {
  test('constrainNode per axis; left/top and no constraints never move', () => {
    const child = { type: 'shape', id: 's', kind: 'rect', x: 10, y: 20, w: 30, h: 40 } as ShapeNode
    const from = { w: 100, h: 100 }
    const to = { w: 200, h: 50 }
    expect(constrainNode(child, from, to)).toBe(child)
    expect(constrainNode(child, from, to, { h: 'right', v: 'bottom' })).toMatchObject({ x: 110, y: -30 })
    expect(constrainNode(child, from, to, { h: 'leftRight', v: 'topBottom' })).toMatchObject({ x: 10, w: 130, y: 20, h: 1 })
    expect(constrainNode(child, from, to, { h: 'scale' })).toMatchObject({ x: 20, w: 60 })
    expect(constrainNode(child, from, to, { h: 'left', v: 'top' })).toEqual(child)
  })

  test('resizing an absolute board or frame moves constrained children in the stored design', () => {
    const board = resizeBoardConstrained(R4, 'a', 1200, 600)
    expect(node(board, 'a', 'badge')).toMatchObject({ x: 1100, y: 500 })
    expect(node(board, 'a', 'row')).toMatchObject({ w: 1200 })
    expect(validateDesign(board).ok).toBe(true)
    const frame: Design = ok({ ...R4, boards: [{ ...R4.boards[1], root: { type: 'frame', id: 'b-root', layout: 'stack-v', children: [
      { type: 'frame', id: 'card', layout: 'absolute', w: 100, h: 100, children: [{ type: 'shape', id: 'dot', kind: 'ellipse', w: 10, h: 10, x: 80, y: 0, constraints: { h: 'right' } }] },
    ] } }, R4.boards[0], R4.boards[2]] })
    const resized = resizeNodeConstrained(frame, 'b', 'card', { w: 150 })
    expect(node(resized, 'b', 'dot')).toMatchObject({ x: 130 })
  })
})

describe('shared styles', () => {
  test('applyStyles: the text style wins; a fill style sets fill and gradient', () => {
    const title = applyStyles(node(R4, 'a', 'title'), R4.styles) as Extract<DesignNode, { type: 'text' }>
    expect([title.style, title.fontSize, title.color]).toEqual(['h2', 36, 'text'])
    const row = applyStyles(node(R4, 'a', 'row'), R4.styles) as FrameNode
    expect(row.gradient).toEqual({ from: 'primary', to: '#000000' })
  })

  test('editing a style restyles every user; usage counts; remove bakes values in', () => {
    expect(styleUsage(R4, 'text', 'heading')).toBe(1)
    const edited = upsertStyle(R4, 'text', { id: 'heading', name: 'Heading', style: 'h1', fontSize: 40 })
    expect(materializeBoard(edited.boards[0], edited.styles, null).root.children[0].type).toBe('frame')
    const drawn = (materializeBoard(edited.boards[0], edited.styles, null).root.children[0] as FrameNode).children[0]
    expect(drawn).toMatchObject({ style: 'h1', fontSize: 40 })
    const removed = removeStyle(R4, 'text', 'heading')
    expect(removed.styles?.text).toBeUndefined()
    expect(node(removed, 'a', 'title')).toMatchObject({ style: 'h2', fontSize: 36, weight: 700, color: 'text' })
    expect((node(removed, 'a', 'title') as Record<string, unknown>).textStyle).toBeUndefined()
    expect(validateDesign(removed).ok).toBe(true)
  })

  test('applyStyle attaches, detaches (baking) and refuses a wrong kind or unknown style', () => {
    const detached = applyStyle(R4, 'a', 'row', 'fill', null)
    expect(node(detached, 'a', 'row')).toMatchObject({ fill: 'primary', gradient: { from: 'primary', to: '#000000' } })
    expect(applyStyle(R4, 'a', 'go', 'fill', 'brand')).toBe(R4)
    expect(applyStyle(R4, 'a', 'title', 'text', 'missing')).toBe(R4)
  })

  test('styleFromNode makes a style from a node and applies it', () => {
    const made = styleFromNode(R4, 'a', 'badge', 'Accent star')
    expect(made.kind).toBe('fill')
    expect(made.design.styles?.fills?.map((style) => style.id)).toEqual(['brand', 'accent-star'])
    expect(node(made.design, 'a', 'badge')).toMatchObject({ fillStyle: 'accent-star' })
    expect(validateDesign(made.design).ok).toBe(true)
    expect(styleFromNode(R4, 'a', 'go', 'X').styleId).toBeNull()
  })

  test('removing a colour token rewrites the styles that name it', () => {
    const next = removeColorToken(R4, 'primary')
    expect(next.styles?.fills?.[0]).toMatchObject({ fill: '#4f46e5', gradient: { from: '#4f46e5' } })
  })

  test('codegen honours text styles and fill styles', () => {
    const html = boardToHtml(R4, 'a')
    expect(html).toContain('font-size: 36px')
    expect(html).toContain('linear-gradient')
    expect(boardToReact(R4, 'a')).toContain('<svg')
  })
})

describe('starter kits and token export', () => {
  test('three kits, each valid when applied; same-id styles replaced, others kept', () => {
    expect(STARTER_KITS).toHaveLength(3)
    for (const kit of STARTER_KITS) {
      const applied = applyStarterKit(R4, kit.id)!
      expect(validateDesign(applied).ok).toBe(true)
      expect(applied.tokens?.fonts).toEqual(kit.tokens.fonts)
      expect(applied.styles?.text?.find((style) => style.id === 'heading')).toEqual(kit.text.find((style) => style.id === 'heading'))
      expect(applied.styles?.fills).toEqual(R4.styles?.fills)
    }
    expect(applyStarterKit(R4, 'nope')).toBeNull()
  })

  test('CSS, JSON and Tailwind exports carry the tokens and text styles', () => {
    expect(tokensToCss(R4)).toContain('--color-primary: #4f46e5;')
    expect(tokensToCss(R4)).toContain('--text-heading-size: 36px;')
    const json = JSON.parse(tokensToJson(R4))
    expect(json.color.primary).toEqual({ $value: '#4f46e5', $type: 'color' })
    expect(json.typography.heading.$value.fontSize).toBe('36px')
    const tailwind = tokensToTailwind(R4)
    expect(tailwind).toContain('"primary": "#4f46e5"')
    expect(tailwind).toContain('"heading": [')
  })
})

describe('vectors', () => {
  test('polygon and star points sit in the box; geometry per kind', () => {
    expect(polygonPoints(4, 100, 100)).toEqual([[50, 0], [100, 50], [50, 100], [0, 50]])
    expect(starPoints(5, 0.5, 100, 100)).toHaveLength(10)
    const star = node(R4, 'a', 'badge') as ShapeNode
    expect(shapeGeometry(star, 40, 40).closed).toBe(true)
    const pen = node(R4, 'a', 'pen') as ShapeNode
    expect(shapeGeometry(pen, 100, 50)).toEqual({ d: 'M0 0 L50 50 L100 0', closed: false })
    expect(shapeGeometry(node(R4, 'a', 'arrow') as ShapeNode, 120, 20).d).toMatch(/^M0 10 L120 10 M/)
  })
})

describe('prototype flows', () => {
  test('lists every link with its trigger and transition; start board and dead ends', () => {
    expect(prototypeLinks(R4)).toEqual([
      { fromBoardId: 'a', nodeId: 'go', label: 'Go', toBoardId: 'b', transition: 'slide-left', trigger: 'click' },
      { fromBoardId: 'b', nodeId: 'back', label: 'Back', toBoardId: 'a', transition: 'instant', trigger: 'click' },
    ])
    expect(startBoardOf(R4)).toBe('b')
    expect(unreachableBoards(R4)).toEqual(['c'])
    expect(startBoardOf(setStartBoard(R4, null))).toBe('a')
    expect(setStartBoard(R4, 'zzz')).toBe(R4)
  })

  test('removing the start board clears it', () => {
    const next = removeBoard(R4, 'b')
    expect(next.startBoard).toBeUndefined()
    expect(validateDesign(next).ok).toBe(true)
  })
})

describe('clipboard', () => {
  test('copy then paste gives fresh ids and validates; parse refuses foreign text', () => {
    const text = copyNodes(R4, 'a', ['row', 'badge'])!
    const payload = parseClipboard(text)!
    expect(payload.nodes.map((entry) => entry.id)).toEqual(['row', 'badge'])
    const pasted = pasteNodes(R4, { boardId: 'b', parentId: 'b-root' }, payload)
    expect(pasted.ids).toHaveLength(2)
    expect(pasted.ids).not.toContain('row')
    expect(validateDesign(pasted.design).ok).toBe(true)
    expect(parseClipboard('hello')).toBeNull()
    expect(parseClipboard('{"kind":"freebuff-design-nodes"}')).toBeNull()
    expect(copyNodes(R4, 'a', ['a-root'])).toBeNull()
  })

  test('pasting into another design resolves tokens, styles and links it lacks', () => {
    const payload = parseClipboard(copyNodes(R4, 'a', ['row'])!)!
    const other: Design = ok({ version: 1, title: 'Other', boards: [{ id: 'o', title: 'O', x: 0, y: 0, w: 400, h: 400, root: { type: 'frame', id: 'o-root', layout: 'stack-v', children: [] } }] })
    const pasted = pasteNodes(other, { boardId: 'o', parentId: 'o-root' }, payload)
    expect(validateDesign(pasted.design).ok).toBe(true)
    const row = node(pasted.design, 'o', pasted.ids[0]) as FrameNode
    expect(row.fill).toBe('#4f46e5')
    expect(row.fillStyle).toBeUndefined()
    const go = row.children[1]
    expect((go as Record<string, unknown>).linkTo).toBeUndefined()
  })
})

describe('guide', () => {
  test('names every round-4 field', () => {
    for (const word of ['"breakpoints"', '"responsive"', '"constraints"', '"styles"', '"textStyle"', '"fillStyle"', '"startBoard"', '"guides"', '"layoutGrid"', '"rowGap"', '"vertices"', '"fontSize"']) {
      expect(DESIGN_GUIDE).toContain(word)
    }
  })
})
