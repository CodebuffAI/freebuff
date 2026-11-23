import { describe, expect, test } from 'bun:test'

import { arrowGeometry, estimateMeasure, geometryContext, withSectionMembers } from './whiteboard-geometry'
import { copyFragment, deleteElements, describeSelection, moveElements, pasteFragment, updateElements } from './whiteboard-ops'
import {
  addVotes,
  applySectionNoteColors,
  attachStickers,
  boardOutline,
  candidateInDirection,
  clusterNotes,
  clusterNotesAsk,
  connectCandidates,
  cropFromTrims,
  cropImage,
  cropTrims,
  elementsInLasso,
  formatTimer,
  moveToIndex,
  pointInPolygon,
  setVotes,
  sortByVotes,
  stickersOn,
  summarizeBoardAsk,
  tallyVotes,
  timerRemaining,
  timerState,
  updateTimer,
} from './whiteboard-r4'
import { applyTemplate, TEMPLATE_IDS, templateBoard } from './whiteboard-templates'
import { parseBoard, WHITEBOARD_EXAMPLE, type ImageElement, type WhiteboardBoard, type WhiteboardElement } from './whiteboard'

function valid(board: WhiteboardBoard) {
  const result = parseBoard(board)
  if (!result.ok) throw new Error(result.errors.join('; '))
  return result.board
}

const byId = (board: WhiteboardBoard, id: string) => board.elements.find((e) => e.id === id)!
const ctxOf = (board: WhiteboardBoard) => geometryContext(board.elements, estimateMeasure)

const note = (id: string, x: number, y: number, extra: Partial<WhiteboardElement> = {}): WhiteboardElement =>
  ({ type: 'note', id, x, y, w: 200, h: 200, text: id, color: 'yellow', ...extra }) as WhiteboardElement

const board: WhiteboardBoard = {
  version: 1,
  title: 'Votes',
  elements: [
    { type: 'section', id: 'sec', x: 0, y: 0, w: 760, h: 288, title: 'Ideas', noteColor: 'green' },
    note('a', 40, 48),
    note('b', 280, 48, { votes: 3 } as Partial<WhiteboardElement>),
    note('c', 520, 48, { votes: 1 } as Partial<WhiteboardElement>),
    note('far', 2000, 2000),
    { type: 'sticker', id: 's1', x: 60, y: 60, w: 56, h: 56, sticker: 'star', attachedTo: 'a' },
    { type: 'sticker', id: 's2', x: 300, y: 60, w: 56, h: 56, sticker: 'heart' },
    { type: 'shape', id: 'clock', kind: 'rounded', x: 0, y: 400, w: 200, h: 96, color: 'gray', timer: { duration: 300 } },
    { type: 'arrow', id: 'ab', from: { elementId: 'a' }, to: { elementId: 'b' }, style: 'solid' },
  ],
}

