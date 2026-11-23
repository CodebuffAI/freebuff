/**
 * Board checks (round 5): what a reader would notice is wrong with a board, measured the way the
 * editor draws it. The editor's Checks panel lists them (each with "Ask Buffy to fix", carrying
 * the element ids) and the agent's read returns them, so both see the same issues:
 *   overlap          two boxes cover each other (not a sticker on a note, not text on a shape,
 *                    not members of one group, never a section and what sits in it);
 *   text-overflow    a note's, shape's or table cell's text does not fit its box even at the
 *                    smallest size (it is clipped);
 *   tiny-text        the text only fits by shrinking below 12 px;
 *   section-edge     an element straddles a section's edge: half in, so it looks like a member
 *                    but does not move with the section (or sticks out of it);
 *   dangling-arrow   an arrow end points at nothing (a free point, not an element);
 *   duplicate-arrow  two arrows join the same two elements the same way;
 *   low-contrast     a custom (#rrggbb) line colour that almost vanishes on the light or dark canvas.
 * Hidden elements are not checked. Pure and deterministic; O(n log n + overlaps) with a sweep, so
 * it runs off the drag path (the panel computes it when shown, the server on read).
 */

import { tableCellRect, tableMerges, tableSize } from './whiteboard-arrange'
import {
  center,
  elementBounds,
  estimateMeasure,
  fitTextInBox,
  geometryContext,
  NOTE_PADDING,
  pointInRect,
  rectContains,
  shapeTextBox,
  wrapText,
  type GeometryContext,
  type Measure,
} from './whiteboard-geometry'
import { visibleBoard } from './whiteboard-r5'
import { plainRichText } from './whiteboard-richtext'
import { isBoundEnd, isHexColor, TEXT_SIZE_PX, type Rect, type WhiteboardBoard, type WhiteboardElement } from './whiteboard'

export const LINT_RULES = [
  'overlap',
  'text-overflow',
  'tiny-text',
  'section-edge',
  'dangling-arrow',
  'duplicate-arrow',
  'low-contrast',
] as const
export type LintRule = (typeof LINT_RULES)[number]

export type BoardIssue = {
  rule: LintRule
  /** The elements it is about (first the one to fix). */
  ids: string[]
  message: string
  /** What would fix it, in a few words. */
  fix: string
}

/** Most issues listed (the rest are counted). */
export const MAX_BOARD_ISSUES = 60

const NOTE_STEPS = [22, 18, 16, 14, 12, 10]
const SHAPE_STEPS = [16, 14, 12, 10]
const CELL_STEPS = [14, 13, 12, 11, 10]
const TINY_PX = 12

const area = (r: Rect) => Math.max(0, r.w) * Math.max(0, r.h)
function overlapArea(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
  return w > 0 && h > 0 ? w * h : 0
}

function name(element: WhiteboardElement): string {
  const text =
    element.type === 'note' || element.type === 'text'
      ? element.text
      : element.type === 'shape'
        ? element.text ?? ''
        : element.type === 'section' || element.type === 'link'
          ? element.title
          : ''
  const clean = plainRichText(text).replace(/\s+/g, ' ').trim()
  const noun = element.type === 'stroke' ? 'sketch' : element.type === 'link' ? 'link card' : element.type
  return clean ? `${noun} "${clean.length > 30 ? `${clean.slice(0, 29)}…` : clean}"` : `${noun} ${element.id}`
}

/** Relative luminance of `#rrggbb` (WCAG). */
function luminance(hex: string): number {
  const channel = (i: number) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5)
}

/** WCAG contrast ratio of two `#rrggbb` colours (1 to 21). */
export function contrastRatio(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [number, number]
  return (x + 0.05) / (y + 0.05)
}

/** The ink a custom fill gets so its text reads: near-black on light fills, near-white on dark. */
export function inkOn(fill: string): string {
  return contrastRatio(fill, '#1f2328') >= contrastRatio(fill, '#ffffff') ? '#1f2328' : '#ffffff'
}

/** The light and dark canvas backgrounds a line colour must show on. */
export const CANVAS_BACKGROUNDS = ['#ffffff', '#1c1c1e'] as const
const LINE_CONTRAST_MIN = 1.5

/** Text fit: does `text` fit `box` at some step, and at which size. */
function fit(text: string, box: Rect, measure: Measure, steps: readonly number[], fixed?: number) {
  const plain = plainRichText(text)
  if (fixed) {
    const lines = plain.split('\n').flatMap((line) => wrapText(line, fixed, box.w, measure)).length
    return { fits: lines * fixed * 1.3 <= box.h + 0.5, size: fixed }
  }
  const block = fitTextInBox(plain, box.w, box.h, measure, steps)
  return { fits: block.lines.length * block.lineHeight <= box.h + 0.5, size: block.fontSize }
}

