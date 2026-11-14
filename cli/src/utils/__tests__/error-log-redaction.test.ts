import { AnalyticsEvent } from '@codebuff/common/constants/analytics-events'
import { describe, expect, test } from 'bun:test'

import {
  MAX_ERROR_LOG_STRING_CHARS,
  sanitizeErrorLogData,
} from '../error-log-redaction'
import { remoteLogPayload, selectAxiomLogData } from '../logger'

const SECRET_PROMPT = 'please refactor my proprietary billing module'
const SECRET_SYSTEM = 'You are a coding agent. Project files follow: SECRET'
const BULK = 'x'.repeat(50_000)

function failurePayload() {
  const error = new Error('Agent run failed: upstream 500')
  return {
    error,
    agentId: 'agent-123',
    runId: 'run-456',
    totalSteps: 7,
    messageHistory: [
      { role: 'user', content: [{ type: 'text', text: SECRET_PROMPT }] },
    ],
    systemPrompt: SECRET_SYSTEM,
    agentState: { output: { notes: SECRET_PROMPT } },
    toolOutput: BULK,
  }
}

function expectNoConversation(shipped: unknown) {
  const text = JSON.stringify(shipped)
  expect(text).not.toContain(SECRET_PROMPT)
  expect(text).not.toContain('SECRET')
  expect(text).not.toContain(BULK)
  expect(text.length).toBeLessThan(12_000)
}

describe('sanitizeErrorLogData', () => {
  test('keeps the error and scalar fields, drops the conversation and bulk', () => {
    const payload = failurePayload()
    const out = sanitizeErrorLogData(payload) as Record<string, any>

    expectNoConversation(out)
    expect(out.error.name).toBe('Error')
    expect(out.error.message).toBe('Agent run failed: upstream 500')
    expect(out.error.stack).toBe(payload.error.stack)
    expect(out.agentId).toBe('agent-123')
    expect(out.runId).toBe('run-456')
    expect(out.totalSteps).toBe(7)
    expect(out.messageHistory).toEqual({ kind: 'array', length: 1 })
    expect(out.systemPrompt).toEqual({
      kind: 'string',
      length: SECRET_SYSTEM.length,
    })
    expect(out.agentState).toEqual({ kind: 'object', keyCount: 1, keys: ['output'] })
    expect(out.toolOutput).toStartWith('x'.repeat(MAX_ERROR_LOG_STRING_CHARS))
    expect(out.toolOutput).toEndWith(
      `[${50_000 - MAX_ERROR_LOG_STRING_CHARS} chars omitted]`,
    )
  })

  test('replaces a large array with its length and survives cycles', () => {
    const cyclic: Record<string, unknown> = { paths: Array(500).fill('a.ts') }
    cyclic.self = cyclic
    const out = sanitizeErrorLogData(cyclic) as Record<string, unknown>
    expect(out.paths).toEqual({ kind: 'array', length: 500 })
    expect(out.self).toBe('[Circular]')
  })

  test('the Axiom record is sanitized for errors even under full telemetry', () => {
    for (const level of ['error', 'fatal'] as const) {
      const shipped = selectAxiomLogData({
        level,
        data: failurePayload(),
        fullTelemetry: true,
      }) as Record<string, any>
      expectNoConversation(shipped)
      expect(shipped.error.message).toBe('Agent run failed: upstream 500')
      expect(shipped.error.stack).toContain('error-log-redaction.test')
    }
    // Other levels keep today's behaviour: raw only under full telemetry.
    const data = { prompt: SECRET_PROMPT }
    expect(selectAxiomLogData({ level: 'info', data, fullTelemetry: true })).toBe(
      data,
    )
    expectNoConversation(
      selectAxiomLogData({ level: 'info', data, fullTelemetry: false }),
    )
  })
})

// Through `remoteLogPayload`, not `logger.error`: other CLI test files
// mock.module('../logger') for the whole `bun test` run, so a real logger call
// here is the mock in CI and reaches no client.
describe('what error and fatal records send to PostHog', () => {
  test('error tracking and the analytics event get the error, never the conversation', () => {
    for (const level of ['error', 'fatal'] as const) {
      const { data, msg } = remoteLogPayload({
        level,
        data: { ...failurePayload(), eventId: AnalyticsEvent.CLI_FATAL_CRASH },
        msg: `Agent execution failed ${BULK}`,
      }) as { data: Record<string, any>; msg: string }
      expectNoConversation(data)
      expect(data.eventId).toBe(AnalyticsEvent.CLI_FATAL_CRASH)
      expect(data.error.message).toBe('Agent run failed: upstream 500')
      expect(data.error.stack).toContain('error-log-redaction.test')
      expect(data.messageHistory).toEqual({ kind: 'array', length: 1 })
      expect(msg).toStartWith('Agent execution failed')
      expect(msg).not.toContain(BULK)
    }
  })

  test('other levels pass through unchanged', () => {
    const data = { prompt: SECRET_PROMPT }
    expect(remoteLogPayload({ level: 'info', data, msg: 'm' })).toEqual({
      data,
      msg: 'm',
    })
  })
})
