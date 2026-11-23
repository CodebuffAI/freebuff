/**
 * Whiteboard geometry: bounds, hit testing, arrow anchoring and routing, section containment,
 * marquee selection, resizing, text layout, stroke simplification and viewport maths.
 * Pure: no DOM. Text width comes from an injected `measure` (a canvas in the browser, an
 * estimate in tests), so wrapping is the same wherever it is computed.
 */

import {
  isBoundEnd,
  isBoxElement,
  LINE_HEIGHT,
  TEXT_SIZE_PX,
  type ArrowElement,
  type ArrowEnd,
  type Point,
  type Rect,
  type SectionElement,
  type Side,
  type TextElement,
  type Viewport,
  type WhiteboardElement,
} from './whiteboard'
import { MAX_ROUTE_OBSTACLES, routeOrthogonal, segmentCrossesRect } from './whiteboard-route'

/** Width of `text` at `fontSize`, in world units. */
export type Measure = (text: string, fontSize: number) => number

/** A system sans averages a little over half an em per character. */
export const estimateMeasure: Measure = (text, fontSize) => text.length * fontSize * 0.56

export type GeometryContext = {
  byId: ReadonlyMap<string, WhiteboardElement>
  measure: Measure
}

export function geometryContext(
  elements: readonly WhiteboardElement[],
  measure: Measure = estimateMeasure,
): GeometryContext {
  return { byId: new Map(elements.map((element) => [element.id, element])), measure }
}

// ---- rects and points

export function rectFromPoints(a: Point, b: Point): Rect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) }
}

export function unionRects(rects: readonly Rect[]): Rect | null {
  if (rects.length === 0) return null
  let x1 = Infinity
  let y1 = Infinity
  let x2 = -Infinity
  let y2 = -Infinity
  for (const r of rects) {
    x1 = Math.min(x1, r.x)
    y1 = Math.min(y1, r.y)
    x2 = Math.max(x2, r.x + r.w)
    y2 = Math.max(y2, r.y + r.h)
  }
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 }
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h
}

export function rectContains(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.w <= outer.x + outer.w &&
    inner.y + inner.h <= outer.y + outer.h
  )
}

export function pointInRect(p: Point, r: Rect, pad = 0): boolean {
  return p.x >= r.x - pad && p.x <= r.x + r.w + pad && p.y >= r.y - pad && p.y <= r.y + r.h + pad
}

export function inflate(r: Rect, by: number): Rect {
  return { x: r.x - by, y: r.y - by, w: r.w + 2 * by, h: r.h + 2 * by }
}

export function center(r: Rect): Point {
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 }
}

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y)

export function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const lengthSq = dx * dx + dy * dy
  if (lengthSq === 0) return dist(p, a)
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq))
  return dist(p, { x: a.x + t * dx, y: a.y + t * dy })
}

export function distanceToPolyline(p: Point, points: readonly Point[]): number {
  if (points.length === 1) return dist(p, points[0])
  let best = Infinity
  for (let i = 1; i < points.length; i++) best = Math.min(best, distanceToSegment(p, points[i - 1], points[i]))
  return best
}

// ---- text layout

/** Breaks `text` into lines no wider than `maxWidth` (words longer than a line are split). */
export function wrapText(text: string, fontSize: number, maxWidth: number | undefined, measure: Measure): string[] {
  const out: string[] = []
  for (const paragraph of text.split('\n')) {
    if (maxWidth === undefined || maxWidth <= 0) {
      out.push(paragraph)
      continue
    }
    const words = paragraph.split(/\s+/).filter(Boolean)
    if (words.length === 0) {
      out.push('')
      continue
    }
    let line = ''
    for (let word of words) {
      const candidate = line ? `${line} ${word}` : word
      if (measure(candidate, fontSize) <= maxWidth) {
        line = candidate
        continue
      }
      if (line) out.push(line)
      // A word wider than the line is cut into pieces that fit.
      while (measure(word, fontSize) > maxWidth && word.length > 1) {
        let cut = word.length - 1
        while (cut > 1 && measure(word.slice(0, cut), fontSize) > maxWidth) cut--
        out.push(word.slice(0, cut))
        word = word.slice(cut)
      }
      line = word
    }
    out.push(line)
  }
  return out
}

export type TextBlock = { lines: string[]; fontSize: number; lineHeight: number }

export const NOTE_PADDING = 16
export const SHAPE_PADDING = 12
const NOTE_FONT_STEPS = [22, 18, 16, 14, 12, 10]

/** The largest font that fits `text` in the box; the smallest step overflows (clipped) if not. */
export function fitTextInBox(
  text: string,
  width: number,
  height: number,
  measure: Measure,
  steps: readonly number[] = NOTE_FONT_STEPS,
): TextBlock {
  for (const fontSize of steps) {
    const lines = wrapText(text, fontSize, width, measure)
    const lineHeight = fontSize * LINE_HEIGHT
    if (lines.length * lineHeight <= height) return { lines, fontSize, lineHeight }
  }
  const fontSize = steps[steps.length - 1]
  return { lines: wrapText(text, fontSize, width, measure), fontSize, lineHeight: fontSize * LINE_HEIGHT }
}

