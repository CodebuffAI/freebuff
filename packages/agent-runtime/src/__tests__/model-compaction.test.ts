import { expect, test } from 'bun:test'
import { compactWithModel, COMPACTION_TAG } from '../model-compaction'
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
