/**
 * The ChatGPT plan's Codex backend speaks only the Responses API, always
 * streamed. The BYOK model speaks Chat Completions. This module translates a
 * Chat Completions request into a Responses request, and the Responses event
 * stream back into Chat Completions: SSE chunks for a streamed call, one JSON
 * completion for a non-streamed one (the backend streams either way).
 *
 * Revived from the ChatGPT integration #1175 removed, which ran this
 * translation in production; see docs/freebuff-chatgpt-subscription.md.
 */

type Json = Record<string, unknown>

type ChatToolCall = {
  id: string
  type?: string
  function: { name: string; arguments: string }
}
type ChatMessage = {
  role: string
  content?: unknown
  tool_calls?: ChatToolCall[]
  tool_call_id?: string
}
type ChatTool = {
  type: string
  function?: {
    name: string
    description?: string
    parameters?: unknown
    strict?: boolean
  }
}

/** What the effort control sends when the user picked none. Codex's own default. */
const DEFAULT_REASONING_EFFORT = 'medium'

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part: Json) => (typeof part?.text === 'string' ? part.text : ''))
    .filter(Boolean)
    .join('\n\n')
}

function userContent(content: unknown): unknown {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return String(content ?? '')
  return content.map((part: Json) => {
    if (part.type === 'text') return { type: 'input_text', text: part.text }
    if (part.type === 'image_url') {
      const image = part.image_url as Json | string | undefined
      return {
        type: 'input_image',
        image_url: typeof image === 'string' ? image : image?.url,
      }
    }
    return part
  })
}

function inputItems(messages: ChatMessage[]): unknown[] {
  const input: unknown[] = []
  for (const message of messages) {
    switch (message.role) {
      // Normally lifted into `instructions`; a later system message (a
      // mid-run reminder) keeps its place as a developer message.
      case 'system':
      case 'developer': {
        const text = textOf(message.content)
        if (text)
          input.push({ type: 'message', role: 'developer', content: text })
        break
      }
      case 'user':
        input.push({
          type: 'message',
          role: 'user',
          content: userContent(message.content),
        })
        break
      case 'assistant': {
        const text = textOf(message.content)
        if (text)
          input.push({ type: 'message', role: 'assistant', content: text })
        for (const call of message.tool_calls ?? [])
          input.push({
            type: 'function_call',
            call_id: call.id,
            name: call.function.name,
            arguments: call.function.arguments,
          })
        break
      }
      case 'tool':
        input.push({
          type: 'function_call_output',
          call_id: message.tool_call_id ?? 'unknown',
          output:
            typeof message.content === 'string'
              ? message.content
              : JSON.stringify(message.content),
        })
        break
    }
  }
  return input
}

function responsesTools(tools: ChatTool[]): unknown[] {
  return tools.map((tool) =>
    tool.type === 'function' && tool.function
      ? {
          type: 'function',
          name: tool.function.name,
          description: tool.function.description,
          parameters: tool.function.parameters,
          // Responses reads an omitted flag as strict, which makes every
          // optional argument required. Ours are validated locally.
          strict: tool.function.strict ?? false,
        }
      : tool,
  )
}

function responsesToolChoice(choice: unknown): unknown {
  if (
    choice &&
    typeof choice === 'object' &&
    (choice as Json).type === 'function'
  ) {
    const name = ((choice as Json).function as Json | undefined)?.name
    return { type: 'function', name }
  }
  return choice
}

function responsesTextFormat(format: unknown): Json | undefined {
  if (!format || typeof format !== 'object') return undefined
  const value = format as Json
  if (value.type === 'json_object') return { format: { type: 'json_object' } }
  if (value.type === 'json_schema') {
    const schema = (value.json_schema ?? {}) as Json
    return {
      format: {
        type: 'json_schema',
        name: schema.name ?? 'response',
        schema: schema.schema,
        strict: schema.strict ?? false,
      },
    }
  }
  return undefined
}

/**
 * The Responses request for a Chat Completions body. Only fields the Codex
 * backend accepts survive: it rejects output caps, sampling parameters and
 * stored responses.
 */
