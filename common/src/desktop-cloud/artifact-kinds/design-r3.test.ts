import { describe, expect, test } from 'bun:test'
import ts from 'typescript'

import { DESIGN_EXAMPLE, DESIGN_LIBRARY_IDS, emptyDesign, validateDesign, type Design, type DesignBoard } from './design'
import { boardToHtml, boardToReact, landmarkTag, nodeCode, responsiveClasses } from './design-codegen'
import { DESIGN_LIBRARY, LIBRARY_CATEGORIES, libraryNode } from './design-library'
import { contrastRatio, lintDesign, opaqueRgb, requiredRatio } from './design-lint'
import { resolveInstance } from './design-components'
import { carryOverrides, swapInstance, variantName, variantsOf } from './design-variants'
import { countNodes, insertNode, removeBoard, updateNode } from './design-tree'

/**
 * Round 3: the code export's quality (valid TSX checked by the TypeScript compiler, semantic
 * and accessible markup, mobile-first classes), the per-node CSS behind Inspect, the larger
 * library, design lint, and the promise that every body stored before round 3 still parses
 * unchanged.
 */

/** A body written before round 3 (pages, a main and an overridden instance, pins, gradients). Frozen: never build it from helpers. */
const PRE_R3_BODY = {
  version: 1,
  title: 'Pre round 3',
  tokens: { colors: { background: '#ffffff', text: '#111827', primary: '#0f766e', 'on-primary': '#ffffff', border: '#e5e7eb' }, fonts: { heading: 'geometric', body: 'system' }, radius: 10, spacingUnit: 8 },
  pages: [{ id: 'pg-1', title: 'Screens' }, { id: 'pg-2', title: 'Components' }],
  boards: [
    {
      id: 'b-home', title: 'Home', x: 0, y: 0, w: 390, h: 844, page: 'pg-1', device: 'phone', background: 'background',
      root: {
        type: 'frame', id: 'b-home-root', layout: 'stack-v', padding: [48, 24], gap: 16, children: [
          { type: 'text', id: 't-hello', text: 'Hello', style: 'h1', letterSpacing: 1, lineHeight: 1.2, decoration: 'underline' },
          { type: 'frame', id: 'i-card', layout: 'stack-v', instanceOf: 'm-card', children: [], overrides: { 'm-card-title': { text: 'Overridden' } } },
          {
            type: 'frame', id: 'f-badge-host', layout: 'stack-h', gradient: { from: 'primary', to: '#ffffff', angle: 90 }, strokeSides: ['top'], stroke: 'border', children: [
              { type: 'icon', id: 'ic-pin', icon: 'star', absolute: true, anchor: 'top-right', x: 8, y: 8 },
              { type: 'button', id: 'btn-go', label: 'Go', variant: 'primary', size: 'sm', linkTo: 'b-cards' },
            ],
          },
        ],
      },
    },
    {
      id: 'b-cards', title: 'Cards', x: 0, y: 0, w: 1440, h: 900, page: 'pg-2',
      root: {
        type: 'frame', id: 'b-cards-root', layout: 'stack-v', children: [
          { type: 'frame', id: 'm-card', name: 'Card', layout: 'stack-v', component: true, padding: 24, radius: 12, fill: 'background', shadow: 'sm', children: [
            { type: 'text', id: 'm-card-title', text: 'Card', style: 'h3' },
          ] },
        ],
      },
    },
  ],
  notes: [{ id: 'n-1', x: 0, y: -120, text: 'Screens', kind: 'title', page: 'pg-1' }],
}

describe('pre-round-3 bodies', () => {
  test('parse unchanged', () => {
    const result = validateDesign(structuredClone(PRE_R3_BODY))
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.design).toEqual(PRE_R3_BODY as unknown as Design)
  })
})

// ---- code export: compiled by TypeScript

/** Syntax diagnostics of a TSX module, as messages (empty when it compiles). */
function tsxDiagnostics(code: string): string[] {
  const out = ts.transpileModule(code, {
    fileName: 'Board.tsx',
    reportDiagnostics: true,
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  })
  return (out.diagnostics ?? []).map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'))
}

