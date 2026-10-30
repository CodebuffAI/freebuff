import {
  assistantMessage,
  jsonToolResult,
  systemMessage,
  userMessage,
} from '@codebuff/common/util/messages'
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from 'bun:test'

import {
  trimMessagesToFitTokenLimit,
  messagesWithSystem,
  getPreviouslyReadFiles,
  buildUserMessageContent,
  frameSteeringContent,
  frameSteeringText,
  STEERING_NOTE,
  unwrapSteeringText,
  applyKeepLastTags,
  expireMessages,
} from '../../util/messages'
import { dropUnansweredToolCalls } from '@codebuff/common/util/messages'
import * as tokenCounter from '../token-counter'

import type { CodebuffToolMessage } from '@codebuff/common/tools/list'
import type { Message } from '@codebuff/common/types/messages/codebuff-message'
import type { TextPart } from '@codebuff/common/types/messages/content-part'

/**
 * Type guard to check if a content part is a text part.
 */
function isTextPart(part: unknown): part is TextPart {
  return (
    typeof part === 'object' &&
    part !== null &&
    'type' in part &&
    part.type === 'text' &&
    'text' in part
  )
}

describe('messagesWithSystem', () => {
  it('prepends system message to array', () => {
    const messages = [userMessage('hello'), assistantMessage('hi')] as Message[]
    const system = 'Be helpful'

    const result = messagesWithSystem({ messages, system })

    // Use the original message objects to avoid flaky sentAt timestamp comparisons
    expect(result).toEqual([systemMessage('Be helpful'), ...messages])
  })
})

describe('buildUserMessageContent', () => {
  it('uses prompt directly when no content is provided', () => {
    const result = buildUserMessageContent('Hello world', undefined, undefined)

    expect(result).toHaveLength(1)
    expect(result[0].type).toBe('text')
    const firstPart = result[0]
    if (!isTextPart(firstPart)) throw new Error('Expected text part')
    expect(firstPart.text).toBe('Hello world')
  })

  it('uses text content directly', () => {
    const result = buildUserMessageContent(undefined, undefined, [
      { type: 'text', text: 'Hello from content' },
    ])

    expect(result).toHaveLength(1)
    expect(result[0].type).toBe('text')
    const firstPart = result[0]
    if (!isTextPart(firstPart)) throw new Error('Expected text part')
    expect(firstPart.text).toBe('Hello from content')
  })

  it('uses prompt when content has empty text part', () => {
    const result = buildUserMessageContent('See attached image(s)', undefined, [
      { type: 'text', text: '' },
      { type: 'image', image: 'base64data', mediaType: 'image/png' },
    ])

    expect(result).toHaveLength(2)
    expect(result[0].type).toBe('text')
    const firstPart = result[0]
    if (!isTextPart(firstPart)) throw new Error('Expected text part')
    expect(firstPart.text).toContain('See attached image(s)')
    expect(result[1].type).toBe('image')
  })

  it('uses prompt when content has whitespace-only text part', () => {
    const result = buildUserMessageContent('See attached image(s)', undefined, [
      { type: 'text', text: '   ' },
      { type: 'image', image: 'base64data', mediaType: 'image/png' },
    ])

    expect(result).toHaveLength(2)
    expect(result[0].type).toBe('text')
    const firstPart = result[0]
    if (!isTextPart(firstPart)) throw new Error('Expected text part')
    expect(firstPart.text).toContain('See attached image(s)')
    expect(result[1].type).toBe('image')
  })

  it('uses prompt when content has only images (no text part)', () => {
    const result = buildUserMessageContent('See attached image(s)', undefined, [
      { type: 'image', image: 'base64data', mediaType: 'image/png' },
    ])

    expect(result).toHaveLength(2)
    expect(result[0].type).toBe('text')
    const firstPart = result[0]
    if (!isTextPart(firstPart)) throw new Error('Expected text part')
    expect(firstPart.text).toContain('See attached image(s)')
    expect(result[1].type).toBe('image')
  })

  it('uses content text when it has meaningful content (ignores prompt)', () => {
    const result = buildUserMessageContent(
      'This prompt should be ignored',
      undefined,
      [
        { type: 'text', text: 'User provided text' },
        { type: 'image', image: 'base64data', mediaType: 'image/png' },
      ],
    )

    expect(result).toHaveLength(2)
    expect(result[0].type).toBe('text')
    const firstPart = result[0]
    if (!isTextPart(firstPart)) throw new Error('Expected text part')
    expect(firstPart.text).toContain('User provided text')
    expect(firstPart.text).not.toContain('This prompt should be ignored')
    expect(result[1].type).toBe('image')
  })

  it('ignores whitespace-only prompt when content has no text', () => {
    const result = buildUserMessageContent('   ', undefined, [
      { type: 'image', image: 'base64data', mediaType: 'image/png' },
    ])

    expect(result).toHaveLength(1)
    expect(result[0].type).toBe('image')
  })
})

