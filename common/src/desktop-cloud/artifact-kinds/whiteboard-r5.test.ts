import { describe, expect, test } from 'bun:test'

import {
  insertTableColumn,
  insertTableRow,
  mergeTableCells,
  removeTableColumn,
  removeTableRow,
  resizeTableTrack,
  tableCellAt,
  tableCellRect,
  tableMerges,
  tableShares,
} from './whiteboard-arrange'
import { elementBounds, estimateMeasure, geometryContext } from './whiteboard-geometry'
import {
  addMindMapChild,
  addMindMapSibling,
  arrowHeadFields,
  arrowHeads,
  arrowheadPath,
  autoSizeNotes,
  childMap,
  describeChange,
  eraseStrokeAt,
  eraseStrokes,
  layoutSubtree,
  newArtifactCard,
  parentOf,
  recognizeStroke,
  restackSection,
  restackSections,
  searchShapes,
  setArrowHeads,
  setHidden,
  subtreeIds,
  treeRoot,
  visibleBoard,
} from './whiteboard-r5'
import { templateBoard } from './whiteboard-templates'
import {
  ARROWHEAD_SHAPES,
  artifactCardUrl,
  parseBoard,
  type ArrowElement,
  type NoteElement,
  type Point,
  type Rect,
  type StrokeElement,
  type TableElement,
  type WhiteboardBoard,
  type WhiteboardElement,
} from './whiteboard'

function valid(board: WhiteboardBoard): WhiteboardBoard {
  const result = parseBoard(board)
  if (!result.ok) throw new Error(result.errors.join('; '))
  return result.board
}

const byId = (board: WhiteboardBoard, id: string) => board.elements.find((e) => e.id === id)!
const boardOf = (elements: WhiteboardElement[], title = 'R5'): WhiteboardBoard => ({ version: 1, title, elements })
const note = (id: string, x: number, y: number, extra: Partial<NoteElement> = {}): NoteElement => ({
  type: 'note',
  id,
  x,
  y,
  w: 200,
  h: 200,
  text: id,
  color: 'yellow',
  ...extra,
})
const shape = (id: string, x: number, y: number): WhiteboardElement => ({ type: 'shape', id, kind: 'rounded', x, y, w: 160, h: 64, text: id, color: 'blue' })
const arrow = (id: string, from: string, to: string, extra: Partial<ArrowElement> = {}): ArrowElement => ({
  type: 'arrow',
  id,
  from: { elementId: from },
  to: { elementId: to },
  style: 'solid',
  ...extra,
})
const overlapping = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

describe('arrowheads', () => {
  test('every pair of shapes round-trips through the stored fields, and the board stays valid', () => {
    for (const start of ARROWHEAD_SHAPES)
      for (const end of ARROWHEAD_SHAPES) {
        const fields = arrowHeadFields(start, end)
        const a: ArrowElement = { ...arrow('a', 'x', 'y'), ...fields }
        for (const key of ['head', 'startHead', 'endHead'] as const) if (a[key] === undefined) delete a[key]
        expect(arrowHeads(a)).toEqual({ start, end })
        valid(boardOf([note('x', 0, 0), note('y', 400, 0), a]))
      }
  })

  test('absent fields read as the r4 head; defaults stay out of the body', () => {
    expect(arrowHeads(arrow('a', 'x', 'y'))).toEqual({ start: 'none', end: 'triangle' })
    expect(arrowHeads(arrow('a', 'x', 'y', { head: 'both' }))).toEqual({ start: 'triangle', end: 'triangle' })
    expect(arrowHeads(arrow('a', 'x', 'y', { head: 'none' }))).toEqual({ start: 'none', end: 'none' })
    const board = boardOf([note('x', 0, 0), note('y', 400, 0), arrow('a', 'x', 'y')])
    // Setting the defaults again changes nothing (the same board back).
    expect(setArrowHeads(board, ['a'], { start: 'none', end: 'triangle' })).toBe(board)
    const set = setArrowHeads(board, ['a'], { start: 'circle' })
    expect(byId(set, 'a')).toEqual({ ...arrow('a', 'x', 'y'), head: 'both', startHead: 'circle' })
    expect(arrowheadPath('none', { x: 0, y: 0 }, 0, 10)).toBeNull()
    expect(arrowheadPath('open', { x: 0, y: 0 }, 0, 10)!.filled).toBe(false)
  })
})

