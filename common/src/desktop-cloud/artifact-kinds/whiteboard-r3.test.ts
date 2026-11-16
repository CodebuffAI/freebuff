import { describe, expect, test } from 'bun:test'

import {
  arrowGeometry,
  contentBounds,
  elbowRoute,
  elementBounds,
  estimateMeasure,
  geometryContext,
  inflate,
  resolveEnd,
  shapeTextBox,
} from './whiteboard-geometry'
import { tidyElements } from './whiteboard-layout'
import { ROUTE_MARGIN, routeOrthogonal, segmentCrossesRect } from './whiteboard-route'
import { applyTemplate } from './whiteboard-templates'
import {
  parseBoard,
  SHAPE_DEFAULT_SIZE,
  SHAPE_KINDS,
  type ArrowElement,
  type Point,
  type Rect,
  type ShapeKind,
  type WhiteboardBoard,
  type WhiteboardElement,
} from './whiteboard'

function valid(board: WhiteboardBoard): WhiteboardBoard {
  const result = parseBoard(board)
  if (!result.ok) throw new Error(result.errors.join('; '))
  return result.board
}

const box = (id: string, x: number, y: number, w = 160, h = 80, kind: ShapeKind = 'rect'): WhiteboardElement => ({
  type: 'shape',
  id,
  kind,
  x,
  y,
  w,
  h,
  text: id,
  color: 'blue',
})
const elbow = (id: string, from: string, to: string, extra: Partial<ArrowElement> = {}): ArrowElement => ({
  type: 'arrow',
  id,
  from: { elementId: from },
  to: { elementId: to },
  style: 'solid',
  routing: 'elbow',
  ...extra,
})

/** No segment of `points` passes through any of `rects` (touching an edge is fine). */
function clear(points: readonly Point[], rects: readonly Rect[]) {
  for (let i = 1; i < points.length; i++)
    for (const r of rects) if (segmentCrossesRect(points[i - 1], points[i], r)) return false
  return true
}
const rightAngled = (points: readonly Point[]) =>
  points.every((p, i) => i === 0 || p.x === points[i - 1].x || p.y === points[i - 1].y)

describe('a board stored before round 3', () => {
  // A body written by the round-2 editor: every element type, groups, locks, elbows with bends.
  const before = {
    version: 1,
    title: 'Before',
    elements: [
      { type: 'section', id: 's', x: 0, y: 0, w: 600, h: 400, title: 'Team', color: 'gray' },
      { type: 'note', id: 'n', x: 40, y: 48, w: 200, h: 200, text: '**Go**', color: 'yellow', fontSize: 'm', groups: ['g1'] },
      { type: 'shape', id: 'c', kind: 'cylinder', x: 300, y: 48, w: 120, h: 120, text: 'DB', color: 'blue', locked: true },
      { type: 'text', id: 't', x: 0, y: -60, text: 'Title', size: 'xl' },
      { type: 'arrow', id: 'a', from: { elementId: 'n' }, to: { elementId: 'c' }, style: 'solid', routing: 'elbow', bend: 12, labelAt: 0.4 },
      { type: 'stroke', id: 'k', points: [[0, 0], [10, 10]], color: 'red', width: 4 },
      { type: 'sticker', id: 'st', x: 200, y: 40, w: 56, h: 56, sticker: 'star' },
      { type: 'table', id: 'tb', x: 0, y: 500, w: 280, h: 80, rows: [['a', 'b'], ['c', 'd']], header: true },
      { type: 'link', id: 'l', x: 400, y: 500, w: 280, h: 96, url: 'https://example.com', title: 'Example' },
      { type: 'image', id: 'i', x: 700, y: 0, w: 100, h: 100, src: '/_blob/abc', alt: 'pic' },
    ],
  }

  test('still parses, unchanged', () => {
    const result = parseBoard(JSON.stringify(before))
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.board).toEqual(before as WhiteboardBoard)
  })

  test('its hand-bent elbow keeps the plain route', () => {
    const board = valid(before as WhiteboardBoard)
    const ctx = geometryContext(board.elements, estimateMeasure)
    const arrow = board.elements.find((e) => e.id === 'a') as ArrowElement
    const plain = elbowRoute(resolveEnd(arrow.from, arrow.to, ctx), resolveEnd(arrow.to, arrow.from, ctx), 12)
    expect(arrowGeometry(arrow, ctx).points).toEqual(plain.points)
  })
})