/** A design with one board of `w` holding a library entry (or nothing). */
function boardWith(entryId: string | null, w: number): Design {
  const board: DesignBoard = { id: 'b', title: 'Test board', x: 0, y: 0, w, h: 900, root: { type: 'frame', id: 'b-root', layout: 'stack-v', children: [] } }
  let design: Design = { ...emptyDesign('Lib'), boards: [board] }
  if (entryId) design = insertNode(design, 'b', 'b-root', libraryNode(design, entryId, w < 600)!)
  return design
}

/** Every <input> or <select> in the React output has a visible label around it or an aria-label. */
function controlsNamed(code: string): boolean {
  const lines = code.split('\n')
  return lines.every((line, i) => {
    if (!/<(input|select)\b/.test(line)) return true
    if (/aria-label="[^"]+"/.test(line)) return true
    // Wrapped in a <label> with text (the label opens on an earlier line).
    return lines.slice(Math.max(0, i - 3), i).some((prev) => /<label\b/.test(prev))
  })
}

describe('React + Tailwind export compiles as TSX', () => {
  const cases: Array<[string, Design, string]> = [
    ['the guide example, desktop', DESIGN_EXAMPLE, 'desktop'],
    ['the guide example, phone', DESIGN_EXAMPLE, 'phone'],
    ...DESIGN_LIBRARY.flatMap((entry): Array<[string, Design, string]> => [
      [`${entry.id}, desktop`, boardWith(entry.id, 1440), 'b'],
      [`${entry.id}, phone`, boardWith(entry.id, 390), 'b'],
    ]),
  ]
  for (const [label, design, boardId] of cases) {
    test(label, () => {
      const code = boardToReact(design, boardId)
      expect(tsxDiagnostics(code)).toEqual([])
      expect(code).not.toMatch(/\sclass=|\sfor=/)
      expect(controlsNamed(code)).toBe(true)
      // One h1 per board at most.
      expect((code.match(/<h1\b/g) ?? []).length).toBeLessThanOrEqual(1)
    })
  }

  test('a syntax error is caught (the check is not vacuous)', () => {
    expect(tsxDiagnostics('export default function A() { return (<div><p></div>) }').length).toBeGreaterThan(0)
  })
})