// Mock logger for tests
const logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

describe('trimMessagesToFitTokenLimit', () => {
  beforeEach(() => {
    // Mock countTokensJson to just count characters
    spyOn(tokenCounter, 'countTokensJson').mockImplementation((text) => {
      // Make token count high enough to trigger simplification
      return JSON.stringify(text).length
    })
  })

  afterEach(() => {
    mock.restore()
  })

  const testMessages: Message[] = [
    // Regular message without tool calls - should never be shortened, but won't fit in the final array
    assistantMessage(
      'This is a long assistant message that would normally be shortened but since it has no tool calls it should be preserved completely intact no matter what',
    ),
    // Regular message without tool calls - should never be shortened
    userMessage(
      'This is a long message that would normally be shortened but since it has no tool calls it should be preserved completely intact no matter what',
    ),
    {
      // Terminal output 0 (oldest) - should be simplified

      role: 'tool',
      toolName: 'run_terminal_command',
      toolCallId: 'test-id-0',
      content: jsonToolResult(`Terminal output 0${'.'.repeat(2000)}`),
    },
    {
      // Terminal output 1 - should be preserved (shorter than '[Output omitted]')
      role: 'tool',
      toolName: 'run_terminal_command',
      toolCallId: 'test-id-1',
      content: jsonToolResult(`Short output 1`),
    },
    {
      // Terminal output 2 - should be simplified
      role: 'tool',
      toolName: 'run_terminal_command',
      toolCallId: 'test-id-2',
      content: jsonToolResult(`Terminal output 2${'.'.repeat(2000)}`),
    },
    {
      // Terminal output 3 - should be preserved (5th most recent)
      role: 'tool',
      toolName: 'run_terminal_command',
      toolCallId: 'test-id-3',
      content: jsonToolResult(`Terminal output 3`),
    },
    {
      role: 'tool',
      toolName: 'run_terminal_command',
      toolCallId: 'test-id-4',
      content: jsonToolResult(`Terminal output 4`),
    },
    // Regular message - should never be shortened
    userMessage({
      type: 'image',
      image: 'xyz',
      mediaType: 'image/jpeg',
    }),
    {
      // Terminal output 5 - should be preserved (3rd most recent)
      role: 'tool',
      toolName: 'run_terminal_command',
      toolCallId: 'test-id-5',
      content: jsonToolResult(`Terminal output 5`),
    },
    {
      // Terminal output 6 - should be preserved (2nd most recent)
      role: 'tool',
      toolName: 'run_terminal_command',
      toolCallId: 'test-id-6',
      content: jsonToolResult(`Terminal output 6`),
    },
    {
      // Terminal output 7 - should be preserved (most recent)
      role: 'tool',
      toolName: 'run_terminal_command',
      toolCallId: 'test-id-7',
      content: jsonToolResult(`Terminal output 7`),
    },
    // Regular message - should never be shortened
    assistantMessage(
      'Another long message that should never be shortened because it has no tool calls in it at all',
    ),
  ]

  it('handles all features working together correctly', () => {
    const maxTotalTokens = 3000
    const systemTokens = 0
    const result = trimMessagesToFitTokenLimit({
      messages: testMessages,
      systemTokens,
      maxTotalTokens,
      logger,
    })

    // Should have replacement message for omitted content
    expect(result.length).toBeGreaterThan(0)

    // Should contain a replacement message for omitted content
    const hasReplacementMessage = result.some(
      (msg) =>
        msg.content[0].type === 'text' &&
        msg.content[0].text.includes(
          'Previous message(s) omitted due to length',
        ),
    )
    expect(hasReplacementMessage).toBe(true)

    // Verify total tokens are under limit
    const finalTokens = tokenCounter.countTokensJson(result)
    expect(finalTokens).toBeLessThan((maxTotalTokens - systemTokens) * 0.5)
  })

  it('subtracts system tokens from total tokens', () => {
    const maxTotalTokens = 10_000
    const systemTokens = 7_000
    const result = trimMessagesToFitTokenLimit({
      messages: testMessages,
      systemTokens,
      maxTotalTokens,
      logger,
    })

    // Should have replacement message for omitted content
    expect(result.length).toBeGreaterThan(0)

    // Should contain a replacement message for omitted content
    const hasReplacementMessage = result.some(
      (msg) =>
        msg.content[0].type === 'text' &&
        msg.content[0].text.includes(
          'Previous message(s) omitted due to length',
        ),
    )
    expect(hasReplacementMessage).toBe(true)

    // Verify total tokens are under limit
    const finalTokens = tokenCounter.countTokensJson(result)
    expect(finalTokens).toBeLessThan((maxTotalTokens - systemTokens) * 0.5)
  })

  it('does not simplify if under token limit', () => {
    const maxTotalTokens = 10_000
    const systemTokens = 100
    const result = trimMessagesToFitTokenLimit({
      messages: testMessages,
      systemTokens,
      maxTotalTokens,
      logger,
    })

    // All messages should be unchanged
    expect(result).toHaveLength(testMessages.length)
    for (let i = 0; i < testMessages.length; i++) {
      expect(result[i].role).toEqual(testMessages[i].role)
      expect(result[i].content).toEqual(testMessages[i].content)
    }

    // Verify total tokens are under limit
    const finalTokens = tokenCounter.countTokensJson(result)
    expect(finalTokens).toBeLessThan(maxTotalTokens - systemTokens)
  })

  it('handles empty messages array', () => {
    const maxTotalTokens = 200
    const systemTokens = 100
    const result = trimMessagesToFitTokenLimit({
      messages: [],
      systemTokens,
      maxTotalTokens,
      logger,
    })

    expect(result).toEqual([])
  })

  describe('keepDuringTruncation functionality', () => {
    it('preserves messages marked with keepDuringTruncation=true', () => {
      const messages: Message[] = [
        userMessage(
          'A'.repeat(500), // Large message to force truncation
        ),
        userMessage(
          'B'.repeat(500), // Large message to force truncation
        ),
        userMessage({
          content: 'Message 3 - keep me!',
          keepDuringTruncation: true,
        }),
        assistantMessage(
          'C'.repeat(500), // Large message to force truncation
        ),
        userMessage({
          content: 'Message 5 - keep me too!',
          keepDuringTruncation: true,
        }),
      ]

      const result = trimMessagesToFitTokenLimit({
        messages,
        systemTokens: 0,
        // Below the messages' structured token total so truncation triggers.
        maxTotalTokens: 300,
        logger,
      })

      // Should contain the kept messages
      const keptMessages = result.filter(
        (msg) =>
          msg.content[0].type === 'text' &&
          (msg.content[0].text.includes('keep me!') ||
            msg.content[0].text.includes('keep me too!')),
      )
      expect(keptMessages).toHaveLength(2)

      // Should have replacement message for omitted content
      const hasReplacementMessage = result.some(
        (msg) =>
          msg.content[0].type === 'text' &&
          msg.content[0].text.includes(
            'Previous message(s) omitted due to length',
          ),
      )
      expect(hasReplacementMessage).toBe(true)
    })

    it('does not add replacement message when no messages are removed', () => {
      const messages = [
        userMessage('Short message 1'),
        userMessage({
          content: 'Short message 2',
          keepDuringTruncation: true,
        }),
      ]

      const result = trimMessagesToFitTokenLimit({
        messages,
        systemTokens: 0,
        maxTotalTokens: 10000,
        logger,
      })

      // Should be unchanged when under token limit
      expect(result).toHaveLength(2)
      expect(
        result[0].content[0].type === 'text' && result[0].content[0].text,
      ).toBe('Short message 1')
      expect(
        result[1].content[0].type === 'text' && result[1].content[0].text,
      ).toBe('Short message 2')
    })

    it('handles consecutive replacement messages correctly', () => {
      const messages: Message[] = [
        userMessage('A'.repeat(1000)), // Large message to be removed
        userMessage('B'.repeat(1000)), // Large message to be removed
        userMessage('C'.repeat(1000)), // Large message to be removed
        userMessage({ content: 'Keep this', keepDuringTruncation: true }),
      ]

      const result = trimMessagesToFitTokenLimit({
        messages,
        systemTokens: 0,
        // Below the messages' structured token total so truncation triggers.
        maxTotalTokens: 500,
        logger,
      })

      // Should only have one replacement message for consecutive removals
      const replacementMessages = result.filter(
        (msg) =>
          msg.content[0].type === 'text' &&
          msg.content[0].text.includes(
            'Previous message(s) omitted due to length',
          ),
      )
      expect(replacementMessages).toHaveLength(1)

      // Should keep the marked message
      const keptMessage = result.find(
        (msg) =>
          msg.content[0].type === 'text' &&
          msg.content[0].text.includes('Keep this'),
      )
      expect(keptMessage).toBeDefined()
    })

    it('calculates token removal correctly with keepDuringTruncation', () => {
      const messages: Message[] = [
        userMessage('A'.repeat(500)), // Will be removed
        userMessage('B'.repeat(500)), // Will be removed
        userMessage({
          content: 'Keep this short message',
          keepDuringTruncation: true,
        }),
        userMessage('C'.repeat(100)), // Might be kept
      ]

      const result = trimMessagesToFitTokenLimit({
        messages,
        systemTokens: 0,
        maxTotalTokens: 2000,
        logger,
      })

      // Should preserve the keepDuringTruncation message
      const keptMessage = result.find(
        (msg) =>
          msg.content[0].type === 'text' &&
          msg.content[0].text.includes('Keep this short message'),
      )
      expect(keptMessage).toBeDefined()

      // Total tokens should be under limit
      const finalTokens = tokenCounter.countTokensJson(result)
      expect(finalTokens).toBeLessThan(2000)
    })

    it('handles mixed keepDuringTruncation and regular messages', () => {
      const messages: Message[] = [
        userMessage('A'.repeat(800)), // Large message to force truncation
        userMessage({ content: 'Keep 1', keepDuringTruncation: true }),
        userMessage('B'.repeat(800)), // Large message to force truncation
        userMessage({ content: 'Keep 2', keepDuringTruncation: true }),
        userMessage('C'.repeat(800)), // Large message to force truncation
      ]

      const result = trimMessagesToFitTokenLimit({
        messages,
        systemTokens: 0,
        maxTotalTokens: 500,
        logger,
      })

      // Should keep both marked messages
      const keptMessages = result.filter(
        (msg) =>
          msg.content[0].type === 'text' &&
          (msg.content[0].text.includes('Keep 1') ||
            msg.content[0].text.includes('Keep 2')),
      )
      expect(keptMessages).toHaveLength(2)

      // Should have replacement messages for removed content
      const replacementMessages = result.filter(
        (msg) =>
          msg.content[0].type === 'text' &&
          msg.content[0].text.includes(
            'Previous message(s) omitted due to length',
          ),
      )
      expect(replacementMessages.length).toBeGreaterThan(0)
    })
  })
})