describe('new shape kinds', () => {
  test('every kind parses, has a default size and a text box inside its own box', () => {
    for (const kind of SHAPE_KINDS) {
      const size = SHAPE_DEFAULT_SIZE[kind]
      const shape = { type: 'shape' as const, id: `s-${kind}`, kind, x: 0, y: 0, ...size, text: kind, color: 'blue' as const }
      valid({ version: 1, title: kind, elements: [shape] })
      const inner = shapeTextBox(kind, shape)
      expect(inner.x).toBeGreaterThanOrEqual(0)
      expect(inner.y).toBeGreaterThanOrEqual(0)
      expect(inner.x + inner.w).toBeLessThanOrEqual(size.w)
      expect(inner.y + inner.h).toBeLessThanOrEqual(size.h)
    }
  })

  test('an unknown kind is still refused', () => {
    expect(parseBoard({ version: 1, title: 'x', elements: [{ ...box('a', 0, 0), kind: 'star' }] }).ok).toBe(false)
  })
})

describe('routeOrthogonal', () => {
  test('a clear straight run stays straight', () => {
    expect(routeOrthogonal({ point: { x: 0, y: 0 }, side: 'right' }, { point: { x: 300, y: 0 }, side: 'left' }, [])).toEqual([
      { x: 0, y: 0 },
      { x: 300, y: 0 },
    ])
  })

  test('goes round a box in the way, keeping the margin, leaving and arriving the right way', () => {
    const wall = { x: 100, y: -60, w: 80, h: 120 }
    const route = routeOrthogonal({ point: { x: 0, y: 0 }, side: 'right' }, { point: { x: 300, y: 0 }, side: 'left' }, [wall])!
    expect(route).not.toBeNull()
    expect(rightAngled(route)).toBe(true)
    expect(clear(route, [inflate(wall, ROUTE_MARGIN - 1)])).toBe(true)
    // Leaves heading right, arrives heading right (into the left side).
    expect(route[1].y).toBe(0)
    expect(route[1].x).toBeGreaterThan(0)
    expect(route[route.length - 2].y).toBe(0)
    expect(route[route.length - 2].x).toBeLessThan(300)
    expect(route.length).toBe(6) // two detours: out, round, back
  })

  test('fully walled in: null, so the caller keeps the plain elbow', () => {
    const walls = [
      { x: -100, y: -100, w: 200, h: 20 },
      { x: -100, y: 80, w: 200, h: 20 },
      { x: -100, y: -100, w: 20, h: 200 },
      { x: 80, y: -100, w: 20, h: 200 },
    ]
    expect(routeOrthogonal({ point: { x: 0, y: 0 } }, { point: { x: 400, y: 0 } }, walls)).toBeNull()
  })

  test('an obstacle holding an end is ignored rather than trapping it', () => {
    const route = routeOrthogonal({ point: { x: 0, y: 0 } }, { point: { x: 300, y: 0 } }, [{ x: -20, y: -20, w: 40, h: 40 }])
    expect(route).not.toBeNull()
  })
})

describe('elbow arrows route round boxes', () => {
  const board = valid({
    version: 1,
    title: 'Route',
    elements: [box('a', 0, 0), box('block', 240, -20, 160, 120), box('b', 480, 0), elbow('e', 'a', 'b')],
  })
  const ctx = geometryContext(board.elements, estimateMeasure)
  const arrow = board.elements[3] as ArrowElement

  test('an obstructed elbow avoids every box, its ends still on the bound sides', () => {
    const g = arrowGeometry(arrow, ctx)
    expect(g.points).toBeDefined()
    const points = g.points!
    expect(rightAngled(points)).toBe(true)
    const rects = board.elements.filter((e) => e.type === 'shape').map((e) => elementBounds(e, ctx))
    expect(clear(points, rects)).toBe(true)
    expect(points[0]).toEqual({ x: 160, y: 40 })
    expect(points[points.length - 1]).toEqual({ x: 480, y: 40 })
    // Its label still sits on the route and its bounds hold every corner.
    const bounds = elementBounds(arrow, ctx)
    for (const p of points) expect(p.y).toBeGreaterThanOrEqual(bounds.y)
  })

  test('an unobstructed elbow is exactly the plain route', () => {
    const open = valid({ ...board, elements: [box('a', 0, 0), box('b', 480, 100), elbow('e', 'a', 'b')] })
    const openCtx = geometryContext(open.elements, estimateMeasure)
    const e = open.elements[2] as ArrowElement
    const plain = elbowRoute(resolveEnd(e.from, e.to, openCtx), resolveEnd(e.to, e.from, openCtx))
    expect(arrowGeometry(e, openCtx).points).toEqual(plain.points)
    expect(arrowGeometry(e, openCtx).bendHandle).toBeDefined()
  })

  test('a hand-set bend turns routing off', () => {
    const bent = { ...arrow, bend: 0 }
    const plain = elbowRoute(resolveEnd(bent.from, bent.to, ctx), resolveEnd(bent.to, bent.from, ctx), 0)
    expect(arrowGeometry(bent, ctx).points).toEqual(plain.points)
  })

  test('a curved arrow is untouched by obstacles', () => {
    const curved = { ...arrow, routing: undefined }
    delete curved.routing
    expect(arrowGeometry(curved, ctx).points).toBeUndefined()
  })

  test('sections are not obstacles', () => {
    const withSection = valid({
      ...board,
      elements: [
        { type: 'section', id: 's', x: -40, y: -60, w: 760, h: 200, title: 'S' },
        box('a', 0, 0),
        box('b', 480, 0),
        elbow('e', 'a', 'b'),
      ],
    })
    const c = geometryContext(withSection.elements, estimateMeasure)
    const e = withSection.elements[3] as ArrowElement
    const plain = elbowRoute(resolveEnd(e.from, e.to, c), resolveEnd(e.to, e.from, c))
    expect(arrowGeometry(e, c).points).toEqual(plain.points)
  })
})

