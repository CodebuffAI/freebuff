/**
 * Where the terminal's *hardware* cursor has to sit so an IME puts its
 * candidate window on the caret.
 *
 * Terminals anchor the IME composition/candidate window to the real cursor
 * position (Windows Terminal via ConPTY, macOS via AXBoundsForRange, Linux via
 * ibus/fcitx cursor tracking). This input draws its own caret glyph and never
 * moves the real cursor, so the popup ends up wherever the last frame happened
 * to write text. See issue #1128.
 *
 * Returned coordinates are 1-based, which is what `renderer.setCursorPosition`
 * expects: the framework's own edit-buffer renderable adds 1 for the same
 * reason.
 */
import stringWidth from 'string-width'

export type CaretCell = {
  /** 1-based screen column. */
  col: number
  /** 1-based screen row. */
  row: number
}

export type CaretCellInput = {
  /** Rendered text, with tabs already expanded to spaces. */
  text: string
  /** Caret offset into `text`, as a string index. */
  caretIndex: number
  /** First character index of each visual (wrapped) line, from the text buffer. */
  lineStarts: readonly number[]
  /** 0-based screen row of the first row of `text`. */
  originRow: number
  /** 0-based screen column of the left edge of `text`. */
  originCol: number
  /** 0-based screen row of the top of the visible input area. */
  viewportTop: number
  /** How many rows of the input area are visible. */
  viewportRows: number
}

/**
 * Cell for the caret, or `null` when it is scrolled out of view — a real cursor
 * parked outside the input box would be worse than no cursor at all.
 */
export function caretCell(input: CaretCellInput): CaretCell | null {
  const {
    text,
    lineStarts,
    originRow,
    originCol,
    viewportTop,
    viewportRows,
  } = input
  const caretIndex = Math.max(0, Math.min(input.caretIndex, text.length))

  const starts = lineStarts.length > 0 ? lineStarts : [0]
  let lineIndex = 0
  for (let i = 0; i < starts.length; i++) {
    if (starts[i] > caretIndex) break
    lineIndex = i
  }
  const lineStart = starts[lineIndex] ?? 0

  // CJK glyphs occupy two cells, so the column must be measured in cells and
  // never in string indices.
  const colInLine = stringWidth(text.slice(lineStart, caretIndex))
  const row = originRow + lineIndex

  if (row < viewportTop || row >= viewportTop + viewportRows) return null

  return { col: originCol + colInLine + 1, row: row + 1 }
}