/** The inner box a shape's label wraps in (narrower for diamonds, hexagons and the like). */
export function shapeTextBox(kind: string, r: Rect): Rect {
  if (kind === 'person') {
    // The label sits in the band under the figure.
    const band = Math.max(20, r.h * 0.3)
    return { x: r.x + 2, y: r.y + r.h - band, w: Math.max(1, r.w - 4), h: Math.max(1, band) }
  }
  if (kind === 'triangle') {
    // The widest part: the lower half, inset where the sides close in.
    return {
      x: r.x + r.w * 0.22 + SHAPE_PADDING / 2,
      y: r.y + r.h * 0.45,
      w: Math.max(1, r.w * 0.56 - SHAPE_PADDING),
      h: Math.max(1, r.h * 0.55 - SHAPE_PADDING / 2),
    }
  }
  const inset =
    kind === 'diamond' ? { x: r.w * 0.22, y: r.h * 0.22 }
    : kind === 'hexagon' || kind === 'parallelogram' ? { x: r.w * 0.16, y: 0 }
    : kind === 'ellipse' ? { x: r.w * 0.12, y: r.h * 0.12 }
    : kind === 'cylinder' ? { x: 0, y: Math.min(r.h * 0.18, 24) }
    : kind === 'pill' ? { x: Math.min(r.h / 2, r.w / 4), y: 0 }
    : kind === 'document' ? { x: 0, y: Math.min(r.h * 0.12, 14) }
    : kind === 'subroutine' ? { x: Math.min(r.w * 0.1, 14), y: 0 }
    : kind === 'queue' ? { x: Math.min(r.w * 0.14, 20) * 1.5, y: 0 }
    : kind === 'cloud' ? { x: r.w * 0.16, y: r.h * 0.2 }
    : { x: 0, y: 0 }
  return {
    x: r.x + inset.x + SHAPE_PADDING,
    y: r.y + inset.y + SHAPE_PADDING,
    w: Math.max(1, r.w - 2 * (inset.x + SHAPE_PADDING)),
    h: Math.max(1, r.h - 2 * (inset.y + SHAPE_PADDING)),
  }
}

export function textBlock(element: TextElement, measure: Measure): TextBlock {
  const fontSize = TEXT_SIZE_PX[element.size]
  return { lines: wrapText(element.text || ' ', fontSize, element.w, measure), fontSize, lineHeight: fontSize * LINE_HEIGHT }
}

// ---- bounds

export function textBounds(element: TextElement, measure: Measure): Rect {
  const block = textBlock(element, measure)
  const width = element.w ?? Math.max(block.fontSize, ...block.lines.map((line) => measure(line, block.fontSize)))
  return { x: element.x, y: element.y, w: Math.max(width, 8), h: Math.max(block.lines.length, 1) * block.lineHeight }
}

export function strokeBounds(points: readonly (readonly [number, number])[], width: number): Rect {
  let x1 = Infinity
  let y1 = Infinity
  let x2 = -Infinity
  let y2 = -Infinity
  for (const [x, y] of points) {
    x1 = Math.min(x1, x)
    y1 = Math.min(y1, y)
    x2 = Math.max(x2, x)
    y2 = Math.max(y2, y)
  }
  const half = width / 2
  return { x: x1 - half, y: y1 - half, w: x2 - x1 + width, h: y2 - y1 + width }
}

export function elementBounds(element: WhiteboardElement, ctx: GeometryContext): Rect {
  if (isBoxElement(element)) return { x: element.x, y: element.y, w: element.w, h: element.h }
  if (element.type === 'text') return textBounds(element, ctx.measure)
  if (element.type === 'stroke') return strokeBounds(element.points, element.width)
  const geometry = arrowGeometry(element, ctx)
  const r = rectFromPoints(geometry.start, geometry.end)
  if (geometry.points) {
    // An elbow's bend can sit outside both ends: bound it by every corner.
    return unionRects([r, ...geometry.points.map((p) => ({ x: p.x, y: p.y, w: 0, h: 0 }))]) ?? r
  }
  const withCurve = unionRects([r, rectFromPoints(geometry.c1, geometry.c2)])
  return withCurve ?? r
}

export function contentBounds(elements: readonly WhiteboardElement[], ctx: GeometryContext): Rect | null {
  return unionRects(elements.map((element) => elementBounds(element, ctx)))
}

// ---- arrows

export function sideAnchor(r: Rect, side: Side): Point {
  switch (side) {
    case 'top':
      return { x: r.x + r.w / 2, y: r.y }
    case 'right':
      return { x: r.x + r.w, y: r.y + r.h / 2 }
    case 'bottom':
      return { x: r.x + r.w / 2, y: r.y + r.h }
    case 'left':
      return { x: r.x, y: r.y + r.h / 2 }
  }
}

const NORMAL: Record<Side, Point> = {
  top: { x: 0, y: -1 },
  right: { x: 1, y: 0 },
  bottom: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
}

/** The side of `r` that faces `toward`, judged relative to the box's proportions. */
export function facingSide(r: Rect, toward: Point): Side {
  const c = center(r)
  const dx = (toward.x - c.x) / Math.max(r.w, 1)
  const dy = (toward.y - c.y) / Math.max(r.h, 1)
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'right' : 'left'
  return dy >= 0 ? 'bottom' : 'top'
}

/** The side whose anchor is nearest `p` (used to snap an arrow end the pointer drops on a box). */
export function nearestSide(r: Rect, p: Point): Side {
  let best: Side = 'top'
  let bestDistance = Infinity
  for (const side of ['top', 'right', 'bottom', 'left'] as const) {
    const d = dist(p, sideAnchor(r, side))
    if (d < bestDistance) {
      bestDistance = d
      best = side
    }
  }
  return best
}