export function chatGptResponsesBody(body: Json): Json {
  const messages = (
    Array.isArray(body.messages) ? body.messages : []
  ) as ChatMessage[]
  // Leading system messages become `instructions`, which the backend requires.
  let lead = 0
  while (lead < messages.length && messages[lead]!.role === 'system') lead++
  const instructions = messages
    .slice(0, lead)
    .map((message) => textOf(message.content))
    .filter(Boolean)
    .join('\n\n')
  const tools = Array.isArray(body.tools) ? (body.tools as ChatTool[]) : []
  const text = responsesTextFormat(body.response_format)
  return {
    model: body.model,
    instructions: instructions || 'You are a helpful assistant.',
    input: inputItems(messages.slice(lead)),
    stream: true,
    store: false,
    reasoning: {
      effort:
        typeof body.reasoning_effort === 'string'
          ? body.reasoning_effort
          : DEFAULT_REASONING_EFFORT,
      summary: 'auto',
    },
    ...(tools.length ? { tools: responsesTools(tools) } : {}),
    ...(body.tool_choice != null
      ? { tool_choice: responsesToolChoice(body.tool_choice) }
      : {}),
    ...(typeof body.parallel_tool_calls === 'boolean'
      ? { parallel_tool_calls: body.parallel_tool_calls }
      : {}),
    ...(text ? { text } : {}),
  }
}

function chatUsage(usage: Json | undefined): Json | undefined {
  if (!usage) return undefined
  const input = usage.input_tokens_details as Json | undefined
  const output = usage.output_tokens_details as Json | undefined
  return {
    prompt_tokens: usage.input_tokens,
    completion_tokens: usage.output_tokens,
    total_tokens: usage.total_tokens,
    ...(input?.cached_tokens != null
      ? { prompt_tokens_details: { cached_tokens: input.cached_tokens } }
      : {}),
    ...(output?.reasoning_tokens != null
      ? {
          completion_tokens_details: {
            reasoning_tokens: output.reasoning_tokens,
          },
        }
      : {}),
  }
}

/** Reads Responses events and reports them as Chat Completions deltas. */
class ResponsesEvents {
  id: string | null = null
  model: string | null = null
  private toolCalls = 0
  private toolIndexByOutput = new Map<number, number>()
  private streamedArguments = new Set<number>()

  constructor(
    private readonly onDelta: (delta: Json) => void,
    private readonly onFinish: (finishReason: string, usage?: Json) => void,
    private readonly onError: (message: string, type: string) => void,
  ) {}

  read(event: Json) {
    switch (event.type) {
      case 'response.created': {
        const response = event.response as Json | undefined
        this.id = (response?.id as string) ?? null
        this.model = (response?.model as string) ?? null
        this.onDelta({ role: 'assistant' })
        break
      }
      case 'response.output_text.delta':
        this.onDelta({ content: event.delta })
        break
      case 'response.reasoning_summary_text.delta':
        this.onDelta({ reasoning_content: event.delta })
        break
      case 'response.output_item.added': {
        const item = event.item as Json | undefined
        if (item?.type !== 'function_call') break
        const index = this.toolCalls++
        this.toolIndexByOutput.set(Number(event.output_index ?? 0), index)
        this.onDelta({
          tool_calls: [
            {
              index,
              id: item.call_id ?? item.id,
              type: 'function',
              function: { name: item.name, arguments: '' },
            },
          ],
        })
        break
      }
      case 'response.function_call_arguments.delta': {
        const index =
          this.toolIndexByOutput.get(Number(event.output_index ?? 0)) ?? 0
        this.streamedArguments.add(index)
        this.onDelta({
          tool_calls: [{ index, function: { arguments: event.delta } }],
        })
        break
      }
      case 'response.output_item.done': {
        // Arguments normally stream as deltas; send them whole if they did not.
        const item = event.item as Json | undefined
        const index = this.toolIndexByOutput.get(
          Number(event.output_index ?? 0),
        )
        if (
          item?.type === 'function_call' &&
          index !== undefined &&
          !this.streamedArguments.has(index) &&
          typeof item.arguments === 'string' &&
          item.arguments
        )
          this.onDelta({
            tool_calls: [{ index, function: { arguments: item.arguments } }],
          })
        break
      }
      case 'response.completed':
      case 'response.incomplete':
      case 'response.done': {
        const response = event.response as Json | undefined
        this.onFinish(
          response?.status === 'incomplete'
            ? 'length'
            : this.toolCalls > 0
              ? 'tool_calls'
              : 'stop',
          chatUsage(response?.usage as Json | undefined),
        )
        break
      }
      case 'response.failed': {
        const response = event.response as Json | undefined
        const error = (response?.error ?? event.error) as Json | undefined
        this.onError(
          (error?.message as string) ??
            'ChatGPT could not complete the request.',
          (error?.type as string) ?? 'server_error',
        )
        break
      }
      case 'error': {
        const error = (event.error ?? event) as Json
        this.onError(
          (error.message as string) ??
            'ChatGPT could not complete the request.',
          (error.type as string) ?? (error.code as string) ?? 'server_error',
        )
        break
      }
    }
  }
}

