import { describe, expect, it } from 'bun:test'

import { expireMessages } from '../messages'

import type { Message } from '@codebuff/common/types/messages/codebuff-message'

const base = (over: Record<string, unknown> = {}): Message =>
  ({ role: 'user', content: [{ type: 'text', text: 'x' }], ...over }) as Message

describe('expireMessages', () => {
  it('returns the input array by reference when nothing expired', () => {
    for (const endOf of ['agentStep', 'userPrompt'] as const) {
      const messages = [base(), base({ tags: ['STEP_PROMPT'] })]
      expect(expireMessages(messages, endOf)).toBe(messages)
      // A userPrompt-scoped message survives end-of-step without allocation.
      const kept = [base({ timeToLive: 'userPrompt' })]
      expect(expireMessages(kept, 'agentStep')).toBe(kept)
    }
  })

  it('filters expired messages when any exist', () => {
    const messages = [
      base(),
      base({ timeToLive: 'agentStep' }),
      base({ timeToLive: 'userPrompt' }),
    ]
    const afterStep = expireMessages(messages, 'agentStep')
    expect(afterStep).not.toBe(messages)
    expect(afterStep).toEqual([messages[0], messages[2]])
    const afterPrompt = expireMessages(messages, 'userPrompt')
    expect(afterPrompt).toEqual([messages[0]])
  })
})
