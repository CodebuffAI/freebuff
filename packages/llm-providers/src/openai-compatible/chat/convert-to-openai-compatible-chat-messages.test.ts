import { describe, it, expect } from 'bun:test'

import { convertToOpenAICompatibleChatMessages } from './convert-to-openai-compatible-chat-messages'

describe('user messages', () => {
  it('should keep messages with only a text part', async () => {
    const result = convertToOpenAICompatibleChatMessages([
      {
        role: 'user',
        content: [{ type: 'text', text: 'Hello' }],
      },
    ])

    expect(result).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
    ])
  })

  it('should convert messages with image parts', async () => {
    const result = convertToOpenAICompatibleChatMessages([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Hello' },
          {
            type: 'file',
            data: Buffer.from([0, 1, 2, 3]).toString('base64'),
            mediaType: 'image/png',
          },
        ],
      },
    ])

    expect(result).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Hello' },
          {
            type: 'image_url',
            image_url: { url: 'data:image/png;base64,AAECAw==' },
          },
        ],
      },
    ])
  })

  it('should convert messages with image parts from Uint8Array', async () => {
    const result = convertToOpenAICompatibleChatMessages([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Hi' },
          {
            type: 'file',
            data: new Uint8Array([0, 1, 2, 3]),
            mediaType: 'image/png',
          },
        ],
      },
    ])

    expect(result).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Hi' },
          {
            type: 'image_url',
            image_url: { url: 'data:image/png;base64,AAECAw==' },
          },
        ],
      },
    ])
  })

  it('should handle URL-based images', async () => {
    const result = convertToOpenAICompatibleChatMessages([
      {
        role: 'user',
        content: [
          {
            type: 'file',
            data: new URL('https://example.com/image.jpg'),
            mediaType: 'image/*',
          },
        ],
      },
    ])

    expect(result).toEqual([
      {
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: { url: 'https://example.com/image.jpg' },
          },
        ],
      },
    ])
  })

  // Callers on `ai` v7 reach this v2 model through the SDK's compatibility
  // proxy, which forwards a LanguageModelV4 prompt untouched — so `data`
  // arrives TAGGED, not raw. Reading it as raw stringified the wrapper into
  // `data:image/png;base64,[object Object]` and 400'd every image turn.
  describe('LanguageModelV4 tagged file data', () => {
    it('reads base64 out of a tagged data part', async () => {
      const result = convertToOpenAICompatibleChatMessages([
        {
          role: 'user',
          content: [
            {
              type: 'file',
              data: { type: 'data', data: 'AAECAw==' },
              mediaType: 'image/png',
            } as any,
          ],
        },
      ])

      expect(result[0].content).toEqual([
        {
          type: 'image_url',
          image_url: { url: 'data:image/png;base64,AAECAw==' },
        },
      ])
    })

    it('reads bytes out of a tagged data part', async () => {
      const result = convertToOpenAICompatibleChatMessages([
        {
          role: 'user',
          content: [
            {
              type: 'file',
              data: { type: 'data', data: new Uint8Array([0, 1, 2, 3]) },
              mediaType: 'image/png',
            } as any,
          ],
        },
      ])

      expect(result[0].content).toEqual([
        {
          type: 'image_url',
          image_url: { url: 'data:image/png;base64,AAECAw==' },
        },
      ])
    })

    it('passes a tagged url part through', async () => {
      const result = convertToOpenAICompatibleChatMessages([
        {
          role: 'user',
          content: [
            {
              type: 'file',
              data: { type: 'url', url: new URL('https://example.com/a.png') },
              mediaType: 'image/png',
            } as any,
          ],
        },
      ])

      expect(result[0].content).toEqual([
        {
          type: 'image_url',
          image_url: { url: 'https://example.com/a.png' },
        },
      ])
    })
  })

  it('does not re-prefix data that is already a data URL', async () => {
    const result = convertToOpenAICompatibleChatMessages([
      {
        role: 'user',
        content: [
          {
            type: 'file',
            data: 'data:image/png;base64,AAECAw==',
            mediaType: 'image/png',
          },
        ],
      },
    ])

    expect(result[0].content).toEqual([
      {
        type: 'image_url',
        image_url: { url: 'data:image/png;base64,AAECAw==' },
      },
    ])
  })
})