describe('tidyElements', () => {
  const ids = (board: WhiteboardBoard) => board.elements.map((e) => e.id)
  const at = (board: WhiteboardBoard, id: string) => {
    const e = board.elements.find((el) => el.id === id)!
    return elementBounds(e, geometryContext(board.elements, estimateMeasure))
  }
  const noOverlap = (board: WhiteboardBoard, which: readonly string[]) => {
    const rects = which.map((id) => at(board, id))
    for (let i = 0; i < rects.length; i++)
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i]
        const b = rects[j]
        expect(a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h).toBe(false)
      }
  }
  const scattered = valid({
    version: 1,
    title: 'Mess',
    elements: [box('a', 13, 7), box('b', 600, 300), box('c', 90, 500), box('d', 410, 40), box('e', 1000, 900)],
  })

  test('grid: a near-square grid from the top-left on the 8 grid, nothing overlapping', () => {
    const next = valid(tidyElements(scattered, ids(scattered), 'grid', geometryContext(scattered.elements, estimateMeasure)))
    noOverlap(next, ids(scattered))
    for (const id of ids(scattered)) {
      const r = at(next, id)
      expect(r.x % 8).toBe(0)
      expect(r.y % 8).toBe(0)
    }
    expect(at(next, 'a')).toMatchObject({ x: 16, y: 8 })
    // 5 units: 3 columns, reading order a, d, b / c, e.
    expect(at(next, 'd').x).toBe(at(next, 'a').x + 200)
    expect(at(next, 'c').y).toBe(at(next, 'a').y + 120)
  })

  test('tree: a root on top, children a rank below, centred under it; a cycle does not hang', () => {
    const tree = valid({
      version: 1,
      title: 'Tree',
      elements: [
        box('root', 500, 500),
        box('l', 0, 0),
        box('r', 900, 0),
        box('ll', 300, 900),
        elbow('x1', 'root', 'l'),
        elbow('x2', 'root', 'r'),
        elbow('x3', 'l', 'll'),
        elbow('back', 'll', 'root'), // closes a cycle
      ],
    })
    const next = valid(tidyElements(tree, ['root', 'l', 'r', 'll'], 'tree', geometryContext(tree.elements, estimateMeasure)))
    const root = at(next, 'root')
    const l = at(next, 'l')
    const r = at(next, 'r')
    const ll = at(next, 'll')
    expect(l.y).toBe(root.y + 80 + 80)
    expect(r.y).toBe(l.y)
    expect(ll.y).toBe(l.y + 160)
    expect(l.x).toBeLessThan(r.x)
    expect(Math.abs(root.x + root.w / 2 - (l.x + (r.x + r.w)) / 2)).toBeLessThanOrEqual(8)
    noOverlap(next, ['root', 'l', 'r', 'll'])
    // The arrows are untouched (bound ends follow).
    expect(next.elements.filter((e) => e.type === 'arrow')).toEqual(tree.elements.filter((e) => e.type === 'arrow'))
  })

  test('flow: ranks left to right by the longest chain, a back edge ignored', () => {
    const flow = valid({
      version: 1,
      title: 'Flow',
      elements: [
        box('start', 900, 900),
        box('form', 0, 0),
        box('valid', 300, 600, 160, 120, 'diamond'),
        box('done', 40, 300),
        box('lonely', 700, 50),
        elbow('a1', 'start', 'form'),
        elbow('a2', 'form', 'valid'),
        elbow('a3', 'valid', 'done'),
        elbow('a4', 'valid', 'form'), // back edge
        elbow('a5', 'start', 'done'),
      ],
    })
    const chosen = ['start', 'form', 'valid', 'done', 'lonely']
    const next = valid(tidyElements(flow, chosen, 'flow', geometryContext(flow.elements, estimateMeasure)))
    const x = (id: string) => at(next, id).x
    expect(x('start')).toBeLessThan(x('form'))
    expect(x('form')).toBeLessThan(x('valid'))
    expect(x('valid')).toBeLessThan(x('done'))
    expect(x('form') - x('start')).toBe(160 + 80)
    // An element with no arrows is a source: rank 0, beside start.
    expect(x('lonely')).toBe(x('start'))
    noOverlap(next, chosen)
  })

  test('locked elements stay, groups move as one, a section brings its members', () => {
    const board = valid({
      version: 1,
      title: 'Mixed',
      elements: [
        { type: 'section', id: 'sec', x: 1000, y: 1000, w: 400, h: 300, title: 'S' },
        box('inside', 1040, 1060),
        { ...box('g1', 0, 0), groups: ['g'] },
        { ...box('g2', 0, 120), groups: ['g'] },
        { ...box('lock', 500, 500), locked: true },
        box('free', 700, 0),
      ],
    })
    const ctx = geometryContext(board.elements, estimateMeasure)
    const next = valid(tidyElements(board, ['sec', 'inside', 'g1', 'g2', 'lock', 'free'], 'grid', ctx))
    expect(at(next, 'lock')).toEqual(at(board, 'lock'))
    expect(at(next, 'g2').y - at(next, 'g1').y).toBe(120)
    expect(at(next, 'g2').x).toBe(at(next, 'g1').x)
    const sec = at(next, 'sec')
    expect(at(next, 'inside').x - sec.x).toBe(40)
    expect(at(next, 'inside').y - sec.y).toBe(60)
  })

  test('fewer than two units, or already tidy: the same board', () => {
    const ctx = geometryContext(scattered.elements, estimateMeasure)
    expect(tidyElements(scattered, ['a'], 'grid', ctx)).toBe(scattered)
    const once = tidyElements(scattered, ids(scattered), 'grid', ctx)
    expect(tidyElements(once, ids(once), 'grid', geometryContext(once.elements, estimateMeasure))).toBe(once)
  })
})