describe('getPreviouslyReadFiles', () => {
  it('returns empty array when no messages provided', () => {
    const result = getPreviouslyReadFiles({ messages: [], logger })
    expect(result).toEqual([])
  })

  it('returns empty array when no tool messages with relevant tool names', () => {
    const messages: Message[] = [
      userMessage('hello'),
      userMessage('hi'),
      {
        role: 'tool',
        toolName: 'write_file',
        toolCallId: 'test-id',
        content: jsonToolResult({
          file: 'test.ts',
          errorMessage: 'error',
        }),
      } satisfies CodebuffToolMessage<'write_file'>,
    ]

    const result = getPreviouslyReadFiles({ messages, logger })
    expect(result).toEqual([])
  })

  it('extracts files from read_files tool messages', () => {
    const messages: Message[] = [
      {
        role: 'tool',
        toolName: 'read_files',
        toolCallId: 'test-id',
        content: jsonToolResult([
          {
            path: 'src/test.ts',
            content: 'export function test() {}',
            referencedBy: { 'main.ts': ['line 10'] },
          },
          {
            path: 'src/utils.ts',
            content: 'export const utils = {}',
          },
        ] as const),
      } satisfies CodebuffToolMessage<'read_files'>,
    ]

    const result = getPreviouslyReadFiles({ messages, logger })
    expect(result).toEqual([
      {
        path: 'src/test.ts',
        content: 'export function test() {}',
        referencedBy: { 'main.ts': ['line 10'] },
      },
      {
        path: 'src/utils.ts',
        content: 'export const utils = {}',
      },
    ])
  })

  it('extracts files from find_files tool messages', () => {
    const messages: Message[] = [
      {
        role: 'tool',
        toolName: 'find_files',
        toolCallId: 'test-id',
        content: jsonToolResult([
          {
            path: 'components/Button.tsx',
            content: 'export const Button = () => {}',
          },
        ] as const),
      } satisfies CodebuffToolMessage<'find_files'>,
    ]

    const result = getPreviouslyReadFiles({ messages, logger })
    expect(result).toEqual([
      {
        path: 'components/Button.tsx',
        content: 'export const Button = () => {}',
      },
    ])
  })

  it('combines files from multiple tool messages', () => {
    const messages: Message[] = [
      {
        role: 'tool',
        toolName: 'read_files',
        toolCallId: 'test-id-1',
        content: jsonToolResult([
          {
            path: 'file1.ts',
            content: 'content 1',
          },
        ]),
      } satisfies CodebuffToolMessage<'read_files'>,
      {
        role: 'tool',
        toolName: 'find_files',
        toolCallId: 'test-id-2',
        content: jsonToolResult([
          {
            path: 'file2.ts',
            content: 'content 2',
          },
        ]),
      } satisfies CodebuffToolMessage<'find_files'>,
      userMessage('Some user message'),
    ]

    const result = getPreviouslyReadFiles({ messages, logger })
    expect(result).toEqual([
      { path: 'file1.ts', content: 'content 1' },
      { path: 'file2.ts', content: 'content 2' },
    ])
  })

  it('handles contentOmittedForLength files by filtering them out', () => {
    const messages: Message[] = [
      {
        role: 'tool',
        toolName: 'read_files',
        toolCallId: 'test-id',
        content: jsonToolResult([
          {
            path: 'small-file.ts',
            content: 'small content',
          },
          {
            path: 'large-file.ts',
            contentOmittedForLength: true,
          },
          {
            path: 'another-small-file.ts',
            content: 'another small content',
          },
        ] as const),
      } satisfies CodebuffToolMessage<'read_files'>,
    ]

    const result = getPreviouslyReadFiles({ messages, logger })
    expect(result).toEqual([
      { path: 'small-file.ts', content: 'small content' },
      { path: 'another-small-file.ts', content: 'another small content' },
    ])
  })

  it('handles malformed tool message output gracefully', () => {
    const mockLoggerError = spyOn(logger, 'error').mockImplementation(() => {})

    // Use jsonToolResult with non-array data to trigger error handling
    // The function expects an array of files but we give it an object
    const malformedMessage: Message = {
      role: 'tool' as const,
      toolName: 'read_files',
      toolCallId: 'test-id',
      content: jsonToolResult({ unexpectedFormat: true }),
    }

    const messages: Message[] = [malformedMessage]

    const result = getPreviouslyReadFiles({ messages, logger })
    expect(result).toEqual([])
    expect(mockLoggerError).toHaveBeenCalled()

    mockLoggerError.mockRestore()
  })

  it('handles find_files tool messages with error message instead of files', () => {
    const messages: Message[] = [
      {
        role: 'tool',
        toolName: 'find_files',
        toolCallId: 'test-id',
        content: jsonToolResult({
          message: 'No files found matching the criteria',
        }),
      } satisfies CodebuffToolMessage<'find_files'>,
    ]

    const result = getPreviouslyReadFiles({ messages, logger })
    expect(result).toEqual([])
  })

  it('ignores non-tool messages', () => {
    const messages: Message[] = [
      userMessage('hello'),
      assistantMessage('hi there'),
      systemMessage('system message'),
      {
        role: 'tool',
        toolName: 'read_files',
        toolCallId: 'test-id',
        content: jsonToolResult([
          {
            path: 'test.ts',
            content: 'test content',
          },
        ]),
      } satisfies CodebuffToolMessage<'read_files'>,
    ]

    const result = getPreviouslyReadFiles({ messages, logger })
    expect(result).toEqual([{ path: 'test.ts', content: 'test content' }])
  })

  it('handles empty file arrays in tool output', () => {
    const messages: Message[] = [
      {
        role: 'tool',
        toolName: 'read_files',
        toolCallId: 'test-id',
        content: jsonToolResult([]),
      } satisfies CodebuffToolMessage<'read_files'>,
    ]

    const result = getPreviouslyReadFiles({ messages, logger })
    expect(result).toEqual([])
  })
})

