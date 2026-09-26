import { expect, test } from 'bun:test'
import {
  compactWithModel,
  compactWithModelOrFallback,
  COMPACTION_TAG,
  parseCompactionSummary,
} from '../model-compaction'
import { promptSuccess } from '@codebuff/common/util/error'
import { countTokensMessages } from '../util/token-counter'
import type { Message } from '@codebuff/common/types/messages/codebuff-message'
import type { PromptAiSdkStreamFn } from '@codebuff/common/types/contracts/llm'

const user = (text: string): Message => ({
  role: 'user',
  tags: ['USER_PROMPT'],
  content: [{ type: 'text', text }],
})
const messages: Message[] = [
  user('Compare the time units in a.ts and b.ts.'),
  {
    role: 'assistant',
    content: [
      {
        type: 'tool-call',
        toolCallId: 'a',
        toolName: 'read_files',
        input: { paths: ['a.ts'] },
      },
    ],
  },
  {
    role: 'tool',
    toolName: 'read_files',
    toolCallId: 'a',
    content: [
      {
        type: 'json',
        value: [
          {
            path: 'a.ts',
            content:
              'A_EXPECTS_MILLISECONDS\n' +
              'const timeoutMs = 5000;\n'.repeat(200),
          },
        ],
      },
    ],
  },
  {
    role: 'assistant',
    content: [{ type: 'text', text: 'Next inspect b.ts.' }],
  },
  {
    role: 'assistant',
    content: [
      {
        type: 'tool-call',
        toolCallId: 'b',
        toolName: 'read_files',
        input: { paths: ['b.ts'] },
      },
    ],
  },
  {
    role: 'tool',
    toolName: 'read_files',
    toolCallId: 'b',
    content: [
      {
        type: 'json',
        value: [
          {
            path: 'b.ts',
            content:
              'B_PRODUCES_SECONDS\n' +
              'const timeoutSeconds = 5;\n'.repeat(200),
          },
        ],
      },
    ],
  },
]
const summary =
  '## Objective\nCompare time units.\n## Important Details\n- a.ts expects milliseconds; b.ts produces seconds.\n## Work State\n### Active\n- Compare and explain the mismatch.'
const emit = async function* (
  value = summary,
): ReturnType<PromptAiSdkStreamFn> {
  yield {
    type: 'tool-call',
    toolCallId: 'summary',
    toolName: 'complete_compaction',
    input: { summary: value },
  }
  return promptSuccess('compaction-id')
}
const run = (
  stream: Parameters<typeof compactWithModel>[0]['stream'],
  overrides: Partial<Parameters<typeof compactWithModel>[0]> = {},
) =>
  compactWithModel({
    messages,
    system: 'You are a coding agent.',
    maxContextLength: 16_384,
    fixedTokenCount: 500,
    signal: new AbortController().signal,
    stream,
    ...overrides,
  })

test('summarizes actual findings from sequential reads and installs exactly the returned handoff', async () => {
  const before = structuredClone(messages)
  const result = await run((request) => {
    const text = JSON.stringify(request)
    expect(text).toContain('A_EXPECTS_MILLISECONDS')
    expect(text).toContain('B_PRODUCES_SECONDS')
    return emit()
  })
  expect(result?.summary).toBe(summary)
  expect(result?.messages[0].tags).toContain(COMPACTION_TAG)
  expect(JSON.stringify(result?.messages)).toContain(
    summary.replaceAll('\n', '\\n'),
  )
  expect(result?.messages.at(-1)).toMatchObject(messages[0])
  expect(result!.postTokens).toBeLessThan(result!.preTokens)
  expect(messages).toEqual(before)
})

test('oversized history is read in bounded sections, with findings carried between model calls', async () => {
  let calls = 0
  const seen: string[] = []
  const result = await run(
    (request) => {
      expect(countTokensMessages(request)).toBeLessThanOrEqual(4096)
      const text = JSON.stringify(request)
      seen.push(text)
      if (calls++) expect(text).toContain('Previous anchored summary:')
      return emit()
    },
    { maxContextLength: 4096 },
  )
  expect(calls).toBeGreaterThan(1)
  expect(seen.join('')).toContain('A_EXPECTS_MILLISECONDS')
  expect(seen.join('')).toContain('B_PRODUCES_SECONDS')
  expect(result?.summary).toBe(summary)
})

