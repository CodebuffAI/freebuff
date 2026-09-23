import { describe, expect, test } from 'bun:test'

import {
  countTokens,
  countTokensJson,
  countTokensMessages,
} from '../token-counter'

import type { Message } from '@codebuff/common/types/messages/codebuff-message'

test('pathological repeated text is safe even when restoring a multi-MB conversation', async () => {
  // A subprocess gives the test a real wall-clock limit: a synchronous BPE
  // regression cannot block this test runner's own timeout/event loop.
  const modulePath = new URL('../token-counter.ts', import.meta.url).pathname
  const child = Bun.spawn(
    [
      process.execPath,
      '-e',
      `
    import { countTokensMessages } from ${JSON.stringify(modulePath)};
    const size = countTokensMessages([
      { role: 'assistant', content: [{type: 'text', text: ' '.repeat(21_000_000)}] },
      { role: 'tool', content: [{type: 'json', value: {stdout: 'A'.repeat(21_000_000)}}] }
    ]);
    if (!Number.isFinite(size) || size < 1_000_000) process.exit(1);
  `,
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  )
  const timeout = setTimeout(() => child.kill(), 3000)
  try {
    expect(await child.exited).toBe(0)
  } finally {
    clearTimeout(timeout)
    child.kill()
  }
}, 5000)

describe('countTokensMessages', () => {
  test('charges token-dense Unicode in text and nested tool results', () => {
    const dense = '🧑‍💻🔥🚀⚠️'.repeat(5_000)
    expect(countTokens(dense)).toBeGreaterThan(20_000)
    expect(countTokens('漢字'.repeat(15_000))).toBeGreaterThan(20_000)
    expect(countTokensJson({ stdout: dense })).toBeGreaterThanOrEqual(
      countTokens(dense),
    )
    expect(
      countTokensMessages([
        {
          role: 'tool',
          toolCallId: '1',
          toolName: 'read_files',
          content: [{ type: 'json', value: { content: dense } }],
        },
      ]),
    ).toBeGreaterThan(20_000)
  })

  test('counts text content plus per-message overhead', () => {
    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'hello world' }] },
    ] as unknown as Message[]

    const count = countTokensMessages(messages)
    // At least the text tokens; overhead makes it strictly greater.
    expect(count).toBeGreaterThan(countTokens('hello world'))
  })

  test('counts tool-call inputs and tool-result payloads', () => {
    const messages = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'reading' },
          {
            type: 'tool-call',
            toolCallId: '1',
            toolName: 'read_files',
            input: { paths: ['a.ts', 'b.ts'] },
          },
        ],
      },
      {
        role: 'tool',
        toolCallId: '1',
        toolName: 'read_files',
        content: [{ type: 'json', value: { files: ['contents here'] } }],
      },
    ] as unknown as Message[]

    expect(countTokensMessages(messages)).toBeGreaterThan(0)
  })

  test('is cheaper than JSON.stringify counting for structured messages', () => {
    const codeBlock = 'const x = "a \\"b\\" c";\n'.repeat(50)
    const messages = [
      {
        role: 'tool',
        toolCallId: '1',
        toolName: 'read_files',
        content: [
          { type: 'json', value: { path: 'x.ts', content: codeBlock } },
        ],
      },
      { role: 'user', content: [{ type: 'text', text: codeBlock }] },
    ] as unknown as Message[]

    // Structured counting removes the JSON envelope for text parts, so it must
    // not exceed the whole-array JSON count.
    expect(countTokensMessages(messages)).toBeLessThanOrEqual(
      countTokensJson(messages),
    )
  })

  test('does NOT count image/file base64 as text (uses a fixed estimate)', () => {
    const bigB64 = 'A'.repeat(500_000)
    const messages = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'screenshot:' },
          { type: 'image', image: bigB64, mediaType: 'image/png' },
        ],
      },
      {
        role: 'tool',
        toolCallId: '1',
        toolName: 'browser',
        content: [{ type: 'media', data: bigB64, mediaType: 'image/png' }],
      },
    ] as unknown as Message[]

    const count = countTokensMessages(messages)
    // Two images at a ~1600-token ceiling each, plus a little text/overhead —
    // nowhere near the ~hundreds-of-thousands of tokens the base64 would add.
    expect(count).toBeLessThan(10_000)
  })

  test('tolerates string content without iterating characters', () => {
    const text = 'a plain string message content'
    const messages = [{ role: 'user', content: text }] as unknown as Message[]

    // Must count the string as one blob, not char-by-char via the default case.
    expect(countTokensMessages(messages)).toBeGreaterThan(countTokens(text))
    expect(countTokensMessages(messages)).toBeLessThan(countTokens(text) + 100)
  })

  test('does not throw on missing/non-array content', () => {
    const messages = [
      { role: 'assistant' },
      { role: 'user', content: undefined },
    ] as unknown as Message[]

    expect(() => countTokensMessages(messages)).not.toThrow()
  })

  test('falls back to JSON for unknown part shapes so it never under-counts', () => {
    const messages = [
      {
        role: 'user',
        content: [{ type: 'mystery', payload: 'some meaningful content here' }],
      },
    ] as unknown as Message[]

    expect(countTokensMessages(messages)).toBeGreaterThan(0)
  })
})
