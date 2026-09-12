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
} from '../../util/messages'
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

  describe('orphaned tool results at the removal boundary', () => {
    // Regression: the removal run stops as soon as the token budget is met,
    // which can land exactly between an assistant tool-call and its result.
    // The kept tool message then reaches the provider without its call and
    // is rejected with "tool_call_id does not exist", failing the whole step.

    const toolCallPart = (toolCallId: string, filler: string) => ({
      type: 'tool-call' as const,
      toolCallId,
      toolName: 'write_file' as const,
      input: { content: filler },
    })

    const toolResultMessage = (
      toolCallId: string,
      filler: string,
    ): Message => ({
      role: 'tool',
      toolName: 'write_file',
      toolCallId,
      content: jsonToolResult(filler),
    })

    /** Every tool result in the output must have its call in the output. */
    const expectNoOrphanedToolResults = (result: Message[]) => {
      const keptToolCallIds = new Set<string>()
      for (const message of result) {
        if (message.role !== 'assistant' || !Array.isArray(message.content)) {
          continue
        }
        for (const part of message.content) {
          if (part.type === 'tool-call') {
            keptToolCallIds.add(part.toolCallId)
          }
        }
      }
      const orphaned = result.filter(
        (message) =>
          message.role === 'tool' && !keptToolCallIds.has(message.toolCallId),
      )
      expect(orphaned).toEqual([])
    }

    it('drops a tool result whose call was removed at the boundary', () => {
      const messages: Message[] = [
        userMessage('please write the file'),
        assistantMessage({
          content: [toolCallPart('c1', 'x'.repeat(4000))],
        }),
        toolResultMessage('c1', 'ok'),
        assistantMessage('done'),
      ]

      const result = trimMessagesToFitTokenLimit({
        messages,
        systemTokens: 0,
        maxTotalTokens: 600,
        logger,
      })

      expectNoOrphanedToolResults(result)
      // The final 'done' assistant message must survive the trim.
      expect(
        result.some(
          (message) =>
            message.role === 'assistant' &&
            message.content.some(
              (part) => part.type === 'text' && part.text === 'done',
            ),
        ),
      ).toBe(true)
    })

    it('drops tool results orphaned after a kept keepDuringTruncation message', () => {
      // The removal run is not a pure prefix when keepDuringTruncation
      // messages sit in the middle: the boundary orphan can appear anywhere,
      // not just leading the kept run.
      const messages: Message[] = [
        userMessage('please write the file'),
        assistantMessage({
          content: [toolCallPart('c1', 'x'.repeat(4000))],
        }),
        userMessage({ content: 'steer', keepDuringTruncation: true }),
        toolResultMessage('c1', 'ok'),
        assistantMessage('done'),
      ]

      const result = trimMessagesToFitTokenLimit({
        messages,
        systemTokens: 0,
        maxTotalTokens: 600,
        logger,
      })

      expectNoOrphanedToolResults(result)
    })

    it('keeps tool results whose call survives the trim', () => {
      const messages: Message[] = [
        userMessage('please write the file'),
        assistantMessage({
          content: [toolCallPart('c1', 'x'.repeat(4000))],
        }),
        toolResultMessage('c1', 'ok'),
        assistantMessage('done'),
      ]

      // Generous budget: nothing gets removed, pairing stays intact.
      const result = trimMessagesToFitTokenLimit({
        messages,
        systemTokens: 0,
        maxTotalTokens: 60_000,
        logger,
      })

      expect(result).toEqual(messages)
    })

    it('leaves pre-existing orphans in an already-malformed history untouched', () => {
      // The tool result has no call anywhere in the input: trimming did not
      // create this orphan, so this fix leaves it alone instead of silently
      // rewriting histories it did not break. The trim is active here (the
      // large user message is removed) — only calls removed BY the trim
      // cause their results to be dropped.
      const messages: Message[] = [
        userMessage('x'.repeat(4000)),
        assistantMessage('done'),
        toolResultMessage('ghost', 'ok'),
      ]

      const result = trimMessagesToFitTokenLimit({
        messages,
        systemTokens: 0,
        maxTotalTokens: 600,
        logger,
      })

      const ghost = result.find(
        (message) => message.role === 'tool' && message.toolCallId === 'ghost',
      )
      expect(ghost).toBeDefined()
    })

    it('drops only the orphaned results when one assistant message carries multiple tool calls', () => {
      // Parallel tool calls: a single assistant message with calls c1 and c2.
      // The trim removes the call message; the drop matches per toolCallId, so
      // every result whose call was removed is dropped and nothing keyed to a
      // surviving call is touched.
      const messages: Message[] = [
        userMessage('write two files'),
        assistantMessage({
          content: [
            toolCallPart('c1', 'x'.repeat(3000)),
            toolCallPart('c2', 'y'.repeat(3000)),
          ],
        }),
        toolResultMessage('c1', 'ok1'),
        userMessage({ content: 'steer', keepDuringTruncation: true }),
        toolResultMessage('c2', 'ok2'),
        assistantMessage('done'),
      ]

      const result = trimMessagesToFitTokenLimit({
        messages,
        systemTokens: 0,
        maxTotalTokens: 600,
        logger,
      })

      expectNoOrphanedToolResults(result)
      // Neither orphaned result may survive in any form...
      expect(
        result.filter(
          (message) =>
            message.role === 'tool' &&
            (message.toolCallId === 'c1' || message.toolCallId === 'c2'),
        ),
      ).toEqual([])
      // ...while the kept steer message and the final reply still do.
      expect(
        result.some(
          (message) =>
            message.role === 'user' &&
            message.content.some(
              (part) => part.type === 'text' && part.text === 'steer',
            ),
        ),
      ).toBe(true)
      expect(
        result.some(
          (message) =>
            message.role === 'assistant' &&
            message.content.some(
              (part) => part.type === 'text' && part.text === 'done',
            ),
        ),
      ).toBe(true)
    })

    it('keeps every result of a multi-call assistant message that survives the trim', () => {
      const messages: Message[] = [
        userMessage('write two files'),
        assistantMessage({
          content: [toolCallPart('c1', 'ok'), toolCallPart('c2', 'ok')],
        }),
        toolResultMessage('c1', 'ok1'),
        toolResultMessage('c2', 'ok2'),
        assistantMessage('done'),
      ]

      // Generous budget: the multi-call message and both results survive.
      const result = trimMessagesToFitTokenLimit({
        messages,
        systemTokens: 0,
        maxTotalTokens: 60_000,
        logger,
      })

      expect(result).toEqual(messages)
    })

    it('keeps the invariant across a sweep of budgets', () => {
      const messages: Message[] = [
        userMessage('please write the file'),
        assistantMessage({
          content: [toolCallPart('c1', 'x'.repeat(3000))],
        }),
        toolResultMessage('c1', 'ok'),
        assistantMessage({
          content: [toolCallPart('c2', 'y'.repeat(1500))],
        }),
        toolResultMessage('c2', 'ok'),
        assistantMessage('done'),
      ]

      for (const maxTotalTokens of [200, 400, 800, 1600, 3200, 6400]) {
        const result = trimMessagesToFitTokenLimit({
          messages,
          systemTokens: 0,
          maxTotalTokens,
          logger,
        })
        expectNoOrphanedToolResults(result)
      }
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
