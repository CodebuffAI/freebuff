import { describe, expect, it } from 'bun:test'

import { compactMessages, maybeCompactHistory } from '../compact-history'
import { fitToolResults } from '../util/fit-tool-results'
import { countTokensMessages } from '../util/token-counter'

import type { JSONValue } from '@codebuff/common/types/json'
import type { Message } from '@codebuff/common/types/messages/codebuff-message'

const user = (text: string): Message => ({
  role: 'user',
  tags: ['USER_PROMPT'],
  content: [{ type: 'text', text }],
})
const call = (
  id: string,
  toolName = 'read_files',
  paths: unknown[] = ['file.ts'],
): Message => ({
  role: 'assistant',
  content: [{ type: 'tool-call', toolCallId: id, toolName, input: { paths } }],
})
const tool = (
  id: string,
  value: JSONValue,
  toolName = 'read_files',
): Message => ({
  role: 'tool',
  toolCallId: id,
  toolName,
  content: [{ type: 'json', value }],
})
const read = (id: string, content: string, path = 'file.ts') =>
  tool(id, [{ path, content, referencedBy: {} }])
const compact = (
  messages: Message[],
  maxContextLength = 4096,
  fixedTokenCount = 500,
) =>
  maybeCompactHistory({
    messages,
    contextTokenCount: 100_000,
    maxContextLength,
    fixedTokenCount,
    cacheExpiryMs: null,
  })!

describe('request-sized compaction', () => {
  it('preserves every call/result in a parallel batch and the current prompt', () => {
    const messages = [
      user('older request'),
      call('old'),
      read('old', 'old payload '.repeat(5000)),
      user('Edit both files, without changing their exports.'),
      call('a', 'read_files', ['a.ts']),
      call('b', 'read_files', ['b.ts']),
      read('a', 'export const a = 1', 'a.ts'),
      read('b', 'export const b = 2', 'b.ts'),
    ]
    const output = compact(messages)
    expect(countTokensMessages(output) + 500).toBeLessThanOrEqual(4096)
    expect(output.slice(-4)).toEqual(messages.slice(-4))
    expect(
      output.some(
        (message) =>
          message.tags?.includes('USER_PROMPT') &&
          JSON.stringify(message).includes('without changing their exports'),
      ),
    ).toBe(true)
    expect(JSON.stringify(output)).not.toContain('old payload')
  })

  it('keeps steering messages after the fresh tool batch in order', () => {
    const messages = [
      user('Original request'),
      call('a'),
      read('a', 'const value = 1'),
      user('First correction'),
      user('Second correction'),
    ]
    const output = compact(messages)
    expect(output.slice(-4)).toEqual(messages.slice(-4))
    expect(JSON.stringify(output)).toContain('Original request')
  })

  it('bounds a summary even when historical user messages exceed a small model window', () => {
    const messages = [
      ...Array.from({ length: 3 }, (_, i) =>
        user(
          `Old requirements ${i}: ` +
            'Preserve keyboard navigation and layout. '.repeat(1000),
        ),
      ),
      {
        role: 'assistant' as const,
        content: [
          { type: 'text' as const, text: 'Completed the prior requests.' },
        ],
      },
      user('Now change the color.'),
      call('a'),
      read('a', 'const color = "red"'),
    ]
    const first = compact(messages)
    expect(countTokensMessages(first) + 500).toBeLessThanOrEqual(4096)
    expect(JSON.stringify(first)).toContain('const color')
    expect(JSON.stringify(first)).toContain('Now change the color.')
    const second = compact([
      ...first,
      call('b'),
      read('b', 'const next = "blue"'),
    ])
    expect(countTokensMessages(second) + 500).toBeLessThanOrEqual(4096)
    expect(JSON.stringify(second)).toContain('const next')
  })

  it('does not preserve a tool result already followed by an assistant response', () => {
    const output = compact([
      user('task'),
      call('a'),
      read('a', 'ALREADY_CONSUMED '.repeat(1000)),
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'I used those contents.' }],
      },
    ])
    expect(output.some((message) => message.role === 'tool')).toBe(false)
    expect(JSON.stringify(output)).not.toContain('ALREADY_CONSUMED')
  })

  it('retains the task when resuming a legacy summary without USER_PROMPT tags', () => {
    const legacy = compactMessages({
      messages: [
        user('KEEP_THE_LOGIN_BUTTON_BLUE'),
        call('old'),
        read('old', 'old code'),
      ],
    }).messages
    expect(
      legacy.some((message) => message.tags?.includes('USER_PROMPT')),
    ).toBe(false)
    const output = compact([
      ...legacy,
      call('a'),
      read('a', 'const button = "red"\n'.repeat(3000)),
    ])
    expect(countTokensMessages(output) + 500).toBeLessThanOrEqual(4096)
    expect(JSON.stringify(output)).toContain('KEEP_THE_LOGIN_BUTTON_BLUE')
    expect(JSON.stringify(output)).toContain('const button')
    const again = compact([
      ...output,
      call('b'),
      read('b', 'const label = "Login"\n'.repeat(3000)),
    ])
    expect(JSON.stringify(again)).toContain('KEEP_THE_LOGIN_BUTTON_BLUE')
    expect(JSON.stringify(again)).toContain('const label')
  })

  it('refuses when fixed instructions and the current prompt alone cannot fit', () => {
    expect(() =>
      compact([user('current request '.repeat(2000))], 4096, 3000),
    ).toThrow('current request and agent instructions')
  })

  it('carries a live image through a clipped read without changing its bytes', () => {
    const image = {
      type: 'image' as const,
      image: new Uint8Array([1, 2, 3]),
      mediaType: 'image/png',
    }
    const prompt: Message = {
      role: 'user',
      tags: ['USER_PROMPT'],
      content: [{ type: 'text', text: 'Match this design' }, image],
    }
    const output = compact(
      [prompt, call('a'), read('a', 'const design = true\n'.repeat(2000))],
      6000,
    )
    const preserved = output.find((message) =>
      message.tags?.includes('USER_PROMPT'),
    )!
    expect(preserved.content).toEqual(prompt.content)
    expect(countTokensMessages(output) + 500).toBeLessThanOrEqual(6000)
  })
})

