import { describe, expect, test } from 'bun:test'

import { MAX_RATED_MESSAGE_CHARS } from '@codebuff/common/constants/feedback'
import { feedbackRequestSchema } from '@codebuff/common/schemas/feedback'

import {
  buildFeedbackPayload,
  buildMessageContext,
  feedbackMessageText,
  type RecentMessageSummary,
} from '../feedback-helpers'

import type { ChatMessage } from '../../types/chat'

const createMessage = (
  overrides: Partial<ChatMessage> & { id: string },
): ChatMessage => ({
  variant: 'ai',
  content: 'test content',
  timestamp: new Date().toISOString(),
  ...overrides,
})

describe('buildMessageContext', () => {
  test('returns target and recent messages for a valid target', () => {
    const messages = [
      createMessage({ id: 'msg-1', variant: 'user' }),
      createMessage({ id: 'msg-2', variant: 'ai' }),
      createMessage({ id: 'msg-3', variant: 'user' }),
    ]

    const result = buildMessageContext(messages, 'msg-2')

    expect(result.target).toBe(messages[1])
    expect(result.recentMessages).toHaveLength(2)
    expect(result.recentMessages[0]).toEqual({ type: 'user', id: 'msg-1' })
    expect(result.recentMessages[1]).toEqual({ type: 'ai', id: 'msg-2' })
  })

  test('returns null target and all messages when targetMessageId is null', () => {
    const messages = [
      createMessage({ id: 'msg-1' }),
      createMessage({ id: 'msg-2' }),
    ]

    const result = buildMessageContext(messages, null)

    expect(result.target).toBeNull()
    expect(result.recentMessages).toHaveLength(2)
  })

  test('returns null target and empty recentMessages when message ID is not found', () => {
    const messages = [
      createMessage({ id: 'msg-1' }),
      createMessage({ id: 'msg-2' }),
    ]

    const result = buildMessageContext(messages, 'nonexistent')

    expect(result.target).toBeNull()
    expect(result.recentMessages).toHaveLength(0)
  })

  test('limits to last 10 messages when targetMessageId is null', () => {
    const messages = Array.from({ length: 15 }, (_, i) =>
      createMessage({ id: `msg-${i}` }),
    )

    const result = buildMessageContext(messages, null)

    expect(result.recentMessages).toHaveLength(10)
    expect(result.recentMessages[0]).toMatchObject({ id: 'msg-5' })
    expect(result.recentMessages[9]).toMatchObject({ id: 'msg-14' })
  })

  test('includes credits: 0 in recent messages (not dropped)', () => {
    const messages = [
      createMessage({ id: 'msg-1', credits: 0 }),
      createMessage({ id: 'msg-2', credits: 5.5 }),
      createMessage({ id: 'msg-3' }),
    ]

    const result = buildMessageContext(messages, null)

    expect(result.recentMessages[0]).toEqual({
      type: 'ai',
      id: 'msg-1',
      credits: 0,
    })
    expect(result.recentMessages[1]).toEqual({
      type: 'ai',
      id: 'msg-2',
      credits: 5.5,
    })
    expect(result.recentMessages[2]).toEqual({ type: 'ai', id: 'msg-3' })
  })

  test('omits credits when undefined', () => {
    const messages = [createMessage({ id: 'msg-1' })]

    const result = buildMessageContext(messages, null)

    expect(result.recentMessages[0]).toEqual({ type: 'ai', id: 'msg-1' })
    expect('credits' in result.recentMessages[0]).toBe(false)
  })

  test('includes completionTime when present', () => {
    const messages = [
      createMessage({ id: 'msg-1', completionTime: '3.2s' }),
    ]

    const result = buildMessageContext(messages, null)

    expect(result.recentMessages[0]).toEqual({
      type: 'ai',
      id: 'msg-1',
      completionTime: '3.2s',
    })
  })

  test('includes empty string completionTime (not dropped by != null)', () => {
    const messages = [
      createMessage({ id: 'msg-1', completionTime: '' }),
    ]

    const result = buildMessageContext(messages, null)

    expect(result.recentMessages[0]).toEqual({
      type: 'ai',
      id: 'msg-1',
      completionTime: '',
    })
  })

  test('limits to last 10 messages up to target', () => {
    const messages = Array.from({ length: 15 }, (_, i) =>
      createMessage({ id: `msg-${i}` }),
    )

    const result = buildMessageContext(messages, 'msg-14')

    expect(result.recentMessages).toHaveLength(10)
    expect(result.recentMessages[0]).toMatchObject({ id: 'msg-5' })
    expect(result.recentMessages[9]).toMatchObject({ id: 'msg-14' })
  })

  test('returns all messages when fewer than 10 exist', () => {
    const messages = [
      createMessage({ id: 'msg-1' }),
      createMessage({ id: 'msg-2' }),
      createMessage({ id: 'msg-3' }),
    ]

    const result = buildMessageContext(messages, 'msg-3')

    expect(result.recentMessages).toHaveLength(3)
  })

  test('returns only target message when target is at index 0', () => {
    const messages = [
      createMessage({ id: 'msg-0' }),
      createMessage({ id: 'msg-1' }),
      createMessage({ id: 'msg-2' }),
    ]

    const result = buildMessageContext(messages, 'msg-0')

    expect(result.target).toBe(messages[0])
    expect(result.recentMessages).toHaveLength(1)
    expect(result.recentMessages[0]).toMatchObject({ id: 'msg-0' })
  })

  test('handles empty messages array', () => {
    const result = buildMessageContext([], null)

    expect(result.target).toBeNull()
    expect(result.recentMessages).toHaveLength(0)
  })
})