describe('show / hide', () => {
  const board = boardOf([note('a', 0, 0), note('b', 400, 0), note('c', 800, 0), arrow('ab', 'a', 'b'), arrow('bc', 'b', 'c')])

  test('setHidden sets and clears the flag', () => {
    const hidden = setHidden(board, ['b'], true)
    expect(byId(hidden, 'b').hidden).toBe(true)
    expect(setHidden(hidden, ['b'], true)).toBe(hidden)
    expect(byId(setHidden(hidden, ['b'], false), 'b')).not.toHaveProperty('hidden')
    valid(hidden)
  })

  test('visibleBoard drops hidden elements and the arrows bound to them', () => {
    const view = visibleBoard(setHidden(board, ['b'], true))
    expect(view.elements.map((e) => e.id)).toEqual(['a', 'c'])
    expect(visibleBoard(board)).toBe(board)
    // A hidden arrow goes on its own; its ends stay.
    expect(visibleBoard(setHidden(board, ['ab'], true)).elements.map((e) => e.id)).toEqual(['a', 'b', 'c', 'bc'])
  })
})

describe('artifact link cards', () => {
  test('newArtifactCard is a valid link centred on the point', () => {
    const id = '1b4e28ba-2fa1-41d2-883f-0016d3cca427'
    const card = newArtifactCard('card', { id, kind: 'sheet' }, '  Budget  ', { x: 140, y: 48 })
    expect(card).toMatchObject({ x: 0, y: 0, w: 280, h: 96, title: 'Budget', url: artifactCardUrl(id), artifact: { id, kind: 'sheet' } })
    valid(boardOf([card]))
    expect(newArtifactCard('c', { id, kind: 'doc' }, '   ', { x: 0, y: 0 }).title).toBe('Untitled')
  })
})

describe('mind maps', () => {
  const tree = boardOf([
    shape('root', 0, 0),
    shape('a', 900, 900),
    shape('b', -500, 300),
    shape('c', 40, 40), // overlapping the root on purpose
    shape('a1', 0, 500),
    arrow('r-a', 'root', 'a'),
    arrow('r-b', 'root', 'b'),
    arrow('r-c', 'root', 'c'),
    arrow('a-a1', 'a', 'a1'),
  ])

  test('tree helpers', () => {
    expect(childMap(tree).get('root')).toEqual(['a', 'b', 'c'])
    expect(parentOf(tree, 'a1')).toBe('a')
    expect(treeRoot(tree, 'a1')).toBe('root')
    expect(subtreeIds(tree, 'root')).toEqual(['root', 'a', 'b', 'c', 'a1'])
  })

  test('layoutSubtree puts children right of their parent, without overlap, the root fixed', () => {
    const next = valid(layoutSubtree(tree, 'root', 'right'))
    expect(byId(next, 'root')).toEqual(byId(tree, 'root'))
    const ctx = geometryContext(next.elements, estimateMeasure)
    const rect = (id: string) => elementBounds(byId(next, id), ctx)
    for (const [parent, child] of [['root', 'a'], ['root', 'b'], ['root', 'c'], ['a', 'a1']] as const) {
      expect(rect(child).x).toBeGreaterThanOrEqual(rect(parent).x + rect(parent).w)
    }
    const nodes = ['root', 'a', 'b', 'c', 'a1']
    for (let i = 0; i < nodes.length; i++)
      for (let j = i + 1; j < nodes.length; j++) expect(overlapping(rect(nodes[i]!), rect(nodes[j]!))).toBe(false)
    // Siblings keep board order top to bottom, and the root sits centred on them.
    expect(rect('a').y).toBeLessThan(rect('b').y)
    expect(rect('b').y).toBeLessThan(rect('c').y)
    const mid = (rect('a').y + rect('c').y + rect('c').h) / 2
    expect(Math.abs(rect('root').y + rect('root').h / 2 - mid)).toBeLessThanOrEqual(1)
  })

  test('down lays ranks below; a locked node stays put', () => {
    const down = layoutSubtree(tree, 'root', 'down')
    for (const id of ['a', 'b', 'c']) expect((byId(down, id) as Rect).y).toBe(64 + 80)
    const locked: WhiteboardBoard = { ...tree, elements: tree.elements.map((e) => (e.id === 'b' ? { ...e, locked: true } : e)) }
    expect(byId(layoutSubtree(locked, 'root'), 'b')).toEqual(byId(locked, 'b'))
  })

  test('addMindMapChild and addMindMapSibling', () => {
    const start = boardOf([shape('root', 0, 0)])
    const first = addMindMapChild(start, 'root', { text: 'One' })!
    expect(first).not.toBeNull()
    const child = byId(first.board, first.id)
    expect(child).toMatchObject({ type: 'shape', kind: 'rounded', text: 'One', x: 160 + 80, w: 160, h: 64, color: 'blue' })
    expect(parentOf(first.board, first.id)).toBe('root')
    const sibling = addMindMapSibling(first.board, first.id, { text: 'Two' })!
    expect(parentOf(sibling.board, sibling.id)).toBe('root')
    expect(childMap(sibling.board).get('root')).toEqual([first.id, sibling.id])
    const a = byId(sibling.board, first.id) as Rect
    const b = byId(sibling.board, sibling.id) as Rect
    expect(overlapping(a, b)).toBe(false)
    expect(byId(sibling.board, 'root')).toEqual(byId(start, 'root'))
    valid(sibling.board)
    // A root's sibling is its child; arrows and sections take no children.
    const rootSibling = addMindMapSibling(start, 'root')!
    expect(parentOf(rootSibling.board, rootSibling.id)).toBe('root')
    expect(addMindMapChild(first.board, first.board.elements.find((e) => e.type === 'arrow')!.id)).toBeNull()
    expect(addMindMapChild(boardOf([{ type: 'section', id: 's', x: 0, y: 0, w: 300, h: 300, title: 'S' }]), 's')).toBeNull()
    // A note parent makes a note child.
    const fromNote = addMindMapChild(boardOf([note('n', 0, 0, { votes: 3 })]), 'n', { direction: 'down' })!
    const noteChild = byId(fromNote.board, fromNote.id)
    expect(noteChild).toMatchObject({ type: 'note', x: 0, y: 280, text: '' })
    expect(noteChild).not.toHaveProperty('votes')
  })
})

