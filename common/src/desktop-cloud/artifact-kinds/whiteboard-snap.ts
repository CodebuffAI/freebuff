/**
 * Smart guides: while a selection is dragged or resized, its edges and centre snap to the edges
 * and centres of the other elements, and to equal spacing with its neighbours in a row or
 * column. Returns the corrected offset (or box) and the guides to draw. Pure: no DOM.
 */

import type { Handle } from './whiteboard-geometry'
import type { Rect } from './whiteboard'

/** A guide line in world units: `axis: "x"` is a vertical line at x = `at` from y = `from` to `to`. */
export type LineGuide = { kind: 'line'; axis: 'x' | 'y'; at: number; from: number; to: number }
/**
 * Equal gaps: each span is one gap of `size` along `axis`, drawn at the cross position `at`
 * (for `axis: "x"`, a horizontal span from `from` to `to` at y = `at`).
 */
export type GapGuide = { kind: 'gap'; axis: 'x' | 'y'; spans: Array<{ from: number; to: number; at: number }> }
export type SnapGuide = LineGuide | GapGuide

type AxisSnap = { delta: number; guides: SnapGuide[] }

const lo = (r: Rect, axis: 'x' | 'y') => (axis === 'x' ? r.x : r.y)
const len = (r: Rect, axis: 'x' | 'y') => (axis === 'x' ? r.w : r.h)
const hi = (r: Rect, axis: 'x' | 'y') => lo(r, axis) + len(r, axis)
const mid = (r: Rect, axis: 'x' | 'y') => lo(r, axis) + len(r, axis) / 2
const other = (axis: 'x' | 'y'): 'x' | 'y' => (axis === 'x' ? 'y' : 'x')

/** Whether two boxes overlap across `axis` (share some of the other axis): row/column neighbours. */
const alongside = (a: Rect, b: Rect, axis: 'x' | 'y') => {
  const o = other(axis)
  return lo(a, o) < hi(b, o) && lo(b, o) < hi(a, o)
}

/**
 * Edge and centre alignment on one axis. `points` are the moving box's own lines that may snap
 * (left/centre/right for a move; only the dragged edge for a resize).
 */
function alignAxis(
  moving: Rect,
  points: ReadonlyArray<number>,
  targets: readonly Rect[],
  axis: 'x' | 'y',
  threshold: number,
): AxisSnap | null {
  let best: number | null = null
  for (const target of targets) {
    for (const line of [lo(target, axis), mid(target, axis), hi(target, axis)]) {
      for (const p of points) {
        const delta = line - p
        if (Math.abs(delta) <= threshold && (best === null || Math.abs(delta) < Math.abs(best))) best = delta
      }
    }
  }
  if (best === null) return null
  const delta = best
  // Every line that matches after the snap gets a guide, spanning the boxes on it.
  const o = other(axis)
  const snapped = points.map((p) => p + delta)
  const guides: LineGuide[] = []
  const seen = new Set<number>()
  for (const at of snapped) {
    const key = Math.round(at * 10)
    if (seen.has(key)) continue
    const on = targets.filter((t) => [lo(t, axis), mid(t, axis), hi(t, axis)].some((line) => Math.abs(line - at) < 0.5))
    if (on.length === 0) continue
    seen.add(key)
    const shifted = axis === 'x' ? { ...moving, x: moving.x + delta } : { ...moving, y: moving.y + delta }
    const spans = [shifted, ...on]
    guides.push({
      kind: 'line',
      axis,
      at,
      from: Math.min(...spans.map((r) => lo(r, o))),
      to: Math.max(...spans.map((r) => hi(r, o))),
    })
  }
  return { delta, guides }
}

/**
 * Equal spacing on one axis, among the boxes in the moving box's row (or column): the box can sit
 * the same gap after its neighbour as that neighbour sits after the one before, the same gap
 * before, or centred between the neighbours on either side.
 */
