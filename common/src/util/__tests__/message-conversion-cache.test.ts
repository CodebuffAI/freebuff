import { describe, expect, it } from 'bun:test'

import {
  convertCbToModelMessages,
  dropUnansweredToolCalls,
  jsonToolResult,
  mediaToolResult,
  systemMessage,
  userMessage,
} from '../messages'

import type { Message } from '../../types/messages/codebuff-message'

/**
 * The WeakMap memoization must be behaviourally invisible: any point in a
 * turn must produce the request the uncached pass produced, and second
 * conversions must neither inherit cache-control marks nor disturb the
 * caller's history. These tests pin that on deterministic fixtures; the
 * randomized differential fuzz that established equivalence ran against the
 * pre-change implementation during development.
 */

let seed = 0x2b3b
function rand(n: number) {
  seed = (seed * 1103515245 + 12345) % 2147483648
  return seed % n
}
function pick<T>(arr: T[]): T {
  return arr[rand(arr.length)]
}

const UNICODE = [
  'plain text',
  'emoji 🧑‍💻🔥',
  '漢字テスト',
  'lone-hi \uD83D',
  'lone-lo \uDE00',
  'ends\uD83D',
  '\uDE00starts',
]

function randAssistant(i: number): Message {
  const parts: Message extends never ? never : any[] = []
  const nParts = 1 + rand(3)
  for (let j = 0; j < nParts; j++) {
    const t = rand(3)
    if (t === 0) parts.push({ type: 'text', text: pick(UNICODE) })
    else if (t === 1) parts.push({ type: 'reasoning', text: pick(UNICODE) })
    else
      parts.push({
        type: 'tool-call',
        toolCallId: `c${i}-${j}`,
        toolName: pick(['read_files', 'run_terminal_command']),
        input: { paths: [pick(UNICODE)], nested: { a: [1, 2, pick(UNICODE)] } },
      })
  }
  if (!parts.some((p) => p.type === 'tool-call')) {
    parts.push({
      type: 'tool-call',
      toolCallId: `c${i}-x`,
      toolName: 'read_files',
      input: {},
    })
  }
  const message: Record<string, unknown> = { role: 'assistant', content: parts }
  if (rand(3) === 0) message.tags = [pick(['USER_PROMPT', 'STEP_PROMPT'])]
  if (rand(3) === 0) message.timeToLive = pick(['agentStep', 'userPrompt'])
  if (rand(4) === 0) {
    message.providerOptions = { anthropic: { thinking: { type: 'enabled' } } }
  }
  return message as Message
}

function buildHistory(n: number): Message[] {
  const messages: Message[] = [systemMessage(`sys ${pick(UNICODE)}`)]
  for (let i = 0; i < n; i++) {
    const kind = rand(5)
    if (kind === 0) {
      messages.push({
        role: 'user',
        content: [{ type: 'text', text: pick(UNICODE) }],
        tags: [pick(['USER_PROMPT'])],
      } as Message)
      continue
    }
    if (kind === 1) {
      messages.push(userMessage(pick(UNICODE)))
      continue
    }
    if (kind === 2) {
      messages.push({
        role: 'tool',
        toolCallId: `free-${i}`,
        toolName: 'preview_screenshot',
        content: [
          ...mediaToolResult({ data: 'aXY=', mediaType: 'image/png' }),
          ...jsonToolResult({ note: pick(UNICODE) }),
        ],
      } as unknown as Message)
      continue
    }
    const assistant = randAssistant(i)
    messages.push(assistant)
    for (const part of assistant.content as any[]) {
      if (part.type === 'tool-call' && part.providerExecuted !== true) {
        messages.push(
          (rand(3) === 0
            ? {
                role: 'tool',
                toolCallId: part.toolCallId,
                toolName: 'preview_screenshot',
                content: mediaToolResult({
                  data: 'aXY=',
                  mediaType: 'image/png',
                }),
              }
            : {
                role: 'tool',
                toolCallId: part.toolCallId,
                toolName: part.toolName,
                content: jsonToolResult({ ok: true, note: pick(UNICODE) }),
              }) as Message,
        )
      }
    }
  }
  return messages
}