/** Calls `onEvent` for each JSON `data:` line of an SSE body. */
async function readServerSentEvents(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: Json) => void,
): Promise<void> {
  const decoder = new TextDecoder()
  let buffer = ''
  const line = (raw: string) => {
    if (!raw.startsWith('data:')) return
    const data = raw.slice(5).trim()
    if (!data || data === '[DONE]') return
    try {
      onEvent(JSON.parse(data) as Json)
    } catch {
      // A malformed line is skipped, as a Chat Completions client would.
    }
  }
  const reader = body.getReader()
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      buffer += decoder.decode(next.value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const raw of lines) line(raw.trimEnd())
    }
    buffer += decoder.decode()
    if (buffer) line(buffer.trim())
  } finally {
    reader.releaseLock()
  }
}

/** A Responses event stream as a Chat Completions SSE stream. */
export function chatCompletionsStream(
  body: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let finished = false
      const send = (chunk: Json) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`))
      const events = new ResponsesEvents(
        (delta) =>
          send({
            id: events.id,
            model: events.model,
            choices: [{ index: 0, delta, finish_reason: null }],
          }),
        (finishReason, usage) => {
          finished = true
          send({
            id: events.id,
            model: events.model,
            choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
            ...(usage ? { usage } : {}),
          })
        },
        (message, type) => {
          finished = true
          send({ error: { message, type } })
        },
      )
      try {
        await readServerSentEvents(body, (event) => {
          if (!finished) events.read(event)
        })
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
        controller.close()
      } catch (error) {
        controller.error(error)
      }
    },
  })
}

/** A Responses event stream as one Chat Completions JSON completion. */
export async function chatCompletionsJson(
  body: ReadableStream<Uint8Array>,
): Promise<{ status: number; json: Json }> {
  let content = ''
  let reasoning = ''
  const toolCalls: ChatToolCall[] = []
  let finishReason: string | null = null
  let usage: Json | undefined
  let failure: { message: string; type: string } | undefined
  const events = new ResponsesEvents(
    (delta) => {
      if (typeof delta.content === 'string') content += delta.content
      if (typeof delta.reasoning_content === 'string')
        reasoning += delta.reasoning_content
      for (const call of (delta.tool_calls as Json[] | undefined) ?? []) {
        const index = call.index as number
        const fn = call.function as Json
        if (call.id !== undefined)
          toolCalls[index] = {
            id: call.id as string,
            type: 'function',
            function: { name: fn.name as string, arguments: '' },
          }
        else if (toolCalls[index])
          toolCalls[index]!.function.arguments += fn.arguments as string
      }
    },
    (reason, reported) => {
      finishReason = reason
      usage = reported
    },
    (message, type) => {
      failure = { message, type }
    },
  )
  await readServerSentEvents(body, (event) => {
    if (!finishReason && !failure) events.read(event)
  })
  if (failure) return { status: 500, json: { error: failure } }
  return {
    status: 200,
    json: {
      id: events.id,
      object: 'chat.completion',
      model: events.model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: content || null,
            ...(reasoning ? { reasoning_content: reasoning } : {}),
            ...(toolCalls.length
              ? { tool_calls: toolCalls.filter(Boolean) }
              : {}),
          },
          finish_reason: finishReason ?? 'stop',
        },
      ],
      ...(usage ? { usage } : {}),
    },
  }
}