/** Elements an arrow end may bind to. */
export function isBindable(element: WhiteboardElement): boolean {
  return element.type !== 'arrow' && element.type !== 'stroke'
}

function endTargetRect(end: ArrowEnd, ctx: GeometryContext): Rect | null {
  if (!isBoundEnd(end)) return null
  const target = ctx.byId.get(end.elementId)
  if (!target || !isBindable(target)) return null
  return elementBounds(target, ctx)
}

function endReference(end: ArrowEnd, ctx: GeometryContext): Point {
  const r = endTargetRect(end, ctx)
  if (r) return center(r)
  return isBoundEnd(end) ? { x: 0, y: 0 } : { x: end.x, y: end.y }
}

export type ResolvedEnd = { point: Point; side?: Side }

export function resolveEnd(end: ArrowEnd, other: ArrowEnd, ctx: GeometryContext): ResolvedEnd {
  const r = endTargetRect(end, ctx)
  if (!r) return { point: isBoundEnd(end) ? endReference(other, ctx) : { x: end.x, y: end.y } }
  const side = (isBoundEnd(end) && end.side) || facingSide(r, endReference(other, ctx))
  return { point: sideAnchor(r, side), side }
}

export type ArrowGeometry = {
  start: Point
  end: Point
  c1: Point
  c2: Point
  /** The curve at t = 0.5, where the label sits. */
  mid: Point
  path: string
  /** Direction the head at `end` points, in radians; `startAngle` for the head at `start`. */
  endAngle: number
  startAngle: number
  /** An elbow connector's corners, start to end (absent on a curve). */
  points?: Point[]
  /**
   * An elbow's draggable middle segment: the point to draw its handle at, and the axis the bend
   * moves along (`x`: the segment is vertical and slides left/right).
   */
  bendHandle?: { point: Point; axis: 'x' | 'y' }
}

export function bezierPoint(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
  const u = 1 - t
  return {
    x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
    y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
  }
}

const round1 = (v: number) => Math.round(v * 10) / 10

// ---- elbow connectors

/** How far an elbow leaves a bound side before its first turn. */
export const ELBOW_STUB = 20
const ELBOW_RADIUS = 8

const horizontal = (side: Side) => side === 'left' || side === 'right'

/** The direction an end leaves in: its side, or (a free end) the major axis toward the other end. */
function exitSide(end: ResolvedEnd, other: Point): Side {
  if (end.side) return end.side
  const dx = other.x - end.point.x
  const dy = other.y - end.point.y
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'right' : 'left'
  return dy >= 0 ? 'bottom' : 'top'
}

/** Drops repeated points and the middle of any three in a straight line. */
export function simplifyPolyline(points: readonly Point[]): Point[] {
  const out: Point[] = []
  for (const p of points) {
    const last = out[out.length - 1]
    if (last && Math.abs(last.x - p.x) < 0.01 && Math.abs(last.y - p.y) < 0.01) continue
    if (out.length >= 2) {
      const a = out[out.length - 2]
      const b = out[out.length - 1]
      const collinear =
        (Math.abs(a.x - b.x) < 0.01 && Math.abs(b.x - p.x) < 0.01) ||
        (Math.abs(a.y - b.y) < 0.01 && Math.abs(b.y - p.y) < 0.01)
      // Only drop b when it lies between a and p (a stub that doubles back is a real corner).
      const between =
        Math.min(a.x, p.x) - 0.01 <= b.x &&
        b.x <= Math.max(a.x, p.x) + 0.01 &&
        Math.min(a.y, p.y) - 0.01 <= b.y &&
        b.y <= Math.max(a.y, p.y) + 0.01
      if (collinear && between) out.pop()
    }
    out.push(p)
  }
  return out
}

export type ElbowRoute = { points: Point[]; bendAxis?: 'x' | 'y'; bendSegment?: number }

/**
 * Right-angled route between two resolved ends. Each end leaves along its side (a bound end goes
 * `ELBOW_STUB` out first). When both ends leave on the same axis the route is three segments and
 * its middle one sits halfway between them (or just outside both, when they face the same way),
 * moved by `bend`; mixed axes make one corner and ignore `bend`.
 */
export function elbowRoute(a: ResolvedEnd, b: ResolvedEnd, bend = 0): ElbowRoute {
  const sa = exitSide(a, b.point)
  const sb = exitSide(b, a.point)
  const out = (end: ResolvedEnd, side: Side): Point => {
    const reach = end.side ? ELBOW_STUB : 0
    const n = NORMAL[side]
    return { x: end.point.x + n.x * reach, y: end.point.y + n.y * reach }
  }
  const pa = out(a, sa)
  const pb = out(b, sb)
  let raw: Point[]
  let bendAxis: 'x' | 'y' | undefined
  if (horizontal(sa) === horizontal(sb)) {
    const axis = horizontal(sa) ? 'x' : 'y'
    const lo = Math.min(pa[axis], pb[axis])
    const hi = Math.max(pa[axis], pb[axis])
    const sameWay = sa === sb
    const towardHigh = sa === 'right' || sa === 'bottom'
    const base = sameWay ? (towardHigh ? hi : lo) : (pa[axis] + pb[axis]) / 2
    const mid = base + bend
    bendAxis = axis
    raw =
      axis === 'x'
        ? [a.point, pa, { x: mid, y: pa.y }, { x: mid, y: pb.y }, pb, b.point]
        : [a.point, pa, { x: pa.x, y: mid }, { x: pb.x, y: mid }, pb, b.point]
  } else {
    const corner = horizontal(sa) ? { x: pb.x, y: pa.y } : { x: pa.x, y: pb.y }
    raw = [a.point, pa, corner, pb, b.point]
  }
  const points = simplifyPolyline(raw)
  if (!bendAxis) return { points }
  // The bend segment: the longest segment running across the bend axis.
  let bendSegment: number | undefined
  let best = -1
  for (let i = 1; i < points.length; i++) {
    const p = points[i - 1]
    const q = points[i]
    const across = bendAxis === 'x' ? Math.abs(p.x - q.x) < 0.01 : Math.abs(p.y - q.y) < 0.01
    const length = Math.hypot(p.x - q.x, p.y - q.y)
    if (across && length > best) {
      best = length
      bendSegment = i - 1
    }
  }
  return { points, bendAxis, bendSegment }
}