describe('steering framing', () => {
  it('wraps the text with the mid-turn note', () => {
    const framed = frameSteeringText('also add tests')
    expect(framed).toBe(
      `<user_message_sent_while_working>\nalso add tests\n</user_message_sent_while_working>\n\n${STEERING_NOTE}`,
    )
  })

  it('never double-wraps', () => {
    const once = frameSteeringText('also add tests')
    expect(frameSteeringText(once)).toBe(once)
  })

  it('unwraps back to exactly what the user typed', () => {
    const text = 'line one\n\nline two'
    expect(unwrapSteeringText(frameSteeringText(text))).toBe(text)
    expect(unwrapSteeringText('plain prompt')).toBe('plain prompt')
  })

  it('frames the first text part and keeps images', () => {
    const image = {
      type: 'image' as const,
      image: 'Zmlyc3Q=',
      mediaType: 'image/png',
    }
    expect(
      frameSteeringContent([{ type: 'text', text: 'look' }, image]),
    ).toEqual([{ type: 'text', text: frameSteeringText('look') }, image])
    expect(frameSteeringContent([image])).toEqual([
      { type: 'text', text: frameSteeringText('') },
      image,
    ])
  })
})

const textOf = (m: Message) =>
  Array.isArray(m.content) &&
  m.content[0].type === 'text'
    ? m.content[0].text
    : ''

