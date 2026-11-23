import { describe, expect, test } from 'bun:test'

import {
  arrangeElements,
  expandToGroups,
  groupElements,
  insertTableColumn,
  insertTableRow,
  isOneGroup,
  newTable,
  nextNoteSpot,
  normalizeLinkUrl,
  removeTableRow,
  searchBoard,
  setLocked,
  setTableCell,
  stackNotes,
  tableCellAt,
  ungroupElements,
  unlockedIds,
} from './whiteboard-arrange'
import {
  arrowGeometry,
  elbowRoute,
  elementBounds,
  estimateMeasure,
  geometryContext,
  nearestFraction,
  pointAlong,
  simplifyPolyline,
} from './whiteboard-geometry'
import { copyFragment, pasteFragment, updateElements } from './whiteboard-ops'
import {
  fitRichText,
  hasRichMarks,
  layoutRichText,
  parseInline,
  plainRichText,
  splitBullet,
  toggleBullets,
  toggleMark,
} from './whiteboard-richtext'
import { snapMove, snapResize } from './whiteboard-snap'
import { parseBoard, type NoteElement, type WhiteboardBoard, type WhiteboardElement } from './whiteboard'

function valid(board: WhiteboardBoard): WhiteboardBoard {
  const result = parseBoard(board)
  if (!result.ok) throw new Error(result.errors.join('; '))
  return board
}

const note = (id: string, x: number, y: number, extra: Partial<NoteElement> = {}): NoteElement => ({
  type: 'note',
  id,
  x,
  y,
  w: 100,
  h: 100,
  text: '',
  color: 'yellow',
  ...extra,
})

const board = (elements: WhiteboardElement[]): WhiteboardBoard => ({ version: 1, title: 'T', elements })
const byId = (b: WhiteboardBoard, id: string) => b.elements.find((e) => e.id === id)!

// Stored round-1 bodies, pinned as literal JSON so a later fixture change cannot hide a break.
const V1_BODIES = [
  '{"version":1,"title":"Signup flow","elements":[{"type":"text","id":"title","x":0,"y":0,"text":"Signup flow","size":"xl"},{"type":"shape","id":"visit","kind":"rounded","x":0,"y":120,"w":160,"h":80,"text":"Landing page","color":"blue"},{"type":"shape","id":"valid","kind":"diamond","x":480,"y":100,"w":160,"h":120,"text":"Email valid?","color":"yellow"},{"type":"arrow","id":"a1","from":{"elementId":"visit"},"to":{"elementId":"valid","side":"left"},"label":"Get started","style":"solid"},{"type":"arrow","id":"a2","from":{"x":10,"y":20},"to":{"x":300,"y":40},"style":"dashed","head":"both","color":"red"},{"type":"section","id":"questions","x":0,"y":320,"w":760,"h":288,"title":"Open questions","color":"gray"},{"type":"note","id":"q1","x":40,"y":368,"w":200,"h":200,"text":"Do we need email verification?","color":"yellow"},{"type":"stroke","id":"s1","points":[[0,0],[10.5,4]],"color":"blue","width":4},{"type":"image","id":"i1","x":900,"y":0,"w":320,"h":240,"src":"/_blob/abc123","alt":"Logo"}]}',
  '{"version":1,"title":"Empty","elements":[]}',
]

describe('schema additions are additive', () => {
  test('round-1 bodies still parse, unchanged', () => {
    for (const body of V1_BODIES) {
      const result = parseBoard(body)
      if (!result.ok) throw new Error(result.errors.join('; '))
      expect(result.board).toEqual(JSON.parse(body))
    }
  })

  test('new element types and fields parse; bad values are refused', () => {
    valid(
      board([
        { ...note('n', 0, 0, { fontSize: 'l', groups: ['g1'], locked: true }) },
        { type: 'sticker', id: 's', x: 0, y: 0, w: 48, h: 48, sticker: 'thumbs-up' },
        { type: 'table', id: 't', x: 0, y: 0, w: 280, h: 80, rows: [['a', 'b'], ['c', 'd']], header: true },
        { type: 'link', id: 'l', x: 0, y: 0, w: 280, h: 96, url: 'https://example.com/x', title: 'Example' },
        { type: 'arrow', id: 'a', from: { elementId: 'n' }, to: { elementId: 't' }, style: 'solid', routing: 'elbow', bend: 24, labelAt: 0.3 },
      ]),
    )
    expect(parseBoard(board([{ type: 'link', id: 'l', x: 0, y: 0, w: 9, h: 9, url: 'javascript:alert(1)', title: '' } as never])).ok).toBe(false)
    expect(parseBoard(board([{ type: 'link', id: 'l', x: 0, y: 0, w: 9, h: 9, url: 'http://example.com', title: '' } as never])).ok).toBe(false)
    expect(parseBoard(board([{ type: 'sticker', id: 's', x: 0, y: 0, w: 9, h: 9, sticker: 'https://x/y.png' } as never])).ok).toBe(false)
    // A ragged table is refused.
    expect(parseBoard(board([{ type: 'table', id: 't', x: 0, y: 0, w: 9, h: 9, rows: [['a', 'b'], ['c']] } as never])).ok).toBe(false)
    expect(parseBoard(board([{ ...note('n', 0, 0), groups: [] } as never])).ok).toBe(false)
  })

  test('updateElements accepts the new optional keys', () => {
    const b = board([note('n', 0, 0), { type: 'arrow', id: 'a', from: { x: 0, y: 0 }, to: { x: 9, y: 9 }, style: 'solid' }])
    const next = updateElements(
      b,
      new Map<string, Partial<WhiteboardElement>>([
        ['n', { locked: true, groups: ['g'], fontSize: 'xl' } as Partial<WhiteboardElement>],
        ['a', { routing: 'elbow', bend: 10, labelAt: 0.25 } as Partial<WhiteboardElement>],
      ]),
    )
    valid(next)
    expect(byId(next, 'n')).toMatchObject({ locked: true, groups: ['g'], fontSize: 'xl' })
    expect(byId(next, 'a')).toMatchObject({ routing: 'elbow', bend: 10, labelAt: 0.25 })
  })
})