/** Total length of a polyline. */
export function polylineLength(points: readonly Point[]): number {
  let total = 0
  for (let i = 1; i < points.length; i++) total += dist(points[i - 1], points[i])
  return total
}

/** The point `t` (0 to 1) of the way along a polyline, by length. */
export function pointAlong(points: readonly Point[], t: number): Point {
  if (points.length === 0) return { x: 0, y: 0 }
  if (points.length === 1) return points[0]
  const target = Math.max(0, Math.min(1, t)) * polylineLength(points)
  let walked = 0
  for (let i = 1; i < points.length; i++) {
    const step = dist(points[i - 1], points[i])
    if (walked + step >= target && step > 0) {
      const f = (target - walked) / step
      const p = points[i - 1]
      const q = points[i]
      return { x: p.x + (q.x - p.x) * f, y: p.y + (q.y - p.y) * f }
    }
    walked += step
  }
  return points[points.length - 1]
}

/** The fraction (0 to 1) along a polyline of the point on it nearest `p`. */
export function nearestFraction(points: readonly Point[], p: Point): number {
  const total = polylineLength(points)
  if (points.length < 2 || total === 0) return 0.5
  let best = Infinity
  let bestAt = 0
  let walked = 0
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]
    const b = points[i]
    const step = dist(a, b)
    const t = step === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / (step * step)))
    const d = dist(p, { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })
    if (d < best) {
      best = d
      bestAt = walked + step * t
    }
    walked += step
  }
  return bestAt / total
}

/** An SVG path through right-angled corners, each rounded by up to `radius`. */
export function roundedPolylinePath(points: readonly Point[], radius = ELBOW_RADIUS): string {
  if (points.length === 0) return ''
  let d = `M${round1(points[0].x)} ${round1(points[0].y)}`
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i - 1]
    const c = points[i]
    const n = points[i + 1]
    const r = Math.min(radius, dist(p, c) / 2, dist(c, n) / 2)
    const inX = c.x + ((p.x - c.x) / (dist(p, c) || 1)) * r
    const inY = c.y + ((p.y - c.y) / (dist(p, c) || 1)) * r
    const outX = c.x + ((n.x - c.x) / (dist(c, n) || 1)) * r
    const outY = c.y + ((n.y - c.y) / (dist(c, n) || 1)) * r
    d += ` L${round1(inX)} ${round1(inY)} Q${round1(c.x)} ${round1(c.y)} ${round1(outX)} ${round1(outY)}`
  }
  const last = points[points.length - 1]
  return `${d} L${round1(last.x)} ${round1(last.y)}`
}

// ---- routing around obstacles

/** A board's routing obstacles (every box but sections), bucketed on a grid for nearby lookups. */
type ObstacleIndex = { cells: Map<string, Array<{ id: string; rect: Rect }>> }
const OBSTACLE_CELL = 512
const obstacleIndexes = new WeakMap<GeometryContext, ObstacleIndex>()

/** Built once per context (one per render), so routing every arrow stays linear in the board. */
function obstacleIndex(ctx: GeometryContext): ObstacleIndex {
  const cached = obstacleIndexes.get(ctx)
  if (cached) return cached
  const cells = new Map<string, Array<{ id: string; rect: Rect }>>()
  for (const element of ctx.byId.values()) {
    if (!isBoxElement(element) || element.type === 'section') continue
    const rect = { x: element.x, y: element.y, w: element.w, h: element.h }
    const entry = { id: element.id, rect }
    for (let cx = Math.floor(rect.x / OBSTACLE_CELL); cx <= Math.floor((rect.x + rect.w) / OBSTACLE_CELL); cx++)
      for (let cy = Math.floor(rect.y / OBSTACLE_CELL); cy <= Math.floor((rect.y + rect.h) / OBSTACLE_CELL); cy++) {
        const key = `${cx},${cy}`
        const list = cells.get(key)
        if (list) list.push(entry)
        else cells.set(key, [entry])
      }
  }
  const index = { cells }
  obstacleIndexes.set(ctx, index)
  return index
}

