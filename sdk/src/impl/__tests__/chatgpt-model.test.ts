import { afterEach, describe, expect, test } from 'bun:test'
import { APICallError } from 'ai'

import { chatGptResponsesBody } from '../chatgpt-responses'
import { getModelForRequest } from '../model-provider'
import { fakeChatGptJwt } from '../../__tests__/fixtures/chatgpt-jwt'
import { withByokReasoningEffort } from '../../byok'

import type {
  LanguageModelV2,
  LanguageModelV2CallOptions,
  LanguageModelV2StreamPart,
} from '@ai-sdk/provider'
import type { ResolvedByokConnection } from '../../byok'

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

const token = fakeChatGptJwt()
function connection(
  overrides: Partial<ResolvedByokConnection> = {},
  accessToken: () => Promise<string> = async () => token,
): ResolvedByokConnection {
  const result = {
    id: '00000000-0000-4000-8000-000000000001',
    revision: 1,
    name: 'GPT-6-Sol (ChatGPT)',
    provider: 'chatgpt',
    model: 'gpt-6-sol',
    baseUrl: 'https://chatgpt.com/backend-api/codex',
    contextWindow: 272_000,
    maxOutputTokens: 32_000,
    credentialRef: 'chatgpt:00000000-0000-4000-8000-000000000002',
    createdAt: 'x',
    updatedAt: 'x',
    ...overrides,
  } as ResolvedByokConnection
  Object.defineProperty(result, 'apiKey', {
    value: 'stale-token',
    enumerable: false,
  })
  Object.defineProperty(result, 'accessToken', {
    value: accessToken,
    enumerable: false,
  })
  return result
}

const options: LanguageModelV2CallOptions = {
  prompt: [
    { role: 'system', content: 'You are Freebuff.' },
    { role: 'user', content: [{ type: 'text', text: 'List the files.' }] },
  ],
  maxOutputTokens: 4096,
  temperature: 0.2,
  tools: [
    {
      type: 'function',
      name: 'read_files',
      inputSchema: { type: 'object', properties: { paths: { type: 'array' } } },
    },
  ],
  toolChoice: { type: 'auto' },
}

const sse = (events: unknown[]) =>
  new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
    { headers: { 'content-type': 'text/event-stream' } },
  )
const toolCallEvents = [
  { type: 'response.created', response: { id: 'resp_1', model: 'gpt-6-sol' } },
  { type: 'response.reasoning_summary_text.delta', delta: 'Need the listing.' },
  { type: 'response.output_text.delta', delta: 'Reading.' },
  {
    type: 'response.output_item.added',
    output_index: 1,
    item: { type: 'function_call', call_id: 'call_1', name: 'read_files' },
  },
  {
    type: 'response.function_call_arguments.delta',
    output_index: 1,
    delta: '{"paths":',
  },
  {
    type: 'response.function_call_arguments.delta',
    output_index: 1,
    delta: '["a.ts"]}',
  },
  {
    type: 'response.completed',
    response: {
      status: 'completed',
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        total_tokens: 120,
        input_tokens_details: { cached_tokens: 40 },
        output_tokens_details: { reasoning_tokens: 5 },
      },
    },
  },
]

function capture(answer: () => Response) {
  const sent: {
    url: string
    headers: Headers
    body: Record<string, unknown>
  }[] = []
  globalThis.fetch = (async (input, init) => {
    sent.push({
      url: String(input),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)),
    })
    return answer()
  }) as typeof fetch
  return sent
}

async function failure(operation: PromiseLike<unknown>): Promise<unknown> {
  try {
    await operation
  } catch (error) {
    return error
  }
  throw new Error('expected the request to fail')
}

async function drain(stream: ReadableStream<LanguageModelV2StreamPart>) {
  const parts: LanguageModelV2StreamPart[] = []
  const reader = stream.getReader()
  while (true) {
    const next = await reader.read()
    if (next.done) return parts
    parts.push(next.value)
  }
}