describe('swimlanes template', () => {
  test('lanes are edge to edge and every step sits in a lane', () => {
    const { board } = applyTemplate({ version: 1, title: 'Untitled whiteboard', elements: [] }, 'swimlanes')
    valid(board)
    expect(board.title).toBe('Swimlanes')
    const lanes = board.elements.filter((e) => e.type === 'section')
    expect(lanes.length).toBe(3)
    lanes.forEach((lane, i) => {
      if (i === 0 || lane.type !== 'section') return
      const prev = lanes[i - 1]
      if (prev.type === 'section') expect(lane.y).toBe(prev.y + prev.h)
    })
  })
})

describe('a busy board stays cheap to draw', () => {
  // The page redraws every arrow on every frame of a drag: a full board (the 800-element cap,
  // 200 elbow arrows threading a 600-box grid) must route in well under a frame budget per pass
  // once warm. Measured on an M-series laptop: about 15 ms cold, 3 ms warm. The bound is loose
  // because other work shares the machine; it catches an accidental O(n²), not a regression of 2×.
  test('800 elements, 200 obstructed elbows', () => {
    const elements: WhiteboardElement[] = []
    for (let i = 0; i < 600; i++) elements.push(box(`b${i}`, (i % 30) * 240, Math.floor(i / 30) * 160))
    for (let i = 0; i < 200; i++) {
      const from = (i * 7) % 600
      const to = (from + 2 + (i % 3) * 30) % 600 // skip a column or a row: something is in the way
      elements.push(elbow(`e${i}`, `b${from}`, `b${to}`))
    }
    const board = valid({ version: 1, title: 'Busy', elements })
    const pass = () => {
      const ctx = geometryContext(board.elements, estimateMeasure)
      for (const e of board.elements) if (e.type === 'arrow') arrowGeometry(e, ctx)
      return contentBounds(board.elements, ctx)
    }
    pass()
    const started = performance.now()
    pass()
    expect(performance.now() - started).toBeLessThan(250)
  })
})