/** Obstacle boxes meeting `area`, each once. A huge area (a very long arrow) reads too many cells: none. */
function obstaclesIn(index: ObstacleIndex, area: Rect): Rect[] | null {
  const x1 = Math.floor(area.x / OBSTACLE_CELL)
  const x2 = Math.floor((area.x + area.w) / OBSTACLE_CELL)
  const y1 = Math.floor(area.y / OBSTACLE_CELL)
  const y2 = Math.floor((area.y + area.h) / OBSTACLE_CELL)
  if ((x2 - x1 + 1) * (y2 - y1 + 1) > 400) return null
  const seen = new Set<string>()
  const out: Rect[] = []
  for (let cx = x1; cx <= x2; cx++)
    for (let cy = y1; cy <= y2; cy++)
      for (const entry of index.cells.get(`${cx},${cy}`) ?? []) {
        if (seen.has(entry.id) || !rectsIntersect(entry.rect, area)) continue
        seen.add(entry.id)
        out.push(entry.rect)
      }
  return out
}

/** How far around a connector's own span the router looks for obstacles and room. */
const ROUTE_REACH = 160

/**
 * A route round the boxes the plain elbow `plain` passes through, or null when it is already
 * clear (or no clear route is found, so the plain one stands). The ends' stubs are kept.
 */
function avoidObstacles(a: ResolvedEnd, b: ResolvedEnd, plain: readonly Point[], ctx: GeometryContext): Point[] | null {
  if (plain.length < 2) return null
  const span = unionRects(plain.map((p) => ({ x: p.x, y: p.y, w: 0, h: 0 })))!
  const near = obstaclesIn(obstacleIndex(ctx), inflate(span, ROUTE_REACH))
  if (!near || near.length === 0) return null
  let crossed = false
  for (let i = 1; i < plain.length && !crossed; i++)
    for (const r of near)
      if (segmentCrossesRect(plain[i - 1], plain[i], r)) {
        crossed = true
        break
      }
  if (!crossed) return null
  const stub = (end: ResolvedEnd): Point => {
    if (!end.side) return end.point
    const n = NORMAL[end.side]
    return { x: end.point.x + n.x * ELBOW_STUB, y: end.point.y + n.y * ELBOW_STUB }
  }
  const pa = stub(a)
  const pb = stub(b)
  const centre = { x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 }
  const obstacles =
    near.length <= MAX_ROUTE_OBSTACLES
      ? near
      : [...near]
          .sort((p, q) => dist(center(p), centre) - dist(center(q), centre))
          .slice(0, MAX_ROUTE_OBSTACLES)
  const route = routeOrthogonal({ point: pa, side: a.side }, { point: pb, side: b.side }, obstacles)
  if (!route) return null
  return simplifyPolyline([a.point, ...route, b.point])
}

/**
 * An arrow's drawing. `routing: "elbow"` is right-angled (see `elbowRoute`; without a hand-set
 * `bend`, a plain elbow that would cross a box is routed round it by `routeOrthogonal`); otherwise it is a
 * cubic curve: a bound end leaves its side along the side's normal, a free end aims straight at
 * the other end, so two free ends make a straight line. The label sits `labelAt` along it.
 */
export function arrowGeometry(arrow: ArrowElement, ctx: GeometryContext): ArrowGeometry {
  const a = resolveEnd(arrow.from, arrow.to, ctx)
  const b = resolveEnd(arrow.to, arrow.from, ctx)
  const labelAt = arrow.labelAt ?? 0.5
  if (arrow.routing === 'elbow') {
    let route = elbowRoute(a, b, arrow.bend ?? 0)
    // A hand-set bend is the reader's choice; otherwise go round whatever the plain elbow crosses.
    if (arrow.bend === undefined) {
      const around = avoidObstacles(a, b, route.points, ctx)
      if (around) route = { points: around }
    }
    const points = route.points.length >= 2 ? route.points : [a.point, b.point]
    const last = points[points.length - 1]
    const beforeLast = points[points.length - 2]
    const first = points[0]
    const second = points[1]
    const segment = route.bendSegment
    return {
      start: a.point,
      end: b.point,
      c1: second,
      c2: beforeLast,
      mid: pointAlong(points, labelAt),
      path: roundedPolylinePath(points),
      endAngle: Math.atan2(last.y - beforeLast.y, last.x - beforeLast.x),
      startAngle: Math.atan2(first.y - second.y, first.x - second.x),
      points,
      bendHandle:
        route.bendAxis && segment !== undefined
          ? {
              point: {
                x: (points[segment].x + points[segment + 1].x) / 2,
                y: (points[segment].y + points[segment + 1].y) / 2,
              },
              axis: route.bendAxis,
            }
          : undefined,
    }
  }
  if (arrow.routing === 'straight') {
    const points = [a.point, b.point]
    const flat = a.point.x === b.point.x && a.point.y === b.point.y
    const angle = flat ? 0 : Math.atan2(b.point.y - a.point.y, b.point.x - a.point.x)
    return {
      start: a.point,
      end: b.point,
      c1: a.point,
      c2: b.point,
      mid: pointAlong(points, labelAt),
      path: `M${round1(a.point.x)} ${round1(a.point.y)} L${round1(b.point.x)} ${round1(b.point.y)}`,
      endAngle: angle,
      startAngle: angle + Math.PI,
      points,
    }
  }
  const length = dist(a.point, b.point)
  const reach = Math.min(160, Math.max(24, length / 2.5))
  const control = (from: ResolvedEnd, toward: Point): Point => {
    if (!from.side) {
      return { x: from.point.x + (toward.x - from.point.x) / 3, y: from.point.y + (toward.y - from.point.y) / 3 }
    }
    const n = NORMAL[from.side]
    return { x: from.point.x + n.x * reach, y: from.point.y + n.y * reach }
  }
  const c1 = control(a, b.point)
  const c2 = control(b, a.point)
  const mid = bezierPoint(a.point, c1, c2, b.point, labelAt)
  const angle = (from: Point, to: Point, fallback: Point) =>
    from.x === to.x && from.y === to.y
      ? Math.atan2(to.y - fallback.y, to.x - fallback.x)
      : Math.atan2(to.y - from.y, to.x - from.x)
  return {
    start: a.point,
    end: b.point,
    c1,
    c2,
    mid,
    path: `M${round1(a.point.x)} ${round1(a.point.y)} C${round1(c1.x)} ${round1(c1.y)} ${round1(c2.x)} ${round1(c2.y)} ${round1(b.point.x)} ${round1(b.point.y)}`,
    endAngle: angle(c2, b.point, a.point),
    startAngle: angle(c1, a.point, b.point),
  }
}