describe('kanban columns', () => {
  test('a note dragged into a stack section snaps into its order', () => {
    const before = valid(
      boardOf([
        { type: 'section', id: 'todo', x: 0, y: 0, w: 280, h: 600, title: 'To do', stack: true },
        { type: 'section', id: 'done', x: 400, y: 0, w: 280, h: 400, title: 'Done', stack: true },
        note('t1', 40, 48),
        note('t2', 40, 288),
        note('d1', 440, 48),
      ]),
    )
    const restacked = restackSection(before, 'todo')
    expect(restacked).toBe(before) // already in order
    // Drag d1 between t1 and t2 (its centre just below t1's).
    const dragged: WhiteboardBoard = { ...before, elements: before.elements.map((e) => (e.id === 'd1' ? { ...e, x: 60, y: 160 } : e)) }
    const settled = valid(restackSections(before, dragged))
    expect(byId(settled, 't1')).toMatchObject({ x: 40, y: 48 })
    expect(byId(settled, 'd1')).toMatchObject({ x: 40, y: 288 })
    expect(byId(settled, 't2')).toMatchObject({ x: 40, y: 528 })
    // The column grows to hold three cards: 48 + 3*200 + 2*40 + 40.
    expect((byId(settled, 'todo') as Rect).h).toBe(768)
  })

  test('the kanban template is already stacked: restacking changes nothing', () => {
    const kanban = templateBoard('kanban')
    const columns = kanban.elements.filter((e) => e.type === 'section' && e.stack)
    expect(columns.length).toBe(3)
    for (const column of columns) expect(restackSection(kanban, column.id)).toBe(kanban)
    // From a board without the columns (each one "new"), every column restacks to itself.
    const bare: WhiteboardBoard = { ...kanban, elements: kanban.elements.filter((e) => e.type !== 'section') }
    expect(JSON.stringify(restackSections(bare, kanban))).toBe(JSON.stringify(kanban))
  })
})

describe('auto-sized notes', () => {
  const long = 'This note has quite a long sentence in it, long enough to need many lines at sixteen pixels.'

  test('a note grows with long text only when autoSize is on', () => {
    const previous = boardOf([note('auto', 0, 0, { h: 80, text: 'Hi', autoSize: true }), note('fixed', 400, 0, { h: 80, text: 'Hi' })])
    const typed: WhiteboardBoard = {
      ...previous,
      elements: previous.elements.map((e) => (e.type === 'note' ? { ...e, text: long } : e)),
    }
    const next = autoSizeNotes(previous, typed, estimateMeasure)
    expect((byId(next, 'auto') as Rect).h).toBeGreaterThan(80)
    expect((byId(next, 'fixed') as Rect).h).toBe(80)
    // Short text stays at the minimum height.
    expect((byId(autoSizeNotes(typed, previous, estimateMeasure), 'auto') as Rect).h).toBe(80)
    // Unchanged notes are left alone.
    expect(autoSizeNotes(next, next, estimateMeasure)).toBe(next)
  })
})