describe('buildFeedbackPayload', () => {
  const baseParams = {
    text: 'Great feature!',
    feedbackCategory: 'good_result' as const,
    feedbackMessageId: null as string | null,
    target: null as ReturnType<typeof createMessage> | null,
    recentMessages: [] as RecentMessageSummary[],
    agentMode: null as string | null,
    sessionCreditsUsed: null as number | null,
    errors: null as Array<{ id: string; message: string }> | null,
    clientFeedbackId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  }

  test('builds minimal general feedback payload', () => {
    const payload = buildFeedbackPayload(baseParams)

    expect(payload).toEqual({
      text: 'Great feature!',
      category: 'good_result',
      type: 'general',
      clientFeedbackId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      source: 'cli',
    })
  })

  test('always includes source: cli', () => {
    const payload = buildFeedbackPayload(baseParams)
    expect(payload.source).toBe('cli')
  })

  test('passes through the provided clientFeedbackId', () => {
    const payload = buildFeedbackPayload(baseParams)
    expect(payload.clientFeedbackId).toBe('a1b2c3d4-e5f6-7890-abcd-ef1234567890')
  })

  test('uses the exact clientFeedbackId provided', () => {
    const specificId = 'b2c3d4e5-f6a7-8901-bcde-f12345678901'
    const payload = buildFeedbackPayload({
      ...baseParams,
      clientFeedbackId: specificId,
    })
    expect(payload.clientFeedbackId).toBe(specificId)
  })

  // the id is minted by the CLI and means nothing server-side; the words are how a
  // report says which reply it was about
  test('carries the text of the message it is about', () => {
    const target = createMessage({
      id: 'msg-1',
      content: '',
      blocks: [
        { type: 'text', textType: 'reasoning', content: 'let me think' },
        { type: 'text', content: 'I edited a.ts' },
        { type: 'text', textType: 'text', content: 'and b.ts' },
      ],
    })
    const payload = buildFeedbackPayload({ ...baseParams, feedbackMessageId: 'msg-1', target })
    expect(payload.messageText).toBe('I edited a.ts\n\nand b.ts')
    expect(feedbackRequestSchema.safeParse(payload).success).toBe(true)
  })

  test('message text falls back to content and is capped', () => {
    expect(feedbackMessageText(createMessage({ id: 'u', variant: 'user', content: ' fix it ' }))).toBe('fix it')
    expect(
      feedbackMessageText(createMessage({ id: 'a', content: 'x'.repeat(MAX_RATED_MESSAGE_CHARS + 10) })),
    ).toHaveLength(MAX_RATED_MESSAGE_CHARS)
  })

  test('general feedback and an empty message carry no message text', () => {
    expect(buildFeedbackPayload(baseParams).messageText).toBeUndefined()
    const payload = buildFeedbackPayload({
      ...baseParams,
      feedbackMessageId: 'msg-1',
      target: createMessage({ id: 'msg-1', content: '   ' }),
    })
    expect(payload).not.toHaveProperty('messageText')
  })

  test('sets type to message when feedbackMessageId is present', () => {
    const payload = buildFeedbackPayload({
      ...baseParams,
      feedbackMessageId: 'msg-123',
    })

    expect(payload.type).toBe('message')
    expect(payload.messageId).toBe('msg-123')
  })

  test('sends messageId even when target message is not found', () => {
    const payload = buildFeedbackPayload({
      ...baseParams,
      feedbackMessageId: 'msg-deleted',
      target: null,
    })

    expect(payload.type).toBe('message')
    expect(payload.messageId).toBe('msg-deleted')
    expect(payload.messageVariant).toBeUndefined()
    expect(payload.credits).toBeUndefined()
    expect(payload.completionTime).toBeUndefined()
  })

  test('includes target message details when target is found', () => {
    const target = createMessage({
      id: 'msg-1',
      variant: 'ai',
      completionTime: '2.5s',
      credits: 1.2,
    })

    const payload = buildFeedbackPayload({
      ...baseParams,
      feedbackMessageId: 'msg-1',
      target,
    })

    expect(payload.messageId).toBe('msg-1')
    expect(payload.messageVariant).toBe('ai')
    expect(payload.completionTime).toBe('2.5s')
    expect(payload.credits).toBe(1.2)
  })

  test('includes target credits: 0 (not dropped)', () => {
    const target = createMessage({
      id: 'msg-1',
      credits: 0,
    })

    const payload = buildFeedbackPayload({
      ...baseParams,
      feedbackMessageId: 'msg-1',
      target,
    })

    expect(payload.credits).toBe(0)
  })

  test('includes optional fields when present', () => {
    const recentMessages: RecentMessageSummary[] = [{ type: 'user', id: 'msg-1' }]
    const errors = [{ id: 'err-1', message: 'Something went wrong' }]

    const payload = buildFeedbackPayload({
      ...baseParams,
      agentMode: 'MAX',
      sessionCreditsUsed: 3.5,
      recentMessages,
      errors,
    })

    expect(payload.agentMode).toBe('MAX')
    expect(payload.sessionCreditsUsed).toBe(3.5)
    expect(payload.recentMessages).toEqual(recentMessages)
    expect(payload.errors).toEqual(errors)
  })

  test('includes sessionCreditsUsed: 0 (not dropped)', () => {
    const payload = buildFeedbackPayload({
      ...baseParams,
      sessionCreditsUsed: 0,
    })

    expect(payload.sessionCreditsUsed).toBe(0)
  })

  test('omits empty recentMessages', () => {
    const payload = buildFeedbackPayload({
      ...baseParams,
      recentMessages: [],
    })

    expect(payload.recentMessages).toBeUndefined()
  })

  test('omits null errors', () => {
    const payload = buildFeedbackPayload({
      ...baseParams,
      errors: null,
    })

    expect(payload.errors).toBeUndefined()
  })

  test('omits empty string agentMode', () => {
    const payload = buildFeedbackPayload({
      ...baseParams,
      agentMode: '',
    })

    expect(payload.agentMode).toBeUndefined()
  })

  test('omits empty string completionTime from target', () => {
    const target = createMessage({
      id: 'msg-1',
      completionTime: '',
    })

    const payload = buildFeedbackPayload({
      ...baseParams,
      feedbackMessageId: 'msg-1',
      target,
    })

    expect(payload.completionTime).toBeUndefined()
  })

  test('truncates errors to schema limits', () => {
    const largeErrors = Array.from({ length: 60 }, (_, i) => ({
      id: 'e'.repeat(300),
      message: 'a'.repeat(3000),
    }))

    const payload = buildFeedbackPayload({
      ...baseParams,
      errors: largeErrors,
    })

    expect(payload.errors).toHaveLength(50)
    expect(payload.errors![0].message).toHaveLength(2000)
    expect(payload.errors![0].id).toHaveLength(200)
  })

  test('treats empty feedbackMessageId as general type', () => {
    const payload = buildFeedbackPayload({
      ...baseParams,
      feedbackMessageId: '',
    })

    expect(payload.type).toBe('general')
    expect(payload.messageId).toBeUndefined()
  })
})