describe('round-4 model', () => {
  test('pre-round-4 bodies parse unchanged', () => {
    expect(valid(WHITEBOARD_EXAMPLE)).toEqual(WHITEBOARD_EXAMPLE)
    for (const id of TEMPLATE_IDS.slice(0, 7)) {
      const old = templateBoard(id)
      expect(valid(old)).toEqual(old)
    }
  })

  test('the new optional fields parse; bad ones are refused', () => {
    const extra: WhiteboardBoard = {
      ...board,
      elements: [
        ...board.elements,
        { type: 'shape', id: 'p', kind: 'rect', x: 0, y: 600, w: 160, h: 80, color: 'blue', fill: '#ff8800', stroke: 'red' },
        { type: 'arrow', id: 'st', from: { x: 0, y: 0 }, to: { x: 50, y: 0 }, style: 'solid', routing: 'straight', head: 'start', stroke: '#123abc' },
        { type: 'image', id: 'img', x: 0, y: 800, w: 100, h: 50, src: 'https://example.com/a.png', alt: 'a', crop: { x: 0.1, y: 0, w: 0.5, h: 1 } },
      ],
    }
    expect(valid(extra)).toEqual(extra)
    const bad = (element: Record<string, unknown>) => parseBoard({ ...board, elements: [element] }).ok
    expect(bad({ type: 'note', id: 'n', x: 0, y: 0, w: 1, h: 1, text: '', color: 'yellow', fill: 'orange' })).toBe(false)
    expect(bad({ type: 'note', id: 'n', x: 0, y: 0, w: 1, h: 1, text: '', color: 'yellow', fill: '#ff88' })).toBe(false)
    expect(bad({ type: 'note', id: 'n', x: 0, y: 0, w: 1, h: 1, text: '', color: 'yellow', votes: -1 })).toBe(false)
    expect(bad({ type: 'image', id: 'i', x: 0, y: 0, w: 1, h: 1, src: 'https://e.com/a', alt: '', crop: { x: 0.6, y: 0, w: 0.6, h: 1 } })).toBe(false)
    expect(bad({ type: 'sticker', id: 's', x: 0, y: 0, w: 1, h: 1, sticker: 'star', attachedTo: 's' })).toBe(false)
    expect(bad({ type: 'shape', id: 's', kind: 'rect', x: 0, y: 0, w: 1, h: 1, color: 'blue', timer: { duration: 0 } })).toBe(false)
    // A sticker attached to an id the board lacks is simply free.
    expect(bad({ type: 'sticker', id: 's', x: 0, y: 0, w: 1, h: 1, sticker: 'star', attachedTo: 'gone' })).toBe(true)
  })

  test('updateElements keeps the new optional fields', () => {
    const next = updateElements(
      board,
      new Map<string, Partial<WhiteboardElement>>([
        ['a', { fill: '#00ff00', stroke: 'blue', votes: 2 } as Partial<WhiteboardElement>],
        ['clock', { timer: { duration: 60 } } as Partial<WhiteboardElement>],
      ]),
    )
    expect(byId(next, 'a')).toMatchObject({ fill: '#00ff00', stroke: 'blue', votes: 2 })
    expect(byId(next, 'clock')).toMatchObject({ timer: { duration: 60 } })
  })
})

describe('deleting, copying and moving with attachments', () => {
  test('deleting an element removes the arrows bound to it and frees its stickers', () => {
    const next = valid(deleteElements(board, ['a']))
    expect(next.elements.some((e) => e.id === 'ab')).toBe(false)
    expect(byId(next, 's1')).not.toHaveProperty('attachedTo')
  })

  test('an attached sticker moves and copies with its element', () => {
    expect(withSectionMembers(board.elements, ['a'], ctxOf(board))).toContain('s1')
    const moved = moveElements(board, ['a'], 10, 0)
    expect(byId(moved, 's1')).toMatchObject({ x: 70 })
    const fragment = copyFragment(board, ['a'])
    expect(fragment.map((e) => e.id).sort()).toEqual(['a', 's1'])
    const { board: pasted, ids } = pasteFragment(board, fragment, 0, 600)
    valid(pasted)
    const copy = pasted.elements.find((e) => ids.includes(e.id) && e.type === 'sticker')
    expect(copy?.type === 'sticker' && copy.attachedTo && ids.includes(copy.attachedTo)).toBe(true)
    // A sticker copied without its note comes unattached.
    expect(copyFragment(board, ['s1'])[0]).not.toHaveProperty('attachedTo')
  })

  test('attachStickers sticks a sticker to what it sits on and frees one in the open', () => {
    const next = attachStickers(board, ['s2'])
    expect(byId(next, 's2')).toMatchObject({ attachedTo: 'b' })
    const away = { ...board, elements: board.elements.map((e) => (e.id === 's1' ? { ...e, x: 5000 } : e)) } as WhiteboardBoard
    expect(byId(attachStickers(away, ['s1']), 's1')).not.toHaveProperty('attachedTo')
    expect(attachStickers(next, ['s2'])).toBe(next)
  })
})

