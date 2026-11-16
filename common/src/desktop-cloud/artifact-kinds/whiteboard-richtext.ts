/**
 * Rich text in notes and shapes, kept as plain `text` with three light marks, so an agent and an
 * old reader both see readable words:
 *   **bold**   *italic* (or _italic_)   a line starting with "- " (or "• ") is a bullet.
 * A mark only counts when it hugs a word (`2 * 3` stays as typed); an unclosed mark is literal.
 * This file parses the marks into runs, wraps runs into lines, fits them in a box, and edits
 * marks around a textarea selection. Pure: no DOM.
 */

import type { Measure } from './whiteboard-geometry'
import { LINE_HEIGHT } from './whiteboard'

export type Run = { text: string; bold?: boolean; italic?: boolean }
export type RichLine = { runs: Run[]; bullet: boolean; /** The first visual line of its bullet. */ lead: boolean }
export type RichBlock = { lines: RichLine[]; fontSize: number; lineHeight: number; hasBullets: boolean }

/** Bold type is drawn a little wider than the measure (measured at regular weight). */
export const BOLD_WIDTH = 1.06

const BULLET = /^\s*(?:[-*•])\s+/

/** Whether a paragraph is a bullet, and its text without the marker. */
export function splitBullet(paragraph: string): { bullet: boolean; body: string } {
  const match = BULLET.exec(paragraph)
  // "* " starting a line is a bullet only when it is not the start of an italic run.
  if (match && !/^\s*\*\S/.test(paragraph)) return { bullet: true, body: paragraph.slice(match[0].length) }
  return { bullet: false, body: paragraph }
}

/** The runs of one paragraph (no newlines). */
export function parseInline(text: string): Run[] {
  const runs: Run[] = []
  let bold = false
  let italic: '*' | '_' | null = null
  let buffer = ''
  const flush = () => {
    if (!buffer) return
    const run: Run = { text: buffer }
    if (bold) run.bold = true
    if (italic) run.italic = true
    const last = runs[runs.length - 1]
    if (last && !!last.bold === !!run.bold && !!last.italic === !!run.italic) last.text += buffer
    else runs.push(run)
    buffer = ''
  }
  // A closing mark must exist ahead for an opening one to count.
  const closes = (from: number, mark: string) => {
    for (let j = from; j <= text.length - mark.length; j++) {
      if (text.startsWith(mark, j) && j > from && !/\s/.test(text[j - 1])) {
        if (mark === '*' && text.startsWith('**', j) && !text.startsWith('***', j)) {
          j++
          continue
        }
        return true
      }
    }
    return false
  }
  let i = 0
  while (i < text.length) {
    const prev = i > 0 ? text[i - 1] : ' '
    if (text.startsWith('**', i)) {
      const next = text[i + 2] ?? ' '
      if (bold && !/\s/.test(prev)) {
        flush()
        bold = false
        i += 2
        continue
      }
      // An opener starts a word: `a**b**` mid-word stays as typed.
      if (!bold && !/\s/.test(next) && !/\w/.test(prev) && closes(i + 2, '**')) {
        flush()
        bold = true
        i += 2
        continue
      }
    }
    const ch = text[i]
    if (ch === '*' || ch === '_') {
      const next = text[i + 1] ?? ' '
      if (italic === ch && !/\s/.test(prev)) {
        flush()
        italic = null
        i += 1
        continue
      }
      // A mark inside a word (snake_case, 2*3*4) is literal.
      const wordy = /\w/.test(prev)
      if (!italic && !wordy && !/\s/.test(next) && closes(i + 1, ch)) {
        flush()
        italic = ch
        i += 1
        continue
      }
    }
    buffer += ch
    i += 1
  }
  flush()
  return runs
}

/** The text without its marks (for search, summaries and the agent). */
export function plainRichText(text: string): string {
  return text
    .split('\n')
    .map((paragraph) => {
      const { bullet, body } = splitBullet(paragraph)
      const words = parseInline(body)
        .map((run) => run.text)
        .join('')
      return bullet ? `• ${words}` : words
    })
    .join('\n')
}

/** Whether `text` uses any mark (so a plain note keeps the plain, centred layout). */
export function hasRichMarks(text: string): boolean {
  return text.split('\n').some((paragraph) => {
    const { bullet, body } = splitBullet(paragraph)
    return bullet || parseInline(body).some((run) => run.bold || run.italic)
  })
}

const runWidth = (run: Run, fontSize: number, measure: Measure) =>
  measure(run.text, fontSize) * (run.bold ? BOLD_WIDTH : 1)

/**
 * Wraps rich text to `maxWidth`. Bullet lines (and their wrapped continuations) are indented by
 * `indent`; a word wider than a line is cut.
 */