describe('Cross-layer validation', () => {
  test('buildFeedbackPayload output satisfies server-side zod schema', () => {
    const messages = [
      createMessage({ id: 'msg-1', variant: 'user' }),
      createMessage({ id: 'msg-2', variant: 'ai', completionTime: '2.5s', credits: 1.2 }),
    ]

    const { target, recentMessages } = buildMessageContext(messages, 'msg-2')
    const payload = buildFeedbackPayload({
      text: 'Great feature!',
      feedbackCategory: 'good_result',
      feedbackMessageId: 'msg-2',
      target,
      recentMessages,
      agentMode: 'MAX',
      sessionCreditsUsed: 3.5,
      errors: [{ id: 'err-1', message: 'Something went wrong' }],
      clientFeedbackId: 'c3d4e5f6-a7b8-4012-8def-123456789012',
    })

    const result = feedbackRequestSchema.safeParse(payload)
    expect(result.success).toBe(true)
  })

  test('minimal buildFeedbackPayload output satisfies server-side zod schema', () => {
    const payload = buildFeedbackPayload({
      text: 'Bug report',
      feedbackCategory: 'app_bug',
      feedbackMessageId: null,
      target: null,
      recentMessages: [],
      agentMode: null,
      sessionCreditsUsed: null,
      errors: null,
      clientFeedbackId: 'd4e5f6a7-b8c9-4123-9efa-234567890123',
    })

    const result = feedbackRequestSchema.safeParse(payload)
    expect(result.success).toBe(true)
  })

  test('payload always includes source field', () => {
    const payload = buildFeedbackPayload({
      text: 'test',
      feedbackCategory: 'other',
      feedbackMessageId: null,
      target: null,
      recentMessages: [],
      agentMode: null,
      sessionCreditsUsed: null,
      errors: null,
      clientFeedbackId: 'e5f6a7b8-c9d0-4234-afab-345678901234',
    })

    expect(payload.source).toBe('cli')
    const result = feedbackRequestSchema.safeParse(payload)
    expect(result.success).toBe(true)
  })

  test('schema rejects type=message without messageId', () => {
    const payload = {
      text: 'test',
      category: 'other',
      type: 'message',
      source: 'cli',
    }

    const result = feedbackRequestSchema.safeParse(payload)
    expect(result.success).toBe(false)
  })
})