describe('expireMessages with expiresAt', () => {
  // Consecutive pushes within one millisecond collapse sentAt ties, and the
  // age tiebreak (message.sentAt >= marker.sentAt => too new to expire) then
  // keeps everything alive one extra pass. The loop's real pushes are far
  // apart; the tests space them by a millisecond per push so the boundary
  // order is the thing being pinned, not the tiebreak.
  const tick = { t: (Date.now() - 60_000) + 0 }
  const nudge = () =>
    userMessage({
      content: 'nudge: keep going',
      tags: ['NUDGE'],
      expiresAt: 'agentStep',
    })

  it('keeps a nudge on the immediately following step, drops it one step later', () => {
    // Mid-step nudge lifetime in loopAgentSteps' exact pass order:
    // step-top pass of step N+1 (marker from step N was present, nudge is
    // newer => kept; fresh marker appended after it) -> mid-step cleanup
    // (nudge is older than that fresh marker => expires here, one full
    // diegetic step after push) -> step N+2 sees neither nudge nor marker.
    const nudgeMsg = { ...nudge(), sentAt: tick.t++ }
    const stepTop = expireMessages([userMessage('real prompt'), nudgeMsg], 'agentStep')
    // No marker in the input and nothing else expires, but the nudge itself
    // gets a marker: the model's step N+1 prompt carried the nudge once.
    expect(stepTop.some((m) => textOf(m).includes('nudge: keep going'))).toBe(
      true,
    )
    expect(
      stepTop.filter((m) => textOf(m).includes('<step_boundary_snitch>')),
    ).toHaveLength(1)

    // Mid-step cleanup: marker now precedes the nudge, so this is the
    // boundary the nudge dies on — it has been in exactly one prompt.
    const assistantEcho = assistantMessage('working on it')
    const midStep = expireMessages(
      [...stepTop, assistantEcho],
      'agentStep',
    )
    expect(
      midStep.some((m) => textOf(m).includes('nudge: keep going')),
    ).toBe(false)
    expect(
      midStep.filter((m) => textOf(m).includes('<step_boundary_snitch>')),
    ).toHaveLength(0)
    // Step N+2's prompt: user prompt + assistant answer only.
    expect(midStep.map((m) => m.role)).toEqual(['user', 'assistant'])
  })

  it('userPrompt-scope expiresAt survives steps until a turn-end pass', () => {
    const history = [
      userMessage('real prompt'),
      userMessage({
        content: 'turn note',
        tags: ['NUDGE'],
        expiresAt: 'userPrompt',
      }),
    ]
    const step1 = expireMessages(history, 'agentStep')
    expect(step1.some((m) => textOf(m).includes('turn note'))).toBe(true)
    const turnEnd = expireMessages(step1, 'userPrompt')
    expect(turnEnd.some((m) => textOf(m).includes('turn note'))).toBe(false)
  })

  it('agentStep expiresAt outlives a turn-end pass only when the next pass is agentStep', () => {
    const turnNudge = { ...nudge(), sentAt: tick.t++ }
    const markerAfterTurnEnd = expireMessages([turnNudge], 'userPrompt')
    expect(markerAfterTurnEnd.some((m) => textOf(m).includes('nudge'))).toBe(
      true,
    )
    const nextTurnFirstStep = expireMessages(markerAfterTurnEnd, 'agentStep')
    expect(nextTurnFirstStep.some((m) => textOf(m).includes('nudge'))).toBe(
      false,
    )
  })

  it('never expires unmarked messages', () => {
    const history = [
      { ...nudge(), sentAt: tick.t++ },
      userMessage({ content: 'regular', tags: ['NUDGE'], sentAt: tick.t++ } as any),
    ]
    const result = expireMessages(expireMessages(history, 'agentStep'), 'agentStep')
    expect(
      result.filter((m) => textOf(m).includes('regular')),
    ).toHaveLength(1)
  })

  it('treats turn/conversation/notImplemented as non-expiring', () => {
    for (const expiresAt of ['turn', 'conversation', 'notImplemented'] as const) {
      const history = [
        userMessage({ content: `m-${expiresAt}`, expiresAt }),
      ]
      let current: Message[] = history
      for (let i = 0; i < 3; i++) current = expireMessages(current, 'agentStep')
      expect(current.some((m) => textOf(m) === `m-${expiresAt}`)).toBe(true)
      // No marker churn with nothing expiring.
      expect(
        current.filter((m) => textOf(m).includes('<step_boundary_snitch>')),
      ).toHaveLength(0)
    }
  })

  it('strips both old and new marker aliases', () => {
    const legacy = userMessage({
      content: '<step_boundary_snitch> oldest step boundary legacy',
      tags: ['USER_MESSAGE_SEEN'],
    })
    const result = expireMessages([nudge(), legacy], 'agentStep')
    expect(result.filter((m) => m.tags?.includes('USER_MESSAGE_SEEN'))).toHaveLength(0)
  })
})

