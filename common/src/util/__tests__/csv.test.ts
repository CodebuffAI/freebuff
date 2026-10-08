import { describe, expect, test } from 'bun:test'

import { csvCell, csvRow } from '../csv'

describe('csvCell', () => {
  test('leaves plain values bare', () => {
    expect(csvCell('Acme')).toBe('Acme')
    expect(csvCell(42)).toBe('42')
    expect(csvCell(null)).toBe('')
    expect(csvCell(undefined)).toBe('')
  })

  test('quotes and doubles embedded quotes, commas and newlines', () => {
    expect(csvCell('a "b" c')).toBe('"a ""b"" c"')
    expect(csvCell('a,b')).toBe('"a,b"')
    expect(csvCell('a\nb')).toBe('"a\nb"')
    expect(csvCell('a\rb')).toBe('"a\rb"')
  })

  test.each([
    ['=HYPERLINK("http://x","y")', `"'=HYPERLINK(""http://x"",""y"")"`],
    ['+1+1', "'+1+1"],
    ['-2+3', "'-2+3"],
    ['@SUM(A1)', "'@SUM(A1)"],
    ['\t=1+1', "'\t=1+1"],
    ['\r=1+1', `"'\r=1+1"`],
    [' =1+1', "' =1+1"],
    ['﻿=1+1', "'﻿=1+1"],
  ])('neutralises the formula %j', (input, expected) => {
    expect(csvCell(input)).toBe(expected)
  })

  test('a field cannot break out of its quotes into the next column', () => {
    expect(csvRow(['x", "=1+1', 'next'])).toBe('"x"", ""=1+1",next')
  })
})
