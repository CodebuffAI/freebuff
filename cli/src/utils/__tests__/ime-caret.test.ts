import { describe, expect, test } from 'bun:test'

import { caretCell } from '../ime-caret'

const base = {
  lineStarts: [0],
  originRow: 3,
  originCol: 2,
  viewportTop: 3,
  viewportRows: 4,
}

describe('caretCell', () => {
  test('puts the caret after the text on a single line', () => {
    expect(caretCell({ ...base, text: 'hello', caretIndex: 5 })).toEqual({
      col: 8,
      row: 4,
    })
  })

  test('moves with the caret inside a line', () => {
    expect(caretCell({ ...base, text: 'hello', caretIndex: 0 })).toEqual({
      col: 3,
      row: 4,
    })
    expect(caretCell({ ...base, text: 'hello', caretIndex: 2 })).toEqual({
      col: 5,
      row: 4,
    })
  })

  test('counts a CJK glyph as two cells, not one', () => {
    // 你 = 2 cells: the caret after it sits on column 5, not 4.
    expect(caretCell({ ...base, text: '你好', caretIndex: 1 })).toEqual({
      col: 5,
      row: 4,
    })
    expect(caretCell({ ...base, text: '你好', caretIndex: 2 })).toEqual({
      col: 7,
      row: 4,
    })
  })

  test('mixes CJK and ASCII correctly', () => {
    expect(caretCell({ ...base, text: 'a你b', caretIndex: 3 })).toEqual({
      col: 7,
      row: 4,
    })
  })

  test('follows the visual line the caret is on', () => {
    const multiline = {
      ...base,
      lineStarts: [0, 6, 11],
      text: 'first\nsecond\nthird',
    }
    expect(caretCell({ ...multiline, caretIndex: 0 })?.row).toBe(4)
    expect(caretCell({ ...multiline, caretIndex: 6 })?.row).toBe(5)
    expect(caretCell({ ...multiline, caretIndex: 11 })?.row).toBe(6)
    // Column restarts at the visual line start.
    expect(caretCell({ ...multiline, caretIndex: 13 })).toEqual({
      col: 4,
      row: 6,
    })
  })

  test('returns null when the caret row is scrolled out of view', () => {
    expect(
      caretCell({
        ...base,
        text: 'first\nsecond\nthird',
        lineStarts: [0, 6, 11],
        caretIndex: 0,
        originRow: 1, // first line is above the visible area
      }),
    ).toBeNull()
    expect(
      caretCell({
        ...base,
        text: 'a\nb',
        lineStarts: [0, 2],
        caretIndex: 2,
        viewportRows: 1, // only the first line is visible
      }),
    ).toBeNull()
  })

  test('handles the first row of the viewport', () => {
    expect(
      caretCell({
        ...base,
        text: 'a\nb',
        lineStarts: [0, 2],
        caretIndex: 2,
        viewportRows: 2,
      }),
    ).toEqual({ col: 3, row: 5 })
  })

  test('clamps a caret index past the end of the text', () => {
    expect(caretCell({ ...base, text: 'hi', caretIndex: 99 })).toEqual(
      caretCell({ ...base, text: 'hi', caretIndex: 2 }),
    )
  })

  test('falls back to a single line when the buffer has no line info', () => {
    expect(
      caretCell({ ...base, text: 'hi', caretIndex: 1, lineStarts: [] }),
    ).toEqual({ col: 4, row: 4 })
  })
})