/** Points along the connector, for hit testing (an elbow's own corners). */
export function sampleArrow(geometry: ArrowGeometry, steps = 24): Point[] {
  if (geometry.points) return geometry.points
  const points: Point[] = []
  for (let i = 0; i <= steps; i++) points.push(bezierPoint(geometry.start, geometry.c1, geometry.c2, geometry.end, i / steps))
  return points
}

/** A filled triangle at `tip` pointing along `angle`, as a path. */
export function arrowHeadPath(tip: Point, angle: number, size: number): string {
  const spread = Math.PI / 7
  const left = { x: tip.x - size * Math.cos(angle - spread), y: tip.y - size * Math.sin(angle - spread) }
  const right = { x: tip.x - size * Math.cos(angle + spread), y: tip.y - size * Math.sin(angle + spread) }
  return `M${round1(tip.x)} ${round1(tip.y)} L${round1(left.x)} ${round1(left.y)} L${round1(right.x)} ${round1(right.y)} Z`
}

/**
 * Where an arrow end dropped at `p` attaches: the topmost bindable element under the pointer
 * (within `snap` units of its box), on its nearest side, or the free point itself.
 */
export function snapArrowEnd(
  elements: readonly WhiteboardElement[],
  p: Point,
  ctx: GeometryContext,
  snap: number,
  excludeId?: string,
): ArrowEnd {
  for (let i = elements.length - 1; i >= 0; i--) {
    const element = elements[i]
    if (!isBindable(element) || element.id === excludeId) continue
    const r = elementBounds(element, ctx)
    if (element.type === 'section') {
      // A section binds only near its edge, so an arrow can start on a note inside it.
      if (!pointInRect(p, r, snap) || pointInRect(p, inflate(r, -snap * 2))) continue
    } else if (!pointInRect(p, r, snap)) continue
    // Near an edge, pin that side; deeper inside, leave the side free so it faces the other end.
    const side = nearestSide(r, p)
    const anchor = sideAnchor(r, side)
    const nearEdge = Math.hypot(anchor.x - p.x, anchor.y - p.y) <= Math.min(r.w, r.h) * 0.25 + snap
    return nearEdge || element.type === 'section' ? { elementId: element.id, side } : { elementId: element.id }
  }
  return { x: round1(p.x), y: round1(p.y) }
}

// ---- hit testing

export const SECTION_HEADER = 40

/** The part of a section that takes a click: its title band and its border. */
export function sectionHit(section: SectionElement, p: Point, tolerance: number): boolean {
  const r = { x: section.x, y: section.y, w: section.w, h: section.h }
  if (!pointInRect(p, r, tolerance)) return false
  if (p.y <= section.y + SECTION_HEADER) return true
  return !pointInRect(p, inflate(r, -tolerance))
}

function shapeContains(kind: string, r: Rect, p: Point, tolerance: number): boolean {
  if (!pointInRect(p, r, tolerance)) return false
  const c = center(r)
  const rx = r.w / 2 + tolerance
  const ry = r.h / 2 + tolerance
  if (kind === 'ellipse') return ((p.x - c.x) / rx) ** 2 + ((p.y - c.y) / ry) ** 2 <= 1
  if (kind === 'diamond') return Math.abs(p.x - c.x) / rx + Math.abs(p.y - c.y) / ry <= 1
  return true
}

/** The topmost element under `p` (world units), or null. `tolerance` is in world units. */
export function hitTest(
  elements: readonly WhiteboardElement[],
  p: Point,
  ctx: GeometryContext,
  tolerance: number,
): WhiteboardElement | null {
  for (let i = elements.length - 1; i >= 0; i--) {
    const element = elements[i]
    if (!element.hidden && hitsElement(element, p, ctx, tolerance)) return element
  }
  return null
}

export function hitsElement(element: WhiteboardElement, p: Point, ctx: GeometryContext, tolerance: number): boolean {
  switch (element.type) {
    case 'section':
      return sectionHit(element, p, tolerance)
    case 'shape':
      return shapeContains(element.kind, element, p, tolerance)
    case 'note':
    case 'image':
    case 'sticker':
    case 'table':
    case 'link':
      return pointInRect(p, element, tolerance)
    case 'text':
      return pointInRect(p, textBounds(element, ctx.measure), tolerance)
    case 'stroke':
      return (
        distanceToPolyline(
          p,
          element.points.map(([x, y]) => ({ x, y })),
        ) <=
        element.width / 2 + tolerance
      )
    case 'arrow': {
      const geometry = arrowGeometry(element, ctx)
      if (distanceToPolyline(p, sampleArrow(geometry)) <= tolerance + 2) return true
      if (!element.label) return false
      const w = ctx.measure(element.label, ARROW_LABEL_SIZE) + 12
      return pointInRect(p, { x: geometry.mid.x - w / 2, y: geometry.mid.y - 12, w, h: 24 }, tolerance)
    }
  }
}