describe('tool calls', () => {
  it('should stringify arguments to tool calls', () => {
    const result = convertToOpenAICompatibleChatMessages([
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            input: { foo: 'bar123' },
            toolCallId: 'quux',
            toolName: 'thwomp',
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'quux',
            toolName: 'thwomp',
            output: { type: 'json', value: { oof: '321rab' } },
          },
        ],
      },
    ])

    expect(result).toEqual([
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            type: 'function',
            id: 'quux',
            function: {
              name: 'thwomp',
              arguments: JSON.stringify({ foo: 'bar123' }),
            },
          },
        ],
      },
      {
        role: 'tool',
        content: JSON.stringify({ oof: '321rab' }),
        tool_call_id: 'quux',
      },
    ])
  })

  it('should handle text output type in tool results', () => {
    const result = convertToOpenAICompatibleChatMessages([
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            input: { query: 'weather' },
            toolCallId: 'call-1',
            toolName: 'getWeather',
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call-1',
            toolName: 'getWeather',
            output: { type: 'text', value: 'It is sunny today' },
          },
        ],
      },
    ])

    expect(result).toEqual([
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            type: 'function',
            id: 'call-1',
            function: {
              name: 'getWeather',
              arguments: JSON.stringify({ query: 'weather' }),
            },
          },
        ],
      },
      {
        role: 'tool',
        content: 'It is sunny today',
        tool_call_id: 'call-1',
      },
    ])
  })
})