describe('semantic, accessible, responsive markup', () => {
  test('landmarks from layer names; one h1, later display/h1 texts demoted', () => {
    expect(landmarkTag('Navigation bar')).toBe('nav')
    expect(landmarkTag('Site footer')).toBe('footer')
    expect(landmarkTag('Sidebar')).toBe('aside')
    expect(landmarkTag('Hero')).toBeNull()
    let design: Design = structuredClone(DESIGN_EXAMPLE)
    design = insertNode(design, 'desktop', 'd-root', { type: 'text', id: 'd-second', text: 'Second headline', style: 'display' })
    const html = boardToHtml(design, 'desktop')
    expect(html).toMatch(/<nav class="nav">/)
    // Only the outermost landmark: a "Nav links" frame inside the nav stays a div.
    const nested = insertNode(structuredClone(DESIGN_EXAMPLE), 'desktop', 'd-nav', { type: 'frame', id: 'd-nav-more', name: 'Nav links', layout: 'stack-h', children: [] })
    expect(boardToHtml(nested, 'desktop').match(/<nav\b/g)).toHaveLength(1)
    expect(html.match(/<h1\b/g)).toHaveLength(1)
    expect(html).toMatch(/<h2 class="[^"]+">Second headline<\/h2>/)
  })

  test('a linked frame that holds a button is not an <a>; one with only an icon gets a name', () => {
    let design: Design = structuredClone(DESIGN_EXAMPLE)
    design = updateNode(design, 'desktop', 'd-ctas', { linkTo: 'phone' })
    design = insertNode(design, 'desktop', 'd-root', {
      type: 'frame', id: 'd-back', layout: 'stack-h', linkTo: 'phone', children: [{ type: 'icon', id: 'd-back-icon', icon: 'arrow-left' }],
    })
    const html = boardToHtml(design, 'desktop')
    expect(html).toContain('links to #phone (holds controls, so not an &lt;a&gt;)')
    expect(html).not.toMatch(/<a [^>]*>\s*<button/)
    expect(html).toMatch(/<a class="[^"]+" href="#phone" aria-label="Go to Landing — Phone">/)
  })

  test('unlabelled inputs and decorative placeholders', () => {
    let design = boardWith(null, 1440)
    design = insertNode(design, 'b', 'b-root', { type: 'input', id: 'q', kind: 'search', placeholder: 'Search docs' })
    design = insertNode(design, 'b', 'b-root', { type: 'image', id: 'deco', placeholder: 'photo', alt: '' })
    const html = boardToHtml(design, 'b')
    expect(html).toMatch(/<input class="[^"]+" type="search" aria-label="Search docs"/)
    expect(html).toMatch(/<div class="[^"]+" aria-hidden="true"><\/div>/)
  })

  test('grids stack under md; the board narrows; text widths become measures', () => {
    const design = boardWith('feature-cards', 1440)
    const html = boardToHtml(design, 'b')
    expect(html).toMatch(/@media \(max-width: 767px\) \{\s+\.[a-z-]+ \{\s+grid-template-columns: minmax\(0, 1fr\);/)
    expect(html).toContain('max-width: 1440px;')
    const react = boardToReact(DESIGN_EXAMPLE, 'desktop')
    expect(react).toContain('w-full max-w-[1440px] mx-auto')
    expect(react).toContain('w-[480px] max-w-full')
    expect(responsiveClasses([['display', 'grid'], ['grid-template-columns', 'repeat(3, minmax(0, 1fr))']], [['grid-template-columns', 'minmax(0, 1fr)']])).toEqual(['grid', 'grid-cols-1', 'md:grid-cols-3'])
  })
})

describe('nodeCode (Inspect)', () => {
  test('a node’s CSS with token variables, and the same as Tailwind', () => {
    const code = nodeCode(DESIGN_EXAMPLE, 'desktop', 'd-cta')!
    expect(code.className).toBe('d-cta')
    expect(code.css).toContain('background-color: var(--color-primary);')
    expect(code.css.startsWith('.d-cta {')).toBe(true)
    expect(code.tailwind).toContain('bg-[#0f766e]')
    // The root is the board; a missing node is null.
    expect(nodeCode(DESIGN_EXAMPLE, 'desktop', 'd-root')!.css).toContain('max-width: 1440px;')
    expect(nodeCode(DESIGN_EXAMPLE, 'desktop', 'nope')).toBeNull()
    expect(nodeCode(DESIGN_EXAMPLE, 'nope', 'd-cta')).toBeNull()
  })

  test('a grid shows its narrow-screen rule', () => {
    const design = boardWith('feature-cards', 1440)
    const grid = design.boards[0].root.children[0]
    const inner = grid.type === 'frame' ? grid.children.find((c) => c.type === 'frame')! : null
    const code = nodeCode(design, 'b', inner!.id)!
    expect(code.css).toContain('@media (max-width: 767px)')
    expect(code.tailwind).toContain('md:grid-cols-3')
  })
})

describe('library (round 3 entries)', () => {
  test('ids match the guide; every entry fits a board, desktop and phone, within the caps', () => {
    expect(DESIGN_LIBRARY.map((e) => e.id)).toEqual([...DESIGN_LIBRARY_IDS])
    for (const entry of DESIGN_LIBRARY) {
      expect(LIBRARY_CATEGORIES).toContain(entry.category)
      for (const w of [1440, 390]) {
        const design = boardWith(entry.id, w)
        const verdict = validateDesign(design)
        expect(verdict.ok ? null : verdict.errors).toBeNull()
        expect(countNodes(design.boards[0].root)).toBeLessThan(120)
      }
    }
  })

  test('the new entries exist with their categories', () => {
    const byId = new Map(DESIGN_LIBRARY.map((e) => [e.id, e.category]))
    expect(byId.get('dashboard-shell')).toBe('App')
    expect(byId.get('auth-signin')).toBe('App')
    expect(byId.get('settings-page')).toBe('App')
    expect(byId.get('data-table')).toBe('App')
    expect(byId.get('empty-state')).toBe('Feedback')
    expect(byId.get('modal')).toBe('Feedback')
    expect(byId.get('toast')).toBe('Feedback')
  })
})

describe('design lint', () => {
  test('contrast maths: WCAG ratios and thresholds', () => {
    expect(contrastRatio([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 5)
    expect(contrastRatio([255, 255, 255], [255, 255, 255])).toBeCloseTo(1, 5)
    expect(requiredRatio(16, 400)).toBe(4.5)
    expect(requiredRatio(24, 400)).toBe(3)
    expect(requiredRatio(20, 700)).toBe(3)
    expect(requiredRatio(20, 600)).toBe(4.5)
    expect(opaqueRgb('#fff', undefined)).toEqual([255, 255, 255])
    expect(opaqueRgb('#ffffff80', undefined)).toBeNull()
    expect(opaqueRgb('transparent', undefined)).toBeNull()
    expect(opaqueRgb('primary', undefined)).toEqual([37, 99, 235])
  })

  const lintBoard = (w: number, children: Design['boards'][number]['root']['children'], colors: Record<string, string> = {}): Design => ({
    ...emptyDesign('Lint'),
    tokens: { ...emptyDesign().tokens!, colors: { ...emptyDesign().tokens!.colors, ...colors } },
    boards: [{ id: 'b', title: 'B', x: 0, y: 0, w, h: 800, root: { type: 'frame', id: 'root', layout: 'stack-v', children } }],
  })

  test('clean designs pass: the guide example and every library entry on the default tokens', () => {
    expect(lintDesign(DESIGN_EXAMPLE)).toEqual([])
    for (const entry of DESIGN_LIBRARY) {
      for (const w of [1440, 390]) expect(lintDesign(boardWith(entry.id, w))).toEqual([])
    }
  })

  test('low contrast on a solid fill is flagged with a ratio and a fix', () => {
    const design = lintBoard(1440, [
      { type: 'frame', id: 'card', layout: 'stack-v', fill: '#ffffff', children: [{ type: 'text', id: 'faint', text: 'Faint', style: 'body', color: '#cccccc' }] },
    ])
    const [issue] = lintDesign(design)
    expect(issue).toMatchObject({ id: 'contrast:faint', rule: 'contrast', boardId: 'b', nodeId: 'faint' })
    expect(issue.ratio).toBeCloseTo(1.61, 1)
    expect(issue.fix).toContain('needs 4.5:1')
  })

  test('large text needs 3:1 only; gradients, images, opacity and translucent colours are never guessed', () => {
    const grey = '#949494' // 3.03:1 on white
    const design = lintBoard(1440, [
      { type: 'text', id: 'big', text: 'Big', style: 'h2', color: grey },
      { type: 'text', id: 'body', text: 'Body', style: 'body', color: grey },
      { type: 'frame', id: 'grad', layout: 'stack-v', gradient: { from: '#000000', to: '#ffffff' }, children: [{ type: 'text', id: 'on-grad', text: 'x', style: 'body', color: grey }] },
      { type: 'frame', id: 'img', layout: 'stack-v', fill: '#ffffff', fillImage: { src: 'https://example.com/a.png' }, children: [{ type: 'text', id: 'on-img', text: 'x', style: 'body', color: grey }] },
      { type: 'text', id: 'faded', text: 'x', style: 'body', color: grey, opacity: 0.5 },
      { type: 'text', id: 'alpha', text: 'x', style: 'body', color: '#94949480' },
      { type: 'frame', id: 'reset', layout: 'stack-v', gradient: { from: '#000000', to: '#ffffff' }, children: [
        { type: 'frame', id: 'solid', layout: 'stack-v', fill: '#ffffff', children: [{ type: 'text', id: 'on-solid', text: 'x', style: 'body', color: grey }] },
      ] },
    ])
    expect(lintDesign(design).map((issue) => issue.nodeId)).toEqual(['body', 'on-solid'])
  })

  test('button labels: primary uses on-primary on primary', () => {
    const design = lintBoard(1440, [{ type: 'button', id: 'go', label: 'Go', variant: 'primary' }], { primary: '#fde047', 'on-primary': '#ffffff' })
    expect(lintDesign(design).map((issue) => issue.id)).toEqual(['contrast:go'])
  })

  test('tap targets only on touch boards; small linked frames too', () => {
    const children: Design['boards'][number]['root']['children'] = [
      { type: 'button', id: 'tiny', label: 'Edit', variant: 'secondary', size: 'sm' },
      { type: 'button', id: 'ok', label: 'Save', variant: 'secondary' },
      { type: 'frame', id: 'dot', layout: 'stack-v', w: 24, h: 24, linkTo: 'b', children: [] },
    ]
    expect(lintDesign(lintBoard(1440, children))).toEqual([])
    expect(lintDesign(lintBoard(390, children)).map((issue) => issue.id)).toEqual(['tap-target:tiny', 'tap-target:dot'])
    const tablet = lintBoard(1440, children)
    tablet.boards[0].device = 'tablet'
    expect(lintDesign(tablet)).toHaveLength(2)
  })

  test('a child of an absolute frame or a pinned node may overlap a sibling: not guessed', () => {
    const design = lintBoard(1080, [
      { type: 'frame', id: 'poster', layout: 'absolute', w: 1080, h: 1350, fill: '#ffffff', children: [
        { type: 'shape', id: 'dark', kind: 'rect', w: 1080, h: 600, fill: '#111111' },
        { type: 'text', id: 'over', text: 'White on dark', style: 'h1', color: '#ffffff', x: 40, y: 40 },
        { type: 'frame', id: 'chip', layout: 'stack-h', fill: '#ffffff', x: 40, y: 200, children: [{ type: 'text', id: 'in-chip', text: 'x', style: 'body', color: '#eeeeee' }] },
      ] },
      { type: 'frame', id: 'card', layout: 'stack-v', fill: '#ffffff', children: [{ type: 'text', id: 'pinned', text: 'x', style: 'body', color: '#ffffff', absolute: true }] },
    ])
    // Only the text inside the chip's own opaque fill is checked.
    expect(lintDesign(design).map((issue) => issue.nodeId)).toEqual(['in-chip'])
  })

  test('alt text for real images; hidden layers and instance contents are skipped', () => {
    const design = lintBoard(1440, [
      { type: 'image', id: 'photo', src: 'https://example.com/a.png', alt: ' ' },
      { type: 'image', id: 'ph', placeholder: 'photo', alt: '' },
      { type: 'text', id: 'gone', text: 'x', style: 'body', color: '#eeeeee', hidden: true },
      { type: 'frame', id: 'main', layout: 'stack-v', component: true, children: [{ type: 'text', id: 'main-faint', text: 'x', style: 'body', color: '#eeeeee' }] },
      { type: 'frame', id: 'inst', layout: 'stack-v', instanceOf: 'main', children: [] },
    ])
    // Round 5: the hotlinked src is flagged too (import it as an upload).
    expect(lintDesign(design).map((issue) => issue.id)).toEqual(['external-image:photo', 'alt-text:photo', 'contrast:main-faint'])
  })
})

describe('prototype transitions and min/max sizes (additive fields)', () => {
  test('a link carries a transition; removing the board drops both', () => {
    let design: Design = structuredClone(DESIGN_EXAMPLE)
    design = updateNode(design, 'desktop', 'd-cta', { linkTo: 'phone', transition: 'slide-left' })
    expect(validateDesign(design).ok).toBe(true)
    const bad = updateNode(design, 'desktop', 'd-cta', { transition: 'spin' })
    expect(validateDesign(bad).ok).toBe(false)
    const gone = JSON.stringify(removeBoard(design, 'phone'))
    expect(gone).toContain('"d-cta"')
    expect(gone).not.toContain('slide-left')
  })

  test('an instance draws its own link’s transition, else the main’s', () => {
    const main = { type: 'frame' as const, id: 'm', layout: 'stack-v' as const, component: true, linkTo: 'b', transition: 'dissolve' as const, children: [] }
    const mains = new Map([['m', main]])
    expect(resolveInstance({ type: 'frame', id: 'i', layout: 'stack-v', instanceOf: 'm', children: [] }, mains).transition).toBe('dissolve')
    expect(resolveInstance({ type: 'frame', id: 'i', layout: 'stack-v', instanceOf: 'm', linkTo: 'c', transition: 'slide-up', children: [] }, mains).transition).toBe('slide-up')
    expect(resolveInstance({ type: 'frame', id: 'i', layout: 'stack-v', instanceOf: 'm', linkTo: 'c', children: [] }, mains).transition).toBeUndefined()
  })

  test('min/max bounds validate, refuse min > max, follow instances and reach the code', () => {
    let design: Design = structuredClone(DESIGN_EXAMPLE)
    design = updateNode(design, 'desktop', 'd-copy', { w: 'fill', minW: 320, maxW: 560, maxH: 640 })
    expect(validateDesign(design).ok).toBe(true)
    const crossed = updateNode(design, 'desktop', 'd-copy', { minW: 600 })
    const verdict = validateDesign(crossed)
    expect(verdict.ok ? [] : verdict.errors).toEqual(['node d-copy: minW 600 is more than maxW 560'])
    const code = nodeCode(design, 'desktop', 'd-copy')!
    expect(code.css).toContain('min-width: 320px;')
    expect(code.css).toContain('max-width: 560px;')
    expect(code.tailwind).toContain('min-w-[320px]')
    expect(code.tailwind).toContain('max-h-[640px]')
    const mains = new Map([['m', { type: 'frame' as const, id: 'm', layout: 'stack-v' as const, component: true, maxW: 400, children: [] }]])
    expect(resolveInstance({ type: 'frame', id: 'i', layout: 'stack-v', instanceOf: 'm', children: [] }, mains).maxW).toBe(400)
    expect(resolveInstance({ type: 'frame', id: 'i', layout: 'stack-v', instanceOf: 'm', maxW: 200, children: [] }, mains).maxW).toBe(200)
  })
})

describe('variants and instance swap', () => {
  const main = (id: string, name: string, children: Design['boards'][number]['root']['children']) =>
    ({ type: 'frame' as const, id, name, layout: 'stack-v' as const, component: true, children })

  test('variant names group mains', () => {
    expect(variantName('Button / Primary')).toEqual({ group: 'Button', variant: 'Primary' })
    expect(variantName('Card')).toEqual({ group: 'Card', variant: null })
    expect(variantName(' / x')).toEqual({ group: '/ x', variant: null })
    const mains = new Map([
      ['a', main('a', 'Button / Primary', [])],
      ['b', main('b', 'button / Ghost', [])],
      ['c', main('c', 'Card', [])],
    ])
    expect(variantsOf(mains, 'a').map((m) => m.id)).toEqual(['b', 'a'])
    expect(variantsOf(mains, 'c').map((m) => m.id)).toEqual(['c'])
    expect(variantsOf(mains, 'zz')).toEqual([])
  })

  test('overrides carry by id, then name, then position among the same type; unmatched drop', () => {
    const from = main('a', 'A', [
      { type: 'text', id: 'a-title', name: 'Title', text: 'T', style: 'h3' },
      { type: 'text', id: 'a-body', text: 'B', style: 'body' },
      { type: 'image', id: 'a-pic', placeholder: 'photo', alt: '' },
    ])
    const to = main('b', 'B', [
      { type: 'text', id: 'b-body', text: 'B', style: 'body' },
      { type: 'text', id: 'b-title', name: 'Title', text: 'T', style: 'h3' },
    ])
    expect(carryOverrides({ 'a-title': { text: 'New title' }, 'a-body': { text: 'New body' }, 'a-pic': { alt: 'x' } }, from, to)).toEqual({
      'b-title': { text: 'New title' },
      'b-body': { text: 'New body' },
    })
    expect(carryOverrides(undefined, from, to)).toBeUndefined()
  })

  test('swapInstance refuses non-instances and keeps the design when the target is the same main', () => {
    const design: Design = {
      ...emptyDesign('V'),
      boards: [{ id: 'b', title: 'B', x: 0, y: 0, w: 800, h: 600, root: { type: 'frame', id: 'r', layout: 'stack-v', children: [
        main('m1', 'Chip / On', [{ type: 'text', id: 'm1-t', text: 'On', style: 'small' }]),
        main('m2', 'Chip / Off', [{ type: 'text', id: 'm2-t', text: 'Off', style: 'small' }]),
        { type: 'frame', id: 'i', layout: 'stack-v', instanceOf: 'm1', children: [] },
      ] } }],
    }
    expect(swapInstance(design, 'b', 'r', 'm2')).toEqual({ ok: false, reason: '"r" is not an instance' })
    const same = swapInstance(design, 'b', 'i', 'm1')
    expect(same.ok && same.design).toBe(design)
    const swapped = swapInstance(design, 'b', 'i', 'm2')
    expect(swapped.ok && validateDesign(swapped.design).ok).toBe(true)
  })
})
