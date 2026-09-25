import { describe, expect, test } from 'bun:test'

import {
  adTraceContextFromRunState,
  parseAdTraceContext,
} from './trace-context'

const SESSION = '11111111-2222-4333-8444-555555555555'
const RUN = '66666666-7777-4888-9999-aaaaaaaaaaaa'

describe('parseAdTraceContext', () => {
  test('keeps valid ids, lowercased', () => {
    expect(
      parseAdTraceContext({
        traceSessionId: SESSION.toUpperCase(),
        previousRunId: RUN,
      }),
    ).toEqual({ traceSessionId: SESSION, previousRunId: RUN })
    expect(parseAdTraceContext({ traceSessionId: SESSION })).toEqual({
      traceSessionId: SESSION,
    })
  })

  test('drops a malformed run id but keeps the session', () => {
    for (const previousRunId of ['run-1', 42, '', `${RUN}x`, null]) {
      expect(
        parseAdTraceContext({ traceSessionId: SESSION, previousRunId }),
      ).toEqual({ traceSessionId: SESSION })
    }
  })

  test('is null without a usable session id', () => {
    for (const value of [
      undefined,
      null,
      'string',
      [],
      {},
      { previousRunId: RUN },
      { traceSessionId: 'x'.repeat(500), previousRunId: RUN },
      { traceSessionId: `${SESSION}\n` },
    ]) {
      expect(parseAdTraceContext(value)).toBeNull()
    }
  })

  test('never carries extra keys through', () => {
    expect(
      parseAdTraceContext({
        traceSessionId: SESSION,
        prompt: 'secret text',
      }),
    ).toEqual({ traceSessionId: SESSION })
  })
})

describe('adTraceContextFromRunState', () => {
  test('reads the session and the last run from an SDK run state', () => {
    expect(
      adTraceContextFromRunState({
        traceSessionId: SESSION,
        sessionState: { mainAgentState: { runId: RUN } },
      }),
    ).toEqual({ traceSessionId: SESSION, previousRunId: RUN })
  })

  test('uses the fallback session when the state has none', () => {
    expect(adTraceContextFromRunState(undefined, SESSION)).toEqual({
      traceSessionId: SESSION,
    })
    expect(adTraceContextFromRunState({ sessionState: {} }, SESSION)).toEqual({
      traceSessionId: SESSION,
    })
  })

  test('prefers the carried session over the fallback', () => {
    expect(
      adTraceContextFromRunState({ traceSessionId: SESSION }, RUN),
    ).toEqual({ traceSessionId: SESSION })
  })

  test('is null for foreign or empty state', () => {
    expect(adTraceContextFromRunState(undefined)).toBeNull()
    expect(adTraceContextFromRunState('state')).toBeNull()
    expect(adTraceContextFromRunState({ sessionId: 'abc' })).toBeNull()
  })
})
