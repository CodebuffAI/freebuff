import { describe, expect, test } from 'bun:test'

import { createCliRunFunnel } from '../cli-run-funnel'

import type { PrintModeEvent } from '@codebuff/common/types/print-mode'

function fixture() {
  const events: unknown[][] = []
  let now = 100
  const run = createCliRunFunnel({
    capture: (...event) => events.push(event),
    now: () => now,
  })
  return {
    run,
    events,
    setNow: (value: number) => {
      now = value
    },
  }
}

describe('CLI run conversion', () => {
  test('a stale-catalog retry counts one dispatch/start/output and one useful completion', () => {
    const { run, events, setNow } = fixture()
    run.accept()
    run.event({ type: 'start', messageHistoryLength: 0 })
    run.accept()
    run.event({ type: 'start', messageHistoryLength: 0 })
    run.chunk('hello')
    run.chunk(' again')
    setNow(220)
    run.finish(true)
    run.finish(true)
    expect(events).toEqual([
      ['send', 'accepted'],
      ['turn', 'started'],
      ['response', 'received', { output_kind: 'text' }],
      ['turn', 'succeeded', { has_output: true, duration_ms: 120 }],
    ])
  })

  test('reasoning and subagents cannot turn an empty response into conversion', () => {
    const { run, events } = fixture()
    run.accept()
    run.chunk({ type: 'reasoning_chunk', chunk: 'thinking' })
    run.chunk({ type: 'subagent_chunk', chunk: 'agent answer' })
    run.chunk('  ')
    run.event({
      type: 'tool_call',
      toolCallId: 't1',
      toolName: 'read_files',
      input: {},
      parentAgentId: 'root',
      agentId: 'child',
    })
    run.event({
      type: 'tool_call',
      toolCallId: 't2',
      toolName: 'end_turn',
      input: {},
    })
    for (const toolName of ['set_output', 'set_messages', 'add_message'])
      run.event({
        type: 'tool_call',
        toolCallId: toolName,
        toolName,
        input: {},
        includeToolCall: false,
      })
    run.event({
      type: 'tool_call',
      toolCallId: 'ask',
      toolName: 'ask_user',
      input: {},
    })
    run.finish(true)
    expect(events).toEqual([
      ['send', 'accepted'],
      [
        'turn',
        'failed',
        { has_output: false, reason: 'empty', duration_ms: 0 },
      ],
    ])
  })

  test('a root tool is useful output; repeated calls emit no per-token events', () => {
    const { run, events } = fixture()
    run.accept()
    const tool: PrintModeEvent = {
      type: 'tool_call',
      toolCallId: 't1',
      toolName: 'read_files',
      input: { paths: ['/private/path'] },
    }
    run.event(tool)
    run.event(tool)
    run.finish(true)
    expect(events).toEqual([
      ['send', 'accepted'],
      ['response', 'received', { output_kind: 'tool' }],
      ['turn', 'succeeded', { has_output: true, duration_ms: 0 }],
    ])
    expect(JSON.stringify(events)).not.toContain('/private/path')
  })

  test.each(['read_files', 'run_terminal_command'])(
    '%s still counts as useful tool-only output when drawn collapsed',
    (toolName) => {
      const { run, events } = fixture()
      run.accept()
      run.event({
        type: 'tool_call',
        toolCallId: 't1',
        toolName,
        input: { paths: ['/private/path'], command: 'private command' },
        includeToolCall: false,
      })
      run.finish(true)
      expect(events).toEqual([
        ['send', 'accepted'],
        ['response', 'received', { output_kind: 'tool' }],
        ['turn', 'succeeded', { has_output: true, duration_ms: 0 }],
      ])
      expect(JSON.stringify(events)).not.toContain('private')
    },
  )

  test('cancellation wins over a late result or chunk', () => {
    const { run, events } = fixture()
    run.accept()
    run.cancel()
    run.chunk('late output')
    run.finish(true)
    run.finish(false)
    expect(events).toEqual([
      ['send', 'accepted'],
      ['turn', 'cancelled', { has_output: false }],
    ])
  })

  test('failure stays failure even when partial output exists', () => {
    const { run, events } = fixture()
    run.accept()
    run.chunk('partial')
    run.finish(false)
    expect(events.at(-1)).toEqual([
      'turn',
      'failed',
      { has_output: true, reason: 'error', duration_ms: 0 },
    ])
  })

  test('preflight cancellation and broken capture never produce a conversion or throw', () => {
    const { run, events } = fixture()
    run.cancel()
    run.accept()
    run.finish(false)
    expect(events).toEqual([])
    const broken = createCliRunFunnel({
      capture: () => {
        throw new Error('offline')
      },
    })
    expect(() => {
      broken.accept()
      broken.chunk('hi')
      broken.finish(true)
    }).not.toThrow()
  })
})
