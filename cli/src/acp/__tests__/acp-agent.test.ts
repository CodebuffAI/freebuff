import { describe, expect, test } from 'bun:test'

import { FreebuffAcpAgent } from '../acp-agent'

import type { PrintModeEvent } from '@codebuff/common/types/print-mode'

/** The real constructor shape: a logger nested under `logger`, not spread at
 *  the top level. The previous version passed a bare logger and compiled only
 *  because the whole object was cast to `never`, which is exactly the bug it
 *  was supposed to catch. */
function agent(runTurn?: (request: never) => Promise<{ previousRun: null }>) {
  const calls: Array<{ level: string; data: unknown }> = []
  const backend = new FreebuffAcpAgent({
    logger: {
      info: (data: unknown) => calls.push({ level: 'info', data }),
      error: (data: unknown) => calls.push({ level: 'error', data }),
      warn: (data: unknown) => calls.push({ level: 'warn', data }),
      debug: (data: unknown) => calls.push({ level: 'debug', data }),
      fatal: (data: unknown) => calls.push({ level: 'fatal', data }),
      trace: (data: unknown) => calls.push({ level: 'trace', data }),
    } as never,
    ...(runTurn ? { runTurn: runTurn as never } : {}),
  })
  const sessionId = backend.newSession('/tmp/project')
  return { backend, sessionId, calls }
}

describe('ACP event mapping', () => {
  test('text becomes an agent message chunk', () => {
    const { backend, sessionId } = agent()
    const mapped = backend.eventToUpdate(sessionId, {
      type: 'text',
      text: 'hello',
    } as PrintModeEvent)
    expect(mapped).toEqual({
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'hello' },
      },
    })
  })

  test('empty text is not reported', () => {
    const { backend, sessionId } = agent()
    expect(
      backend.eventToUpdate(sessionId, { type: 'text', text: '' } as PrintModeEvent),
    ).toBeNull()
  })

  test('reasoning becomes a thought chunk', () => {
    const { backend, sessionId } = agent()
    const mapped = backend.eventToUpdate(sessionId, {
      type: 'reasoning_delta',
      text: 'thinking',
      ancestorRunIds: [],
      runId: 'r1',
      agentId: 'a1',
    } as PrintModeEvent)
    expect(mapped).toEqual({
      update: {
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'thinking' },
      },
    })
  })

  test('a tool call becomes a pending tool_call with a kind', () => {
    const { backend, sessionId } = agent()
    const mapped = backend.eventToUpdate(sessionId, {
      type: 'tool_call',
      toolCallId: 'call_1',
      toolName: 'read_files',
      input: { paths: ['a.ts'] },
    } as PrintModeEvent)
    expect(mapped).toEqual({
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'call_1',
        title: 'read_files',
        name: 'read_files',
        kind: 'read',
        status: 'pending',
        rawInput: { paths: ['a.ts'] },
      },
    })
  })

  test('an unknown tool is reported as kind other', () => {
    const { backend, sessionId } = agent()
    const mapped = backend.eventToUpdate(sessionId, {
      type: 'tool_call',
      toolCallId: 'call_2',
      toolName: 'some_new_tool',
      input: {},
    } as PrintModeEvent)
    expect((mapped as { update: { kind: string } }).update.kind).toBe('other')
  })

  test('a tool result completes the tool call with its output', () => {
    const { backend, sessionId } = agent()
    backend.eventToUpdate(sessionId, {
      type: 'tool_call',
      toolCallId: 'call_1',
      toolName: 'read_files',
      input: {},
    } as PrintModeEvent)
    const mapped = backend.eventToUpdate(sessionId, {
      type: 'tool_result',
      toolCallId: 'call_1',
      toolName: 'read_files',
      output: [{ type: 'json', value: 'file contents' }],
    } as PrintModeEvent)
    expect(mapped).toEqual({
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call_1',
        status: 'completed',
        content: [
          { type: 'content', content: { type: 'text', text: 'file contents' } },
        ],
      },
    })
  })

  test('a media tool result is described rather than dropped', () => {
    const { backend, sessionId } = agent()
    const mapped = backend.eventToUpdate(sessionId, {
      type: 'tool_result',
      toolCallId: 'call_3',
      toolName: 'screenshot',
      output: [{ type: 'media', data: 'AAAA', mediaType: 'image/png' }],
    } as PrintModeEvent)
    const content = (mapped as { update: { content: Array<{ content: { text: string } }> } })
      .update.content
    expect(content[0]!.content.text).toContain('image/png')
  })

  test('an error event becomes an error, not an update', () => {
    const { backend, sessionId } = agent()
    const mapped = backend.eventToUpdate(sessionId, {
      type: 'error',
      message: 'boom',
    } as PrintModeEvent)
    expect(mapped).toEqual({ error: 'boom' })
  })

  test('lifecycle events carry nothing a client renders', () => {
    const { backend, sessionId } = agent()
    expect(
      backend.eventToUpdate(sessionId, {
        type: 'start',
        messageHistoryLength: 0,
      } as PrintModeEvent),
    ).toBeNull()
    expect(
      backend.eventToUpdate(sessionId, {
        type: 'finish',
        totalCost: 0,
      } as PrintModeEvent),
    ).toBeNull()
  })
})

describe('ACP sessions', () => {
  test('a new session has a unique id and is known', () => {
    const backend = new FreebuffAcpAgent()
    const first = backend.newSession('/tmp/a')
    const second = backend.newSession('/tmp/b')
    expect(first).not.toBe(second)
    expect(backend.hasSession(first)).toBe(true)
    expect(backend.hasSession('nope')).toBe(false)
  })
})
