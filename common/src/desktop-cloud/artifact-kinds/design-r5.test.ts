import { describe, expect, test } from 'bun:test'

import { DESIGN_EXAMPLE, validateDesign, type Design, type DesignNode, type FrameNode } from './design'
import { boardToReact } from './design-codegen'
import { fillHoles, logicScope, materializeLogic, templateId, themedTokens } from './design-logic'
import { pruneDangling, removeDataList, removeVariable, focusSequence } from './design-logic-edit'
import { applyPrototype, initialPrototype, runInteractions, stateVariant } from './design-prototype'
import { materializeDesign } from './design-resolve'
import { curvedPathOf, shapeGeometry } from './design-vector'

const frame = (id: string, children: DesignNode[], extra: Partial<FrameNode> = {}): FrameNode => ({ type: 'frame', id, layout: 'stack-v', children, ...extra })

const LOGIC: Design = {
  version: 1,
  title: 'Logic',
  tokens: { colors: { background: '#ffffff', text: '#111111', primary: '#0f766e', 'on-primary': '#ffffff' }, themes: { dark: { background: '#0b0b0b', text: '#f5f5f5' } } },
  variables: [
    { id: 'promo', name: 'Promo', type: 'boolean', value: true },
    { id: 'plan', name: 'Plan', type: 'choice', value: 'Pro', options: ['Free', 'Pro'] },
    { id: 'who', name: 'Who', type: 'text', value: 'Ada' },
  ],
  data: [{ id: 'people', name: 'People', fields: ['name', 'role'], rows: [{ name: 'Ada', role: 'Eng' }, { name: 'Lin', role: 'PM' }, { name: 'Sam', role: 'Design' }] }],
  boards: [
    {
      id: 'home', title: 'Home', x: 0, y: 0, w: 800, h: 600, theme: 'dark',
      root: frame('root', [
        { type: 'text', id: 'hello', text: 'Hi {{who}} on {{plan}} ({{nobody}})', style: 'h1' },
        { type: 'text', id: 'banner', text: 'Sale', style: 'body', showIf: { variable: 'promo' } },
        { type: 'text', id: 'free-only', text: 'Upgrade', style: 'body', showIf: { variable: 'plan', equals: 'Free' } },
        frame('team', [frame('card', [{ type: 'text', id: 'card-name', text: '{{item.name}}', style: 'body' }, { type: 'text', id: 'card-role', text: 'x', style: 'small', bind: { text: 'item.role' } }])], { repeat: { data: 'people', limit: 2 } }),
        { type: 'input', id: 'agree', kind: 'toggle', label: 'Promo', bind: { checked: 'promo' } },
        { type: 'button', id: 'go', label: 'Go', variant: 'primary', interactions: [{ action: 'toggle', target: 'banner' }, { action: 'setVariable', target: 'plan', value: 'Free' }, { action: 'navigate', target: 'next', transition: 'slide-left' }] },
      ]),
    },
    { id: 'next', title: 'Next', x: 900, y: 0, w: 390, h: 844, focusOrder: ['back'], root: frame('next-root', [{ type: 'button', id: 'back', label: 'Back', variant: 'ghost', interactions: [{ action: 'back' }] }]) },
  ],
}