describe('groups and locks', () => {
  const base = board([note('a', 0, 0), note('b', 200, 0), note('c', 400, 0)])

  test('group, expand, ungroup round trip', () => {
    const { board: grouped, groupId } = groupElements(base, ['a', 'b'])
    valid(grouped)
    expect(groupId).not.toBeNull()
    expect(expandToGroups(grouped, ['a']).sort()).toEqual(['a', 'b'])
    expect(isOneGroup(grouped, ['a', 'b'])).toBe(true)
    // Nesting: a group of the group and c; a click selects all three.
    const outer = groupElements(grouped, ['a', 'b', 'c']).board
    expect(expandToGroups(outer, ['c']).sort()).toEqual(['a', 'b', 'c'])
    const once = ungroupElements(outer, ['a'])
    expect(expandToGroups(once, ['a']).sort()).toEqual(['a', 'b'])
    const twice = ungroupElements(once, ['a'])
    valid(twice)
    expect(twice.elements.every((e) => e.groups === undefined)).toBe(true)
  })

  test('a single element is not grouped', () => {
    expect(groupElements(base, ['a']).groupId).toBeNull()
  })

  test('pasting a group makes a new group', () => {
    const grouped = groupElements(base, ['a', 'b']).board
    const { board: pasted, ids } = pasteFragment(grouped, copyFragment(grouped, ['a', 'b']), 20, 20)
    valid(pasted)
    const original = byId(grouped, 'a').groups![0]
    const copyGroup = byId(pasted, ids[0]).groups![0]
    expect(copyGroup).not.toBe(original)
    expect(expandToGroups(pasted, [ids[0]]).sort()).toEqual([...ids].sort())
  })

  test('lock and unlock', () => {
    const locked = setLocked(base, ['a'], true)
    valid(locked)
    expect(unlockedIds(locked, ['a', 'b'])).toEqual(['b'])
    const unlocked = setLocked(locked, ['a'], false)
    expect('locked' in byId(unlocked, 'a')).toBe(false)
    expect(setLocked(unlocked, ['a'], false)).toBe(unlocked)
  })
})

describe('align and distribute', () => {
  const ctx = (b: WhiteboardBoard) => geometryContext(b.elements, estimateMeasure)

  test('align left / right / middle', () => {
    const b = board([note('a', 0, 0), note('b', 50, 300, { w: 200 }), note('c', 300, 120)])
    expect(byId(arrangeElements(b, ['a', 'b', 'c'], 'left', ctx(b)), 'c')).toMatchObject({ x: 0 })
    const right = arrangeElements(b, ['a', 'b', 'c'], 'right', ctx(b))
    expect(byId(right, 'a')).toMatchObject({ x: 300 })
    expect(byId(right, 'b')).toMatchObject({ x: 200 })
    const middle = arrangeElements(b, ['a', 'c'], 'middle', ctx(b))
    expect(byId(middle, 'a')).toMatchObject({ y: 60 })
    expect(byId(middle, 'c')).toMatchObject({ y: 60 })
  })

  test('distribute evens the gaps; locked elements stay; a group moves as one', () => {
    const b = board([note('a', 0, 0), note('b', 130, 0), note('c', 600, 0)])
    const spread = valid(arrangeElements(b, ['a', 'b', 'c'], 'distribute-horizontal', ctx(b)))
    expect(byId(spread, 'b')).toMatchObject({ x: 300 })
    const locked = setLocked(b, ['c'], true)
    expect(byId(arrangeElements(locked, ['a', 'c'], 'left', ctx(locked)), 'c')).toMatchObject({ x: 600 })
    const grouped = groupElements(board([note('a', 0, 0), note('b', 0, 120), note('c', 300, 50)]), ['a', 'b']).board
    const aligned = arrangeElements(grouped, ['a', 'b', 'c'], 'top', ctx(grouped))
    expect(byId(aligned, 'a')).toMatchObject({ y: 0 })
    expect(byId(aligned, 'b')).toMatchObject({ y: 120 })
    expect(byId(aligned, 'c')).toMatchObject({ y: 0 })
  })
})

