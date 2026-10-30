import { describe, expect, it, test } from 'bun:test'
import { cloneDeep } from 'lodash'

import {
  withCacheControl,
  withoutCacheControl,
  convertCbToModelMessages,
  dropUnansweredToolCalls,
  systemMessage,
  userMessage,
  assistantMessage,
  jsonToolResult,
  mediaToolResult,
} from '../messages'

import type { Message } from '../../types/messages/codebuff-message'
import type { ToolResultPart } from 'ai'

// Test helper types for provider options with cache control
type CacheControlValue = { type: string }
type ProviderWithCacheControl = Record<string, unknown> & {
  cache_control?: CacheControlValue
}

describe('withCacheControl', () => {
  it('should add cache control to object without providerOptions', () => {
    const obj = {} as Parameters<typeof withCacheControl>[0]
    const result = withCacheControl(obj)

    expect(result.providerOptions).toBeDefined()
    const resultOptions = result.providerOptions as Record<string, ProviderWithCacheControl>
    expect(resultOptions.anthropic?.cache_control).toEqual({
      type: 'ephemeral',
    })
    expect(resultOptions.openrouter?.cache_control).toEqual({
      type: 'ephemeral',
    })
    expect(resultOptions.openaiCompatible?.cache_control).toEqual({
      type: 'ephemeral',
    })
  })

  it('should add cache control to existing providerOptions', () => {
    const obj = {
      providerOptions: {
        anthropic: { someOtherOption: 'value' },
      },
    } as Parameters<typeof withCacheControl>[0]
    const result = withCacheControl(obj)

    const resultAnthropicOptions = result.providerOptions?.anthropic as ProviderWithCacheControl
    expect(resultAnthropicOptions.cache_control).toEqual({
      type: 'ephemeral',
    })
    expect(resultAnthropicOptions.someOtherOption).toBe(
      'value',
    )
  })

  it('should not mutate original object', () => {
    const original = {} as Parameters<typeof withCacheControl>[0]
    const result = withCacheControl(original)

    expect(original.providerOptions).toBeUndefined()
    expect(result.providerOptions).toBeDefined()
  })

  it('should handle all three providers', () => {
    const obj = {} as Parameters<typeof withCacheControl>[0]
    const result = withCacheControl(obj)

    const resultOptions = result.providerOptions as Record<string, ProviderWithCacheControl>
    expect(resultOptions.anthropic?.cache_control?.type).toBe('ephemeral')
    expect(resultOptions.openrouter?.cache_control?.type).toBe('ephemeral')
    expect(resultOptions.openaiCompatible?.cache_control?.type).toBe('ephemeral')
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
    const obj = {} as Parameters<typeof withoutCacheControl>[0]
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

describe('dropUnansweredToolCalls', () => {
  const toolCall = (toolCallId: string) =>
    assistantMessage({
      type: 'tool-call',
      toolCallId,
      toolName: 'read_files',
      input: { paths: ['README.md'] },
    })

  const toolResult = (toolCallId: string): Message => ({
    role: 'tool',
    toolCallId,
    toolName: 'read_files',
    content: jsonToolResult({ files: [] }),
  })

  it('returns valid history unchanged', () => {
    const messages: Message[] = [
      userMessage('start'),
      toolCall('complete'),
      toolResult('complete'),
      assistantMessage('done'),
    ]

    expect(dropUnansweredToolCalls(messages)).toBe(messages)
  })

  it('repairs a partial run of consecutive assistant calls', () => {
    const messages: Message[] = [
      userMessage('start'),
      toolCall('complete'),
      toolCall('interrupted'),
      toolResult('complete'),
    ]

    expect(dropUnansweredToolCalls(messages)).toEqual([
      messages[0],
      messages[1],
      messages[3],
    ])
  })

  it('removes only unanswered parts without mutating assistant metadata', () => {
    const assistant = {
      ...assistantMessage('working'),
      content: [
        { type: 'text' as const, text: 'working' },
        toolCall('complete').content[0],
        toolCall('interrupted').content[0],
      ],
      tags: ['important'],
    }
    const messages: Message[] = [assistant, toolResult('complete')]

    expect(dropUnansweredToolCalls(messages)).toEqual([
      {
        ...assistant,
        content: [assistant.content[0], assistant.content[1]],
      },
      messages[1],
    ])
    expect(assistant.content).toHaveLength(3)
  })

  it('preserves freestanding tool results', () => {
    const messages: Message[] = [toolResult('orphan'), userMessage('next')]

    expect(dropUnansweredToolCalls(messages)).toBe(messages)
  })

  it('preserves provider-executed calls without local results', () => {
    const messages: Message[] = [
      assistantMessage({
        type: 'tool-call',
        toolCallId: 'provider-call',
        toolName: 'web_search',
        input: { query: 'Freebuff' },
        providerExecuted: true,
      }),
    ]

    expect(dropUnansweredToolCalls(messages)).toBe(messages)
  })
})

describe('convertCbToModelMessages', () => {
  describe('unfinished tool-call repair', () => {
    it('passes through a call whose result arrives after a user boundary', () => {
      // The repair lives with the history builders (run-agent-step repairs
      // the step history before it reaches the converter); this converter
      // used to run dropUnansweredToolCalls a second time on every request
      // and no longer does. A caller that feeds an unpaired history gets it
      // back unchanged: the boundary repair is applied upstream, not here.
      const result = convertCbToModelMessages({
        messages: [
          userMessage('start'),
          assistantMessage({
            type: 'tool-call',
            toolCallId: 'interrupted-call',
            toolName: 'read_files',
            input: { paths: ['README.md'] },
          }),
          userMessage('continue'),
          {
            role: 'tool',
            toolCallId: 'interrupted-call',
            toolName: 'read_files',
            content: jsonToolResult({ files: [] }),
          },
        ],
        includeCacheControl: false,
      })

      expect(result.map((message) => message.role)).toEqual([
        'user',
        'assistant',
        'user',
        'tool',
      ])
    })

    // A media result rides a user message, and the AI SDK treats a user message
    // as a boundary where every tool call issued so far must already be
    // answered. Emitted inline it splits a batch of parallel calls and the
    // sibling still pending throws MissingToolResultsError client-side, which
    // wedges every later turn in the thread that replays the history.
    it('keeps a media result from splitting a batch of parallel tool calls', () => {
      const screenshot = (toolCallId: string): Message => ({
        role: 'tool',
        toolCallId,
        toolName: 'preview_screenshot',
        content: [
          ...mediaToolResult({ data: 'base64data', mediaType: 'image/png' }),
          ...jsonToolResult({ ok: true }),
        ],
      })
      const readFiles = (toolCallId: string): Message => ({
        role: 'tool',
        toolCallId,
        toolName: 'read_files',
        content: jsonToolResult({ files: [] }),
      })

      const result = convertCbToModelMessages({
        messages: [
          userMessage('screenshot the preview and read the file'),
          {
            ...assistantMessage('working'),
            content: [
              {
                type: 'tool-call',
                toolCallId: 'call_shot',
                toolName: 'preview_screenshot',
                input: {},
              },
              {
                type: 'tool-call',
                toolCallId: 'call_read',
                toolName: 'read_files',
                input: {},
              },
            ],
          },
          screenshot('call_shot'),
          readFiles('call_read'),
        ],
        includeCacheControl: false,
      })

      // Both results land before the image's user message, so no call is still
      // pending at the boundary.
      expect(result.map((message) => message.role)).toEqual([
        'user',
        'assistant',
        'tool',
        'tool',
        'user',
      ])
      expect(result.at(-1)!.content).toEqual([
        expect.objectContaining({ type: 'file' }),
      ])
    })

    // Waiting on the answers, not merely on the next non-tool message: anything
    // interleaved between a batch's results must not let the image out early.
    it('holds media until a sibling result arrives after an interleaved message', () => {
      const result = convertCbToModelMessages({
        messages: [
          userMessage('go'),
          {
            ...assistantMessage('working'),
            content: [
              {
                type: 'tool-call',
                toolCallId: 'call_shot',
                toolName: 'preview_screenshot',
                input: {},
              },
              {
                type: 'tool-call',
                toolCallId: 'call_read',
                toolName: 'read_files',
                input: {},
              },
            ],
          },
          {
            role: 'tool',
            toolCallId: 'call_shot',
            toolName: 'preview_screenshot',
            content: [
              ...mediaToolResult({ data: 'base64data', mediaType: 'image/png' }),
              ...jsonToolResult({ ok: true }),
            ],
          },
          assistantMessage('still thinking'),
          {
            role: 'tool',
            toolCallId: 'call_read',
            toolName: 'read_files',
            content: jsonToolResult({ files: [] }),
          },
        ],
        includeCacheControl: false,
      })

      expect(result.map((message) => message.role)).toEqual([
        'user',
        'assistant',
        'tool',
        'assistant',
        'tool',
        'user',
      ])
    })

    it('flushes buffered media before the next assistant message', () => {
      const result = convertCbToModelMessages({
        messages: [
          userMessage('go'),
          {
            ...assistantMessage('working'),
            content: [
              {
                type: 'tool-call',
                toolCallId: 'call_shot',
                toolName: 'preview_screenshot',
                input: {},
              },
            ],
          },
          {
            role: 'tool',
            toolCallId: 'call_shot',
            toolName: 'preview_screenshot',
            content: [
              ...mediaToolResult({ data: 'base64data', mediaType: 'image/png' }),
              ...jsonToolResult({ ok: true }),
            ],
          },
          assistantMessage('here is what I saw'),
        ],
        includeCacheControl: false,
      })

      expect(result.map((message) => message.role)).toEqual([
        'user',
        'assistant',
        'tool',
        'user',
        'assistant',
      ])
    })
  })

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

  describe('lone surrogate sanitization', () => {
    // A lone (unpaired) UTF-16 surrogate — e.g. produced by slicing a file read
    // in the middle of an emoji — serializes to a syntactically-valid \uXXXX
    // escape that JS JSON.parse accepts but strict server-side parsers
    // (serde_json) reject with "unexpected end of hex escape", fatally aborting
    // the agent on every subsequent request. The converter must neutralize it.
    const LONE_HIGH = '\uD83D' // high surrogate of 😀 with the low half dropped
    const REPLACEMENT = '�'

    const assertWellFormed = (value: unknown): void => {
      const json = JSON.stringify(value)
      // matchAll over lone surrogates: there should be none left.
      const lone = json.match(
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
      )
      expect(lone).toBeNull()
    }

    it('sanitizes a lone surrogate in a user text part', () => {
      const result = convertCbToModelMessages({
        messages: [userMessage(`hello ${LONE_HIGH} world`)],
        includeCacheControl: false,
      })
      assertWellFormed(result)
      expect(JSON.stringify(result)).toContain(`hello ${REPLACEMENT} world`)
    })

    it('sanitizes a lone surrogate nested in a tool result value', () => {
      const result = convertCbToModelMessages({
        messages: [
          {
            role: 'tool',
            toolName: 'read_files',
            toolCallId: 'call_1',
            content: jsonToolResult([
              { path: 'big.ts', content: `truncated${LONE_HIGH}` },
            ]),
          },
        ],
        includeCacheControl: false,
      })
      assertWellFormed(result)
    })

    it('sanitizes a lone surrogate in a system message string', () => {
      const result = convertCbToModelMessages({
        messages: [systemMessage(`prompt ${LONE_HIGH}`)],
        includeCacheControl: false,
      })
      assertWellFormed(result)
    })

    it('leaves valid surrogate pairs (emoji) intact', () => {
      const result = convertCbToModelMessages({
        messages: [userMessage('keep the 😀 emoji')],
        includeCacheControl: false,
      })
      assertWellFormed(result)
      expect(JSON.stringify(result)).toContain('keep the 😀 emoji')
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

      // The image rides a user message (providers reject images inside a tool
      // message), but the call still has to be answered or it is an unpaired
      // tool call — which providers reject and the server's repair then strips.
      expect(result).toEqual([
        expect.objectContaining({
          role: 'tool',
          content: [
            expect.objectContaining({
              toolCallId: 'call_123',
              type: 'tool-result',
            }),
          ],
        }),
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

    it('should convert tool messages with empty content', () => {
      const messages: Message[] = [
        {
          role: 'tool',
          toolName: 'scraper_page_to_markdown',
          toolCallId: 'call_empty',
          content: [],
        },
      ]

      const result = convertCbToModelMessages({
        messages,
        includeCacheControl: false,
      })

      expect(result).toEqual([
        expect.objectContaining({
          role: 'tool',
          toolCallId: 'call_empty',
          toolName: 'scraper_page_to_markdown',
          content: [
            expect.objectContaining({
              type: 'tool-result',
              toolCallId: 'call_empty',
              toolName: 'scraper_page_to_markdown',
              output: { type: 'json', value: '' },
            } satisfies ToolResultPart),
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
          sentAt: expect.any(Number),
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
          sentAt: expect.any(Number),
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
        const lastContentPart = result[2].content[result[2].content.length - 1] as { providerOptions?: Record<string, ProviderWithCacheControl> }
        expect(
          lastContentPart.providerOptions?.anthropic?.cache_control,
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
          sentAt: expect.any(Number),
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
          sentAt: expect.any(Number),
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
          sentAt: expect.any(Number),
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
          sentAt: expect.any(Number),
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
          sentAt: expect.any(Number),
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
          sentAt: expect.any(Number),
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
        {
          role: 'tool',
          toolCallId: 'call_123',
          toolName: 'test_tool',
          content: jsonToolResult({ ok: true }),
        },
      ]

      const result = convertCbToModelMessages({
        messages,
        includeCacheControl: false,
      })

      expect(result[0]).toEqual({
        role: 'assistant',
        sentAt: expect.any(Number),
        content: [
          {
            type: 'tool-call',
            toolCallId: 'call_123',
            toolName: 'test_tool',
            input: { param: 'value' },
          },
        ],
      })
      expect(result[1].role).toBe('tool')
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

      const resultMessage = result[0] as { tags?: string[]; timeToLive?: string; providerOptions?: Record<string, ProviderWithCacheControl> }
      expect(resultMessage.tags).toEqual(['custom_tag'])
      expect(resultMessage.timeToLive).toBe('agentStep')
      expect((resultMessage.providerOptions?.anthropic as ProviderWithCacheControl)?.someOption).toBe(
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