export function layoutRichText(
  text: string,
  fontSize: number,
  maxWidth: number,
  measure: Measure,
): RichLine[] {
  const indent = fontSize * 1.1
  const out: RichLine[] = []
  for (const paragraph of text.split('\n')) {
    const { bullet, body } = splitBullet(paragraph)
    const width = Math.max(1, maxWidth - (bullet ? indent : 0))
    // Tokens: words and the spaces between them, each keeping its run's style.
    const tokens: Run[] = []
    for (const run of parseInline(body)) {
      for (const piece of run.text.split(/(\s+)/)) {
        if (piece) tokens.push({ ...run, text: piece })
      }
    }
    let line: Run[] = []
    let used = 0
    let lead = true
    const push = () => {
      // Trailing spaces never count toward a line.
      while (line.length && /^\s+$/.test(line[line.length - 1].text)) line.pop()
      out.push({ runs: merge(line), bullet, lead })
      lead = false
      line = []
      used = 0
    }
    for (const token of tokens) {
      const space = /^\s+$/.test(token.text)
      if (space && line.length === 0) continue
      let w = runWidth(token, fontSize, measure)
      if (used + w <= width || space) {
        line.push(token)
        used += w
        continue
      }
      if (line.length) push()
      let piece = token
      while (runWidth(piece, fontSize, measure) > width && piece.text.length > 1) {
        let cut = piece.text.length - 1
        while (cut > 1 && runWidth({ ...piece, text: piece.text.slice(0, cut) }, fontSize, measure) > width) cut--
        line.push({ ...piece, text: piece.text.slice(0, cut) })
        push()
        piece = { ...piece, text: piece.text.slice(cut) }
      }
      w = runWidth(piece, fontSize, measure)
      line.push(piece)
      used = w
    }
    push()
  }
  return out
}

function merge(runs: Run[]): Run[] {
  const out: Run[] = []
  for (const run of runs) {
    const last = out[out.length - 1]
    if (last && !!last.bold === !!run.bold && !!last.italic === !!run.italic) out[out.length - 1] = { ...last, text: last.text + run.text }
    else out.push({ ...run })
  }
  return out
}

/**
 * The largest of `steps` at which the text fits `width × height` (the smallest overflows and is
 * clipped when nothing fits).
 */
export function fitRichText(
  text: string,
  width: number,
  height: number,
  measure: Measure,
  steps: readonly number[],
): RichBlock {
  const hasBullets = text.split('\n').some((p) => splitBullet(p).bullet)
  for (const fontSize of steps) {
    const lines = layoutRichText(text, fontSize, width, measure)
    const lineHeight = fontSize * LINE_HEIGHT
    if (lines.length * lineHeight <= height) return { lines, fontSize, lineHeight, hasBullets }
  }
  const fontSize = steps[steps.length - 1]
  return { lines: layoutRichText(text, fontSize, width, measure), fontSize, lineHeight: fontSize * LINE_HEIGHT, hasBullets }
}

// ---- editing marks in a textarea

export type TextSelection = { value: string; start: number; end: number }

/**
 * Wraps the selection in `mark` (`**` bold, `*` italic), or unwraps it when it is already
 * wrapped. An empty selection inserts the pair with the caret between.
 */
export function toggleMark(sel: TextSelection, mark: '**' | '*'): TextSelection {
  const { value } = sel
  let { start, end } = sel
  // Leave surrounding spaces outside the marks.
  while (start < end && /\s/.test(value[start])) start++
  while (end > start && /\s/.test(value[end - 1])) end--
  const before = value.slice(0, start)
  const inner = value.slice(start, end)
  const after = value.slice(end)
  // Stars hugging the selection: 1 or 3 is italic (3 is bold italic), 2 or 3 is bold.
  const starsBefore = /\**$/.exec(before)![0].length
  const starsAfter = /^\**/.exec(after)![0].length
  const stars = Math.min(starsBefore, starsAfter)
  const wrappedOutside = mark === '**' ? stars >= 2 : stars === 1 || stars === 3
  if (wrappedOutside) {
    return {
      value: before.slice(0, -mark.length) + inner + after.slice(mark.length),
      start: start - mark.length,
      end: end - mark.length,
    }
  }
  if (inner.length >= mark.length * 2 && inner.startsWith(mark) && inner.endsWith(mark)) {
    const stripped = inner.slice(mark.length, inner.length - mark.length)
    return { value: before + stripped + after, start, end: start + stripped.length }
  }
  return {
    value: before + mark + inner + mark + after,
    start: start + mark.length,
    end: end + mark.length,
  }
}

/** Turns the lines the selection touches into bullets, or back to plain lines when all are bullets. */
export function toggleBullets(sel: TextSelection): TextSelection {
  const { value, start, end } = sel
  const lineStart = value.lastIndexOf('\n', start - 1) + 1
  const nextBreak = value.indexOf('\n', Math.max(end, start) - (end > start && value[end - 1] === '\n' ? 1 : 0))
  const lineEnd = nextBreak === -1 ? value.length : nextBreak
  const block = value.slice(lineStart, lineEnd)
  const lines = block.split('\n')
  const all = lines.every((line) => splitBullet(line).bullet || !line.trim())
  const next = lines
    .map((line) => {
      if (all) return line.replace(BULLET, '')
      if (!line.trim() || splitBullet(line).bullet) return line
      return `- ${line}`
    })
    .join('\n')
  const replaced = value.slice(0, lineStart) + next + value.slice(lineEnd)
  return { value: replaced, start: lineStart, end: lineStart + next.length }
}
