// The forced pass. `maybeCompactHistory` answers "is this worth doing unasked";
// `compactHistoryNow` is what a host calls when the user has already decided, so
// what it pins is that the decision is the only thing removed — the protected
// prefix, the fresh tool exchange and the budget are all still the shared ones —
// plus the two answers a caller has to be able to tell apart: a reduction, and
// nothing worth doing.

import { describe, expect, it } from 'bun:test'

import { compactHistoryNow, maybeCompactHistory } from '../compact-history'
import { countTokensMessages } from '../util/token-counter'

import type { JSONValue } from '@codebuff/common/types/json'
import type { Message } from '@codebuff/common/types/messages/codebuff-message'

const user = (text: string): Message => ({
  role: 'user',
  tags: ['USER_PROMPT'],
  content: [{ type: 'text', text }],
})
const assistant = (text: string): Message => ({
  role: 'assistant',
  content: [{ type: 'text', text }],
  sentAt: Date.now(),
})
const call = (id: string, paths: unknown[] = ['file.ts']): Message => ({
  role: 'assistant',
  content: [
    { type: 'tool-call', toolCallId: id, toolName: 'read_files', input: { paths } },
  ],
})
const tool = (id: string, value: JSONValue): Message => ({
  role: 'tool',
  toolCallId: id,
  toolName: 'read_files',
  content: [{ type: 'json', value }],
})
const read = (id: string, content: string, path = 'file.ts') =>
  tool(id, [{ path, content, referencedBy: {} }])

/** A settled conversation: several exchanges, then a final assistant answer. */
const settledHistory = (): Message[] => [
  user('Add a retry to the uploader.'),
  call('a', ['uploader.ts']),
  read('a', 'export const upload = () => {}\n'.repeat(400), 'uploader.ts'),
  assistant('Added the retry.'),
  user('Now document it.'),
  call('b', ['README.md']),
  read('b', '# docs\n'.repeat(400), 'README.md'),
  assistant('Documented.'),
]

describe('compactHistoryNow', () => {
  it('compacts a history the triggers would have left alone', () => {
    const messages = settledHistory()
    const contextTokenCount = countTokensMessages(messages)
    // Well under the budget and the cache is warm: nothing to trigger on.
    expect(
      maybeCompactHistory({
        messages,
        contextTokenCount,
        maxContextLength: 400_000,
        cacheExpiryMs: null,
      }),
    ).toBeNull()

    const forced = compactHistoryNow({ messages, maxContextLength: 400_000 })
    expect(forced).not.toBeNull()
    expect(forced!.nextTokens).toBeLessThan(forced!.previousTokens)
    expect(countTokensMessages(forced!.messages)).toBe(forced!.nextTokens)
    expect(JSON.stringify(forced!.messages)).not.toContain(
      'export const upload',
    )
  })

  it('keeps the last request live and the files it named in memory', () => {
    const forced = compactHistoryNow({
      messages: settledHistory(),
      maxContextLength: 400_000,
    })!
    const live = forced.messages.filter((message) =>
      message.tags?.includes('USER_PROMPT'),
    )
    expect(live).toHaveLength(1)
    expect(JSON.stringify(live[0])).toContain('Now document it')
    // The mechanical summary keeps what was read and edited, not its contents.
    expect(JSON.stringify(forced.messages)).toContain('uploader.ts')
  })

  it('preserves an unconsumed tool batch mid-turn', () => {
    const messages = [
      ...settledHistory(),
      user('And the changelog.'),
      call('c', ['CHANGELOG.md']),
      read('c', 'entry', 'CHANGELOG.md'),
    ]
    const forced = compactHistoryNow({ messages, maxContextLength: 400_000 })!
    expect(forced.messages.slice(-2)).toEqual(messages.slice(-2))
  })

  it('answers null rather than growing a history with nothing older in it', () => {
    expect(
      compactHistoryNow({
        messages: [user('Hello.')],
        maxContextLength: 400_000,
      }),
    ).toBeNull()
  })

  it('answers null for an empty history', () => {
    expect(
      compactHistoryNow({ messages: [], maxContextLength: 400_000 }),
    ).toBeNull()
  })

  it('subtracts the fixed overhead from the budget it fits into', () => {
    const messages = settledHistory()
    const forced = compactHistoryNow({
      messages,
      maxContextLength: 8_000,
      fixedTokenCount: 4_000,
    })!
    expect(forced.nextTokens).toBeLessThanOrEqual(4_000)
  })

  it('throws the runtime sentence when the live request alone is over budget', () => {
    expect(() =>
      compactHistoryNow({
        messages: [...settledHistory(), user('x'.repeat(20_000))],
        maxContextLength: 1_000,
      }),
    ).toThrow(/exceed the configured context window/)
  })
})