export const ARROW_LABEL_SIZE = 13

/**
 * The ids a marquee selects: anything its box touches, except sections, which only a marquee
 * that encloses them selects (so dragging inside a section picks its notes, not the section).
 */
export function elementsInMarquee(
  elements: readonly WhiteboardElement[],
  marquee: Rect,
  ctx: GeometryContext,
): string[] {
  return elements
    .filter((element) => {
      if (element.hidden) return false
      const r = elementBounds(element, ctx)
      return element.type === 'section' ? rectContains(marquee, r) : rectsIntersect(marquee, r)
    })
    .map((element) => element.id)
}

// ---- sections

/**
 * The elements a section carries when it moves: those whose centre lies inside it, smaller
 * nested sections included (and, through them, their own members). A bound arrow follows its
 * elements by itself; a free arrow comes along when both its ends are inside.
 */
export function sectionMembers(
  elements: readonly WhiteboardElement[],
  section: SectionElement,
  ctx: GeometryContext,
): string[] {
  const box = { x: section.x, y: section.y, w: section.w, h: section.h }
  const area = section.w * section.h
  const ids: string[] = []
  for (const element of elements) {
    if (element.id === section.id) continue
    if (element.type === 'arrow') {
      const ends = [element.from, element.to]
      if (ends.every((end) => !isBoundEnd(end) && pointInRect(end, box))) ids.push(element.id)
      continue
    }
    if (element.type === 'section' && element.w * element.h >= area) continue
    if (pointInRect(center(elementBounds(element, ctx)), box)) ids.push(element.id)
  }
  return ids
}

/** Sticker ids by the element each is attached to (`attachedTo`), for elements the board has. */
export function attachedStickers(elements: readonly WhiteboardElement[]): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const element of elements) {
    if (element.type !== 'sticker' || element.attachedTo === undefined) continue
    const list = out.get(element.attachedTo)
    if (list) list.push(element.id)
    else out.set(element.attachedTo, [element.id])
  }
  return out
}

/**
 * `ids` plus every member of each selected section, transitively, and every sticker attached to
 * any of them (round 4: a sticker stuck on a note moves and copies with it).
 */
export function withSectionMembers(
  elements: readonly WhiteboardElement[],
  ids: readonly string[],
  ctx: GeometryContext,
): string[] {
  const out = new Set(ids)
  const queue = [...ids]
  const stuck = elements.some((element) => element.type === 'sticker' && element.attachedTo !== undefined)
    ? attachedStickers(elements)
    : null
  while (queue.length > 0) {
    const id = queue.pop()!
    for (const sticker of stuck?.get(id) ?? []) {
      if (out.has(sticker)) continue
      out.add(sticker)
      queue.push(sticker)
    }
    const element = ctx.byId.get(id)
    if (element?.type !== 'section') continue
    for (const member of sectionMembers(elements, element, ctx)) {
      if (out.has(member)) continue
      out.add(member)
      queue.push(member)
    }
  }
  return [...out]
}

// ---- resizing

export type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'
export const HANDLES: readonly Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']

export function handlePoint(r: Rect, handle: Handle): Point {
  const x = handle.includes('w') ? r.x : handle.includes('e') ? r.x + r.w : r.x + r.w / 2
  const y = handle.includes('n') ? r.y : handle.includes('s') ? r.y + r.h : r.y + r.h / 2
  return { x, y }
}

export const MIN_SIZE = 16

/** The box after dragging `handle` by (dx, dy). `keepAspect` holds the start box's ratio. */
export function resizeRect(start: Rect, handle: Handle, dx: number, dy: number, keepAspect = false): Rect {
  let x1 = start.x
  let y1 = start.y
  let x2 = start.x + start.w
  let y2 = start.y + start.h
  if (handle.includes('w')) x1 += dx
  if (handle.includes('e')) x2 += dx
  if (handle.includes('n')) y1 += dy
  if (handle.includes('s')) y2 += dy
  // Never flip through zero: clamp at the minimum size on the dragged side.
  if (x2 - x1 < MIN_SIZE) {
    if (handle.includes('w')) x1 = x2 - MIN_SIZE
    else x2 = x1 + MIN_SIZE
  }
  if (y2 - y1 < MIN_SIZE) {
    if (handle.includes('n')) y1 = y2 - MIN_SIZE
    else y2 = y1 + MIN_SIZE
  }
  let w = x2 - x1
  let h = y2 - y1
  if (keepAspect && start.w > 0 && start.h > 0) {
    const scale =
      handle === 'n' || handle === 's' ? h / start.h
      : handle === 'e' || handle === 'w' ? w / start.w
      : Math.max(w / start.w, h / start.h)
    w = start.w * scale
    h = start.h * scale
    // The opposite edge or corner stays put; an edge handle keeps the other axis centred.
    x1 = handle.includes('w') ? x2 - w : handle.includes('e') ? start.x : start.x + (start.w - w) / 2
    y1 = handle.includes('n') ? y2 - h : handle.includes('s') ? start.y : start.y + (start.h - h) / 2
  }
  return { x: x1, y: y1, w, h }
}