describe('convertCbToModelMessages memoization', () => {
  it('returns byte-identical output on a warmed cache across history sizes', () => {
    for (const n of [1, 2, 3, 5, 8, 15, 30]) {
      for (let trial = 0; trial < 3; trial++) {
        const history = dropUnansweredToolCalls(buildHistory(n))
        for (const includeCacheControl of [false, true]) {
          const first = convertCbToModelMessages({
            messages: history,
            includeCacheControl,
          })
          const second = convertCbToModelMessages({
            messages: history,
            includeCacheControl,
          })
          expect(JSON.stringify(second)).toBe(JSON.stringify(first))
        }
      }
    }
  })

  it('does not leak cache-control marks into later requests or the history', () => {
    const history = [
      systemMessage('sys'),
      {
        role: 'user',
        content: [{ type: 'text', text: 'prompt' }],
        tags: ['USER_PROMPT'],
      },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'a',
            toolName: 'read_files',
            input: {},
          },
          { type: 'text', text: 'tail' },
        ],
      },
      {
        role: 'tool',
        toolCallId: 'a',
        toolName: 'read_files',
        content: jsonToolResult({ x: 1 }),
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'done' }],
        tags: ['STEP_PROMPT'],
        timeToLive: 'agentStep',
      },
    ] as Message[]
    const snapshot = JSON.stringify(history)

    const marked = convertCbToModelMessages({
      messages: history,
      includeCacheControl: true,
    })
    expect(JSON.stringify(marked)).toContain('cache_control')

    // The history itself is never touched.
    expect(JSON.stringify(history)).toBe(snapshot)

    // A later cache-control-free conversion over the same (cached) message
    // objects must observe none of the marks.
    const unmarked = convertCbToModelMessages({
      messages: history,
      includeCacheControl: false,
    })
    expect(JSON.stringify(unmarked)).not.toContain('cache_control')

    // And a repeated marked conversion is byte-identical to the first.
    const markedAgain = convertCbToModelMessages({
      messages: history,
      includeCacheControl: true,
    })
    expect(JSON.stringify(markedAgain)).toBe(JSON.stringify(marked))
  })

  it('invalidates on message replacement: a rewritten tail reconverts', () => {
    const prefix: Message[] = [
      systemMessage('sys'),
      userMessage('prompt'),
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'r',
            toolName: 'read_files',
            input: {},
          },
        ],
      } as Message,
      {
        role: 'tool',
        toolCallId: 'r',
        toolName: 'read_files',
        content: jsonToolResult({ content: 'original result' }),
      } as Message,
    ]
    const before = convertCbToModelMessages({
      messages: prefix,
      includeCacheControl: false,
    })
    // fitToolResults-style copy-on-write: same history except the tool
    // message object is replaced with a rewritten copy.
    const replaced: Message[] = [
      ...prefix.slice(0, -1),
      {
        ...(prefix[prefix.length - 1] as any),
        content: jsonToolResult({ content: 'rewritten result' }),
      } as Message,
    ]
    const after = convertCbToModelMessages({
      messages: replaced,
      includeCacheControl: false,
    })
    expect(JSON.stringify(after)).toContain('rewritten result')
    expect(JSON.stringify(after)).not.toContain('original result')
    // The prefix conversion still agrees with the earlier run (cached
    // forms were reused, output is unchanged).
    expect(
      JSON.stringify(
        convertCbToModelMessages({ messages: prefix, includeCacheControl: false }),
      ),
    ).toBe(JSON.stringify(before))
  })

  it('scrubs lone surrogates nested inside tool-call inputs', () => {
    const history: Message[] = [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 's',
            toolName: 'read_files',
            input: { paths: ['\uDE00starts'], nested: { a: ['ends\uD83D'] } },
          },
        ],
      } as Message,
      {
        role: 'tool',
        toolCallId: 's',
        toolName: 'read_files',
        content: jsonToolResult({ ok: true }),
      } as Message,
    ]
    const out = convertCbToModelMessages({
      messages: history,
      includeCacheControl: false,
    })
    const text = JSON.stringify(out)
    expect(text).toContain('�starts')
    expect(text).toContain('ends�')
    expect(text).not.toContain('\\ude00')
  })
})
