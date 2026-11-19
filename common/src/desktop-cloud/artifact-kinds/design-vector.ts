import type { ShapeNode, StrokePattern } from './design'

/**
 * Vector shape geometry: an SVG path (`d`) for a shape's kind inside its w×h box. The renderer,
 * the code export and the board export all draw vectors from this, so they match. Pure.
 */

const r = (value: number) => Math.round(value * 100) / 100

/** Rounded SVG caps turn a very short dash into a dot. */
export function strokeDashArray(pattern: StrokePattern | undefined, width: number): string | undefined {
  if (width <= 0) return undefined
  if (pattern === 'dashed') return `${3 * width} ${2 * width}`
  if (pattern === 'dotted') return `0.01 ${2 * width}`
  return undefined
}

/** The shape kinds drawn as an SVG path rather than a CSS box. */
export const VECTOR_KINDS = ['arrow', 'polygon', 'star', 'path'] as const
export function isVectorShape(node: ShapeNode): boolean {
  return (VECTOR_KINDS as readonly string[]).includes(node.kind)
}

/** Regular polygon points inscribed in the box (first vertex at the top). */
export function polygonPoints(sides: number, w: number, h: number): Array<[number, number]> {
  const n = Math.max(3, Math.min(24, Math.round(sides)))
  const out: Array<[number, number]> = []
  for (let i = 0; i < n; i += 1) {
    const angle = -Math.PI / 2 + (i * 2 * Math.PI) / n
    out.push([r(w / 2 + (w / 2) * Math.cos(angle)), r(h / 2 + (h / 2) * Math.sin(angle))])
  }
  return out
}

/** Star points (outer and inner alternating, first point at the top). */
export function starPoints(points: number, innerRatio: number, w: number, h: number): Array<[number, number]> {
  const n = Math.max(3, Math.min(24, Math.round(points)))
  const inner = Math.max(0.1, Math.min(0.95, innerRatio))
  const out: Array<[number, number]> = []
  for (let i = 0; i < n * 2; i += 1) {
    const angle = -Math.PI / 2 + (i * Math.PI) / n
    const k = i % 2 === 0 ? 1 : inner
    out.push([r(w / 2 + (w / 2) * k * Math.cos(angle)), r(h / 2 + (h / 2) * k * Math.sin(angle))])
  }
  return out
}

const pathOf = (points: Array<[number, number]>, closed: boolean) =>
  points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${r(x)} ${r(y)}`).join(' ') + (closed ? ' Z' : '')

/**
 * A path whose segment i (point i to i + 1; with `closed`, the last back to the first) is a cubic
 * curve when `curves[i]` gives its two control points (shares of the box), else a line.
 */
export function curvedPathOf(
  points: Array<[number, number]>,
  curves: ReadonlyArray<readonly [number, number, number, number] | null>,
  closed: boolean,
  w: number,
  h: number,
): string {
  if (points.length === 0) return ''
  const parts = [`M${r(points[0][0])} ${r(points[0][1])}`]
  const segments = closed ? points.length : points.length - 1
  for (let i = 0; i < segments; i += 1) {
    const [x, y] = points[(i + 1) % points.length]
    const curve = curves[i]
    parts.push(curve ? `C${r(curve[0] * w)} ${r(curve[1] * h)} ${r(curve[2] * w)} ${r(curve[3] * h)} ${r(x)} ${r(y)}` : `L${r(x)} ${r(y)}`)
  }
  return parts.join(' ') + (closed ? ' Z' : '')
}

/**
 * The SVG path of a vector shape in its w×h box, plus whether it is filled (closed) or only
 * stroked. An arrow runs left to right through the box's middle with its head at the end.
 */
export function shapeGeometry(node: ShapeNode, w: number, h: number): { d: string; closed: boolean } {
  switch (node.kind) {
    case 'polygon':
      return { d: pathOf(polygonPoints(node.sides ?? 6, w, h), true), closed: true }
    case 'star':
      return { d: pathOf(starPoints(node.sides ?? 5, node.innerRatio ?? 0.5, w, h), true), closed: true }
    case 'path': {
      const points = (node.vertices ?? [[0, 0], [1, 1]]).map(([x, y]) => [x * w, y * h] as [number, number])
      if (!node.curves?.some(Boolean)) return { d: pathOf(points, node.closed === true), closed: node.closed === true }
      return { d: curvedPathOf(points, node.curves, node.closed === true, w, h), closed: node.closed === true }
    }
    case 'arrow': {
      const stroke = node.strokeWidth ?? 2
      const head = Math.min(w / 2, Math.max(8, stroke * 4))
      const mid = h / 2
      return {
        d: `M0 ${r(mid)} L${r(w)} ${r(mid)} M${r(w - head)} ${r(mid - head / 2)} L${r(w)} ${r(mid)} L${r(w - head)} ${r(mid + head / 2)}`,
        closed: false,
      }
    }
    default:
      return { d: `M0 0 L${r(w)} 0 L${r(w)} ${r(h)} L0 ${r(h)} Z`, closed: true }
  }
}

/**
 * A pen path from board px points (and per-segment cubic control points, also board px): its box
 * at (x, y), and the points and controls as shares of that box, which is how a path shape stores
 * them. The editor's pen and the agent's addPath both build paths with this.
 */
export function pathShapeFromPoints(
  points: Array<[number, number]>,
  curves: Array<[number, number, number, number] | null> | undefined,
  taken: ReadonlySet<string>,
  id: string,
): ShapeNode {
  const minX = Math.min(...points.map(([x]) => x))
  const minY = Math.min(...points.map(([, y]) => y))
  const w = Math.max(1, Math.max(...points.map(([x]) => x)) - minX)
  const h = Math.max(1, Math.max(...points.map(([, y]) => y)) - minY)
  const share = (value: number, from: number, size: number) => Math.round(((value - from) / size) * 1000) / 1000
  const clampShare = (value: number) => Math.min(2, Math.max(-1, value))
  let nodeId = id
  for (let n = 2; taken.has(nodeId); n += 1) nodeId = `${id}-${n}`
  return {
    type: 'shape',
    id: nodeId,
    kind: 'path',
    x: Math.round(minX),
    y: Math.round(minY),
    w: Math.round(w),
    h: Math.round(h),
    vertices: points.map(([x, y]) => [share(x, minX, w), share(y, minY, h)] as [number, number]),
    ...(curves?.some(Boolean)
      ? {
          curves: curves.map((curve) =>
            curve ? ([clampShare(share(curve[0], minX, w)), clampShare(share(curve[1], minY, h)), clampShare(share(curve[2], minX, w)), clampShare(share(curve[3], minY, h))] as [number, number, number, number]) : null,
          ),
        }
      : {}),
  }
}