/** Maps every element from the `from` box onto the `to` box (a group resize). */
export function scaleElements(
  elements: readonly WhiteboardElement[],
  from: Rect,
  to: Rect,
): WhiteboardElement[] {
  const sx = from.w > 0 ? to.w / from.w : 1
  const sy = from.h > 0 ? to.h / from.h : 1
  const mapX = (x: number) => round1(to.x + (x - from.x) * sx)
  const mapY = (y: number) => round1(to.y + (y - from.y) * sy)
  return elements.map((element): WhiteboardElement => {
    if (isBoxElement(element)) {
      return {
        ...element,
        x: mapX(element.x),
        y: mapY(element.y),
        w: Math.max(MIN_SIZE, round1(element.w * sx)),
        h: Math.max(MIN_SIZE, round1(element.h * sy)),
      }
    }
    if (element.type === 'text') {
      const next: TextElement = { ...element, x: mapX(element.x), y: mapY(element.y) }
      if (element.w !== undefined) next.w = Math.max(MIN_SIZE, round1(element.w * sx))
      return next
    }
    if (element.type === 'stroke') {
      return { ...element, points: element.points.map(([x, y]) => [mapX(x), mapY(y)] as [number, number]) }
    }
    const mapEnd = (end: ArrowEnd): ArrowEnd => (isBoundEnd(end) ? end : { x: mapX(end.x), y: mapY(end.y) })
    return { ...element, from: mapEnd(element.from), to: mapEnd(element.to) }
  })
}

// ---- marker strokes

function perpendicularDistance(p: Point, a: Point, b: Point): number {
  return distanceToSegment(p, a, b)
}

/** Ramer–Douglas–Peucker: drops points within `tolerance` of the line through their neighbours. */
export function simplifyPoints(points: readonly Point[], tolerance: number): Point[] {
  if (points.length <= 2) return [...points]
  const keep = new Uint8Array(points.length)
  keep[0] = 1
  keep[points.length - 1] = 1
  const stack: Array<[number, number]> = [[0, points.length - 1]]
  while (stack.length > 0) {
    const [first, last] = stack.pop()!
    let index = -1
    let max = tolerance
    for (let i = first + 1; i < last; i++) {
      const d = perpendicularDistance(points[i], points[first], points[last])
      if (d > max) {
        max = d
        index = i
      }
    }
    if (index !== -1) {
      keep[index] = 1
      stack.push([first, index], [index, last])
    }
  }
  return points.filter((_, i) => keep[i] === 1)
}

/** The stored form of a drawn line: simplified, rounded to 0.1, capped at `max` points. */
export function strokePoints(raw: readonly Point[], tolerance: number, max = 2000): Array<[number, number]> {
  let simplified = simplifyPoints(raw, tolerance)
  let t = tolerance
  while (simplified.length > max) {
    t *= 1.5
    simplified = simplifyPoints(raw, t)
  }
  return simplified.map((p) => [round1(p.x), round1(p.y)])
}

/** A smooth SVG path through stroke points (quadratic curves through the midpoints). */
export function strokePath(points: readonly (readonly [number, number])[]): string {
  if (points.length === 0) return ''
  const [x0, y0] = points[0]
  if (points.length === 1) return `M${x0} ${y0} L${x0 + 0.1} ${y0}`
  if (points.length === 2) return `M${x0} ${y0} L${points[1][0]} ${points[1][1]}`
  let d = `M${x0} ${y0}`
  for (let i = 1; i < points.length - 1; i++) {
    const [x, y] = points[i]
    const [nx, ny] = points[i + 1]
    d += ` Q${x} ${y} ${round1((x + nx) / 2)} ${round1((y + ny) / 2)}`
  }
  const [lx, ly] = points[points.length - 1]
  return `${d} L${lx} ${ly}`
}

// ---- viewport

export const MIN_ZOOM = 0.05
export const MAX_ZOOM = 4

export const clampZoom = (zoom: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom))

/** Viewport: a world point p is drawn at `p * zoom + (x, y)` on screen. */
export function screenToWorld(v: Viewport, p: Point): Point {
  return { x: (p.x - v.x) / v.zoom, y: (p.y - v.y) / v.zoom }
}

export function worldToScreen(v: Viewport, p: Point): Point {
  return { x: p.x * v.zoom + v.x, y: p.y * v.zoom + v.y }
}

/** Zooms to `zoom` keeping the world point under `screen` still. */
export function zoomAt(v: Viewport, screen: Point, zoom: number): Viewport {
  const next = clampZoom(zoom)
  const world = screenToWorld(v, screen)
  return { zoom: next, x: screen.x - world.x * next, y: screen.y - world.y * next }
}

/** The viewport that shows `bounds` centred in a `width × height` screen, never above `maxZoom`. */
export function fitViewport(
  bounds: Rect | null,
  width: number,
  height: number,
  padding = 64,
  maxZoom = 1,
): Viewport {
  if (!bounds || width <= 0 || height <= 0) return { x: width / 2, y: height / 2, zoom: 1 }
  const zoom = clampZoom(
    Math.min(
      maxZoom,
      (width - 2 * padding) / Math.max(bounds.w, 1),
      (height - 2 * padding) / Math.max(bounds.h, 1),
    ),
  )
  const c = center(bounds)
  return { zoom, x: width / 2 - c.x * zoom, y: height / 2 - c.y * zoom }
}
