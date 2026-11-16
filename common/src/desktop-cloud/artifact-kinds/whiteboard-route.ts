/**
 * Orthogonal connector routing around obstacles, for elbow arrows.
 *
 * `routeOrthogonal` finds a right-angled path between two points that stays `ROUTE_MARGIN` clear
 * of every obstacle box, preferring few bends and then a short path. It searches a sparse grid
 * whose lines are the obstacles' (inflated) edges, the two ends and a frame around them, with A*
 * over (grid node, heading) so a turn costs `BEND_COST`. Small and bounded: the caller passes only
 * the obstacles near the connector, and a grid over `MAX_GRID_NODES` gives up (null), as does no
 * path, so the caller falls back to the plain elbow. Results are memoised by their inputs, since
 * the canvas redraws every arrow on every frame of a drag.
 *
 * Pure: points and rects in, points out; no board types beyond them, no DOM.
 */

import type { Point, Rect, Side } from './whiteboard'

/** How far a route keeps from an obstacle's edge. Under `ELBOW_STUB`, so a stub leaves its own box clear. */
export const ROUTE_MARGIN = 16
/** What one turn costs, in world units of length: two turns must save more than this much path. */
export const BEND_COST = 48
/** Obstacles one search considers; the nearest are kept. */
export const MAX_ROUTE_OBSTACLES = 48
const MAX_GRID_NODES = 12_000

/** Headings: 0 +x, 1 +y, 2 -x, 3 -y. */
const DX = [1, 0, -1, 0]
const DY = [0, 1, 0, -1]
const SIDE_DIR: Record<Side, number> = { right: 0, bottom: 1, left: 2, top: 3 }

export type RouteEnd = {
  /** Where the route starts or ends (a bound end's stub point, already outside its box). */
  point: Point
  /** The side it leaves (start) or enters from (end); absent for a free end, which may go any way. */
  side?: Side
}

const inflateBy = (r: Rect, m: number): Rect => ({ x: r.x - m, y: r.y - m, w: r.w + 2 * m, h: r.h + 2 * m })

const strictlyInside = (p: Point, r: Rect) => p.x > r.x && p.x < r.x + r.w && p.y > r.y && p.y < r.y + r.h

/** Sorted, de-duplicated values (to 0.01). */
function lines(values: number[]): number[] {
  values.sort((a, b) => a - b)
  const out: number[] = []
  for (const v of values) if (out.length === 0 || v - out[out.length - 1] > 0.01) out.push(v)
  return out
}

/** Index of `v` in sorted `values` (exact to 0.01), or -1. */
function indexOf(values: readonly number[], v: number): number {
  let lo = 0
  let hi = values.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (Math.abs(values[mid] - v) <= 0.01) return mid
    if (values[mid] < v) lo = mid + 1
    else hi = mid - 1
  }
  return -1
}

/** The first index of sorted `values` at or above `v`. */
function lowerBound(values: readonly number[], v: number): number {
  let lo = 0
  let hi = values.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (values[mid] < v) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** A binary min-heap of state ids keyed by a Float64 score. */
class Heap {
  private ids: number[] = []
  private keys: number[] = []
  get size() {
    return this.ids.length
  }
  push(id: number, key: number) {
    const ids = this.ids
    const keys = this.keys
    let i = ids.length
    ids.push(id)
    keys.push(key)
    while (i > 0) {
      const parent = (i - 1) >> 1
      if (keys[parent] <= key) break
      ids[i] = ids[parent]
      keys[i] = keys[parent]
      i = parent
    }
    ids[i] = id
    keys[i] = key
  }
  /** The smallest key (Infinity when empty). */
  peekKey() {
    return this.keys.length ? this.keys[0] : Infinity
  }
  pop(): number {
    const ids = this.ids
    const keys = this.keys
    const top = ids[0]
    const lastId = ids.pop()!
    const lastKey = keys.pop()!
    if (ids.length > 0) {
      let i = 0
      const n = ids.length
      for (;;) {
        const l = 2 * i + 1
        const r = l + 1
        let m = i
        let mKey = lastKey
        if (l < n && keys[l] < mKey) {
          m = l
          mKey = keys[l]
        }
        if (r < n && keys[r] < mKey) m = r
        if (m === i) break
        ids[i] = ids[m]
        keys[i] = keys[m]
        i = m
      }
      ids[i] = lastId
      keys[i] = lastKey
    }
    return top
  }
}

const cache = new Map<string, Point[] | null>()
const CACHE_SIZE = 2_000

function cacheKey(a: RouteEnd, b: RouteEnd, obstacles: readonly Rect[]): string {
  let key = `${a.point.x},${a.point.y},${a.side ?? ''}|${b.point.x},${b.point.y},${b.side ?? ''}`
  for (const r of obstacles) key += `|${r.x},${r.y},${r.w},${r.h}`
  return key
}

/**
 * A right-angled path from `a` to `b` around `obstacles`, as its corner points from `a.point` to
 * `b.point` inclusive, or null when there is none (or the search would be too big). The path
 * leaves `a` along `a.side` and arrives at `b` heading into `b.side` (it never leaves or arrives
 * backwards). Obstacles that already hold either end inside their margin are ignored, so a
 * crowded end still routes.
 */
export function routeOrthogonal(a: RouteEnd, b: RouteEnd, obstacles: readonly Rect[]): Point[] | null {
  const key = cacheKey(a, b, obstacles)
  if (cache.has(key)) {
    const hit = cache.get(key)!
    // Refresh its place in the LRU order.
    cache.delete(key)
    cache.set(key, hit)
    return hit
  }
  const result = search(a, b, obstacles)
  cache.set(key, result)
  if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!)
  return result
}