describe('round 5 schema', () => {
  test('a pre-round-5 design parses unchanged and draws the same', () => {
    const verdict = validateDesign(DESIGN_EXAMPLE)
    expect(verdict.ok).toBe(true)
    if (!verdict.ok) return
    expect(verdict.design).toEqual(DESIGN_EXAMPLE)
    // No variables or data: logic is the identity, so every existing body renders as before.
    expect(materializeLogic(DESIGN_EXAMPLE)).toBe(DESIGN_EXAMPLE)
    expect(materializeDesign(DESIGN_EXAMPLE, null).boards[0].root).toEqual(materializeDesign({ ...DESIGN_EXAMPLE }, null).boards[0].root)
  })

  test('the logic fixture validates, and broken references are refused with a reason', () => {
    expect(validateDesign(LOGIC)).toEqual({ ok: true, design: LOGIC })
    const bad = structuredClone(LOGIC)
    const root = bad.boards[0].root
    ;(root.children[1] as DesignNode).showIf = { variable: 'ghost' }
    ;(root.children[5] as DesignNode).interactions = [{ action: 'navigate', target: 'nowhere' }, { action: 'setVariable', target: 'plan', value: 'Enterprise' }]
    bad.variables!.push({ id: 'n', name: 'N', type: 'number', value: 'ten' })
    const verdict = validateDesign(bad)
    expect(verdict.ok).toBe(false)
    if (verdict.ok) return
    const all = verdict.errors.join('\n')
    expect(all).toContain('showIf: no variable "ghost"')
    expect(all).toContain('no board "nowhere"')
    expect(all).toContain('the value is one of Free, Pro')
    expect(all).toContain('a number variable takes a number')
  })

  test('an item binding outside a repeat and a repeat of a missing list are refused', () => {
    const bad = structuredClone(LOGIC)
    bad.boards[0].root.children.push({ type: 'text', id: 'stray', text: 'x', style: 'body', bind: { text: 'item.name' } })
    ;(bad.boards[0].root.children[3] as FrameNode).repeat = { data: 'missing' }
    const verdict = validateDesign(bad)
    expect(verdict.ok).toBe(false)
    if (verdict.ok) return
    expect(verdict.errors.join('\n')).toContain('only meaningful inside a repeat')
    expect(verdict.errors.join('\n')).toContain('no data list "missing"')
  })

  test('repeats count against the drawn-node cap', () => {
    const big = structuredClone(LOGIC)
    big.data![0].rows = Array.from({ length: 50 }, (_, i) => ({ name: `P${i}`, role: 'r' }))
    const team = big.boards[0].root.children[3] as FrameNode
    team.repeat = { data: 'people' }
    team.children = [frame('big', Array.from({ length: 199 }, (_, i) => ({ type: 'text', id: `t${i}`, text: 'x', style: 'body' }) as DesignNode))]
    const verdict = validateDesign(big)
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.errors.join(' ')).toContain('once instances expand')
  })
})

describe('logic', () => {
  test('holes, showIf, bindings and repeat resolve; unknown holes stay', () => {
    const drawn = materializeLogic(LOGIC).boards[0].root
    const [hello, banner, freeOnly, team, agree] = drawn.children as [DesignNode, DesignNode, DesignNode, FrameNode, DesignNode]
    expect(hello.type === 'text' && hello.text).toBe('Hi Ada on Pro ({{nobody}})')
    expect(banner.hidden).toBeUndefined()
    expect(freeOnly.hidden).toBe(true)
    // Two rows (limit 2): row 0 keeps the template ids, row 1 is suffixed.
    expect(team.children.map((child) => child.id)).toEqual(['card', 'card~r1'])
    const second = team.children[1] as FrameNode
    expect(second.children.map((child) => child.id)).toEqual(['card-name~r1', 'card-role~r1'])
    expect(second.children.map((child) => (child.type === 'text' ? child.text : ''))).toEqual(['Lin', 'PM'])
    expect(templateId('card-role~r1')).toBe('card-role')
    expect(agree.type === 'input' && agree.checked).toBe(true)
    // A prototype's variable wins over the stored value.
    const off = materializeLogic(LOGIC, { promo: false, plan: 'Free' }).boards[0].root.children
    expect(off[1].hidden).toBe(true)
    expect(off[2].hidden).toBeUndefined()
    expect(fillHoles('{{who}}!', logicScope(LOGIC))).toBe('Ada!')
  })

  test('the dark theme replaces colours a board draws with', () => {
    const tokens = themedTokens(LOGIC.tokens, 'dark')
    expect(tokens?.colors.background).toBe('#0b0b0b')
    expect(tokens?.colors.primary).toBe('#0f766e')
    expect(themedTokens(LOGIC.tokens, 'light')).toBe(LOGIC.tokens)
  })

  test('removing a lever or a list drops what named it, so the design stays valid', () => {
    const noPromo = removeVariable(LOGIC, 'promo')
    expect(validateDesign(noPromo).ok).toBe(true)
    const root = noPromo.boards[0].root.children
    expect(root[1].showIf).toBeUndefined()
    expect(root[4].bind).toBeUndefined()
    const noData = removeDataList(LOGIC, 'people')
    expect(validateDesign(noData).ok).toBe(true)
    const team = noData.boards[0].root.children[3] as FrameNode
    expect(team.repeat).toBeUndefined()
    expect((team.children[0] as FrameNode).children[1].bind).toBeUndefined()
    // A node an interaction toggles goes: the interaction goes with it.
    const gone = structuredClone(LOGIC)
    gone.boards[0].root.children.splice(1, 1)
    const pruned = pruneDangling(gone)
    expect(validateDesign(pruned).ok).toBe(true)
    expect(pruned.boards[0].root.children.at(-1)?.interactions?.map((entry) => entry.action)).toEqual(['setVariable', 'navigate'])
    expect(pruneDangling(LOGIC)).toBe(LOGIC)
  })

  test('code export draws the repeat rows and the bound text', () => {
    const code = boardToReact(LOGIC, 'home')
    expect(code).toContain('Lin')
    expect(code).toContain('Hi Ada on Pro')
    expect(code).not.toContain('Upgrade')
  })
})

