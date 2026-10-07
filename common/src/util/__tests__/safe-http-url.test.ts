import { describe, expect, test } from 'bun:test'

import { safeHttpUrl } from '../safe-http-url'

const UNSAFE = [
  'javascript:alert(1)',
  'JaVaScRiPt:alert(1)',
  ' javascript:alert(1)',
  '\tjavascript:alert(1)',
  '\x00javascript:alert(1)',
  '\x1b javascript:alert(1)',
  'java\nscript:alert(1)',
  'java\tscript:alert(1)',
  'data:text/html,<script>alert(1)</script>',
  'DATA:text/html;base64,PHNjcmlwdD4=',
  'vbscript:msgbox(1)',
  ' VBScript:msgbox(1)',
  'file:///etc/passwd',
  'ms-msdt:/id PCWDiagnostic',
  'blob:https://example.com/uuid',
]

describe('safeHttpUrl', () => {
  test('returns http(s) URLs unchanged', () => {
    expect(safeHttpUrl('https://example.com/a?b=1')).toBe(
      'https://example.com/a?b=1',
    )
    expect(safeHttpUrl('http://example.com')).toBe('http://example.com')
    expect(safeHttpUrl('HTTPS://Example.com/x')).toBe('HTTPS://Example.com/x')
  })

  test.each(UNSAFE)('refuses %p', (value) => {
    expect(safeHttpUrl(value)).toBeUndefined()
    expect(safeHttpUrl(value, { allowRelative: true })).toBeUndefined()
  })

  test('refuses empty and non-string values', () => {
    for (const value of [undefined, null, '', '   ', 42, {}, ['https://a.b']]) {
      expect(safeHttpUrl(value)).toBeUndefined()
      expect(safeHttpUrl(value, { allowRelative: true })).toBeUndefined()
    }
  })

  test('refuses relative references unless they are allowed', () => {
    const relative = '/api/ads/first-party/click/abc'
    expect(safeHttpUrl(relative)).toBeUndefined()
    expect(safeHttpUrl(relative, { allowRelative: true })).toBe(relative)
    expect(safeHttpUrl('plans?x=1', { allowRelative: true })).toBe('plans?x=1')
  })

  test('refuses a scheme-bearing value that does not parse', () => {
    expect(safeHttpUrl('http://[bad', { allowRelative: true })).toBeUndefined()
  })
})