test('screenshot pixels are named, not serialized, so the summary is one call and not dozens', async () => {
  // The shape Freebuff Desktop's screenshot tool returns (thread-agent.ts):
  // the pixels ride a `media` part, the note a `json` part. A 3D-app thread
  // with a few of these, compacted under GLM's 400k budget, sent 806,223-token
  // summarizer requests one after another for minutes, then restarted on
  // every later turn because a Stop threw the unfinished pass away.
  const screenshot = 'iVBORw0KGgoAAAANSUhEUgAA'.repeat(20_000) // ~480 KB of base64
  const withScreenshots: Message[] = [
    user('Why does the reveal wash the scene out white?'),
    ...[1, 2, 3].flatMap((n): Message[] => [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: `s${n}`,
            toolName: 'browser_screenshot',
            input: {},
          },
        ],
      },
      {
        role: 'tool',
        toolName: 'browser_screenshot',
        toolCallId: `s${n}`,
        content: [
          { type: 'media', data: screenshot, mediaType: 'image/png' },
          { type: 'json', value: { ok: true, note: `SHOT_${n}_NOTE` } },
        ],
      },
    ]),
    {
      role: 'tool',
      toolName: 'mcp_capture',
      toolCallId: 'm1',
      content: [
        {
          type: 'json',
          value: {
            data: `data:image/jpeg;base64,${screenshot}`,
            raw: screenshot,
            caption: 'MCP_CAPTION',
          },
        },
      ],
    },
  ]
  const requests: string[] = []
  const result = await run(
    (request) => {
      requests.push(JSON.stringify(request))
      return emit()
    },
    { messages: withScreenshots, maxContextLength: 16_384 },
  )
  // One section: before this, ~2 MB of base64 at 3 chars/token was ~640k
  // estimated tokens, split into ~40 sequential summarizer calls.
  expect(requests).toHaveLength(1)
  expect(requests[0]).not.toContain('iVBORw0KGgo')
  expect(requests[0]).toContain('[image/png omitted from this summary request]')
  expect(requests[0]).toContain('[image/jpeg omitted from this summary request]')
  // Everything that is not pixels still reaches the summarizer.
  for (const kept of ['SHOT_1_NOTE', 'SHOT_3_NOTE', 'MCP_CAPTION'])
    expect(requests[0]).toContain(kept)
  expect(result?.summary).toBe(summary)
  // The source history is never mutated; the pixels are still there for the model.
  expect(JSON.stringify(withScreenshots)).toContain('iVBORw0KGgo')
})

test('prose and code in a tool result are never mistaken for base64', async () => {
  const longCode = 'const timeoutMs = 5000;\n'.repeat(400)
  const longWord = 'A'.repeat(2_000)
  const requests: string[] = []
  await run(
    (request) => {
      requests.push(JSON.stringify(request))
      return emit()
    },
    {
      messages: [
        user('Read these.'),
        {
          role: 'tool',
          toolName: 'read_files',
          toolCallId: 'r',
          content: [{ type: 'json', value: { code: longCode, word: longWord } }],
        },
      ],
      maxContextLength: 32_768,
    },
  )
  expect(requests.join('')).toContain('const timeoutMs = 5000;')
  expect(requests.join('')).toContain(longWord)
  expect(requests.join('')).not.toContain('omitted from this summary request')
})

test('invalid, missing, unexpected and interrupted tool outputs preserve source history', async () => {
  const before = structuredClone(messages)
  const streams: Array<() => ReturnType<PromptAiSdkStreamFn>> = [
    () => emit(''),
    async function* () {
      yield { type: 'text', text: 'ordinary answer' }
      return promptSuccess(null)
    },
    async function* () {
      yield {
        type: 'tool-call',
        toolCallId: 'bad',
        toolName: 'write_file',
        input: { path: 'bad' },
      }
      return promptSuccess(null)
    },
    async function* () {
      yield {
        type: 'tool-call',
        toolCallId: 's',
        toolName: 'complete_compaction',
        input: { summary },
      }
      throw new Error('connection interrupted')
    },
  ]
  for (const stream of streams) await expect(run(stream)).rejects.toThrow()
  expect(messages).toEqual(before)
})

test('cancellation, including after the final tool call, never returns a replacement', async () => {
  const controller = new AbortController()
  await expect(
    run(
      async function* () {
        yield {
          type: 'tool-call',
          toolCallId: 's',
          toolName: 'complete_compaction',
          input: { summary },
        }
        controller.abort()
        return promptSuccess(null)
      },
      { signal: controller.signal },
    ),
  ).rejects.toThrow()
})

test('a handoff without new work is a no-op', async () => {
  const first = await run(() => emit())
  expect(
    await run(
      () => {
        throw new Error('must not call')
      },
      { messages: first!.messages },
    ),
  ).toBeNull()
})

