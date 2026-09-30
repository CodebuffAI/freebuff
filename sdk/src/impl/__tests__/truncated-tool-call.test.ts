/**
 * A write_file cut off by the model's output limit, end to end through the
 * client stack users run: the vendored OpenAI-compatible provider, the AI SDK,
 * and the agent runtime's argument parser.
 *
 * The SSE below is the shape OpenRouter sent for GPT-6 Luna on 2026-09-29 when
 * a write_file call hit max_output_tokens: argument deltas that never close,
 * then `finish_reason: "tool_calls"` with the real reason only in
 * `native_finish_reason`. So the finish reason cannot be what protects the
 * file; the arguments themselves have to.
 */
import http from 'node:http'

import { parseRawToolCall } from '@codebuff/agent-runtime/tools/tool-executor'
import { toolParams } from '@codebuff/common/tools/list'
import { OpenAICompatibleChatLanguageModel } from '@codebuff/llm-providers/openai-compatible'
import { streamText } from 'ai'
import { describe, expect, it } from 'bun:test'

const chunk = (delta: Record<string, unknown>, extra: object = {}) =>
  `data: ${JSON.stringify({
    id: 'gen-1790725927-NNkKJQcajfHJEzLzE7ES',
    object: 'chat.completion.chunk',
    model: 'openai/gpt-6-luna',
    provider: 'OpenAI',
    choices: [
      {
        index: 0,
        delta,
        finish_reason: null,
        native_finish_reason: null,
      },
    ],
    ...extra,
  })}\n\n`

const argumentPieces = [
  '{"path":"src/editor.rs","instructions":"Create the editor panel","content":"',
  'use eframe::egui;\\n\\npub struct Editor {\\n    title: String,\\n}\\n\\n',
  'impl Editor {\\n    /// Marks the current document as saved.\\n',
  '    pub fn mark_saved(&mut',
]

const sse = [
  chunk({
    role: 'assistant',
    content: null,
    tool_calls: [
      {
        index: 0,
        id: 'call_WN6oILk658sfhEDHb2eRDPwp',
        type: 'function',
        function: { name: 'write_file', arguments: '' },
      },
    ],
  }),
  ...argumentPieces.map((piece) =>
    chunk({
      role: 'assistant',
      content: null,
      tool_calls: [{ index: 0, function: { arguments: piece } }],
    }),
  ),
  `data: ${JSON.stringify({
    id: 'gen-1790725927-NNkKJQcajfHJEzLzE7ES',
    object: 'chat.completion.chunk',
    model: 'openai/gpt-6-luna',
    provider: 'OpenAI',
    service_tier: 'flex',
    choices: [
      {
        index: 0,
        delta: { content: '', role: 'assistant' },
        finish_reason: 'tool_calls',
        native_finish_reason: 'max_output_tokens',
      },
    ],
    usage: { prompt_tokens: 104, completion_tokens: 700, total_tokens: 804 },
  })}\n\n`,
  'data: [DONE]\n\n',
].join('')

describe('write_file cut off by the output limit', () => {
  it('reaches the runtime as cut-off arguments and is never applied', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.end(sse)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port

    try {
      const result = streamText({
        model: new OpenAICompatibleChatLanguageModel('openai/gpt-6-luna', {
          provider: 'codebuff',
          url: () => `http://127.0.0.1:${port}/chat/completions`,
          headers: () => ({}),
        }),
        messages: [{ role: 'user', content: 'write the editor' }],
        tools: { write_file: toolParams.write_file },
        maxRetries: 0,
        // What promptAiSdkStream does for anything but a misnamed agent.
        experimental_repairToolCall: async ({ toolCall }) => toolCall,
      })

      const toolCalls: { input: unknown; invalid?: boolean }[] = []
      let finishReason: string | undefined
      for await (const part of result.stream) {
        if (part.type === 'tool-call') toolCalls.push(part)
        if (part.type === 'finish') finishReason = part.finishReason
      }

      // The step looks like an ordinary tool-calling step...
      expect(finishReason).toBe('tool-calls')
      // ...and still delivers the cut-off call, as raw argument text.
      expect(toolCalls).toHaveLength(1)
      expect(toolCalls[0]!.invalid).toBe(true)
      expect(toolCalls[0]!.input).toBe(argumentPieces.join(''))

      const parsed = parseRawToolCall({
        rawToolCall: {
          toolName: 'write_file',
          toolCallId: 'call_WN6oILk658sfhEDHb2eRDPwp',
          input: toolCalls[0]!.input,
        },
      })
      expect('error' in parsed).toBe(true)
      if (!('error' in parsed)) return
      expect(parsed.truncated).toBe(true)
      expect(parsed.error).toContain('nothing was written')
      expect(parsed.error).toContain('`src/editor.rs` is unchanged on disk')
    } finally {
      server.close()
    }
  })
})
