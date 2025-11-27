import { describe, expect, it, test } from 'bun:test'
import { cloneDeep } from 'lodash'

import {
  withCacheControl,
  withoutCacheControl,
  convertCbToModelMessages,
  systemMessage,
  userMessage,
  assistantMessage,
  jsonToolResult,
  mediaToolResult,
} from '../messages'

import type { Message } from '../../types/messages/codebuff-message'
import type { AssistantModelMessage, ToolResultPart } from 'ai'

describe('withCacheControl', () => {
  it('should add cache control to object without providerOptions', () => {
    const obj: { providerOptions?: any } = {}
    const result = withCacheControl(obj)

    expect(result.providerOptions).toBeDefined()
    expect(result.providerOptions?.anthropic?.cache_control).toEqual({
      type: 'ephemeral',
    })
    expect(result.providerOptions?.openrouter?.cache_control).toEqual({
      type: 'ephemeral',
    })
    expect(result.providerOptions?.openaiCompatible?.cache_control).toEqual({
      type: 'ephemeral',
    })
  })

  it('should add cache control to existing providerOptions', () => {
    const obj = {
      providerOptions: {
        anthropic: { someOtherOption: 'value' } as any,
      },
    }
    const result = withCacheControl(obj)

    expect((result.providerOptions?.anthropic as any)?.cache_control).toEqual({
      type: 'ephemeral',
    })
    expect((result.providerOptions?.anthropic as any)?.someOtherOption).toBe(
      'value',
    )
  })

  it('should not mutate original object', () => {
    const original: { providerOptions?: any } = {}
    const result = withCacheControl(original)

    expect(original.providerOptions).toBeUndefined()
    expect(result.providerOptions).toBeDefined()
  })

  it('should handle all three providers', () => {
    const obj: { providerOptions?: any } = {}
    const result = withCacheControl(obj)

    expect(
      (result.providerOptions?.anthropic as any)?.cache_control?.type,
    ).toBe('ephemeral')
    expect(
      (result.providerOptions?.openrouter as any)?.cache_control?.type,
    ).toBe('ephemeral')
    expect(
      (result.providerOptions?.openaiCompatible as any)?.cache_control?.type,
    ).toBe('ephemeral')
  })
})

describe('withoutCacheControl', () => {
  it('should remove cache control from all providers', () => {
    const obj = {
      id: 'test',
      providerOptions: {
        anthropic: { cache_control: { type: 'ephemeral' } },
        openrouter: { cache_control: { type: 'ephemeral' } },
        openaiCompatible: { cache_control: { type: 'ephemeral' } },
      },
    }
    const result = withoutCacheControl(obj)

    expect(result.providerOptions).toBeUndefined()
  })

  it('should preserve other provider options', () => {
    const obj = {
      id: 'test',
      providerOptions: {
        anthropic: {
          cache_control: { type: 'ephemeral' },
          otherOption: 'value',
        },
      },
    }
    const result = withoutCacheControl(obj)

    expect(result.providerOptions?.anthropic?.cache_control).toBeUndefined()
    expect(result.providerOptions?.anthropic?.otherOption).toBe('value')
  })

  it('should not mutate original object', () => {
    const original = {
      id: 'test',
      providerOptions: {
        anthropic: { cache_control: { type: 'ephemeral' } },
      },
    }
    const result = withoutCacheControl(original)

    expect(original.providerOptions?.anthropic?.cache_control).toBeDefined()
    expect(result.providerOptions?.anthropic?.cache_control).toBeUndefined()
  })

  it('should handle object with no cache control', () => {
    const obj: { providerOptions?: any } = {}
    const result = withoutCacheControl(obj)

    expect(result.providerOptions).toBeUndefined()
  })

  it('should clean up empty provider objects', () => {
    const obj = {
      id: 'test',
      providerOptions: {
        anthropic: { cache_control: { type: 'ephemeral' } },
      },
    }
    const result = withoutCacheControl(obj)

    expect(result.providerOptions).toBeUndefined()
  })
})