// Regression for "ZodError: expected object, received string at
// compactWithModel" (Freebuff Cloud, 2026-09-23). The AI SDK emits a tool call
// whose arguments failed the schema with `input` as the parsed-or-raw TEXT, so
// the summarizer's call can reach the runtime as a string.
test('parseCompactionSummary decodes every argument shape a provider produces', () => {
  const obj = { summary }
  expect(parseCompactionSummary(obj)).toBe(summary)
  // Double-encoded arguments: the SDK parsed one layer, one remains.
  expect(parseCompactionSummary(JSON.stringify(obj))).toBe(summary)
  expect(parseCompactionSummary(JSON.stringify(JSON.stringify(obj)))).toBe(
    summary,
  )
  // A Markdown fence around the arguments.
  expect(
    parseCompactionSummary('```json\n' + JSON.stringify(obj) + '\n```'),
  ).toBe(summary)
  // Unknown keys are ignored rather than rejecting the whole handoff.
  expect(parseCompactionSummary({ summary, note: 'extra' })).toBe(summary)
  // Prose written straight into the argument slot is the handoff itself.
  expect(parseCompactionSummary(summary)).toBe(summary)
  // Truncated JSON (output cap), empty, and non-summary shapes are rejected.
  expect(parseCompactionSummary('{"summary": "half a sum')).toBeUndefined()
  expect(parseCompactionSummary('')).toBeUndefined()
  expect(parseCompactionSummary({ summary: '   ' })).toBeUndefined()
  expect(parseCompactionSummary({ text: summary })).toBeUndefined()
  expect(parseCompactionSummary(['a'])).toBeUndefined()
  expect(parseCompactionSummary(null)).toBeUndefined()
  expect(parseCompactionSummary(42)).toBeUndefined()
})

const stringInput = (text: string) => text as unknown as Record<string, unknown>

test('a string-encoded complete_compaction call compacts instead of throwing a ZodError', async () => {
  const result = await run(async function* () {
    yield {
      type: 'tool-call',
      toolCallId: 'summary',
      toolName: 'complete_compaction',
      input: stringInput(JSON.stringify({ summary })),
    }
    return promptSuccess('compaction-id')
  })
  expect(result?.summary).toBe(summary)
})

const noopLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

test('compactWithModelOrFallback falls back to mechanical compaction on any summarizer failure', async () => {
  const before = structuredClone(messages)
  const warnings: unknown[] = []
  const failures: Array<() => ReturnType<PromptAiSdkStreamFn>> = [
    async function* () {
      yield {
        type: 'tool-call',
        toolCallId: 's',
        toolName: 'complete_compaction',
        input: stringInput('{"summary": "cut off'),
      }
      return promptSuccess(null)
    },
    async function* () {
      yield { type: 'error', message: 'provider 500' }
      return promptSuccess(null)
    },
    async function* () {
      throw new Error('connection reset')
    },
  ]
  for (const stream of failures) {
    const result = await compactWithModelOrFallback({
      messages,
      system: 'You are a coding agent.',
      maxContextLength: 16_384,
      fixedTokenCount: 500,
      signal: new AbortController().signal,
      stream,
      logger: { ...noopLogger, warn: (data: unknown) => warnings.push(data) },
    })
    expect(result?.fallback).toBe(true)
    expect(result!.postTokens).toBeLessThan(result!.preTokens)
    // The live request survives the mechanical pass.
    expect(JSON.stringify(result!.messages)).toContain(
      'Compare the time units in a.ts and b.ts.',
    )
  }
  expect(warnings).toHaveLength(failures.length)
  expect(warnings.map((w) => (w as { error_kind: string }).error_kind)).toEqual(
    ['invalid_summary', 'provider_error', 'provider_error'],
  )
  expect(warnings[0]).toMatchObject({
    axiomEvent: 'model_compaction.fallback',
    fallback_applied: true,
    fallback_failed: false,
  })
  expect(messages).toEqual(before)
})

test('compactWithModelOrFallback still propagates cancellation', async () => {
  const controller = new AbortController()
  await expect(
    compactWithModelOrFallback({
      messages,
      system: 'You are a coding agent.',
      maxContextLength: 16_384,
      fixedTokenCount: 500,
      signal: controller.signal,
      logger: noopLogger,
      stream: async function* () {
        controller.abort()
        yield { type: 'text', text: '' }
        return promptSuccess(null)
      },
    }),
  ).rejects.toThrow()
})