describe('prototype', () => {
  test('a click toggles, sets a variable and navigates; back returns', () => {
    const start = initialPrototype(LOGIC)
    const go = LOGIC.boards[0].root.children[5]
    const first = runInteractions(LOGIC, start, go.interactions!, 'home', () => false)
    expect(first.state.hidden.banner).toBe(true)
    expect(first.state.vars.plan).toBe('Free')
    expect(first.effect).toEqual({ kind: 'navigate', boardId: 'next', transition: 'slide-left' })
    const back = runInteractions(LOGIC, first.state, [{ action: 'back' }], 'next', () => false)
    expect(back.effect).toEqual({ kind: 'back', boardId: 'home' })
    const shown = applyPrototype(LOGIC.boards[0], first.state)
    expect(shown.root.children[1].hidden).toBe(true)
  })

  test('hover and pressed variants follow the "<Group> / <Variant> Hover" naming', () => {
    const mains = new Map<string, FrameNode>([
      ['btn', frame('btn', [], { component: true, name: 'Button / Primary' })],
      ['btn-h', frame('btn-h', [], { component: true, name: 'Button / Primary Hover' })],
      ['btn-p', frame('btn-p', [], { component: true, name: 'Button / Primary Pressed' })],
      ['tab', frame('tab', [], { component: true, name: 'Tab / Default' })],
      ['tab-h', frame('tab-h', [], { component: true, name: 'Tab / Hover' })],
    ])
    expect(stateVariant(mains, 'btn', 'hover')).toBe('btn-h')
    expect(stateVariant(mains, 'btn', 'pressed')).toBe('btn-p')
    expect(stateVariant(mains, 'tab', 'hover')).toBe('tab-h')
    expect(stateVariant(mains, 'tab', 'pressed')).toBeNull()
  })

  test('the keyboard order puts focusOrder first, then other interactive layers', () => {
    expect(focusSequence(LOGIC.boards[0]).map((node) => node.id)).toEqual(['agree', 'go'])
    expect(focusSequence(LOGIC.boards[1]).map((node) => node.id)).toEqual(['back'])
  })
})

describe('vectors', () => {
  test('a pen path with curves draws cubic segments and stays valid', () => {
    expect(curvedPathOf([[0, 0], [100, 0], [100, 100]], [[0.2, -0.2, 0.8, -0.2], null], false, 100, 100)).toBe('M0 0 C20 -20 80 -20 100 0 L100 100')
    const shape = { type: 'shape' as const, id: 'pen', kind: 'path' as const, w: 100, h: 50, vertices: [[0, 0], [1, 1]] as Array<[number, number]>, curves: [[0.5, 0, 0.5, 1]] as Array<[number, number, number, number]> }
    expect(shapeGeometry(shape, 100, 50).d).toBe('M0 0 C50 0 50 50 100 50')
  })
})