describe('provider-specific metadata merging', () => {
  it('should merge system message metadata', async () => {
    const result = convertToOpenAICompatibleChatMessages([
      {
        role: 'system',
        content: 'You are a helpful assistant.',
        providerOptions: {
          openaiCompatible: {
            cacheControl: { type: 'ephemeral' },
          },
        },
      },
    ])

    expect(result).toEqual([
      {
        role: 'system',
        content: 'You are a helpful assistant.',
        cacheControl: { type: 'ephemeral' },
      },
    ])
  })

  it('should merge user message content metadata', async () => {
    const result = convertToOpenAICompatibleChatMessages([
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'Hello',
            providerOptions: {
              openaiCompatible: {
                cacheControl: { type: 'ephemeral' },
              },
            },
          },
        ],
      },
    ])

    expect(result).toEqual([
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'Hello',
            cacheControl: { type: 'ephemeral' },
          },
        ],
      },
    ])
  })

  it('should keep both content-level and message-level metadata', async () => {
    const result = convertToOpenAICompatibleChatMessages([
      {
        role: 'user',
        providerOptions: {
          openaiCompatible: {
            messageLevel: true,
          },
        },
        content: [
          {
            type: 'text',
            text: 'Hello',
            providerOptions: {
              openaiCompatible: {
                contentLevel: true,
              },
            },
          },
        ],
      },
    ])

    expect(result).toEqual([
      {
        role: 'user',
        content: [{ type: 'text', text: 'Hello', contentLevel: true }],
        messageLevel: true,
      },
    ])
  })

  it('should handle tool calls with metadata', async () => {
    const result = convertToOpenAICompatibleChatMessages([
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'call1',
            toolName: 'calculator',
            input: { x: 1, y: 2 },
            providerOptions: {
              openaiCompatible: {
                cacheControl: { type: 'ephemeral' },
              },
            },
          },
        ],
      },
    ])

    expect(result).toEqual([
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call1',
            type: 'function',
            function: {
              name: 'calculator',
              arguments: JSON.stringify({ x: 1, y: 2 }),
            },
            cacheControl: { type: 'ephemeral' },
          },
        ],
      },
    ])
  })

  it('should handle image content with metadata', async () => {
    const imageUrl = new URL('https://example.com/image.jpg')
    const result = convertToOpenAICompatibleChatMessages([
      {
        role: 'user',
        content: [
          {
            type: 'file',
            data: imageUrl,
            mediaType: 'image/*',
            providerOptions: {
              openaiCompatible: {
                cacheControl: { type: 'ephemeral' },
              },
            },
          },
        ],
      },
    ])

    expect(result).toEqual([
      {
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: { url: imageUrl.toString() },
            cacheControl: { type: 'ephemeral' },
          },
        ],
      },
    ])
  })

  it('should omit non-openaiCompatible metadata', async () => {
    const result = convertToOpenAICompatibleChatMessages([
      {
        role: 'system',
        content: 'Hello',
        providerOptions: {
          someOtherProvider: {
            shouldBeIgnored: true,
          },
        },
      },
    ])

    expect(result).toEqual([
      {
        role: 'system',
        content: 'Hello',
      },
    ])
  })

  it('should handle a user message with multiple content parts (text + image)', () => {
    const result = convertToOpenAICompatibleChatMessages([
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'Hello from part 1',
            providerOptions: {
              openaiCompatible: { sentiment: 'positive' },
              leftoverKey: { foo: 'some leftover data' },
            },
          },
          {
            type: 'file',
            data: Buffer.from([0, 1, 2, 3]).toString('base64'),
            mediaType: 'image/png',
            providerOptions: {
              openaiCompatible: { alt_text: 'A sample image' },
            },
          },
        ],
        providerOptions: {
          openaiCompatible: { priority: 'high' },
        },
      },
    ])

    expect(result).toEqual([
      {
        role: 'user',
        priority: 'high', // hoisted from message-level providerOptions
        content: [
          {
            type: 'text',
            text: 'Hello from part 1',
            sentiment: 'positive', // hoisted from part-level openaiCompatible
          },
          {
            type: 'image_url',
            image_url: {
              url: 'data:image/png;base64,AAECAw==',
            },
            alt_text: 'A sample image',
          },
        ],
      },
    ])
  })

  it('should handle a user message with multiple text parts (flattening disabled)', () => {
    const result = convertToOpenAICompatibleChatMessages([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Part 1' },
          { type: 'text', text: 'Part 2' },
        ],
      },
    ])

    // Because there are multiple text parts, the converter won't flatten them
    expect(result).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Part 1' },
          { type: 'text', text: 'Part 2' },
        ],
      },
    ])
  })

  it('should handle an assistant message with text plus multiple tool calls', () => {
    const result = convertToOpenAICompatibleChatMessages([
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Checking that now...' },
          {
            type: 'tool-call',
            toolCallId: 'call1',
            toolName: 'searchTool',
            input: { query: 'Weather' },
            providerOptions: {
              openaiCompatible: { function_call_reason: 'user request' },
            },
          },
          { type: 'text', text: 'Almost there...' },
          {
            type: 'tool-call',
            toolCallId: 'call2',
            toolName: 'mapsTool',
            input: { location: 'Paris' },
          },
        ],
      },
    ])

    expect(result).toEqual([
      {
        role: 'assistant',
        content: 'Checking that now...Almost there...',
        tool_calls: [
          {
            id: 'call1',
            type: 'function',
            function: {
              name: 'searchTool',
              arguments: JSON.stringify({ query: 'Weather' }),
            },
            function_call_reason: 'user request',
          },
          {
            id: 'call2',
            type: 'function',
            function: {
              name: 'mapsTool',
              arguments: JSON.stringify({ location: 'Paris' }),
            },
          },
        ],
      },
    ])
  })

  it('should preserve assistant reasoning content with tool calls', () => {
    const result = convertToOpenAICompatibleChatMessages([
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'Need the date first. ' },
          { type: 'reasoning', text: 'Then call weather.' },
          { type: 'text', text: 'Checking that now...' },
          {
            type: 'tool-call',
            toolCallId: 'call1',
            toolName: 'get_weather',
            input: { location: 'Hangzhou' },
          },
        ],
      },
    ])

    expect(result).toEqual([
      {
        role: 'assistant',
        content: 'Checking that now...',
        reasoning_content: 'Need the date first. Then call weather.',
        tool_calls: [
          {
            id: 'call1',
            type: 'function',
            function: {
              name: 'get_weather',
              arguments: JSON.stringify({ location: 'Hangzhou' }),
            },
          },
        ],
      },
    ])
  })

  it('should replay reasoning_details from reasoning part provider options', () => {
    const details = [
      {
        type: 'reasoning.text',
        text: 'Need the weather.',
        signature: 'sig-abc',
        format: 'anthropic-claude-v1',
      },
    ]
    const result = convertToOpenAICompatibleChatMessages([
      {
        role: 'assistant',
        content: [
          {
            type: 'reasoning',
            text: 'Need the weather.',
            providerOptions: { codebuff: { reasoning_details: details } },
          },
          {
            type: 'tool-call',
            toolCallId: 'call1',
            toolName: 'get_weather',
            input: { location: 'Hangzhou' },
          },
        ],
      },
    ])

    expect(result).toEqual([
      {
        role: 'assistant',
        content: '',
        reasoning_details: details,
        tool_calls: [
          {
            id: 'call1',
            type: 'function',
            function: {
              name: 'get_weather',
              arguments: JSON.stringify({ location: 'Hangzhou' }),
            },
          },
        ],
      },
    ])
  })

  it('replays reasoning_details recorded for the requesting model', () => {
    const details = [
      {
        type: 'reasoning.text',
        text: 'Need the weather.',
        signature: 'sig-abc',
        format: 'anthropic-claude-v1',
      },
    ]
    const result = convertToOpenAICompatibleChatMessages(
      [
        {
          role: 'assistant',
          content: [
            {
              type: 'reasoning',
              text: 'Need the weather.',
              providerOptions: {
                codebuff: {
                  reasoning_details: details,
                  model: 'anthropic/claude-opus-4.8',
                },
              },
            },
          ],
        },
      ],
      { providerOptionsName: 'codebuff', modelId: 'anthropic/claude-opus-4.8' },
    )

    expect(result[0].reasoning_details).toEqual(details)
  })

  it('drops reasoning_details recorded for a different model', () => {
    const details = [
      {
        type: 'reasoning.text',
        text: 'Need the weather.',
        signature: 'sig-abc',
        format: 'anthropic-claude-v1',
      },
    ]
    const result = convertToOpenAICompatibleChatMessages(
      [
        {
          role: 'assistant',
          content: [
            {
              type: 'reasoning',
              text: 'Need the weather.',
              providerOptions: {
                codebuff: {
                  reasoning_details: details,
                  model: 'anthropic/claude-opus-4.8',
                },
              },
            },
          ],
        },
      ],
      { providerOptionsName: 'codebuff', modelId: 'deepseek/deepseek-v3' },
    )

    expect(result[0].reasoning_details).toBeUndefined()
    expect(result[0].reasoning_content).toBe('Need the weather.')
  })

  it('reads reasoning_details only from the named provider namespace', () => {
    const details = [{ type: 'reasoning.text', text: 'x', signature: 's' }]
    const result = convertToOpenAICompatibleChatMessages(
      [
        {
          role: 'assistant',
          content: [
            {
              type: 'reasoning',
              text: 'x',
              providerOptions: { other: { reasoning_details: details } },
            },
          ],
        },
      ],
      { providerOptionsName: 'codebuff' },
    )

    expect(result[0].reasoning_details).toBeUndefined()
    expect(result[0].reasoning_content).toBe('x')
  })

  it('should handle a single tool role message with multiple tool-result parts', () => {
    const result = convertToOpenAICompatibleChatMessages([
      {
        role: 'tool',
        providerOptions: {
          // this just gets omitted as we prioritize content-level metadata
          openaiCompatible: { responseTier: 'detailed' },
        },
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call123',
            toolName: 'calculator',
            output: { type: 'json', value: { stepOne: 'data chunk 1' } },
          },
          {
            type: 'tool-result',
            toolCallId: 'call123',
            toolName: 'calculator',
            providerOptions: {
              openaiCompatible: { partial: true },
            },
            output: { type: 'json', value: { stepTwo: 'data chunk 2' } },
          },
        ],
      },
    ])

    expect(result).toEqual([
      {
        role: 'tool',
        tool_call_id: 'call123',
        content: JSON.stringify({ stepOne: 'data chunk 1' }),
      },
      {
        role: 'tool',
        tool_call_id: 'call123',
        content: JSON.stringify({ stepTwo: 'data chunk 2' }),
        partial: true,
      },
    ])
  })

  it('should handle multiple content parts with multiple metadata layers', () => {
    const result = convertToOpenAICompatibleChatMessages([
      {
        role: 'user',
        providerOptions: {
          openaiCompatible: { messageLevel: 'global-metadata' },
          leftoverForMessage: { x: 123 },
        },
        content: [
          {
            type: 'text',
            text: 'Part A',
            providerOptions: {
              openaiCompatible: { textPartLevel: 'localized' },
              leftoverForText: { info: 'text leftover' },
            },
          },
          {
            type: 'file',
            data: Buffer.from([9, 8, 7, 6]).toString('base64'),
            mediaType: 'image/png',
            providerOptions: {
              openaiCompatible: { imagePartLevel: 'image-data' },
            },
          },
        ],
      },
    ])

    expect(result).toEqual([
      {
        role: 'user',
        messageLevel: 'global-metadata',
        content: [
          {
            type: 'text',
            text: 'Part A',
            textPartLevel: 'localized',
          },
          {
            type: 'image_url',
            image_url: {
              url: 'data:image/png;base64,CQgHBg==',
            },
            imagePartLevel: 'image-data',
          },
        ],
      },
    ])
  })

  it('should handle different tool metadata vs. message-level metadata', () => {
    const result = convertToOpenAICompatibleChatMessages([
      {
        role: 'assistant',
        providerOptions: {
          openaiCompatible: { globalPriority: 'high' },
        },
        content: [
          { type: 'text', text: 'Initiating tool calls...' },
          {
            type: 'tool-call',
            toolCallId: 'callXYZ',
            toolName: 'awesomeTool',
            input: { param: 'someValue' },
            providerOptions: {
              openaiCompatible: {
                toolPriority: 'critical',
              },
            },
          },
        ],
      },
    ])

    expect(result).toEqual([
      {
        role: 'assistant',
        globalPriority: 'high',
        content: 'Initiating tool calls...',
        tool_calls: [
          {
            id: 'callXYZ',
            type: 'function',
            function: {
              name: 'awesomeTool',
              arguments: JSON.stringify({ param: 'someValue' }),
            },
            toolPriority: 'critical',
          },
        ],
      },
    ])
  })

  it('should handle metadata collisions and overwrites in tool calls', () => {
    const result = convertToOpenAICompatibleChatMessages([
      {
        role: 'assistant',
        providerOptions: {
          openaiCompatible: {
            cacheControl: { type: 'default' },
            sharedKey: 'assistantLevel',
          },
        },
        content: [
          {
            type: 'tool-call',
            toolCallId: 'collisionToolCall',
            toolName: 'collider',
            input: { num: 42 },
            providerOptions: {
              openaiCompatible: {
                cacheControl: { type: 'ephemeral' }, // overwrites top-level
                sharedKey: 'toolLevel',
              },
            },
          },
        ],
      },
    ])

    expect(result).toEqual([
      {
        role: 'assistant',
        cacheControl: { type: 'default' },
        sharedKey: 'assistantLevel',
        content: '',
        tool_calls: [
          {
            id: 'collisionToolCall',
            type: 'function',
            function: {
              name: 'collider',
              arguments: JSON.stringify({ num: 42 }),
            },
            cacheControl: { type: 'ephemeral' },
            sharedKey: 'toolLevel',
          },
        ],
      },
    ])
  })
})

