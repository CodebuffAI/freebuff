import { assistantMessage } from '@codebuff/common/util/messages'
import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'

import { ErrorCodes } from '../errors'
import { run } from '../run'
import * as runModule from '../run'

import type { RunState } from '../run-state'
import type { SessionState } from '@codebuff/common/types/session-state'

const baseOptions = {
  apiKey: 'test-key',
  fingerprintId: 'fp',
  agent: 'base',
  prompt: 'hi',
} as const

describe('run retry wrapper', () => {
  afterEach(() => {
    mock.restore()
  })

  it('returns immediately on success without retrying', async () => {
    const expectedState: RunState = {
      sessionState: {} as SessionState,
      output: { type: 'lastMessage', value: [assistantMessage('hi')] },
    }
    const runSpy = spyOn(runModule, 'runOnce').mockResolvedValueOnce(
      expectedState,
    )

    const result = await run(baseOptions)

    expect(result).toBe(expectedState)
    expect(runSpy).toHaveBeenCalledTimes(1)
  })

  it('retries once on retryable error output and then succeeds', async () => {
    const errorState: RunState = {
      sessionState: {} as SessionState,
      output: { type: 'error', message: 'NetworkError: Service unavailable' },
    }
    const successState: RunState = {
      sessionState: {} as SessionState,
      output: { type: 'lastMessage', value: [assistantMessage('hi')] },
    }

    const runSpy = spyOn(runModule, 'runOnce')
      .mockResolvedValueOnce(errorState)
      .mockResolvedValueOnce(successState)

    const result = await run({
      ...baseOptions,
      retry: { backoffBaseMs: 1, backoffMaxMs: 2 },
    })

    expect(result).toBe(successState)
    expect(runSpy).toHaveBeenCalledTimes(2)
  })

  it('stops after max retries are exhausted and returns error output', async () => {
    const errorState = {
      sessionState: {} as any,
      output: { type: 'error', message: 'NetworkError: Connection timeout' },
    } as RunState

    const runSpy = spyOn(runModule, 'runOnce').mockResolvedValue(errorState)

    const result = await run({
      ...baseOptions,
      retry: { maxRetries: 1, backoffBaseMs: 1, backoffMaxMs: 1 },
    })

    // Should return error output after exhausting retries
    expect(result.output.type).toBe('error')
    if (result.output.type === 'error') {
      expect(result.output.message).toContain('timeout')
    }
    // Initial attempt + one retry
    expect(runSpy).toHaveBeenCalledTimes(2)
  })

  it('does not retry non-retryable error outputs', async () => {
    const errorState = {
      sessionState: {} as any,
      output: { type: 'error', message: 'Invalid input' },
    } as RunState

    const runSpy = spyOn(runModule, 'runOnce').mockResolvedValue(errorState)

    const result = await run({
      ...baseOptions,
      retry: { maxRetries: 3, backoffBaseMs: 1, backoffMaxMs: 1 },
    })

    // Should return immediately without retrying
    expect(result.output.type).toBe('error')
    expect(runSpy).toHaveBeenCalledTimes(1)
  })

  it('skips retry when retry is false even for retryable error outputs', async () => {
    const errorState = {
      sessionState: {} as any,
      output: { type: 'error', message: 'NetworkError: Connection failed' },
    } as RunState

    const runSpy = spyOn(runModule, 'runOnce').mockResolvedValue(errorState)

    const result = await run({
      ...baseOptions,
      retry: false,
    })

    expect(result.output.type).toBe('error')
    expect(runSpy).toHaveBeenCalledTimes(1)
  })

  it('retries when provided custom retryableErrorCodes set', async () => {
    const errorState: RunState = {
      sessionState: {} as any,
      output: { type: 'error', message: 'Server error (500)' },
    }
    const successState: RunState = {
      sessionState: {} as SessionState,
      output: { type: 'lastMessage', value: [assistantMessage('hi')] },
    }

    const runSpy = spyOn(runModule, 'runOnce')
      .mockResolvedValueOnce(errorState)
      .mockResolvedValueOnce(successState)

    const result = await run({
      ...baseOptions,
      retry: {
        backoffBaseMs: 1,
        backoffMaxMs: 2,
        retryableErrorCodes: new Set([ErrorCodes.SERVER_ERROR]),
      },
    })

    expect(result).toBe(successState)
    expect(runSpy).toHaveBeenCalledTimes(2)
  })

  it('returns error output on abort before first attempt', async () => {
    const controller = new AbortController()
    controller.abort('cancelled')

    const runSpy = spyOn(runModule, 'runOnce')

    const result = await run({
      ...baseOptions,
      retry: { backoffBaseMs: 1, backoffMaxMs: 2 },
      abortController: controller,
    })

    expect(result.output.type).toBe('error')
    if (result.output.type === 'error') {
      expect(result.output.message).toContain('Aborted')
    }
    expect(runSpy).toHaveBeenCalledTimes(0)
  })

  it('calls onRetry callback with correct parameters on error output', async () => {
    const errorState: RunState = {
      sessionState: {} as SessionState,
      output: { type: 'error', message: 'Service unavailable (503)' },
    }
    const successState: RunState = {
      sessionState: {} as SessionState,
      output: { type: 'lastMessage', value: [assistantMessage('done')] },
    }

    const runSpy = spyOn(runModule, 'runOnce')
      .mockResolvedValueOnce(errorState)
      .mockResolvedValueOnce(successState)

    const onRetryCalls: any[] = []
    const onRetry = async (params: any) => {
      onRetryCalls.push(params)
    }

    await run({
      ...baseOptions,
      retry: { backoffBaseMs: 1, backoffMaxMs: 2, onRetry },
    })

    expect(onRetryCalls).toHaveLength(1)
    expect(onRetryCalls[0].attempt).toBe(1)
    expect(onRetryCalls[0].delayMs).toBe(1)
    expect(onRetryCalls[0].errorCode).toBe('SERVICE_UNAVAILABLE')
  })

  it('calls onRetryExhausted after all retries fail', async () => {
    const errorState = {
      sessionState: {} as any,
      output: { type: 'error', message: 'NetworkError: timeout' },
    } as RunState

    spyOn(runModule, 'runOnce').mockResolvedValue(errorState)

    const onRetryExhaustedCalls: any[] = []
    const onRetryExhausted = async (params: any) => {
      onRetryExhaustedCalls.push(params)
    }

    await run({
      ...baseOptions,
      retry: { maxRetries: 2, backoffBaseMs: 1, onRetryExhausted },
    })

    expect(onRetryExhaustedCalls).toHaveLength(1)
    expect(onRetryExhaustedCalls[0].totalAttempts).toBe(3) // Initial + 2 retries
    expect(onRetryExhaustedCalls[0].errorCode).toBe('TIMEOUT')
  })

  it('returns error output without sessionState on first attempt failure', async () => {
    const errorState = {
      output: { type: 'error', message: 'Not retryable' },
    } as RunState

    spyOn(runModule, 'runOnce').mockResolvedValue(errorState)

    const result = await run({
      ...baseOptions,
      retry: { maxRetries: 3, backoffBaseMs: 1 },
    })

    expect(result.output.type).toBe('error')
    expect(result.sessionState).toBeUndefined()
  })

  it('preserves sessionState from previousRun on retry', async () => {
    const previousSession = { fileContext: { cwd: '/test' } } as any
    const errorState: RunState = {
      sessionState: { fileContext: { cwd: '/new' } } as SessionState,
      output: { type: 'error', message: 'Service unavailable' },
    }
    const successState: RunState = {
      sessionState: { fileContext: { cwd: '/final' } } as SessionState,
      output: { type: 'lastMessage', value: [assistantMessage('ok')] },
    }

    const runSpy = spyOn(runModule, 'runOnce')
      .mockResolvedValueOnce(errorState)
      .mockResolvedValueOnce(successState)

    const result = await run({
      ...baseOptions,
      previousRun: {
        sessionState: previousSession,
        output: { type: 'lastMessage', value: [assistantMessage('prev')] },
      },
      retry: { backoffBaseMs: 1, backoffMaxMs: 2 },
    })

    expect(result).toBe(successState)
    expect(result.sessionState?.fileContext.cwd).toBe('/final')
  })

  it('handles 503 Service Unavailable errors as retryable', async () => {
    const errorState: RunState = {
      sessionState: {} as SessionState,
      output: {
        type: 'error',
        message: 'Error from AI SDK: 503 Service Unavailable',
      },
    }
    const successState: RunState = {
      sessionState: {} as SessionState,
      output: { type: 'lastMessage', value: [assistantMessage('ok')] },
    }

    const runSpy = spyOn(runModule, 'runOnce')
      .mockResolvedValueOnce(errorState)
      .mockResolvedValueOnce(successState)

    const result = await run({
      ...baseOptions,
      retry: { backoffBaseMs: 1, maxRetries: 1 },
    })

    expect(result).toBe(successState)
    expect(runSpy).toHaveBeenCalledTimes(2)
  })

  it('applies exponential backoff correctly', async () => {
    const errorState: RunState = {
      sessionState: {} as SessionState,
      output: { type: 'error', message: 'NetworkError: Connection refused' },
    } as RunState
    const successState: RunState = {
      sessionState: {} as SessionState,
      output: { type: 'lastMessage', value: [assistantMessage('ok')] },
    }

    spyOn(runModule, 'runOnce')
      .mockResolvedValueOnce(errorState)
      .mockResolvedValueOnce(errorState)
      .mockResolvedValueOnce(successState)

    const delays: number[] = []
    const onRetry = async ({ delayMs }: any) => {
      delays.push(delayMs)
    }

    await run({
      ...baseOptions,
      retry: { maxRetries: 3, backoffBaseMs: 100, backoffMaxMs: 1000, onRetry },
    })

    expect(delays).toEqual([100, 200]) // First two retries (third succeeds, no retry callback)
  })
})
