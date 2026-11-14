/**
 * Tool calls a model got slightly wrong, through the AI SDK as users run it: an invented tool name
 * and arguments with an unescaped quote both reach the agent as the call the model meant.
 */
import { jsonSchema, tool } from 'ai'
import type { JSONSchema7 } from 'ai'
import { afterEach, expect, test } from 'bun:test'

import { promptAiSdkStream } from '../llm'

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

const logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  fatal() {},
  trace() {},
  child() {
    return this
  },
}

async function toolCallsFor(name: string, args: string) {
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(
        [
          {
            delta: {
              tool_calls: [
                { index: 0, id: 'call_1', type: 'function', function: { name, arguments: args } },
              ],
            },
            finish_reason: null,
          },
          { delta: {}, finish_reason: 'tool_calls' },
        ]
          .map(
            (choice) =>
              `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 1, model: 'test-model', choices: [{ index: 0, ...choice }] })}\n\n`,
          )
          .join('') + 'data: [DONE]\n\n',
        { headers: { 'Content-Type': 'text/event-stream' } },
      ),
    )) as unknown as typeof fetch

  const object = (properties: Record<string, JSONSchema7>) =>
    tool({ inputSchema: jsonSchema({ type: 'object', properties, required: Object.keys(properties) }) })
  const stream = promptAiSdkStream({
    apiKey: 'test-key',
    runId: 'run-1',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
    tools: {
      run_terminal_command: object({ command: { type: 'string' } }),
      str_replace: object({ path: { type: 'string' }, replacements: { type: 'array' } }),
    },
    clientSessionId: 'session-1',
    fingerprintId: 'fingerprint-1',
    model: 'openai/gpt-5.6-luna',
    userId: 'user-1',
    userInputId: 'input-1',
    sendAction: async () => undefined,
    logger,
    trackEvent: async () => undefined,
    signal: new AbortController().signal,
  } as unknown as Parameters<typeof promptAiSdkStream>[0])

  const calls: { toolName: string; input: unknown }[] = []
  for await (const chunk of stream)
    if (chunk.type === 'tool-call') calls.push({ toolName: chunk.toolName, input: chunk.input })
  return calls
}

test('an invented tool name runs as the real tool', async () => {
  expect(await toolCallsFor('run_command', '{"command": "ls"}')).toEqual([
    { toolName: 'run_terminal_command', input: { command: 'ls' } },
  ])
})

test('arguments with an unescaped quote run as the model meant them', async () => {
  expect(
    await toolCallsFor(
      'str_replace',
      '{"path": "a.tsx", "replacements": [{"oldString": "<div className="a">", "newString": "b"}]}',
    ),
  ).toEqual([
    {
      toolName: 'str_replace',
      input: { path: 'a.tsx', replacements: [{ oldString: '<div className="a">', newString: 'b' }] },
    },
  ])
})
