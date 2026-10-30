import { expect, test } from 'bun:test'

import {
  automaticCompactionIsWorthwhile,
  automaticCompactionPostCeiling,
  compactedContextCeiling,
} from '../compaction'
import { countTokensMessages } from '../util/token-counter'

import type { Message } from '@codebuff/common/types/messages/codebuff-message'

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
test('an automatic compaction that cannot clear its own threshold is not worthwhile', () => {
  const byokDefault = { maxContextLength: 25_804, thresholdTokens: 20_643 }
  expect(
    automaticCompactionIsWorthwhile({
      messages,
      ...byokDefault,
      fixedTokenCount: 16_000,
    }),
  ).toBe(false)
  expect(
    automaticCompactionIsWorthwhile({
      messages,
      ...byokDefault,
      fixedTokenCount: 3_000,
    }),
  ).toBe(true)
  expect(
    automaticCompactionIsWorthwhile({
      messages,
      maxContextLength: 400_000,
      thresholdTokens: 320_000,
      fixedTokenCount: 20_000,
    }),
  ).toBe(true)
  const ceiling = compactedContextCeiling({
    messages,
    maxContextLength: 400_000,
    fixedTokenCount: 20_000,
  })
  expect(ceiling).toBe(20_000 + countTokensMessages([messages[0]]) + 6_000)
  expect(
    compactedContextCeiling({
      messages,
      maxContextLength: 400_000,
      fixedTokenCount: 20_000,
      maxOutputTokens: 4_096,
    }),
  ).toBe(20_000 + countTokensMessages([messages[0]]) + 2_048)
})

test('the low-water mark sits below the trigger', () => {
  expect(automaticCompactionPostCeiling(100_000)).toBe(85_000)
})