function spacingAxis(moving: Rect, targets: readonly Rect[], axis: 'x' | 'y', threshold: number): AxisSnap | null {
  const row = targets.filter((t) => alongside(t, moving, axis)).sort((a, b) => lo(a, axis) - lo(b, axis))
  if (row.length === 0) return null
  const o = other(axis)
  const before = row.filter((t) => hi(t, axis) <= lo(moving, axis) + threshold)
  const after = row.filter((t) => lo(t, axis) >= hi(moving, axis) - threshold)
  const prev = before.length ? before.reduce((a, b) => (hi(b, axis) > hi(a, axis) ? b : a)) : null
  const next = after.length ? after.reduce((a, b) => (lo(b, axis) < lo(a, axis) ? b : a)) : null
  type Option = { delta: number; spans: Array<[Rect, Rect]> }
  const options: Option[] = []
  const gapAfter = (a: Rect, b: Rect) => lo(b, axis) - hi(a, axis)
  const neighbourBefore = (r: Rect) =>
    row.filter((t) => t !== r && hi(t, axis) <= lo(r, axis)).reduce<Rect | null>((a, b) => (!a || hi(b, axis) > hi(a, axis) ? b : a), null)
  const neighbourAfter = (r: Rect) =>
    row.filter((t) => t !== r && lo(t, axis) >= hi(r, axis)).reduce<Rect | null>((a, b) => (!a || lo(b, axis) < lo(a, axis) ? b : a), null)
  if (prev) {
    const pp = neighbourBefore(prev)
    if (pp && gapAfter(pp, prev) > 0) {
      const target = hi(prev, axis) + gapAfter(pp, prev)
      options.push({ delta: target - lo(moving, axis), spans: [[pp, prev], [prev, moving]] })
    }
  }
  if (next) {
    const nn = neighbourAfter(next)
    if (nn && gapAfter(next, nn) > 0) {
      const target = lo(next, axis) - gapAfter(next, nn) - len(moving, axis)
      options.push({ delta: target - lo(moving, axis), spans: [[moving, next], [next, nn]] })
    }
  }
  if (prev && next && lo(next, axis) - hi(prev, axis) > len(moving, axis)) {
    const target = (hi(prev, axis) + lo(next, axis) - len(moving, axis)) / 2
    options.push({ delta: target - lo(moving, axis), spans: [[prev, moving], [moving, next]] })
  }
  const best = options
    .filter((option) => Math.abs(option.delta) <= threshold)
    .sort((a, b) => Math.abs(a.delta) - Math.abs(b.delta))[0]
  if (!best) return null
  const shifted = axis === 'x' ? { ...moving, x: moving.x + best.delta } : { ...moving, y: moving.y + best.delta }
  const fix = (r: Rect) => (r === moving ? shifted : r)
  return {
    delta: best.delta,
    guides: [
      {
        kind: 'gap',
        axis,
        spans: best.spans.map(([a, b]) => {
          const ra = fix(a)
          const rb = fix(b)
          const top = Math.max(lo(ra, o), lo(rb, o))
          const bottom = Math.min(hi(ra, o), hi(rb, o))
          return { from: hi(ra, axis), to: lo(rb, axis), at: (top + bottom) / 2 }
        }),
      },
    ],
  }
}

function pick(a: AxisSnap | null, b: AxisSnap | null): AxisSnap | null {
  if (!a) return b
  if (!b) return a
  if (Math.abs(a.delta - b.delta) < 0.5) return { delta: a.delta, guides: [...a.guides, ...b.guides] }
  return Math.abs(a.delta) <= Math.abs(b.delta) ? a : b
}

/**
 * Snaps a box being moved. `moving` is where the drag would put the selection's bounds;
 * `targets` are the other elements' bounds (collected once, at the start of the drag).
 * `threshold` is in world units (a few screen pixels over the zoom).
 */
export function snapMove(
  moving: Rect,
  targets: readonly Rect[],
  threshold: number,
): { dx: number; dy: number; guides: SnapGuide[] } {
  const near = targets.filter((t) => Math.abs(t.x - moving.x) < 4000 && Math.abs(t.y - moving.y) < 4000)
  const x = pick(
    alignAxis(moving, [moving.x, moving.x + moving.w / 2, moving.x + moving.w], near, 'x', threshold),
    spacingAxis(moving, near, 'x', threshold),
  )
  const y = pick(
    alignAxis(moving, [moving.y, moving.y + moving.h / 2, moving.y + moving.h], near, 'y', threshold),
    spacingAxis(moving, near, 'y', threshold),
  )
  const dx = x?.delta ?? 0
  const dy = y?.delta ?? 0
  // Guides are recomputed for the final box, so a line drawn on one axis spans the moved box.
  const final = { ...moving, x: moving.x + dx, y: moving.y + dy }
  const guides = [
    ...(x ? (alignAxis(final, [final.x, final.x + final.w / 2, final.x + final.w], near, 'x', 0.5)?.guides ?? []) : []),
    ...(x ? x.guides.filter((g) => g.kind === 'gap') : []),
    ...(y ? (alignAxis(final, [final.y, final.y + final.h / 2, final.y + final.h], near, 'y', 0.5)?.guides ?? []) : []),
    ...(y ? y.guides.filter((g) => g.kind === 'gap') : []),
  ]
  return { dx, dy, guides }
}

/**
 * Snaps the edges a resize handle drags (the opposite edges stay put) to other elements' edges
 * and centres. Returns the corrected box and its guides.
 */
export function snapResize(
  rect: Rect,
  handle: Handle,
  targets: readonly Rect[],
  threshold: number,
): { rect: Rect; guides: SnapGuide[] } {
  const near = targets.filter((t) => Math.abs(t.x - rect.x) < 4000 && Math.abs(t.y - rect.y) < 4000)
  let { x, y, w, h } = rect
  const guides: SnapGuide[] = []
  if (handle.includes('e') || handle.includes('w')) {
    const west = handle.includes('w')
    const edge = west ? x : x + w
    const snap = alignAxis(rect, [edge], near, 'x', threshold)
    if (snap && (west ? w - snap.delta : w + snap.delta) >= 16) {
      if (west) {
        x += snap.delta
        w -= snap.delta
      } else w += snap.delta
      guides.push(...snap.guides)
    }
  }
  if (handle.includes('n') || handle.includes('s')) {
    const north = handle.includes('n')
    const edge = north ? y : y + h
    const snap = alignAxis({ x, y, w, h }, [edge], near, 'y', threshold)
    if (snap && (north ? h - snap.delta : h + snap.delta) >= 16) {
      if (north) {
        y += snap.delta
        h -= snap.delta
      } else h += snap.delta
      guides.push(...snap.guides)
    }
  }
  return { rect: { x, y, w, h }, guides }
}
