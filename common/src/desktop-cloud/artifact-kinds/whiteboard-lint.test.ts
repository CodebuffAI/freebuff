import { describe, expect, test } from 'bun:test'

import { contrastRatio, formatBoardIssues, inkOn, lintBoard, type LintRule } from './whiteboard-lint'
import { TEMPLATE_IDS, templateBoard } from './whiteboard-templates'
import { parseBoard, WHITEBOARD_EXAMPLE, type WhiteboardBoard, type WhiteboardElement } from './whiteboard'

const boardOf = (elements: WhiteboardElement[]): WhiteboardBoard => ({ version: 1, title: 'Lint', elements })
const rules = (board: WhiteboardBoard): LintRule[] => lintBoard(board).issues.map((issue) => issue.rule)
const note = (id: string, x: number, y: number, extra: Record<string, unknown> = {}): WhiteboardElement =>
  ({ type: 'note', id, x, y, w: 200, h: 200, text: id, color: 'yellow', ...extra }) as WhiteboardElement
const bound = (id: string, from: string, to: string, extra: Record<string, unknown> = {}): WhiteboardElement =>
  ({ type: 'arrow', id, from: { elementId: from }, to: { elementId: to }, style: 'solid', ...extra }) as WhiteboardElement

describe('lintBoard: shipped boards are clean', () => {
  test('the guide example and every template', () => {
    expect(lintBoard(WHITEBOARD_EXAMPLE).issues).toEqual([])
    for (const id of TEMPLATE_IDS) expect({ id, issues: lintBoard(templateBoard(id)).issues }).toEqual({ id, issues: [] })
  })
})

describe('lintBoard: each rule fires on a minimal board', () => {
  test('overlap', () => {
    const result = lintBoard(boardOf([note('a', 0, 0), note('b', 40, 40)]))
    expect(result.issues.map((i) => i.rule)).toEqual(['overlap'])
    expect(result.issues[0]!.ids).toEqual(['b', 'a']) // the one on top first
  })

  test('text-overflow', () => {
    expect(rules(boardOf([note('n', 0, 0, { text: 'word '.repeat(80) })]))).toEqual(['text-overflow'])
    expect(rules(boardOf([{ type: 'shape', id: 's', kind: 'rect', x: 0, y: 0, w: 60, h: 30, text: 'a label far too long for this box', color: 'blue' }]))).toEqual(['text-overflow'])
    expect(rules(boardOf([{ type: 'table', id: 't', x: 0, y: 0, w: 120, h: 40, rows: [['a cell with far too much text for its tiny box', 'b']] }]))).toEqual(['text-overflow'])
  })

  test('tiny-text', () => {
    const text = 'tiny words in a small note that should only fit when shrunk below twelve px, really it is quite a lot of words for this'
    expect(rules(boardOf([note('n', 0, 0, { h: 120, text })]))).toEqual(['tiny-text'])
  })

  test('section-edge: sticking out, and half in without belonging', () => {
    const section: WhiteboardElement = { type: 'section', id: 's', x: 0, y: 0, w: 400, h: 400, title: 'S' }
    expect(rules(boardOf([section, note('out', 280, 100)]))).toEqual(['section-edge'])
    expect(lintBoard(boardOf([section, note('half', 320, 100)])).issues[0]!.message).toContain('not part of it')
  })

  test('dangling-arrow and duplicate-arrow', () => {
    const free = { type: 'arrow', id: 'f', from: { x: 0, y: 500 }, to: { elementId: 'a' }, style: 'solid' } as WhiteboardElement
    expect(rules(boardOf([note('a', 0, 0), free]))).toEqual(['dangling-arrow'])
    const dup = boardOf([note('a', 0, 0), note('b', 400, 0), bound('x', 'a', 'b'), bound('y', 'a', 'b', { label: 'again' })])
    const issue = lintBoard(dup).issues[0]!
    expect(issue.rule).toBe('duplicate-arrow')
    expect(issue.ids).toEqual(['y', 'x'])
  })

  test('low-contrast', () => {
    expect(rules(boardOf([note('a', 0, 0), note('b', 400, 0), bound('x', 'a', 'b', { stroke: '#ffffff' })]))).toEqual(['low-contrast'])
    expect(rules(boardOf([note('a', 0, 0), note('b', 400, 0), bound('x', 'a', 'b', { stroke: '#808080' })]))).toEqual([])
    expect(rules(boardOf([{ type: 'section', id: 's', x: 0, y: 0, w: 400, h: 400, title: 'S', stroke: '#121212' }]))).toEqual(['low-contrast'])
  })
})

describe('lintBoard: what is not a problem', () => {
  test('a sticker on a note, a note inside its section, text centred on a shape', () => {
    expect(
      rules(
        boardOf([
          { type: 'section', id: 's', x: 0, y: 0, w: 280, h: 288, title: 'S' },
          note('n', 40, 48),
          { type: 'sticker', id: 'st', x: 60, y: 60, w: 56, h: 56, sticker: 'star', attachedTo: 'n' },
          { type: 'shape', id: 'box', kind: 'rect', x: 400, y: 0, w: 240, h: 120, color: 'blue' },
          { type: 'text', id: 'label', x: 440, y: 40, text: 'Label', size: 'm' },
        ]),
      ),
    ).toEqual([])
  })

  test('hidden elements, and arrows bound to them, are not checked', () => {
    expect(rules(boardOf([note('a', 0, 0), note('b', 40, 40, { hidden: true })]))).toEqual([])
    const hiddenEnd = boardOf([note('a', 0, 0), note('b', 400, 0, { hidden: true }), bound('x', 'a', 'b'), bound('y', 'a', 'b')])
    expect(rules(hiddenEnd)).toEqual([])
    expect(rules(boardOf([note('n', 0, 0, { text: 'word '.repeat(80), hidden: true })]))).toEqual([])
  })

  test('members of one group may overlap', () => {
    expect(rules(boardOf([note('a', 0, 0, { groups: ['g'] }), note('b', 40, 40, { groups: ['g'] })]))).toEqual([])
  })
})

