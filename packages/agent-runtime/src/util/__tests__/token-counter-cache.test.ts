import { describe, expect, it } from 'bun:test'

import { countTokensMessage, countTokensMessages } from '../token-counter'

import type { Message } from '@codebuff/common/types/messages/codebuff-message'

const text = (role: 'user' | 'assistant', body: string): Message =>
  ({ role, content: [{ type: 'text', text: body }] }) as unknown as Message

function buildHistory(n: number): Message[] {
  const messages: Message[] = []
  for (let i = 0; i < n; i++) {
    messages.push(text(i % 2 === 0 ? 'user' : 'assistant', `turn ${i} `.repeat(40)))
    if (i % 3 === 0) {
      messages.push({
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: `t${i}`,
            toolName: 'read_files',
            input: { paths: [`f${i}.ts`] },
          },
        ],
      } as unknown as Message)
      messages.push({
        role: 'tool',
        toolCallId: `t${i}`,
        toolName: 'read_files',
        content: [{ type: 'json', value: { content: 'const x = 1;\n'.repeat(100) } }],
      } as unknown as Message)
    }
  }
  return messages
}

describe('countTokensMessage memoization', () => {
  it('list count equals the sum of per-message counts (identical arithmetic)', () => {
    for (const n of [1, 5, 20, 100]) {
      const history = buildHistory(n)
      const sum = history.reduce((acc, m) => acc + countTokensMessage(m), 0)
      expect(countTokensMessages(history)).toBe(sum)
    }
  })

  it('a warmed cache returns the same numbers for growing histories', () => {
    const history = buildHistory(40)
    // Warm the cache as the step loop would over successive steps.
    const snapshots: number[] = []
    for (let step = 1; step <= history.length; step += 7) {
      snapshots.push(countTokensMessages(history.slice(0, step)))
    }
    // Replay: the same messages (now all cached) must give the same sums.
    let i = 1
    for (const expected of snapshots) {
      expect(countTokensMessages(history.slice(0, i))).toBe(expected)
      i += 7
    }
  })

  it('a replaced message recounts; its untouched prefix does not change', () => {
    const history = buildHistory(10)
    const before = countTokensMessages(history)
    const replaced = [
      ...history.slice(0, -1),
      text('assistant', 'replacement tail '.repeat(500)),
    ]
    const after = countTokensMessages(replaced)
    expect(after).toBe(
      before -
        countTokensMessage(history[history.length - 1]) +
        countTokensMessage(replaced[replaced.length - 1]),
    )
    // Original untouched.
    expect(countTokensMessages(history)).toBe(before)
  })

  it('cache-hit returns for single-message arrays match fresh arithmetic', () => {
    const history = buildHistory(8)
    for (const message of history) {
      expect(countTokensMessages([message])).toBe(countTokensMessage(message))
      // second pass hits the memoized per-message count
      expect(countTokensMessages([message])).toBe(countTokensMessage(message))
    }
  })
})