describe('partial erasing', () => {
  const stroke: StrokeElement = {
    type: 'stroke',
    id: 's',
    points: Array.from({ length: 21 }, (_, i) => [i * 10, 0] as [number, number]),
    color: 'gray',
    width: 4,
  }

  test('erasing the middle splits a stroke in two; far away is null', () => {
    const taken = new Set(['s'])
    const pieces = eraseStrokeAt(stroke, { x: 100, y: 0 }, 12, taken)!
    expect(pieces).toHaveLength(2)
    expect(pieces[0]!.id).toBe('s')
    expect(pieces[1]!.id).not.toBe('s')
    expect(Math.max(...pieces[0]!.points.map((p) => p[0]))).toBeLessThan(100)
    expect(Math.min(...pieces[1]!.points.map((p) => p[0]))).toBeGreaterThan(100)
    expect(eraseStrokeAt(stroke, { x: 100, y: 500 }, 12, new Set())).toBeNull()
    expect(eraseStrokeAt(stroke, { x: 100, y: 0 }, 500, new Set())).toEqual([])
  })

  test('eraseStrokes keeps the board valid and the same board when nothing is hit', () => {
    const board = boardOf([stroke])
    const next = valid(eraseStrokes(board, { x: 100, y: 0 }, 12))
    expect(next.elements.filter((e) => e.type === 'stroke')).toHaveLength(2)
    expect(eraseStrokes(board, { x: 100, y: 900 }, 12)).toBe(board)
  })
})

describe('recognising a sketch', () => {
  const along = (from: Point, to: Point, n: number) => Array.from({ length: n }, (_, i) => ({ x: from.x + ((to.x - from.x) * i) / n, y: from.y + ((to.y - from.y) * i) / n }))

  test('a drawn rectangle, ellipse and straight line; a scribble is nothing', () => {
    const rect = [
      ...along({ x: 0, y: 0 }, { x: 200, y: 0 }, 10),
      ...along({ x: 200, y: 0 }, { x: 200, y: 100 }, 10),
      ...along({ x: 200, y: 100 }, { x: 0, y: 100 }, 10),
      ...along({ x: 0, y: 100 }, { x: 0, y: 0 }, 10),
      { x: 0, y: 0 },
    ]
    expect(recognizeStroke(rect)).toEqual({ kind: 'rect', rect: { x: 0, y: 0, w: 200, h: 100 } })

    const ellipse = Array.from({ length: 41 }, (_, i) => {
      const t = (i / 40) * Math.PI * 2
      return { x: 100 + 100 * Math.cos(t), y: 60 + 60 * Math.sin(t) }
    })
    expect(recognizeStroke(ellipse)?.kind).toBe('ellipse')

    const line = along({ x: 0, y: 0 }, { x: 300, y: 40 }, 20)
    expect(recognizeStroke(line)).toMatchObject({ kind: 'arrow', from: { x: 0, y: 0 } })

    const scribble = Array.from({ length: 20 }, (_, i) => ({ x: i * 15, y: i % 2 ? 80 : 0 }))
    expect(recognizeStroke(scribble)).toBeNull()
    expect(recognizeStroke(line.slice(0, 3))).toBeNull()
  })
})

describe('shape search', () => {
  test('matches by name and by meaning', () => {
    expect(searchShapes('database')[0]).toBe('cylinder')
    expect(searchShapes('decision')[0]).toBe('diamond')
    expect(searchShapes('user')).toContain('person')
    expect(searchShapes('zzz')).toEqual([])
    expect(searchShapes('').length).toBeGreaterThan(10)
  })
})

describe('describeChange', () => {
  const before = boardOf([note('a', 0, 0, { text: 'Alpha' }), note('b', 400, 0, { text: 'Beta' })])

  test('add, remove, move, connect, edit', () => {
    expect(describeChange(before, before)).toBeNull()
    expect(describeChange(before, { ...before, elements: [...before.elements, note('c', 800, 0, { text: 'Gamma' })] })).toBe('Added "Gamma".')
    expect(describeChange(before, { ...before, elements: [before.elements[0]!] })).toBe('Removed "Beta".')
    expect(describeChange(before, { ...before, elements: [{ ...before.elements[0]!, x: 40 } as WhiteboardElement, before.elements[1]!] })).toBe('Moved "Alpha".')
    expect(describeChange(before, { ...before, elements: [...before.elements, arrow('ab', 'a', 'b')] })).toBe('Connected "Alpha" to "Beta".')
    expect(describeChange(before, { ...before, elements: [{ ...before.elements[0]!, text: 'Alef' } as WhiteboardElement, before.elements[1]!] })).toBe('Changed "Alef".')
  })
})

