import { describe, expect, test } from 'bun:test'

import { coerceToArray } from '../params/utils'
import { parseToolJson } from '../repair-tool-json'

describe('parseToolJson', () => {
  test('valid JSON parses without a repair', () => {
    expect(parseToolJson('{"a": "say \\"hi\\""}')).toEqual({
      value: { a: 'say "hi"' },
    })
  })

  test.each([
    // DeepSeek V4 Flash, replayed from a production context: one quote left bare.
    [
      '{"path": "src/Pricing.tsx", "replacements": [{"oldString": "<section id=\\"pricing\\" className="mx-auto px-6\\">", "newString": "<section id=\\"pricing\\" aria-label=\\"Compare plans\\" className=\\"mx-auto px-6\\">"}]}',
      '<section id="pricing" className="mx-auto px-6">',
    ],
    [
      '{"path": "a.tsx", "replacements": [{"oldString": "import type { Estimate } from "@/lib/types";", "newString": "import type { Estimate, Line } from \\"@/lib/types\\";"}]}',
      'import type { Estimate } from "@/lib/types";',
    ],
    [
      '{"path": "a.py", "replacements": [{"oldString": "print("a", "b")", "newString": "print("a")"}]}',
      'print("a", "b")',
    ],
  ])('escapes the stray quotes in %#', (text, oldString) => {
    const result = parseToolJson(text)
    expect(result?.repair).toBe('unescaped-quote')
    const value = result?.value as { replacements: { oldString: string }[] }
    expect(value.replacements[0]!.oldString).toBe(oldString)
  })

  test("JSX's {\" \"} is not mistaken for the end of the string", () => {
    const result = parseToolJson(
      '{"path": "a.tsx", "replacements": [{"oldString": "until", "newString": "until{" "}\\n{date}"}]}',
    )
    expect(result?.repair).toBe('unescaped-quote')
    expect(result?.value).toEqual({
      path: 'a.tsx',
      replacements: [{ oldString: 'until', newString: 'until{" "}\n{date}' }],
    })
  })

  test('a raw newline inside a string is escaped', () => {
    expect(parseToolJson('{"path": "a.ts", "content": "a\nb"}')).toEqual({
      value: { path: 'a.ts', content: 'a\nb' },
      repair: 'raw-control-character',
    })
  })

  test('replacements closed with } instead of ]} is closed', () => {
    expect(
      parseToolJson('{"path": "a.ts", "replacements": [{"oldString": "a", "newString": "b"}}'),
    ).toEqual({
      value: { path: 'a.ts', replacements: [{ oldString: 'a', newString: 'b' }] },
      repair: 'unclosed-array',
    })
  })

  test('slips together are repaired together', () => {
    expect(
      parseToolJson('{"path": "a.ts", "replacements": [{"oldString": "say "hi"", "newString": "x\ny"}}')
        ?.repair,
    ).toBe('unescaped-quote+raw-control-character+unclosed-array')
  })

  test('a call cut off by the output limit is never completed', () => {
    for (const cut of [
      '{"path":"src/editor.rs","content":"use eframe::egui;\\n\\npub fn mark_saved(&mut',
      '{"path": "a.ts", "replacements": [{"oldString": "say "hi"", "newString": "x',
      '{"path": "a.ts", "replacements": [{"oldString": "a", "newString": "b"}',
    ])
      expect(parseToolJson(cut)).toBeUndefined()
  })

  test('text no repair can parse stays unparsed', () => {
    expect(parseToolJson('{"path": "a.ts", "content": "x')).toBeUndefined()
    expect(parseToolJson('not json')).toBeUndefined()
  })
})

test('a lane that hands over the broken array as a string still yields the edits', () => {
  expect(
    coerceToArray('[{"oldString": "<div className="a">", "newString": "<div className=\\"b\\">"}]'),
  ).toEqual([{ oldString: '<div className="a">', newString: '<div className="b">' }])
})