describe('consecutive assistant messages', () => {
  it('merges a run of assistant messages into one wire message', () => {
    const result = convertToOpenAICompatibleChatMessages([
      {
        role: 'assistant',
        content: [{ type: 'reasoning', text: 'Read the file first.' }],
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Working on it.' }],
      },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'call_1',
            toolName: 'read_files',
            input: { paths: ['a.ts'] },
          },
        ],
      },
    ])

    expect(result).toEqual([
      {
        role: 'assistant',
        content: 'Working on it.',
        reasoning_content: 'Read the file first.',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: {
              name: 'read_files',
              arguments: JSON.stringify({ paths: ['a.ts'] }),
            },
          },
        ],
      },
    ])
  })

  it('concatenates text, reasoning, and tool_calls across the run in order', () => {
    const result = convertToOpenAICompatibleChatMessages([
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'First, ' },
          { type: 'text', text: 'Step one.' },
        ],
      },
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'then done.' },
          { type: 'text', text: ' Step two.' },
          {
            type: 'tool-call',
            toolCallId: 'call_1',
            toolName: 'a',
            input: {},
          },
        ],
      },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'call_2',
            toolName: 'b',
            input: {},
          },
        ],
      },
    ])

    expect(result).toEqual([
      {
        role: 'assistant',
        content: 'Step one. Step two.',
        reasoning_content: 'First, then done.',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'a', arguments: '{}' },
          },
          {
            id: 'call_2',
            type: 'function',
            function: { name: 'b', arguments: '{}' },
          },
        ],
      },
    ])
  })

  it('does not merge assistant messages separated by another role', () => {
    const result = convertToOpenAICompatibleChatMessages([
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'One.' }],
      },
      { role: 'user', content: [{ type: 'text', text: 'Go on.' }] },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Two.' }],
      },
    ])

    expect(result).toEqual([
      { role: 'assistant', content: 'One.' },
      { role: 'user', content: [{ type: 'text', text: 'Go on.' }] },
      { role: 'assistant', content: 'Two.' },
    ])
  })
})
