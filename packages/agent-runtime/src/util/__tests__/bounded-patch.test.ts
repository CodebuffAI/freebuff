import { describe, expect, it } from 'bun:test'
import { applyPatch } from 'diff'

import { spanPatch } from '../bounded-patch'

// The fallback patch is applied to users' files by Desktop and Cloud
// (`changeFile`, workspace-tools.ts): a wrong hunk corrupts the file.
describe('spanPatch', () => {
  it('applies to give exactly the new content', () => {
    const lines = (n: number) =>
      Array.from({ length: n }, (_, i) => `line ${i}\n`).join('')
    const cases: Array<[string, string]> = [
      [lines(20), lines(20).replace('line 10\n', 'changed\n')],
      [lines(20), lines(20).replace('line 0\n', '')],
      [lines(20), `${lines(20)}appended\n`],
      [lines(20), lines(20).slice(0, -1)],
      [lines(20).slice(0, -1), lines(20)],
      ['a\nb\nc', 'a\nB\nc'],
      ['a\r\nb\nc\r\n', 'a\r\nb\r\nc\r\n'],
      [lines(5), ''],
      ['', lines(5)],
    ]
    for (const [before, after] of cases)
      expect(applyPatch(before, spanPatch('f.ts', before, after))).toBe(after)
  })
})
