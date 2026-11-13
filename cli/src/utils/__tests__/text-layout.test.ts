import { describe, test, expect } from 'bun:test'

import { computeInputLayoutMetrics, getLastNVisualLines } from '../text-layout'

describe('computeInputLayoutMetrics', () => {
  test('single-line content keeps height at 1 without gutter', () => {
    const metrics = computeInputLayoutMetrics({
      layoutContent: 'hello world',
      cursorProbe: 'hello world',
      cols: 40,
      maxHeight: 5,
    })

    expect(metrics.heightLines).toBe(1)
    expect(metrics.gutterEnabled).toBe(false)
  })

  test('counts leading indentation toward wrapped line width', () => {
    const metrics = computeInputLayoutMetrics({
      layoutContent: '    indent',
      cursorProbe: '    indent',
      cols: 8,
      maxHeight: 2,
    })

    expect(metrics.heightLines).toBe(2)
    expect(metrics.gutterEnabled).toBe(false)
  })

  test('adds gutter when two lines and cursor on second line', () => {
    const layoutContent = 'first line\nsecond line'
    const cursorProbe = 'first line\nsecond line'

    const metrics = computeInputLayoutMetrics({
      layoutContent,
      cursorProbe,
      cols: 40,
      maxHeight: 5,
    })

    expect(metrics.heightLines).toBe(3)
    expect(metrics.gutterEnabled).toBe(true)
  })

  test('omits gutter when maxHeight would be exceeded', () => {
    const metrics = computeInputLayoutMetrics({
      layoutContent: 'a long first line\nand a second line',
      cursorProbe: 'a long first line\nand a second line',
      cols: 80,
      maxHeight: 2,
    })

    expect(metrics.heightLines).toBe(2)
    expect(metrics.gutterEnabled).toBe(false)
  })

  test('respects a minimum height constraint', () => {
    const metrics = computeInputLayoutMetrics({
      layoutContent: 'short',
      cursorProbe: 'short',
      cols: 40,
      maxHeight: 5,
      minHeight: 3,
    })

    expect(metrics.heightLines).toBe(3)
    expect(metrics.gutterEnabled).toBe(false)
  })

  test('caps the minimum height at the max height', () => {
    const metrics = computeInputLayoutMetrics({
      layoutContent: 'tiny',
      cursorProbe: 'tiny',
      cols: 40,
      maxHeight: 2,
      minHeight: 5,
    })

    expect(metrics.heightLines).toBe(2)
    expect(metrics.gutterEnabled).toBe(false)
  })
})

describe('getLastNVisualLines', () => {
  test('returns empty array when n or cols <= 0 or text is empty', () => {
    expect(getLastNVisualLines('', 40, 5)).toEqual({ lines: [], hasMore: false })
    expect(getLastNVisualLines('hello', 0, 5)).toEqual({ lines: [], hasMore: false })
    expect(getLastNVisualLines('hello', 40, 0)).toEqual({ lines: [], hasMore: false })
  })

  test('returns all lines without hasMore when line count <= n', () => {
    const text = 'line 1\nline 2\nline 3'
    const result = getLastNVisualLines(text, 40, 5)
    expect(result.lines).toEqual(['line 1', 'line 2', 'line 3'])
    expect(result.hasMore).toBe(false)
  })

  test('returns only last n lines with hasMore = true when line count > n', () => {
    const text = 'line 1\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7'
    const result = getLastNVisualLines(text, 40, 3)
    expect(result.lines).toEqual(['line 5', 'line 6', 'line 7'])
    expect(result.hasMore).toBe(true)
  })

  test('correctly bounds array when text has hundreds of wrapped lines', () => {
    const text = Array.from({ length: 100 }, (_, i) => `Line ${i}`).join('\n')
    const result = getLastNVisualLines(text, 40, 4)
    expect(result.lines).toEqual(['Line 96', 'Line 97', 'Line 98', 'Line 99'])
    expect(result.hasMore).toBe(true)
  })

  test('wraps long lines exceeding column width', () => {
    const text = 'supercalifragilisticexpialidocious'
    const result = getLastNVisualLines(text, 10, 2)
    expect(result.lines.length).toBe(2)
    expect(result.hasMore).toBe(true)
  })
})