function search(a: RouteEnd, b: RouteEnd, obstacles: readonly Rect[]): Point[] | null {
  const blocks = obstacles
    .map((r) => inflateBy(r, ROUTE_MARGIN))
    .filter((r) => !strictlyInside(a.point, r) && !strictlyInside(b.point, r))
  // A frame one margin outside everything, so a route can always go round the outside.
  let fx1 = Math.min(a.point.x, b.point.x)
  let fy1 = Math.min(a.point.y, b.point.y)
  let fx2 = Math.max(a.point.x, b.point.x)
  let fy2 = Math.max(a.point.y, b.point.y)
  for (const r of blocks) {
    fx1 = Math.min(fx1, r.x)
    fy1 = Math.min(fy1, r.y)
    fx2 = Math.max(fx2, r.x + r.w)
    fy2 = Math.max(fy2, r.y + r.h)
  }
  const xsRaw = [a.point.x, b.point.x, (a.point.x + b.point.x) / 2, fx1 - ROUTE_MARGIN, fx2 + ROUTE_MARGIN]
  const ysRaw = [a.point.y, b.point.y, (a.point.y + b.point.y) / 2, fy1 - ROUTE_MARGIN, fy2 + ROUTE_MARGIN]
  for (const r of blocks) {
    xsRaw.push(r.x, r.x + r.w)
    ysRaw.push(r.y, r.y + r.h)
  }
  const xs = lines(xsRaw)
  const ys = lines(ysRaw)
  const nx = xs.length
  const ny = ys.length
  if (nx * ny > MAX_GRID_NODES) return null
  const start = indexOf(xs, a.point.x) + nx * indexOf(ys, a.point.y)
  const goal = indexOf(xs, b.point.x) + nx * indexOf(ys, b.point.y)

  // Blocked nodes and the segments to the next node along x (h) and along y (v).
  const nodeBlocked = new Uint8Array(nx * ny)
  const hBlocked = new Uint8Array(nx * ny)
  const vBlocked = new Uint8Array(nx * ny)
  for (const r of blocks) {
    const x2 = r.x + r.w
    const y2 = r.y + r.h
    // Only the grid lines on or inside the box matter (its edges are grid lines themselves).
    const i0 = lowerBound(xs, r.x - 0.01)
    const j0 = lowerBound(ys, r.y - 0.01)
    for (let j = j0; j < ny && ys[j] <= y2 + 0.01; j++) {
      const y = ys[j]
      const yInside = y > r.y + 0.01 && y < y2 - 0.01
      for (let i = i0; i < nx && xs[i] <= x2 + 0.01; i++) {
        const x = xs[i]
        const id = i + nx * j
        const xInside = x > r.x + 0.01 && x < x2 - 0.01
        if (xInside && yInside) nodeBlocked[id] = 1
        // The segment to i+1 lies strictly inside when its row is inside and both ends are within.
        if (yInside && i + 1 < nx && x >= r.x - 0.01 && xs[i + 1] <= x2 + 0.01) hBlocked[id] = 1
        // The segment to j+1 likewise, along a column strictly inside.
        if (xInside && j + 1 < ny && y >= r.y - 0.01 && ys[j + 1] <= y2 + 0.01) vBlocked[id] = 1
      }
    }
  }

  const states = nx * ny * 4
  const cost = new Float64Array(states).fill(Infinity)
  const parent = new Int32Array(states).fill(-1)
  const heap = new Heap()
  const gx = b.point.x
  const gy = b.point.y
  const h = (node: number) => Math.abs(xs[node % nx] - gx) + Math.abs(ys[Math.floor(node / nx)] - gy)
  const startDirs = a.side ? [SIDE_DIR[a.side]] : [0, 1, 2, 3]
  for (const d of startDirs) {
    const s = start * 4 + d
    cost[s] = 0
    heap.push(s, h(start))
  }
  // Arriving at b heading into its side: the reverse of the side's outward heading.
  const arriveDir = b.side ? (SIDE_DIR[b.side] + 2) % 4 : -1
  let best = Infinity
  let bestState = -1
  while (heap.size > 0 && heap.peekKey() < best) {
    const s = heap.pop()
    const node = s >> 2
    const d = s & 3
    const g = cost[s]
    if (node === goal) {
      if (arriveDir === -1 || d === arriveDir || (d + 2) % 4 !== arriveDir) {
        // Turning at the stub point costs a little more than a turn elsewhere, so of two equal
        // routes the one that runs straight into the side wins.
        const total = g + (arriveDir === -1 || d === arriveDir ? 0 : BEND_COST + 8)
        // A start that is already the goal (no move) only counts with a matching heading.
        if (total < best) {
          best = total
          bestState = s
        }
      }
      continue
    }
    const i = node % nx
    const j = (node - i) / nx
    for (let nd = 0; nd < 4; nd++) {
      if (nd === (d + 2) % 4) continue // never double back
      const ni = i + DX[nd]
      const nj = j + DY[nd]
      if (ni < 0 || nj < 0 || ni >= nx || nj >= ny) continue
      const next = ni + nx * nj
      if (nodeBlocked[next] && next !== goal) continue
      const blocked =
        nd === 0 ? hBlocked[node] : nd === 2 ? hBlocked[next] : nd === 1 ? vBlocked[node] : vBlocked[next]
      if (blocked) continue
      const step = Math.abs(xs[ni] - xs[i]) + Math.abs(ys[nj] - ys[j])
      const ng = g + step + (nd === d ? 0 : BEND_COST)
      const ns = next * 4 + nd
      if (ng < cost[ns] - 1e-9) {
        cost[ns] = ng
        parent[ns] = s
        heap.push(ns, ng + h(next))
      }
    }
  }
  if (bestState === -1) return null
  const path: Point[] = []
  for (let s = bestState; s !== -1; s = parent[s]) {
    const node = s >> 2
    const p = { x: xs[node % nx], y: ys[Math.floor(node / nx)] }
    const last = path[path.length - 1]
    if (!last || last.x !== p.x || last.y !== p.y) path.push(p)
  }
  path.reverse()
  // Keep only the corners.
  const corners: Point[] = [path[0]]
  for (let k = 1; k < path.length - 1; k++) {
    const p = corners[corners.length - 1]
    const q = path[k]
    const r = path[k + 1]
    const straight = (p.x === q.x && q.x === r.x) || (p.y === q.y && q.y === r.y)
    if (!straight) corners.push(q)
  }
  if (path.length > 1) corners.push(path[path.length - 1])
  return corners
}

/** Whether an axis-aligned segment passes through the inside of `r` (shrunk by `shrink`; touching an edge is fine). */
export function segmentCrossesRect(p: Point, q: Point, r: Rect, shrink = 1): boolean {
  const x1 = r.x + shrink
  const x2 = r.x + r.w - shrink
  const y1 = r.y + shrink
  const y2 = r.y + r.h - shrink
  if (x2 <= x1 || y2 <= y1) return false
  const minX = Math.min(p.x, q.x)
  const maxX = Math.max(p.x, q.x)
  const minY = Math.min(p.y, q.y)
  const maxY = Math.max(p.y, q.y)
  return maxX > x1 && minX < x2 && maxY > y1 && minY < y2
}
