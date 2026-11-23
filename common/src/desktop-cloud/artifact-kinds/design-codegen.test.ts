import { describe, expect, test } from 'bun:test'

import { DESIGN_EXAMPLE, type Design } from './design'
import { boardToHtml, boardToReact, componentName, nodeCode, tailwindClasses } from './design-codegen'
import { insertInstance, setComponent, setOverride } from './design-components'
import { libraryNode } from './design-library'
import { insertNode, updateNode } from './design-tree'

const transpiler = new Bun.Transpiler({ loader: 'tsx' })

/** Every non-void tag closes in order (a cheap well-formedness check for the HTML export). */
function balanced(html: string): boolean {
  const body = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<style>[\s\S]*?<\/style>/, '')
  const stack: string[] = []
  for (const match of body.matchAll(/<(\/?)([a-z0-9]+)[^>]*?(\/?)>/gi)) {
    const [, close, tag, self] = match
    if (self || ['img', 'input', 'hr', 'meta', '!doctype'].includes(tag.toLowerCase())) continue
    if (close) {
      if (stack.pop() !== tag) return false
    } else stack.push(tag)
  }
  return stack.length === 0
}

/** The example plus a library grid, a main component and an overridden instance. */
function rich(): Design {
  let design: Design = structuredClone(DESIGN_EXAMPLE)
  design = insertNode(design, 'desktop', 'd-root', libraryNode(design, 'feature-cards', false)!)
  const features = design.boards[0].root.children.at(-1)!
  design = setComponent(design, 'desktop', 'd-nav', true)
  const placed = insertInstance(design, 'phone', 'p-root', 'd-nav', 0)
  design = setOverride(placed.design, 'phone', placed.nodeId!, 'd-logo', { text: 'Ledgerly <beta> & {more}' })
  design = updateNode(design, 'desktop', 'd-headline', { decoration: 'underline', letterSpacing: 1, opacity: 0.9 })
  design = updateNode(design, 'desktop', features.id, { gradient: { from: 'surface', to: '#ffffff' }, strokeSides: ['top'], stroke: 'border' })
  return design
}