describe('smart guides', () => {
  const targets = [
    { x: 0, y: 0, w: 100, h: 100 },
    { x: 140, y: 0, w: 100, h: 100 },
  ]

  test('edges snap within the threshold and draw a guide', () => {
    const snap = snapMove({ x: 3, y: 300, w: 100, h: 100 }, targets, 6)
    expect(snap.dx).toBe(-3)
    expect(snap.guides.some((g) => g.kind === 'line' && g.axis === 'x' && g.at === 0)).toBe(true)
    expect(snapMove({ x: 20, y: 300, w: 100, h: 100 }, targets, 6).dx).toBe(0)
  })

  test('centres snap', () => {
    const snap = snapMove({ x: 500, y: 52, w: 40, h: 0.001 + 0 }, targets, 6)
    expect(snap.dy).toBeCloseTo(-2, 1)
  })

  test('equal spacing after a pair', () => {
    // a at 0, b at 140 (gap 40): a box near 280 snaps to exactly 280.
    const snap = snapMove({ x: 283, y: 0, w: 100, h: 100 }, targets, 6)
    expect(snap.dx).toBe(-3)
    expect(snap.guides.some((g) => g.kind === 'gap')).toBe(true)
  })

  test('resize snaps only the dragged edge', () => {
    const { rect } = snapResize({ x: 0, y: 200, w: 236, h: 50 }, 'e', targets, 6)
    expect(rect).toEqual({ x: 0, y: 200, w: 240, h: 50 })
    const west = snapResize({ x: 143, y: 200, w: 60, h: 50 }, 'w', targets, 6).rect
    expect(west).toEqual({ x: 140, y: 200, w: 63, h: 50 })
  })
})

describe('elbow connectors', () => {
  test('right to left makes three segments through the middle, moved by bend', () => {
    const a = { point: { x: 0, y: 0 }, side: 'right' as const }
    const b = { point: { x: 200, y: 100 }, side: 'left' as const }
    const route = elbowRoute(a, b)
    expect(route.points).toEqual([
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
      { x: 200, y: 100 },
    ])
    expect(route.bendAxis).toBe('x')
    expect(elbowRoute(a, b, 30).points[1]).toEqual({ x: 130, y: 0 })
  })

  test('two bottoms route below both; mixed axes make one corner', () => {
    const route = elbowRoute({ point: { x: 0, y: 100 }, side: 'bottom' }, { point: { x: 300, y: 80 }, side: 'bottom' })
    expect(Math.max(...route.points.map((p) => p.y))).toBe(120)
    const mixed = elbowRoute({ point: { x: 0, y: 0 }, side: 'right' }, { point: { x: 200, y: 200 }, side: 'top' })
    expect(mixed.bendAxis).toBeUndefined()
    expect(mixed.points).toContainEqual({ x: 200, y: 0 })
  })

  test('every segment is horizontal or vertical, and bounds include the bend', () => {
    const b = board([
      note('n1', 0, 0),
      note('n2', 400, 300),
      { type: 'arrow', id: 'a', from: { elementId: 'n1' }, to: { elementId: 'n2' }, style: 'solid', routing: 'elbow', bend: 400 },
    ])
    const ctx = geometryContext(b.elements, estimateMeasure)
    const g = arrowGeometry(b.elements[2] as never, ctx)
    for (let i = 1; i < g.points!.length; i++) {
      const p = g.points![i - 1]
      const q = g.points![i]
      expect(p.x === q.x || p.y === q.y).toBe(true)
    }
    const r = elementBounds(b.elements[2], ctx)
    expect(r.x + r.w).toBeGreaterThanOrEqual(Math.max(...g.points!.map((p) => p.x)))
    expect(g.bendHandle?.axis).toBe('x')
  })

  test('labels sit labelAt along the line', () => {
    const line = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
    ]
    expect(pointAlong(line, 0.25)).toEqual({ x: 50, y: 0 })
    expect(pointAlong(line, 0.75)).toEqual({ x: 100, y: 50 })
    expect(nearestFraction(line, { x: 110, y: 50 })).toBeCloseTo(0.75, 5)
    expect(simplifyPolyline([{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 0 }])).toHaveLength(2)
  })
})