describe('applyKeepLastTags', () => {
  const instructions = (n: number, withKeep = true) =>
    userMessage({
      content: `instructions v${n}`,
      tags: ['INSTRUCTIONS_PROMPT'],
      ...(withKeep ? { keepLastTags: ['INSTRUCTIONS_PROMPT'] } : {}),
    })

  it('drops an old INSTRUCTIONS_PROMPT when a new keepLastTags one arrives', () => {
    const result = applyKeepLastTags([
      instructions(1),
      userMessage('user turn 1'),
      instructions(2),
    ])
    expect(result.map(textOf)).toEqual(['user turn 1', 'instructions v2'])
  })

  it('tag overlap through the message own tags also supersedes', () => {
    const result = applyKeepLastTags([
      userMessage({ content: 'stale note', tags: ['INSTRUCTIONS_PROMPT'] }),
      userMessage('between'),
      instructions(2),
    ])
    expect(result.map(textOf)).toEqual(['between', 'instructions v2'])
  })

  it('leaves non-overlapping tags untouched', () => {
    const result = applyKeepLastTags([
      userMessage({ content: 'other tagged', tags: ['SOMETHING_ELSE'] }),
      instructions(1),
      userMessage('plain'),
    ])
    expect(result.map(textOf)).toEqual([
      'other tagged',
      'instructions v1',
      'plain',
    ])
  })

  it('only keeps the latest declaration when several pile up', () => {
    // Declarations never reach FORWARD: an earlier keepLastTags cannot prune
    // a later overlapping message. But a later declaration prunes any earlier
    // overlapping message, including an earlier declaration itself, so of a
    // pile-up only the newest survives.
    const forwardBlocked = applyKeepLastTags([
      instructions(1),
      userMessage({ content: 'late tagged', tags: ['INSTRUCTIONS_PROMPT'] }),
    ])
    expect(forwardBlocked.map(textOf)).toEqual([
      'instructions v1',
      'late tagged',
    ])

    const pileUp = applyKeepLastTags([instructions(1), instructions(2)])
    expect(pileUp.map(textOf)).toEqual(['instructions v2'])
  })

  it('runs from expireMessages while assembling step history', () => {
    // First pass (turn 1's diegetic step): turn 1's instructions stay; no
    // newer declaration exists yet.
    const turn1 = expireMessages(
      [instructions(1), userMessage('turn 1 prompt')],
      'agentStep',
    )
    expect(turn1.map(textOf)).toContain('instructions v1')
    // Turn 2 arrives with a new declaration; the very next assembly pass
    // prunes the superseded turn-1 copy. keepLastTags is a content-supersede
    // rule, so it does not wait for the model to see the new one.
    const turn2 = expireMessages(
      [...turn1, userMessage('turn 2 prompt'), instructions(2)],
      'agentStep',
    )
    expect(turn2.map(textOf)).not.toContain('instructions v1')
    expect(turn2.map(textOf)).toContain('instructions v2')
  })
})