describe('oversized fresh tool results', () => {
  it('keeps complete source lines and provides the correct non-default continuation offset', () => {
    const content = Array.from(
      { length: 1000 },
      (_, i) => `const line${501 + i} = "日本語 🟢";`,
    ).join('\n')
    const messages = [
      call('a', 'read_files', [{ path: 'file.ts', offset: 501, limit: 1000 }]),
      read('a', content),
    ]
    const original = structuredClone(messages)
    const output = fitToolResults(messages, 1000)
    expect(countTokensMessages(output)).toBeLessThanOrEqual(1000)
    const result = output[1]
    if (result.role !== 'tool' || result.content[0].type !== 'json')
      throw new Error('missing result')
    const files = result.content[0].value as { content: string }[]
    const prefix = files[0].content.split('\n[read_files:')[0]
    expect(prefix.length).toBeGreaterThan(0)
    expect(content.startsWith(prefix)).toBe(true)
    expect(prefix.endsWith('\n')).toBe(true)
    expect(files[0].content).toContain(
      `offset=${501 + (prefix.match(/\n/g)?.length ?? 0)}`,
    )
    expect(messages).toEqual(original)
  })

  it('reserves explicit omission notices for later files in an oversized batch', () => {
    const output = fitToolResults(
      [
        call('a', 'read_files', ['first.ts', 'second.ts']),
        tool('a', [
          { path: 'first.ts', content: 'const first = 1\n'.repeat(1000) },
          { path: 'second.ts', content: 'const second = 2\n'.repeat(1000) },
        ]),
      ],
      700,
    )
    expect(countTokensMessages(output)).toBeLessThanOrEqual(700)
    expect(JSON.stringify(output)).toContain('const first')
    expect(JSON.stringify(output)).toContain('second.ts')
    expect(JSON.stringify(output)).toContain('Contents omitted')
  })

  it('does not invent offsets for a result combining multiple windows', () => {
    const output = fitToolResults(
      [
        call('a', 'read_files', [
          { path: 'file.ts', offset: 50 },
          { path: 'file.ts', offset: 900 },
        ]),
        read('a', 'const value = 1\n'.repeat(1000)),
      ],
      700,
    )
    expect(JSON.stringify(output)).toContain('smaller explicit window')
    expect(JSON.stringify(output)).not.toContain('offset=')
  })

  it('explains an oversized single line without pretending to return source code', () => {
    const output = fitToolResults(
      [call('a'), read('a', 'const huge = "' + 'x '.repeat(5000) + '"')],
      700,
    )
    expect(JSON.stringify(output)).toContain('Contents omitted')
    expect(JSON.stringify(output)).toContain('code_search for oversized lines')
    expect(JSON.stringify(output)).not.toContain('const huge')
  })

  it('does not count SDK annotations or template headers as source lines', () => {
    for (const content of [
      'const value = 1\n'.repeat(1000) +
        '\n[read_files: showing lines 1-1000 of 4000.]',
      '[TEMPLATE]\n' + 'const value = 1\n'.repeat(1000),
      'const value = 1\n'.repeat(1000) + '\n[FILE_TOO_LARGE]: output capped',
    ]) {
      const output = fitToolResults([call('a'), read('a', content)], 700)
      expect(JSON.stringify(output)).toContain('smaller explicit window')
      expect(JSON.stringify(output)).not.toContain('offset=')
    }
  })

  it('bounds other tool outputs as valid JSON without suggesting a mutation be rerun', () => {
    const output = fitToolResults(
      [
        call('a', 'run_terminal_command'),
        tool(
          'a',
          { stdout: 'OUTPUT '.repeat(10000), exitCode: 0 },
          'run_terminal_command',
        ),
      ],
      800,
    )
    expect(countTokensMessages(output)).toBeLessThanOrEqual(800)
    expect(JSON.stringify(output)).toContain('OUTPUT')
    expect(JSON.stringify(output)).toContain(
      'do not repeat state-changing actions',
    )
    expect(JSON.stringify(output)).toContain('truncated')
  })

  it('preserves indivisible media and refuses if it cannot fit', () => {
    const messages: Message[] = [
      call('a'),
      {
        role: 'tool',
        toolName: 'read_files',
        toolCallId: 'a',
        content: [{ type: 'media', mediaType: 'image/png', data: 'aGVsbG8=' }],
      },
    ]
    expect(fitToolResults(messages, 3000)).toEqual(messages)
    expect(() => fitToolResults(messages, 100)).toThrow(
      'result metadata exceed',
    )
  })
})