describe('lint helpers', () => {
  test('contrast and ink', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5)
    expect(contrastRatio('#123456', '#123456')).toBeCloseTo(1, 5)
    expect(inkOn('#ffee88')).toBe('#1f2328')
    expect(inkOn('#202060')).toBe('#ffffff')
  })

  test('the total counts overlaps past those listed, and the lines say so', () => {
    const pile = boardOf(Array.from({ length: 12 }, (_, i) => note(`n${i}`, i * 4, i * 4)))
    const result = lintBoard(pile)
    expect(result.issues.length).toBe(30)
    expect(result.total).toBe(66) // 12 choose 2
    const lines = formatBoardIssues(result)
    expect(lines.at(-1)).toBe('- … 36 more')
    expect(lines[0]).toContain('[overlap]')
  })
})

describe('older boards parse unchanged', () => {
  /** Keys sorted at every level: the same JSON, whatever order an object's keys were written in. */
  const canonical = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(canonical)
      : value && typeof value === 'object'
        ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical((value as Record<string, unknown>)[key])]))
        : value

  test('a hand-written board with every round-4 field round-trips byte for byte', () => {
    // Keys in schema order, as the editor writes them.
    const input = {
      version: 1,
      title: 'Every r4 field',
      elements: [
        { type: 'section', id: 'sec', x: 0, y: 0, w: 760, h: 288, title: 'Ideas', color: 'gray', fill: '#f0f0f0', stroke: 'blue', noteColor: 'green' },
        { type: 'note', id: 'n1', x: 40, y: 48, w: 200, h: 200, groups: ['g1'], text: '**Bold** idea', color: 'yellow', fontSize: 'm', fill: '#ffee88', stroke: '#806000', votes: 3 },
        { type: 'note', id: 'n2', x: 280, y: 48, w: 200, h: 200, groups: ['g1'], locked: true, text: 'Locked', color: 'green' },
        { type: 'shape', kind: 'rounded', id: 'clock', x: 0, y: 400, w: 200, h: 96, text: 'Timer', color: 'gray', fill: 'blue', stroke: '#336699', timer: { duration: 300, startedAt: 1700000000000, elapsed: 12.5 } },
        { type: 'shape', kind: 'cylinder', id: 'db', x: 400, y: 400, w: 120, h: 120, text: 'DB', color: 'blue' },
        { type: 'text', id: 'title', x: 0, y: -80, text: 'Board', size: 'xl', w: 400 },
        { type: 'arrow', id: 'a1', from: { elementId: 'clock', side: 'right' }, to: { elementId: 'db' }, label: 'writes', style: 'dashed', head: 'both', color: 'red', stroke: '#aa3300', routing: 'elbow', bend: 24, labelAt: 0.3 },
        { type: 'image', id: 'img', x: 600, y: 400, w: 200, h: 100, src: '/_asset/abc123', alt: 'A chart', crop: { x: 0.1, y: 0, w: 0.8, h: 1 } },
        { type: 'sticker', id: 'st', x: 60, y: 60, w: 56, h: 56, sticker: 'star', attachedTo: 'n1' },
        { type: 'table', id: 't', x: 0, y: 600, w: 280, h: 80, rows: [['Name', 'Owner'], ['Auth', 'Ana']], header: true, color: 'purple', fill: '#eeeeff' },
        { type: 'link', id: 'lnk', x: 400, y: 600, w: 280, h: 96, url: 'https://example.com/docs', title: 'Docs', color: 'blue', stroke: 'gray' },
      ],
    }
    const parsed = parseBoard(input)
    if (!parsed.ok) throw new Error(parsed.errors.join('; '))
    expect(JSON.stringify(parsed.board)).toBe(JSON.stringify(input))
    // A JSON string parses the same way.
    const fromString = parseBoard(JSON.stringify(input))
    expect(fromString.ok && JSON.stringify(fromString.board)).toBe(JSON.stringify(input))
  })

  test('the guide example and every template: nothing added, dropped or changed', () => {
    for (const [name, body] of [['example', WHITEBOARD_EXAMPLE], ...TEMPLATE_IDS.map((id) => [id, templateBoard(id)] as const)] as const) {
      const parsed = parseBoard(body)
      if (!parsed.ok) throw new Error(`${name}: ${parsed.errors.join('; ')}`)
      // zod writes an object's keys in schema order (a shape's "kind" before its "id"), so compare
      // with keys sorted: no default is injected and no value changes.
      expect({ name, body: JSON.stringify(canonical(parsed.board)) }).toEqual({ name, body: JSON.stringify(canonical(body)) })
    }
  })
})