describe('React + Tailwind export', () => {
  test('is valid TSX: one default component, lucide imports, layout as utilities', () => {
    const code = boardToReact(rich(), 'desktop')
    // It compiles to one exported component whose body is JSX calls (not a string of markup).
    const js = transpiler.transformSync(code)
    expect(js).toMatch(/export default function LandingDesktop\(\)/)
    expect(js).toMatch(/return jsx\w*\("main", \{/)
    expect(js).toContain('from "lucide-react"')
    expect(code).toContain('export default function LandingDesktop()')
    expect(code).toContain("import { ArrowRight, ShieldCheck, Users, Zap } from 'lucide-react'")
    // Mobile first: one column under md, the design's three from md up.
    expect(code).toContain('grid grid-cols-1 md:grid-cols-3')
    expect(code).toContain('flex flex-row')
    expect(code).toMatch(/<h1 className="[^"]*underline[^"]*">Get paid on time/)
    // Tokens come out as hex; stroke on one side only.
    expect(code).toContain('bg-[#0f766e]')
    expect(code).toContain('[border-top:1px_solid_#e5e7eb]')
    expect(code).toContain('bg-[linear-gradient(180deg,_#f6f7f9,_#ffffff)]')
  })

  test('instances are expanded with their overrides, and text is escaped for JSX', () => {
    const code = boardToReact(rich(), 'phone')
    // The override's text reaches the compiled output as one string literal, not as markup.
    const js = transpiler.transformSync(code)
    expect(js).toContain('children: "Ledgerly <beta> & {more}"')
    expect(code).toContain('{/* instance of Nav */}')
    expect(code).toContain('{"Ledgerly <beta> & {more}"}')
    expect(code).toContain('Sign in')
  })
})

describe('HTML + CSS export', () => {
  test('a standalone document: token variables, one rule per class, balanced tags, escaped text', () => {
    const html = boardToHtml(rich(), 'phone')
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html).toContain('--color-primary: #0f766e;')
    expect(html).toContain('background-color: var(--color-primary);')
    expect(html).toContain('Ledgerly &lt;beta&gt; &amp; {more}')
    expect(balanced(html)).toBe(true)
    // Class names are unique even when layer names repeat.
    const classes = [...html.matchAll(/class="([^"]+)"/g)].map((m) => m[1])
    expect(new Set(classes).size).toBe(classes.length)
    for (const cls of classes) expect(html).toContain(`.${cls} {`)
  })

  test('hidden nodes are left out; links become anchors to the board', () => {
    let design: Design = structuredClone(DESIGN_EXAMPLE)
    design = updateNode(design, 'desktop', 'd-tour', { hidden: true })
    design = updateNode(design, 'desktop', 'd-cta', { linkTo: 'phone' })
    const html = boardToHtml(design, 'desktop')
    expect(html).not.toContain('See how it works')
    expect(html).toMatch(/<a class="[^"]+" href="#phone">/)
  })
})

describe('exports cannot be broken out of (M4, M5)', () => {
  const SRC = 'https://e.example/</style><img/src/onerror=alert(document.domain)>")'
  function hostile(): Design {
    let design: Design = structuredClone(DESIGN_EXAMPLE)
    design = { ...design, title: 'Site */ globalThis.pwned = 1; /*' }
    design = { ...design, boards: design.boards.map((board) => ({ ...board, title: 'Hero */ globalThis.pwned = 2; /*\nx' })) }
    design = updateNode(design, 'desktop', design.boards[0]!.root.children[0]!.id, { fillImage: { src: SRC } })
    return design
  }

  test('a stored image src stays inside its CSS string: no tag ends the stylesheet early', () => {
    const html = boardToHtml(hostile(), 'desktop')
    const style = html.slice(html.indexOf('<style>') + '<style>'.length, html.indexOf('</style>'))
    expect(html.match(/<\/style>/g)).toHaveLength(1)
    expect(style).not.toContain('<')
    expect(html).not.toContain('<img/src/onerror')
    expect(style).toContain('url("https://e.example/\\3c /style\\3e \\3c img/src/onerror=alert\\28 document.domain\\29 \\3e \\22 \\29 ")')
    expect(balanced(html)).toBe(true)
  })

  test('a title cannot close the React module\'s header comment', () => {
    const code = boardToReact(hostile(), 'desktop')
    const compiled = transpiler.transformSync(code)
    expect(compiled).not.toContain('pwned')
    expect(code).not.toMatch(/\* \/ globalThis[^\n]*\n\s*x/)
  })

  test('round 3 paths: layer-name aria-labels, the responsive stylesheet and the inspector stay escaped', () => {
    const design = hostile()
    const target = design.boards[0]!.root.children[0]!
    const named = updateNode(design, 'desktop', target.id, { name: 'Hero" onclick="alert(1)' } as never)
    const html = boardToHtml(named, 'desktop')
    expect(html).not.toContain('" onclick="alert(1)')
    expect(html.match(/<\/style>/g)).toHaveLength(1)
    const react = boardToReact(named, 'desktop')
    expect(react).not.toContain('" onclick="alert(1)')
    const code = nodeCode(named, 'desktop', target.id)!
    expect(code.css).not.toContain('<')
    expect(code.tailwind).not.toContain('<')
  })

  test('the design validator refuses a same-origin path that could break an export', async () => {
    const { isSafeImageSrc } = await import('./design')
    expect(isSafeImageSrc('/x</style><img/src/onerror=alert(1)>')).toBe(false)
    expect(isSafeImageSrc('/_asset/0193a8f0-0000-7000-a000-000000000001')).toBe(true)
  })
})

describe('helpers', () => {
  test('spacing maps onto the Tailwind scale, else an exact arbitrary value', () => {
    expect(tailwindClasses([['padding', '96px 120px'], ['gap', '24px'], ['width', '560px']])).toEqual(['py-24', 'px-[120px]', 'gap-6', 'w-[560px]'])
    expect(componentName('Landing — Desktop')).toBe('LandingDesktop')
    expect(componentName('3 up')).toBe('Board3Up')
  })
})