/** The checks for one board. */
export function lintBoard(board: WhiteboardBoard, measure: Measure = estimateMeasure): { issues: BoardIssue[]; total: number } {
  const ctx: GeometryContext = geometryContext(board.elements, measure)
  const issues: BoardIssue[] = []
  const add = (issue: BoardIssue) => issues.push(issue)
  // As a reader sees it: hidden elements, and arrows bound to them, are not checked.
  const shown = visibleBoard(board).elements
  const bounds = new Map(shown.map((element) => [element.id, elementBounds(element, ctx)]))
  const sections = shown.filter((element) => element.type === 'section')

  // ---- text that does not fit
  for (const element of shown) {
    if (element.type === 'note' && element.text.trim()) {
      const box = { x: 0, y: 0, w: element.w - 2 * NOTE_PADDING, h: element.h - 2 * NOTE_PADDING }
      const result = fit(element.text, box, measure, NOTE_STEPS, element.fontSize ? TEXT_SIZE_PX[element.fontSize] : undefined)
      if (!result.fits) add({ rule: 'text-overflow', ids: [element.id], message: `The text of ${name(element)} does not fit; it is cut off.`, fix: 'Make the note bigger, turn on auto-size, or shorten the text.' })
      else if (!element.fontSize && result.size < TINY_PX) add({ rule: 'tiny-text', ids: [element.id], message: `${name(element)} only fits its text at ${result.size}px.`, fix: 'Make the note bigger or shorten the text.' })
    } else if (element.type === 'shape' && element.text?.trim() && !element.timer) {
      const box = shapeTextBox(element.kind, element)
      const result = fit(element.text, box, measure, SHAPE_STEPS, element.fontSize ? TEXT_SIZE_PX[element.fontSize] : undefined)
      if (!result.fits) add({ rule: 'text-overflow', ids: [element.id], message: `The label of ${name(element)} does not fit; it is cut off.`, fix: 'Make the shape bigger or shorten the label.' })
      else if (!element.fontSize && result.size < TINY_PX) add({ rule: 'tiny-text', ids: [element.id], message: `${name(element)} only fits its label at ${result.size}px.`, fix: 'Make the shape bigger or shorten the label.' })
    } else if (element.type === 'table') {
      const { rows, cols } = tableSize(element)
      const covered = new Set<string>()
      for (const merge of tableMerges(element)) {
        for (let r = merge.row; r < merge.row + merge.rows; r++) for (let c = merge.col; c < merge.col + merge.cols; c++) if (r !== merge.row || c !== merge.col) covered.add(`${r}:${c}`)
      }
      let worst: string | null = null
      for (let r = 0; r < rows && !worst; r++) {
        for (let c = 0; c < cols; c++) {
          const cell = element.rows[r]![c]!
          if (!cell.trim() || covered.has(`${r}:${c}`)) continue
          const rect = tableCellRect(element, r, c)
          const result = fit(cell, { x: 0, y: 0, w: rect.w - 16, h: rect.h - 4 }, measure, CELL_STEPS)
          if (!result.fits) {
            worst = `row ${r + 1}, column ${c + 1}`
            break
          }
        }
      }
      if (worst) add({ rule: 'text-overflow', ids: [element.id], message: `A cell of table ${element.id} (${worst}) is cut off.`, fix: 'Widen that column, add height to the row, or shorten the text.' })
    }
  }

  // ---- overlaps (a sweep over x)
  const boxes = shown.filter(
    (element) => element.type === 'note' || element.type === 'shape' || element.type === 'image' || element.type === 'table' || element.type === 'link' || element.type === 'text',
  )
  const sorted = boxes.map((element) => ({ element, r: bounds.get(element.id)! })).sort((a, b) => a.r.x - b.r.x)
  const sameGroup = (a: WhiteboardElement, b: WhiteboardElement) => !!a.groups?.some((group) => b.groups?.includes(group))
  let overlaps = 0
  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i]!
    for (let j = i + 1; j < sorted.length; j++) {
      const b = sorted[j]!
      if (b.r.x >= a.r.x + a.r.w) break
      const shared = overlapArea(a.r, b.r)
      if (!shared) continue
      if (sameGroup(a.element, b.element)) continue
      // Text laid over a box is a label, not a clash.
      if ((a.element.type === 'text' && rectContains(b.r, a.r)) || (b.element.type === 'text' && rectContains(a.r, b.r))) continue
      if (shared < 0.15 * Math.min(area(a.r), area(b.r))) continue
      const [top, under] = board.elements.indexOf(a.element) > board.elements.indexOf(b.element) ? [a.element, b.element] : [b.element, a.element]
      overlaps++
      if (overlaps <= 30) add({ rule: 'overlap', ids: [top.id, under.id], message: `${name(top)} covers ${name(under)}.`, fix: 'Move one of them apart (40 units between neighbours), or use Tidy up.' })
    }
  }

  // ---- half in a section
  for (const element of shown) {
    if (element.type === 'section' || element.type === 'arrow' || element.type === 'sticker' || element.type === 'stroke') continue
    const r = bounds.get(element.id)!
    const c = center(r)
    for (const section of sections) {
      const s = bounds.get(section.id)!
      if (rectContains(s, r) || rectContains(r, s)) continue
      const shared = overlapArea(r, s)
      if (!shared) continue
      const inside = pointInRect(c, s)
      if (inside && shared > 0.5 * area(r)) {
        add({ rule: 'section-edge', ids: [element.id, section.id], message: `${name(element)} sticks out of ${name(section)}.`, fix: 'Move it fully inside, or make the section bigger.' })
      } else if (!inside && shared > 0.25 * area(r)) {
        add({ rule: 'section-edge', ids: [element.id, section.id], message: `${name(element)} sits half in ${name(section)} but is not part of it (it will not move with it).`, fix: 'Move it fully into the section, or out of it.' })
      }
    }
  }

  // ---- arrows
  const seen = new Map<string, string>()
  for (const element of shown) {
    if (element.type !== 'arrow') continue
    const free = [element.from, element.to].filter((end) => !isBoundEnd(end)).length
    if (free > 0) add({ rule: 'dangling-arrow', ids: [element.id], message: `Arrow ${element.label ? `"${element.label}" ` : ''}${element.id} has ${free === 2 ? 'both ends' : 'an end'} pointing at nothing.`, fix: 'Attach its ends to elements, or remove it.' })
    else if (isBoundEnd(element.from) && isBoundEnd(element.to)) {
      const key = `${element.from.elementId}>${element.to.elementId}`
      const earlier = seen.get(key)
      if (earlier) add({ rule: 'duplicate-arrow', ids: [element.id, earlier], message: `Arrows ${earlier} and ${element.id} join the same two elements.`, fix: 'Remove one of them.' })
      else seen.set(key, element.id)
    }
    if (element.stroke && isHexColor(element.stroke)) {
      const worst = Math.min(...CANVAS_BACKGROUNDS.map((bg) => contrastRatio(element.stroke!, bg)))
      if (worst < LINE_CONTRAST_MIN) add({ rule: 'low-contrast', ids: [element.id], message: `Arrow ${element.id}'s colour ${element.stroke} almost vanishes on the ${contrastRatio(element.stroke, '#ffffff') < LINE_CONTRAST_MIN ? 'light' : 'dark'} canvas.`, fix: 'Use a colour name (it adapts to the theme) or a mid-tone hex.' })
    }
  }
  for (const element of shown) {
    const stroke = 'stroke' in element && element.type !== 'arrow' ? element.stroke : undefined
    if (!stroke || !isHexColor(stroke)) continue
    const fill = 'fill' in element ? element.fill : undefined
    if (fill) continue // a filled body shows either way
    const worst = Math.min(...CANVAS_BACKGROUNDS.map((bg) => contrastRatio(stroke, bg)))
    if (worst < LINE_CONTRAST_MIN && element.type === 'section') add({ rule: 'low-contrast', ids: [element.id], message: `${name(element)}'s outline ${stroke} almost vanishes on one theme.`, fix: 'Use a colour name or a mid-tone hex.' })
  }

  const order = new Map(LINT_RULES.map((rule, i) => [rule, i]))
  issues.sort((a, b) => order.get(a.rule)! - order.get(b.rule)!)
  // Overlaps past the 30 listed still count towards the total.
  return { issues: issues.slice(0, MAX_BOARD_ISSUES), total: issues.length + Math.max(0, overlaps - 30) }
}

/** The issues as plain lines (the agent's read, an Ask Buffy request). */
export function formatBoardIssues(result: { issues: BoardIssue[]; total: number }): string[] {
  const lines = result.issues.map((issue) => `- [${issue.rule}] ${issue.message} Fix: ${issue.fix} (ids: ${issue.ids.join(', ')})`)
  if (result.total > result.issues.length) lines.push(`- … ${result.total - result.issues.length} more`)
  return lines
}
