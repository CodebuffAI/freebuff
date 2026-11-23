import { describe, expect, test } from 'bun:test'

import { presentationFrames } from './whiteboard-arrange'
import { elementBounds, estimateMeasure, geometryContext, sectionMembers } from './whiteboard-geometry'
import { applyTemplate, TEMPLATE_IDS, templateBoard } from './whiteboard-templates'
import { parseBoard, type WhiteboardBoard } from './whiteboard'

function valid(board: WhiteboardBoard) {
  const result = parseBoard(board)
  if (!result.ok) throw new Error(result.errors.join('; '))
}

describe('templates', () => {
  for (const id of TEMPLATE_IDS) {
    test(`${id}: valid, nothing overlaps, members sit inside their section`, () => {
      const board = templateBoard(id)
      valid(board)
      const ctx = geometryContext(board.elements, estimateMeasure)
      const solid = board.elements.filter((e) => e.type !== 'arrow' && e.type !== 'section')
      for (let i = 0; i < solid.length; i++)
        for (let j = i + 1; j < solid.length; j++) {
          const a = elementBounds(solid[i], ctx)
          const b = elementBounds(solid[j], ctx)
          const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
          if (overlap) throw new Error(`${id}: ${solid[i].id} overlaps ${solid[j].id}`)
        }
      const sections = board.elements.filter((e) => e.type === 'section')
      for (const section of sections) {
        if (section.type !== 'section') continue
        // Sections come before their members, so they draw underneath.
        const at = board.elements.indexOf(section)
        for (const member of sectionMembers(board.elements, section, ctx)) {
          expect(board.elements.findIndex((e) => e.id === member)).toBeGreaterThan(at)
        }
      }
      // Sections never overlap each other (they are frames to present).
      for (let i = 0; i < sections.length; i++)
        for (let j = i + 1; j < sections.length; j++) {
          const a = elementBounds(sections[i], ctx)
          const b = elementBounds(sections[j], ctx)
          expect(a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h).toBe(false)
        }
    })
  }

  test('on an empty untitled board: readable ids and the template title', () => {
    const { board, ids } = applyTemplate({ version: 1, title: 'Untitled whiteboard', elements: [] }, 'kanban')
    valid(board)
    expect(board.title).toBe('Kanban')
    expect(ids).toContain('todo')
  })

  test('twice on one board: fresh ids, arrows re-pointed, placed below', () => {
    const first = applyTemplate({ version: 1, title: 'Plan', elements: [] }, 'flowchart').board
    expect(first.title).toBe('Plan')
    const { board, ids } = applyTemplate(first, 'flowchart')
    valid(board)
    expect(board.elements).toHaveLength(first.elements.length * 2)
    const added = board.elements.filter((e) => ids.includes(e.id))
    const firstBottom = Math.max(...first.elements.map((e) => ('y' in e ? e.y + ('h' in e ? e.h : 0) : 0)))
    for (const e of added) if ('y' in e) expect(e.y).toBeGreaterThan(firstBottom)
    for (const e of added) {
      if (e.type !== 'arrow') continue
      for (const end of [e.from, e.to]) if ('elementId' in end) expect(ids).toContain(end.elementId)
    }
  })
})

describe('presentation frames', () => {
  test('top-level sections in reading order; nested sections are not frames', () => {
    const board = templateBoard('matrix')
    const frames = presentationFrames(board, geometryContext(board.elements))
    expect(frames.map((f) => f.id)).toEqual(['quick-wins', 'big-bets', 'fill-ins', 'time-sinks'])
    const nested: WhiteboardBoard = {
      ...board,
      elements: [...board.elements, { type: 'section', id: 'inner', x: 100, y: 200, w: 100, h: 100, title: 'Inner' }],
    }
    expect(presentationFrames(nested, geometryContext(nested.elements)).map((f) => f.id)).not.toContain('inner')
  })

  test('no sections: one frame of everything; empty board: none', () => {
    const board = templateBoard('flowchart')
    const frames = presentationFrames(board, geometryContext(board.elements))
    expect(frames).toHaveLength(1)
    expect(frames[0].id).toBeNull()
    expect(presentationFrames({ version: 1, title: '', elements: [] }, geometryContext([]))).toEqual([])
  })
})
