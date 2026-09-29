import { describe, expect, test } from 'bun:test'

import { isOpenableWebUrl, safeOpen } from '../open-url'

describe('isOpenableWebUrl', () => {
  test('accepts absolute http(s) URLs', () => {
    expect(isOpenableWebUrl('https://codebuff.com/usage')).toBe(true)
    expect(isOpenableWebUrl('https://greptile.com?click=1&x=%20y')).toBe(true)
    expect(isOpenableWebUrl('http://localhost:3000/login?code=abc')).toBe(true)
  })

  test('refuses every other scheme an ad, advertiser or agent could supply', () => {
    for (const url of [
      'file:///etc/passwd',
      'smb://attacker.example/share',
      'ms-msdt:/id PCWDiagnostic',
      'vscode://file/tmp/x',
      'javascript:alert(1)',
      'data:text/html,<script>1</script>',
      'mailto:a@b.c',
      '//evil.example/x',
      'codebuff.com',
    ]) {
      expect(isOpenableWebUrl(url)).toBe(false)
    }
  })

  test('refuses whitespace and control characters that could split an argument', () => {
    expect(isOpenableWebUrl('https://a.example/ --flag')).toBe(false)
    expect(isOpenableWebUrl('https://a.example/\nnext')).toBe(false)
    expect(isOpenableWebUrl('https://a.example/\x1b]52;c;x\x07')).toBe(false)
    expect(isOpenableWebUrl('')).toBe(false)
    expect(isOpenableWebUrl(undefined)).toBe(false)
    expect(isOpenableWebUrl('https://a.example/' + 'x'.repeat(9000))).toBe(
      false,
    )
  })

  test('safeOpen returns false without spawning anything for a refused URL', async () => {
    expect(await safeOpen('file:///etc/passwd')).toBe(false)
  })
})