describe('rich text', () => {
  test('parses bold, italic and bullets; stray marks stay literal', () => {
    expect(parseInline('a **b** *c* _d_')).toEqual([
      { text: 'a ' },
      { text: 'b', bold: true },
      { text: ' ' },
      { text: 'c', italic: true },
      { text: ' ' },
      { text: 'd', italic: true },
    ])
    expect(parseInline('2 * 3 * 4')).toEqual([{ text: '2 * 3 * 4' }])
    expect(parseInline('snake_case_name')).toEqual([{ text: 'snake_case_name' }])
    expect(parseInline('2*3*4 and a**b**c')).toEqual([{ text: '2*3*4 and a**b**c' }])
    expect(parseInline('**open')).toEqual([{ text: '**open' }])
    expect(parseInline('***both***')).toEqual([{ text: 'both', bold: true, italic: true }])
    expect(splitBullet('- item')).toEqual({ bullet: true, body: 'item' })
    expect(splitBullet('*not a bullet*').bullet).toBe(false)
    expect(plainRichText('- **Ship** it\nnow')).toBe('• Ship it\nnow')
    expect(hasRichMarks('plain words')).toBe(false)
    expect(hasRichMarks('- one')).toBe(true)
  })

  test('wraps runs and indents bullets', () => {
    const measure = (text: string, size: number) => text.length * size * 0.5
    const lines = layoutRichText('- **aaaa** bbbb cccc', 10, 60, measure)
    expect(lines.length).toBeGreaterThan(1)
    expect(lines.every((line) => line.bullet)).toBe(true)
    expect(lines[0].lead).toBe(true)
    expect(lines[1].lead).toBe(false)
    expect(lines[0].runs[0]).toEqual({ text: 'aaaa', bold: true })
    const fit = fitRichText('a **b**', 100, 100, measure, [40, 20, 10])
    expect(fit.fontSize).toBe(40)
  })

  test('toggling marks and bullets around a selection', () => {
    expect(toggleMark({ value: 'make it bold', start: 8, end: 12 }, '**')).toEqual({ value: 'make it **bold**', start: 10, end: 14 })
    expect(toggleMark({ value: 'make it **bold**', start: 10, end: 14 }, '**')).toEqual({ value: 'make it bold', start: 8, end: 12 })
    expect(toggleMark({ value: '**bold**', start: 2, end: 6 }, '*').value).toBe('***bold***')
    expect(toggleMark({ value: '*x*', start: 1, end: 2 }, '*').value).toBe('x')
    expect(toggleBullets({ value: 'one\ntwo', start: 0, end: 7 }).value).toBe('- one\n- two')
    expect(toggleBullets({ value: '- one\n- two', start: 0, end: 11 }).value).toBe('one\ntwo')
  })
})

describe('sticky stacks, tables, links, search', () => {
  test('stackNotes adds valid notes in rows of five', () => {
    const { board: next, ids } = stackNotes(board([]), { x: 0, y: 0 }, 7, 'green')
    valid(next)
    expect(ids).toHaveLength(7)
    expect(byId(next, ids[5])).toMatchObject({ x: 0, y: 240, color: 'green' })
  })

  test('nextNoteSpot steps right past anything in the way', () => {
    const b = board([note('a', 0, 0), note('b', 140, 0)])
    expect(nextNoteSpot(b, b.elements[0] as NoteElement, geometryContext(b.elements))).toEqual({ x: 280, y: 0 })
  })

  test('table edits keep the grid rectangular', () => {
    let t = newTable('t', { x: 0, y: 0 }, 2, 2)
    t = insertTableRow(t, 1)
    t = insertTableColumn(t, 2)
    t = setTableCell(t, 1, 2, 'x')
    t = removeTableRow(t, 0)
    valid(board([t]))
    expect(t.rows).toEqual([
      ['', '', 'x'],
      ['', '', ''],
    ])
    expect(tableCellAt(t, { x: t.x + t.w - 1, y: t.y + 1 })).toEqual({ row: 0, col: 2 })
  })

  test('link urls are https only', () => {
    expect(normalizeLinkUrl('example.com/a')).toBe('https://example.com/a')
    expect(normalizeLinkUrl('https://example.com')).toBe('https://example.com/')
    expect(normalizeLinkUrl('javascript:alert(1)')).toBeNull()
    expect(normalizeLinkUrl('http://example.com')).toBeNull()
    expect(normalizeLinkUrl('two words')).toBeNull()
  })

  test('search finds text in every kind', () => {
    const b = board([note('a', 0, 0, { text: 'Cache **the** session' }), newTable('t', { x: 0, y: 0 })])
    expect(searchBoard(b, 'cache')).toEqual(['a'])
    expect(searchBoard(b, 'column 2')).toEqual(['t'])
  })
})