describe('votes', () => {
  test('setVotes and addVotes clamp at 0 and clear the field', () => {
    expect(byId(setVotes(board, 'a', 4), 'a')).toMatchObject({ votes: 4 })
    expect(byId(addVotes(board, 'b', -10), 'b')).not.toHaveProperty('votes')
    expect(addVotes(board, 'clock', 1)).toBe(board)
  })

  test('tally counts attached and covering stickers', () => {
    const on = stickersOn(board)
    expect(on.get('a')).toEqual(['s1'])
    expect(on.get('b')).toEqual(['s2'])
    const next = tallyVotes(board)
    expect(byId(next, 'a')).toMatchObject({ votes: 1 })
    expect(byId(next, 'b')).toMatchObject({ votes: 1 })
    // c has no sticker and was not named: kept.
    expect(byId(next, 'c')).toMatchObject({ votes: 1 })
    expect(byId(tallyVotes(board, ['c']), 'c')).not.toHaveProperty('votes')
  })

  test('sortByVotes puts the most votes first in reading order; stickers follow', () => {
    const next = valid(sortByVotes(board, ['a', 'b', 'c']))
    expect(byId(next, 'b')).toMatchObject({ x: 40, y: 48 })
    expect(byId(next, 'c')).toMatchObject({ x: 280 })
    expect(byId(next, 'a')).toMatchObject({ x: 520 })
    expect(byId(next, 's1')).toMatchObject({ x: 540 })
    expect(sortByVotes(board, ['a'])).toBe(board)
  })
})

describe('clusters, section note colour, layers', () => {
  test('clusterNotes groups by section, then by proximity', () => {
    const extra = { ...board, elements: [...board.elements, note('far2', 2240, 2000), note('alone', 9000, 0)] }
    expect(clusterNotes(extra)).toEqual([['a', 'b', 'c'], ['far', 'far2']])
    expect(clusterNotes(extra, ['a', 'far'])).toEqual([])
  })

  test('notes in a section with a noteColor take it', () => {
    const next = applySectionNoteColors(board)
    expect(byId(next, 'a')).toMatchObject({ color: 'green' })
    expect(byId(next, 'far')).toMatchObject({ color: 'yellow' })
    expect(applySectionNoteColors(board, ['far'])).toBe(board)
    // After a move: only a note that arrives in the section changes colour.
    const moved = moveElements(board, ['far'], -1960, -1952)
    const after = applySectionNoteColors(moved, ['a', 'far'], board)
    expect(byId(after, 'far')).toMatchObject({ color: 'green' })
    expect(byId(after, 'a')).toMatchObject({ color: 'yellow' })
  })

  test('moveToIndex places one element exactly', () => {
    const next = moveToIndex(board, 'ab', 0)
    expect(next.elements[0].id).toBe('ab')
    expect(moveToIndex(board, 'sec', -5)).toBe(board)
    expect(moveToIndex(board, 'sec', 99).elements.at(-1)!.id).toBe('sec')
  })
})

describe('timer', () => {
  const clock = (b: WhiteboardBoard) => byId(b, 'clock') as Extract<WhiteboardElement, { type: 'shape' }>

  test('start, pause, resume, reset', () => {
    const started = updateTimer(board, 'clock', 'start', 1_000)
    expect(timerState(clock(started), 61_000)).toBe('running')
    expect(timerRemaining(clock(started), 61_000)).toBe(240)
    const paused = updateTimer(started, 'clock', 'pause', 61_000)
    expect(clock(paused).timer).toEqual({ duration: 300, elapsed: 60 })
    expect(timerState(clock(paused), 999_999)).toBe('paused')
    const resumed = updateTimer(paused, 'clock', 'start', 100_000)
    expect(timerRemaining(clock(resumed), 110_000)).toBe(230)
    expect(timerState(clock(resumed), 10_000_000)).toBe('done')
    expect(clock(updateTimer(resumed, 'clock', 'reset', 0)).timer).toEqual({ duration: 300 })
    expect(clock(updateTimer(board, 'clock', null, 0, 90)).timer).toEqual({ duration: 90 })
    valid(resumed)
  })

  test('formatTimer', () => {
    expect(formatTimer(0)).toBe('0:00')
    expect(formatTimer(59.2)).toBe('1:00')
    expect(formatTimer(3723)).toBe('1:02:03')
  })
})