describe('convertCbToModelMessages', () => {
  describe('basic message conversion', () => {
    it('should convert system messages', () => {
      const messages: Message[] = [systemMessage('You are a helpful assistant')]

      const result = convertCbToModelMessages({
        messages,
        includeCacheControl: false,
      })

      expect(result).toEqual([
        {
          role: 'system',
          content: 'You are a helpful assistant',
        },
      ])
    })

    it('should convert user messages with array content', () => {
      const messages: Message[] = [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'First part' },
            { type: 'text', text: 'Second part' },
          ],
        },
      ]

      const result = convertCbToModelMessages({
        messages,
        includeCacheControl: false,
      })

      expect(result).toEqual([
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'First part',
            },
            {
              type: 'text',
              text: 'Second part',
            },
          ],
        },
      ])
    })
  })

  describe('tool message conversion', () => {
    it('should convert tool messages with JSON output', () => {
      const messages: Message[] = [
        {
          role: 'tool',
          toolName: 'test_tool',
          toolCallId: 'call_123',
          content: jsonToolResult({ result: 'success' }),
        },
      ]

      const result = convertCbToModelMessages({
        messages,
        includeCacheControl: false,
      })

      expect(result).toEqual([
        expect.objectContaining({
          role: 'tool',
          content: [
            expect.objectContaining({
              type: 'tool-result',
              toolCallId: 'call_123',
              toolName: 'test_tool',
              output: { type: 'json', value: { result: 'success' } },
            } satisfies ToolResultPart),
          ],
        }),
      ])
    })

    it('should convert tool messages with media output', () => {
      const messages: Message[] = [
        {
          role: 'tool',
          toolName: 'test_tool',
          toolCallId: 'call_123',
          content: mediaToolResult({
            data: 'base64data',
            mediaType: 'image/png',
          }),
        },
      ]

      const result = convertCbToModelMessages({
        messages,
        includeCacheControl: false,
      })

      expect(result).toEqual([
        expect.objectContaining({
          role: 'user',
          content: [
            expect.objectContaining({
              type: 'file',
            }),
          ],
        }),
      ])
    })

    it('should handle multiple tool outputs', () => {
      const messages: Message[] = [
        {
          role: 'tool',
          toolName: 'test_tool',
          toolCallId: 'call_123',
          content: [
            { type: 'json', value: { result1: 'success' } },
            { type: 'json', value: { result2: 'also success' } },
          ],
        },
      ]

      const result = convertCbToModelMessages({
        messages,
        includeCacheControl: false,
      })

      // Multiple tool outputs are aggregated into one user message
      expect(result).toEqual([
        expect.objectContaining({
          role: 'tool',
        }),
        expect.objectContaining({
          role: 'tool',
        }),
      ])
    })
  })

  describe('message aggregation', () => {
    it('should aggregate consecutive system messages', () => {
      const messages: Message[] = [
        systemMessage({ content: 'First system message' }),
        systemMessage({ content: 'Second system message' }),
      ]

      const result = convertCbToModelMessages({
        messages,
        includeCacheControl: false,
      })

      expect(result).toEqual([
        {
          role: 'system',
          content: 'First system message\n\nSecond system message',
        },
      ])
    })

    it('should aggregate consecutive user messages', () => {
      const messages: Message[] = [
        userMessage('First user message'),
        userMessage('Second user message'),
      ]

      const result = convertCbToModelMessages({
        messages,
        includeCacheControl: false,
      })

      expect(result).toEqual([
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'First user message',
            },
            {
              type: 'text',
              text: 'Second user message',
            },
          ],
        },
      ])
    })

    it('should aggregate consecutive assistant messages', () => {
      const messages: Message[] = [
        assistantMessage('First assistant message'),
        assistantMessage('Second assistant message'),
      ]

      const result = convertCbToModelMessages({
        messages,
        includeCacheControl: false,
      })

      expect(result).toEqual([
        {
          role: 'assistant',
          content: [
            {
              type: 'text',
              text: 'First assistant message',
            },
            {
              type: 'text',
              text: 'Second assistant message',
            },
          ],
        },
      ])
    })

    it('should not aggregate messages with different timeToLive', () => {
      const messages: Message[] = [
        {
          role: 'user',
          content: [{ type: 'text', text: 'First' }],
          timeToLive: 'agentStep',
        },

        {
          role: 'user',
          content: [{ type: 'text', text: 'Second' }],
          timeToLive: 'userPrompt',
        },
      ]

      const result = convertCbToModelMessages({
        messages,
        includeCacheControl: false,
      })

      expect(result).toEqual([
        {
          role: 'user',
          content: [{ type: 'text', text: 'First' }],
          timeToLive: 'agentStep',
        },
        {
          role: 'user',
          content: [{ type: 'text', text: 'Second' }],
          timeToLive: 'userPrompt',
        },
      ])
    })

    it('should not aggregate messages with different providerOptions', () => {
      const messages: Message[] = [
        {
          role: 'user',
          content: [{ type: 'text', text: 'First' }],
          providerOptions: { anthropic: { option1: 'value1' } },
        },
        {
          role: 'user',
          content: [{ type: 'text', text: 'Second' }],
          providerOptions: { anthropic: { option1: 'value2' } },
        },
      ]

      const result = convertCbToModelMessages({
        messages,
        includeCacheControl: false,
      })

      expect(result).toEqual([
        {
          role: 'user',
          content: [{ type: 'text', text: 'First' }],
          providerOptions: { anthropic: { option1: 'value1' } },
        },
        {
          role: 'user',
          content: [{ type: 'text', text: 'Second' }],
          providerOptions: { anthropic: { option1: 'value2' } },
        },
      ])
    })

    it('should not aggregate messages with different tags', () => {
      const messages: Message[] = [
        {
          role: 'user',
          content: [{ type: 'text', text: 'First' }],
          tags: ['tag1'],
        },
        {
          role: 'user',
          content: [{ type: 'text', text: 'Second' }],
          tags: ['tag2'],
        },
      ]

      const result = convertCbToModelMessages({
        messages,
        includeCacheControl: false,
      })

      expect(result).toEqual([
        {
          role: 'user',
          content: [{ type: 'text', text: 'First' }],
          tags: ['tag1'],
        },
        {
          role: 'user',
          content: [{ type: 'text', text: 'Second' }],
          tags: ['tag2'],
        },
      ])
    })
  })

  describe('cache control', () => {
    // Note: Cache control is applied to content parts within messages, not to the messages themselves.
    // The implementation splits text content and adds cache control to specific parts based on tagged prompts.
    test('should add cache control when includeCacheControl is true', () => {
      const messages: Message[] = [
        systemMessage('System message'),
        userMessage('Context message'),
        assistantMessage('Response'),
        userMessage({
          content: 'User message',
          tags: ['USER_PROMPT'],
        }),
      ]

      const result = convertCbToModelMessages({
        messages,
        includeCacheControl: true,
      })

      // Cache control is on content parts of the assistant message (result[2])
      if (
        typeof result[2].content !== 'string' &&
        result[2].content.length > 0
      ) {
        const lastContentPart = result[2].content[result[2].content.length - 1]
        expect(
          (lastContentPart as any).providerOptions?.anthropic?.cache_control,
        ).toEqual({
          type: 'ephemeral',
        })
      }
    })

    it('should not add cache control when includeCacheControl is false', () => {
      const messages: Message[] = [
        systemMessage('System message'),
        userMessage({
          content: 'User message',
          tags: ['USER_PROMPT'],
        }),
      ]

      const result = convertCbToModelMessages({
        messages,
        includeCacheControl: false,
      })

      expect(result[0].providerOptions).toBeUndefined()
    })

    test('should add cache control before USER_PROMPT tag', () => {
      const messages: Message[] = [
        systemMessage('System'),
        userMessage('Context'),
        assistantMessage('Response'),
        userMessage('More context'),
        userMessage({
          content: 'User prompt',
          tags: ['USER_PROMPT'],
        }),
      ]

      const result = convertCbToModelMessages({
        messages,
        includeCacheControl: true,
      })

      // Cache control should be on content part before USER_PROMPT
      expect(result).toEqual([
        expect.objectContaining({ role: 'system' }),
        expect.objectContaining({ role: 'user' }),
        expect.objectContaining({ role: 'assistant' }),
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'More context',
              providerOptions: expect.objectContaining({
                openaiCompatible: {
                  cache_control: {
                    type: 'ephemeral',
                  },
                },
              }),
            },
          ],
        },
        expect.objectContaining({ role: 'user' }),
      ])
    })

    test('should add cache control before LAST_ASSISTANT_MESSAGE tag', () => {
      const messages: Message[] = [
        systemMessage('System'),
        userMessage('Context'),
        assistantMessage('Response'),
        userMessage('Instructions'),
        assistantMessage({
          content: 'Second response',
          tags: ['LAST_ASSISTANT_MESSAGE'],
        }),
      ]

      const result = convertCbToModelMessages({
        messages,
        includeCacheControl: true,
      })

      expect(result).toEqual([
        expect.objectContaining({ role: 'system' }),
        expect.objectContaining({ role: 'user' }),
        expect.objectContaining({ role: 'assistant' }),
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Instructions',
              providerOptions: expect.objectContaining({
                openaiCompatible: {
                  cache_control: {
                    type: 'ephemeral',
                  },
                },
              }),
            },
          ],
        },
        expect.objectContaining({ role: 'assistant' }),
      ])
    })

    test('should add cache control before STEP_PROMPT tag', () => {
      const messages: Message[] = [
        systemMessage('System'),
        userMessage('Context'),
        assistantMessage('Response'),
        userMessage('More context'),
        userMessage({ content: 'Step', tags: ['STEP_PROMPT'] }),
      ]

      const result = convertCbToModelMessages({
        messages,
        includeCacheControl: true,
      })

      expect(result).toEqual([
        expect.objectContaining({ role: 'system' }),
        expect.objectContaining({ role: 'user' }),
        expect.objectContaining({ role: 'assistant' }),
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'More context',
              providerOptions: expect.objectContaining({
                openaiCompatible: {
                  cache_control: {
                    type: 'ephemeral',
                  },
                },
              }),
            },
          ],
        },
        expect.objectContaining({ role: 'user' }),
      ])
    })

    test('should add cache control to last message', () => {
      const messages: Message[] = [
        systemMessage('System'),
        userMessage('Context'),
        assistantMessage('Response'),
        userMessage('More context'),
        userMessage('User message'),
      ]

      const result = convertCbToModelMessages({
        messages,
        includeCacheControl: true,
      })

      // Cache control is on content parts in the assistant message
      expect(result).toEqual([
        expect.objectContaining({ role: 'system' }),
        expect.objectContaining({ role: 'user' }),
        expect.objectContaining({ role: 'assistant' }),
        {
          role: 'user',
          content: [
            { type: 'text', text: 'More context' },
            {
              type: 'text',
              text: 'User message',
              providerOptions: expect.objectContaining({
                openaiCompatible: {
                  cache_control: {
                    type: 'ephemeral',
                  },
                },
              }),
            },
          ],
        },
      ])
    })

    test('should handle system messages with cache control', () => {
      const messages: Message[] = [
        systemMessage('Long system prompt'),
        userMessage({ content: 'User', tags: ['USER_PROMPT'] }),
        assistantMessage('Response'),
        userMessage('User 2'),
      ]

      const result = convertCbToModelMessages({
        messages,
        includeCacheControl: true,
      })

      expect(result).toEqual([
        {
          role: 'system',
          content: 'Long system prompt',
          providerOptions: expect.objectContaining({
            openaiCompatible: {
              cache_control: {
                type: 'ephemeral',
              },
            },
          }),
        },
        expect.objectContaining({ role: 'user' }),
        expect.objectContaining({ role: 'assistant' }),
        expect.objectContaining({ role: 'user' }),
      ])
    })

    it('should handle array content with cache control on non-text parts', () => {
      const messages: Message[] = [
        systemMessage('System'),
        userMessage([
          { type: 'text', text: 'Context' },
          { type: 'file', data: 'base64', mediaType: 'image/png' },
        ]),
        userMessage({ content: 'Next', tags: ['USER_PROMPT'] }),
      ]

      const result = convertCbToModelMessages({
        messages,
        includeCacheControl: true,
      })

      // Should add cache control to the file part (last non-text part)
      expect(result).toEqual([
        expect.objectContaining({ role: 'system' }),
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Context',
            },
            {
              type: 'file',
              data: 'base64',
              mediaType: 'image/png',
              providerOptions: expect.objectContaining({
                openaiCompatible: {
                  cache_control: {
                    type: 'ephemeral',
                  },
                },
              }),
            },
          ],
        },
        expect.objectContaining({ role: 'user' }),
      ])
    })

    it('should handle very short text content when finding cache control location', () => {
      const messages: Message[] = [
        systemMessage('System'),
        userMessage([
          { type: 'text', text: 'Longer text' },
          { type: 'text', text: 'X' }, // Short
        ]),
        userMessage({ content: 'Next', tags: ['USER_PROMPT'] }),
      ]

      const result = convertCbToModelMessages({
        messages,
        includeCacheControl: true,
      })

      expect(result).toEqual([
        expect.objectContaining({ role: 'system' }),
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Longer text' },
            {
              type: 'text',
              text: 'X',
              providerOptions: expect.objectContaining({
                openaiCompatible: {
                  cache_control: {
                    type: 'ephemeral',
                  },
                },
              }),
            },
          ],
        },
        expect.objectContaining({ role: 'user' }),
      ])
    })
  })

  describe('edge cases', () => {
    it('should handle empty messages array', () => {
      const result = convertCbToModelMessages({
        messages: [],
        includeCacheControl: false,
      })

      expect(result).toHaveLength(0)
    })

    it('should handle tool-call content in assistant messages', () => {
      const messages: Message[] = [
        assistantMessage({
          type: 'tool-call',
          toolCallId: 'call_123',
          toolName: 'test_tool',
          input: { param: 'value' },
        }),
      ]

      const result = convertCbToModelMessages({
        messages,
        includeCacheControl: false,
      })

      expect(result).toEqual([
        {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCallId: 'call_123',
              toolName: 'test_tool',
              input: { param: 'value' },
            },
          ],
        } satisfies AssistantModelMessage,
      ])
    })

    it('should preserve message metadata during conversion', () => {
      const messages: Message[] = [
        userMessage({
          content: 'Test',
          tags: ['custom_tag'],
          timeToLive: 'agentStep',
          providerOptions: { anthropic: { someOption: 'value' } },
        }),
      ]

      const result = convertCbToModelMessages({
        messages,
        includeCacheControl: false,
      })

      expect((result[0] as any).tags).toEqual(['custom_tag'])
      expect((result[0] as any).timeToLive).toBe('agentStep')
      expect((result[0].providerOptions?.anthropic as any)?.someOption).toBe(
        'value',
      )
    })

    it('should not mutate original messages', () => {
      const originalMessages: Message[] = [
        systemMessage('Original'),
        userMessage('User message'),
      ]
      const messagesCopy = cloneDeep(originalMessages)

      convertCbToModelMessages({
        messages: originalMessages,
        includeCacheControl: true,
      })

      expect(originalMessages).toEqual(messagesCopy)
    })
  })
})