describe('ChatGPT plan model', () => {
  test('streams a tool call through the Codex Responses endpoint with a fresh token', async () => {
    const sent = capture(() => sse(toolCallEvents))
    const model = getModelForRequest({
      apiKey: 'hosted-key-must-not-be-sent',
      model: 'ignored',
      byok: withByokReasoningEffort(connection(), 'high'),
    }) as LanguageModelV2
    const parts = await drain((await model.doStream(options)).stream)

    expect(sent).toHaveLength(1)
    const [request] = sent
    expect(request!.url).toBe('https://chatgpt.com/backend-api/codex/responses')
    expect(request!.headers.get('authorization')).toBe(`Bearer ${token}`)
    expect(request!.headers.get('chatgpt-account-id')).toBe('acct_fixture')
    expect(request!.headers.get('originator')).toBe('freebuff')
    expect(request!.body).toMatchObject({
      model: 'gpt-6-sol',
      instructions: 'You are Freebuff.',
      stream: true,
      store: false,
      reasoning: { effort: 'high', summary: 'auto' },
      tools: [{ type: 'function', name: 'read_files', strict: false }],
      tool_choice: 'auto',
    })
    for (const field of [
      'max_tokens',
      'max_output_tokens',
      'temperature',
      'messages',
    ])
      expect(request!.body).not.toHaveProperty(field)
    expect(JSON.stringify(request!.body)).not.toContain('hosted-key')

    const text = parts
      .filter((part) => part.type === 'text-delta')
      .map((part) => (part as { delta: string }).delta)
      .join('')
    expect(text).toBe('Reading.')
    expect(parts.some((part) => part.type === 'reasoning-delta')).toBe(true)
    const call = parts.find((part) => part.type === 'tool-call') as
      | { toolCallId: string; toolName: string; input: string }
      | undefined
    expect(call).toMatchObject({
      toolCallId: 'call_1',
      toolName: 'read_files',
      input: '{"paths":["a.ts"]}',
    })
    const finish = parts.find((part) => part.type === 'finish') as
      | {
          finishReason: string
          usage: { inputTokens: number; outputTokens: number }
        }
      | undefined
    expect(finish?.finishReason).toBe('tool-calls')
    expect(finish?.usage).toMatchObject({ inputTokens: 100, outputTokens: 20 })
  })

  test('a non-streamed call gets one completion assembled from the stream', async () => {
    const sent = capture(() =>
      sse([
        { type: 'response.created', response: { id: 'resp_2' } },
        { type: 'response.output_text.delta', delta: 'Hello ' },
        { type: 'response.output_text.delta', delta: 'there' },
        { type: 'response.completed', response: { status: 'completed' } },
      ]),
    )
    const model = getModelForRequest({
      apiKey: 'unused',
      model: 'ignored',
      byok: connection(),
    }) as LanguageModelV2
    const result = await model.doGenerate({ ...options, tools: undefined })
    expect(sent[0]!.body.stream).toBe(true)
    expect(sent[0]!.body.reasoning).toEqual({
      effort: 'medium',
      summary: 'auto',
    })
    expect(result.content).toContainEqual({ type: 'text', text: 'Hello there' })
    expect(result.finishReason).toBe('stop')
  })

  test('a spent plan stops at once with our message, not the provider body', async () => {
    let calls = 0
    capture(() => {
      calls++
      return Response.json(
        { error: { type: 'usage_limit_reached', message: `echo ${token}` } },
        { status: 429 },
      )
    })
    const model = getModelForRequest({
      apiKey: 'unused',
      model: 'ignored',
      byok: connection(),
    }) as LanguageModelV2
    const error = await failure(model.doGenerate(options))
    expect(calls).toBe(1)
    expect(APICallError.isInstance(error)).toBe(true)
    expect((error as APICallError).isRetryable).toBe(false)
    expect((error as Error).message).toContain('usage limit')
    expect((error as Error).message).not.toContain(token)
  })

  test('an unknown model names the model and not the response', async () => {
    capture(() =>
      Response.json(
        {
          detail:
            "The 'gpt-9' model is not supported when using Codex with a ChatGPT account.",
        },
        { status: 400 },
      ),
    )
    const model = getModelForRequest({
      apiKey: 'unused',
      model: 'ignored',
      byok: connection({ model: 'gpt-9' }),
    }) as LanguageModelV2
    const error = await failure(model.doGenerate(options))
    expect((error as Error).message).toContain('ChatGPT does not offer "gpt-9"')
  })

  test('an expired sign-in fails before any request', async () => {
    const sent = capture(() => sse([]))
    const expired = connection({}, async () => {
      throw new Error('internal detail that must not show')
    })
    const model = getModelForRequest({
      apiKey: 'unused',
      model: 'ignored',
      byok: expired,
    }) as LanguageModelV2
    const error = await failure(model.doGenerate(options))
    expect(sent).toHaveLength(0)
    expect((error as Error).message).toContain('Sign in with ChatGPT again')
    expect((error as Error).message).not.toContain('internal detail')
  })
})

describe('Chat Completions to Responses', () => {
  test('keeps a conversation, its tool results and images in order', () => {
    const body = chatGptResponsesBody({
      model: 'gpt-6-sol',
      messages: [
        { role: 'system', content: 'One.' },
        { role: 'system', content: 'Two.' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Look' },
            {
              type: 'image_url',
              image_url: { url: 'data:image/png;base64,AA' },
            },
          ],
        },
        {
          role: 'assistant',
          content: 'Calling.',
          tool_calls: [
            {
              id: 'c1',
              type: 'function',
              function: { name: 'run', arguments: '{}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'c1', content: 'done' },
        { role: 'system', content: 'Reminder.' },
      ],
      tool_choice: { type: 'function', function: { name: 'run' } },
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'answer', schema: { type: 'object' } },
      },
      stream_options: { include_usage: true },
      max_tokens: 10,
    })
    expect(body.instructions).toBe('One.\n\nTwo.')
    expect(body.input).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: 'Look' },
          { type: 'input_image', image_url: 'data:image/png;base64,AA' },
        ],
      },
      { type: 'message', role: 'assistant', content: 'Calling.' },
      { type: 'function_call', call_id: 'c1', name: 'run', arguments: '{}' },
      { type: 'function_call_output', call_id: 'c1', output: 'done' },
      { type: 'message', role: 'developer', content: 'Reminder.' },
    ])
    expect(body.tool_choice).toEqual({ type: 'function', name: 'run' })
    expect(body.text).toEqual({
      format: {
        type: 'json_schema',
        name: 'answer',
        schema: { type: 'object' },
        strict: false,
      },
    })
    expect(body).not.toHaveProperty('stream_options')
    expect(body).not.toHaveProperty('max_tokens')
  })
})