describe('image crop', () => {
  const image: ImageElement = { type: 'image', id: 'i', x: 100, y: 100, w: 400, h: 200, src: 'https://e.com/a.png', alt: '' }

  test('trimming keeps the picture where it was and in scale; uncropping restores it', () => {
    const cropped = cropImage(image, { x: 0.25, y: 0, w: 0.5, h: 1 })
    expect(cropped).toMatchObject({ x: 200, y: 100, w: 200, h: 200, crop: { x: 0.25, y: 0, w: 0.5, h: 1 } })
    const back = cropImage(cropped, { x: 0, y: 0, w: 1, h: 1 })
    expect(back).toEqual(image)
  })

  test('trims in percent round-trip and never crop away everything', () => {
    expect(cropTrims({ x: 0.1, y: 0.2, w: 0.7, h: 0.5 })).toEqual({ left: 10, top: 20, right: 20, bottom: 30 })
    const crop = cropFromTrims({ left: 80, right: 80, top: 0, bottom: 0 })
    expect(crop.w).toBeGreaterThanOrEqual(0.05 - 1e-9)
  })
})

describe('lasso, keyboard connect, outline, asks', () => {
  test('pointInPolygon and elementsInLasso', () => {
    const square = [
      { x: 0, y: 0 },
      { x: 600, y: 0 },
      { x: 600, y: 300 },
      { x: 0, y: 300 },
    ]
    expect(pointInPolygon({ x: 10, y: 10 }, square)).toBe(true)
    expect(pointInPolygon({ x: 700, y: 10 }, square)).toBe(false)
    const picked = elementsInLasso(board.elements, square, ctxOf(board))
    expect(picked).toContain('a')
    expect(picked).toContain('b')
    expect(picked).not.toContain('c')
    expect(picked).not.toContain('sec')
  })

  test('connect candidates are nearest first; a direction picks the nearest that way', () => {
    const list = connectCandidates(board, 'a')
    expect(list[0]).toBe('b')
    expect(list).not.toContain('s1')
    expect(candidateInDirection(board, 'a', list, 'right')).toBe('b')
    expect(candidateInDirection(board, 'a', list, 'down')).toBe('clock')
    expect(candidateInDirection(board, 'a', list, 'left')).toBeNull()
  })

  test('the outline lists sections with their members, then the rest and the arrows', () => {
    const outline = boardOutline(board)
    expect(outline[0]).toMatchObject({ id: 'sec', title: 'Ideas' })
    expect(outline[0].items.map((i) => i.id)).toEqual(expect.arrayContaining(['a', 'b', 'c']))
    expect(outline.at(-1)!.title).toBe('Connections')
    expect(outline.at(-1)!.items[0].label).toBe('a → b')
  })

  test('board asks quote elements with their ids', () => {
    const summary = summarizeBoardAsk(board)
    expect(summary.text).toContain('[a] note: “a”')
    expect(summary.elementIds).toContain('clock')
    const clusters = clusterNotesAsk(board, ['a', 'b'])
    expect(clusters.elementIds).toEqual(['a', 'b'])
    expect(clusters.text).toContain('[b] note: “b” (3 votes)')
  })

  test('a big board’s ask stays under the chat quote limit and names the rest by id', () => {
    const big: WhiteboardBoard = { ...board, elements: Array.from({ length: 300 }, (_, i) => note(`note-${i}`, i * 240, 0)) }
    const ask = summarizeBoardAsk(big)
    expect(ask.text.length).toBeLessThan(4000)
    expect(ask.text).toContain('more: note-')
    expect(ask.elementIds).toHaveLength(300)
  })

  test('describeSelection names each element by id', () => {
    expect(describeSelection(board, ['b'], { withIds: true })).toContain('(yellow, 3 votes) [id b]')
    expect(describeSelection(board, ['b'])).not.toContain('[id b]')
  })
})

describe('straight connectors and new templates', () => {
  test('a straight connector is one segment', () => {
    const arrow = { type: 'arrow', id: 'x', from: { x: 0, y: 0 }, to: { x: 100, y: 0 }, style: 'solid', routing: 'straight' } as const
    const g = arrowGeometry(arrow, geometryContext([arrow], estimateMeasure))
    expect(g.path).toBe('M0 0 L100 0')
    expect(g.points).toHaveLength(2)
    expect(g.mid).toEqual({ x: 50, y: 0 })
  })

  test('the round-4 templates apply on a full board', () => {
    for (const id of ['swot', 'mind-map', 'roadmap', 'dot-voting'] as const) {
      const { board: next, ids } = applyTemplate(board, id)
      valid(next)
      expect(ids.length).toBeGreaterThan(3)
    }
  })
})