describe('expiry vs dropUnansweredToolCalls repair', () => {
  // Same sentAt spacing as the expiresAt suite: real pushes are ms apart.
  const tick = { t: Date.now() - 60_000 }
  // Mirrors runAgentStep's order: expireMessages first, repair second.
  const assemble = (messages: Message[]) =>
    dropUnansweredToolCalls(expireMessages(messages, 'agentStep'))

  const orphanCall = () =>
    assistantMessage([
      {
        type: 'tool-call' as const,
        toolCallId: 'tc-1',
        toolName: 'read_files',
        input: {},
      },
    ] as const)

  it('a live nudge flushes and repairs the same orphan timeToLive would have', () => {
    // timeToLive version (legacy behavior pins the semantics both share).
    const withTtl = assemble([
      orphanCall(),
      userMessage({ content: 'n', tags: ['N'], timeToLive: 'userPrompt' }),
    ])
    const withExpiresAt = assemble([
      orphanCall(),
      userMessage({
        content: 'n',
        tags: ['N'],
        expiresAt: 'userPrompt',
      }),
    ])
    // User-boundary flush marks the orphaned call unanswered in both; the
    // appended snitch marker flushes it too, so the repair is identical.
    for (const result of [withTtl, withExpiresAt]) {
      expect(result.some((m) => m.role === 'assistant')).toBe(false)
    }
    expect(withExpiresAt.map(textOf)).toEqual(
      expect.arrayContaining([expect.stringContaining('n')]),
    )
  })

  it('an expelled nudge boundary repairs the same orphan the model saw', () => {
    // Sequence: orphaned call -> nudge -> repair user message -> tool result.
    // The userRole nudge flushes the pending call at the boundary; the model
    // sees that repaired (call-dropped) view on EVERY step the nudge is live,
    // and after the nudge expires the underlying call+result pair is also
    // gone, so repair views never flip between passes.
    const tc = orphanCall()
    const toolResult: Message = {
      role: 'tool',
      toolCallId: 'tc-1',
      toolName: 'read_files',
      content: jsonToolResult([]),
    }
    const firstPass = assemble([
      tc,
      {
        ...userMessage({
          content: 'nudge',
          tags: ['N'],
          expiresAt: 'agentStep',
        }),
        sentAt: tick.t++,
      },
      toolResult,
    ])
    // The nudge is userRole: the orphan was flushed at its boundary and the
    // assistant message dropped; the tool result is intentionally preserved
    // by the repair (freestanding results are legal).
    expect(firstPass.filter((m) => m.role === 'assistant')).toHaveLength(0)
    expect(firstPass.filter((m) => m.role === 'tool')).toHaveLength(1)
    expect(firstPass.some((m) => textOf(m) === 'nudge')).toBe(true)

    // After the nudge expires on the next pass, repair must not resurrect or
    // further mutate the pair.
    const secondPass = dropUnansweredToolCalls(
      expireMessages(firstPass, 'agentStep'),
    )
    expect(secondPass.filter((m) => m.role === 'assistant')).toHaveLength(0)
    expect(secondPass.filter((m) => m.role === 'tool')).toHaveLength(1)
    expect(secondPass.some((m) => textOf(m) === 'nudge')).toBe(false)
  })

  it('empty-but-live nudge history yields no phantom marker-only prompts', () => {
    const result = assemble([])
    expect(result).toHaveLength(0)
  })
})