describe('table weights and merges', () => {
  const table: TableElement = {
    type: 'table',
    id: 't',
    x: 0,
    y: 0,
    w: 400,
    h: 120,
    rows: [
      ['a', 'b'],
      ['c', 'd'],
      ['e', 'f'],
    ],
  }

  test('tableCellRect follows colWidths [1, 3]', () => {
    const weighted = { ...table, colWidths: [1, 3] }
    expect(tableCellRect(weighted, 0, 0)).toEqual({ x: 0, y: 0, w: 100, h: 40 })
    expect(tableCellRect(weighted, 2, 1)).toEqual({ x: 100, y: 80, w: 300, h: 40 })
    expect(tableCellAt(weighted, { x: 120, y: 10 })).toEqual({ row: 0, col: 1 })
  })

  test('a colWidths list of the wrong length falls back to equal', () => {
    expect(tableShares([1, 2, 3], 2)).toEqual([0.5, 0.5])
    expect(tableCellRect({ ...table, colWidths: [1, 2, 3] }, 0, 1)).toEqual({ x: 200, y: 0, w: 200, h: 40 })
  })

  test('resizeTableTrack moves a border and keeps the neighbours', () => {
    const resized = resizeTableTrack(table, 'col', 0, 100)
    expect(tableCellRect(resized, 0, 0).w).toBeCloseTo(100, 5)
    expect(tableCellRect(resized, 0, 1).w).toBeCloseTo(300, 5)
    // Clamped so each keeps its minimum.
    expect(tableCellRect(resizeTableTrack(table, 'col', 0, -50), 0, 0).w).toBeCloseTo(24, 5)
    expect(resizeTableTrack(table, 'col', 1, 100)).toBe(table) // the last column has no border to move
  })

  test('insert and remove keep weights the right length and shift merges', () => {
    const weighted: TableElement = { ...table, colWidths: [1, 3], rowHeights: [1, 1, 2], merges: [{ row: 1, col: 0, rows: 2, cols: 1 }] }
    const rowIn = insertTableRow(weighted, 0)
    expect(rowIn.rowHeights).toHaveLength(4)
    expect(rowIn.merges).toEqual([{ row: 2, col: 0, rows: 2, cols: 1 }])
    // Inserting inside the region grows it.
    expect(insertTableRow(weighted, 2).merges).toEqual([{ row: 1, col: 0, rows: 3, cols: 1 }])
    const rowOut = removeTableRow(weighted, 1)
    expect(rowOut.rowHeights).toEqual([1, 2])
    expect(rowOut).not.toHaveProperty('merges') // the region shrank to one cell
    const colIn = insertTableColumn(weighted, 0)
    expect(colIn.colWidths).toHaveLength(3)
    expect(colIn.merges).toEqual([{ row: 1, col: 1, rows: 2, cols: 1 }])
    const colOut = removeTableColumn(weighted, 0)
    expect(colOut.colWidths).toEqual([3])
    expect(colOut).not.toHaveProperty('merges')
    // Removing a weighted row takes its own height off the table.
    expect(removeTableRow(weighted, 2).h).toBe(60)
    for (const next of [rowIn, rowOut, colIn, colOut]) valid(boardOf([next]))
  })

  test('mergeTableCells keeps every cell\'s text', () => {
    const merged = mergeTableCells(table, 0, 0, 2, 2)
    expect(merged.rows[0]![0]).toBe('a b c d')
    expect(merged.rows[1]).toEqual(['', ''])
    expect(tableMerges(merged)).toEqual([{ row: 0, col: 0, rows: 2, cols: 2 }])
    expect(tableCellRect(merged, 1, 1)).toEqual({ x: 0, y: 0, w: 400, h: 80 })
    expect(mergeTableCells(table, 0, 0, 1, 1)).toBe(table)
    expect(mergeTableCells(table, 2, 0, 2, 1)).toBe(table)
    valid(boardOf([merged]))
  })
})
