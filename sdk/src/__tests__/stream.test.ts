import { describe, expect, test, mock } from 'bun:test'

import { createRunStream, RunStreamBufferOverflowError } from '../stream'

import type { CodebuffClientOptions, RunOptions } from '../run'
import type { RunState } from '../run-state'
import type { RunStream, RunStreamEvent } from '../stream'

const state: RunState = {
  traceSessionId: 'trace-stream',
  output: { type: 'lastMessage', value: [] },
}
const options = { agent: 'base', prompt: 'Hello' }

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

async function collect(stream: RunStream): Promise<RunStreamEvent[]> {
  const events: RunStreamEvent[] = []
  for await (const event of stream) events.push(event)
  return events
}

function controlledRun() {
  const started = deferred<RunOptions & CodebuffClientOptions>()
  const completed = deferred<RunState>()
  return {
    started,
    completed,
    execute: (runOptions: RunOptions & CodebuffClientOptions) => {
      started.resolve(runOptions)
      return completed.promise
    },
  }
}

describe('run streams', () => {
  test('delivers events and all chunk kinds in production order', async () => {
    const subagent = {
      type: 'subagent_chunk' as const,
      agentId: 'child',
      agentType: 'editor',
      chunk: 'Editing',
    }
    const reasoning = {
      type: 'reasoning_chunk' as const,
      agentId: 'child',
      ancestorRunIds: ['parent-run'],
      chunk: 'Thinking',
    }
    const stream = createRunStream(options, async (run) => {
      await run.handleEvent?.({ type: 'start', messageHistoryLength: 0 })
      await run.handleStreamChunk?.('Hello')
      await run.handleStreamChunk?.(subagent)
      await run.handleStreamChunk?.(reasoning)
      await run.handleEvent?.({ type: 'finish', totalCost: 0 })
      return state
    })

    expect(await collect(stream)).toEqual([
      { type: 'event', event: { type: 'start', messageHistoryLength: 0 } },
      { type: 'chunk', chunk: 'Hello' },
      { type: 'chunk', chunk: subagent },
      { type: 'chunk', chunk: reasoning },
      { type: 'event', event: { type: 'finish', totalCost: 0 } },
    ])
    expect(await stream.result).toBe(state)
  })

  test('drains buffered events after the producer has finished', async () => {
    const stream = createRunStream(options, async (run) => {
      await run.handleStreamChunk?.('one')
      await run.handleStreamChunk?.('two')
      return state
    })
    await stream.result
    expect(await collect(stream)).toEqual([
      { type: 'chunk', chunk: 'one' },
      { type: 'chunk', chunk: 'two' },
    ])
  })

  test('wakes concurrent pending reads in FIFO order', async () => {
    const run = controlledRun()
    const stream = createRunStream(options, run.execute)
    const iterator = stream[Symbol.asyncIterator]()
    const first = iterator.next()
    const second = iterator.next()
    const input = await run.started.promise
    await input.handleStreamChunk?.('one')
    await input.handleStreamChunk?.('two')
    expect((await first).value).toEqual({ type: 'chunk', chunk: 'one' })
    expect((await second).value).toEqual({ type: 'chunk', chunk: 'two' })
    const end = iterator.next()
    run.completed.resolve(state)
    expect((await end).done).toBe(true)
    await stream.result
  })

  test('completes an empty stream', async () => {
    const stream = createRunStream(options, async () => state)
    expect(await collect(stream)).toEqual([])
    expect(await stream.result).toBe(state)
  })

  test('error events and error run states remain data', async () => {
    const errorState: RunState = {
      ...state,
      output: { type: 'error', message: 'Agent failed' },
    }
    const stream = createRunStream(options, async (run) => {
      await run.handleEvent?.({ type: 'error', message: 'Agent failed' })
      return errorState
    })
    expect(await collect(stream)).toEqual([
      { type: 'event', event: { type: 'error', message: 'Agent failed' } },
    ])
    expect(await stream.result).toBe(errorState)
  })

  test('passes run options through and consumes stream-only settings', async () => {
    const execute = mock(
      async (_run: RunOptions & CodebuffClientOptions) => state,
    )
    const stream = createRunStream(
      {
        ...options,
        previousRun: state,
        maxAgentSteps: 3,
        maxBufferedEvents: 4,
      },
      execute,
    )
    await stream.result
    expect(execute).toHaveBeenCalledTimes(1)
    const input = execute.mock.calls[0][0]
    expect(input.previousRun).toBe(state)
    expect(input.maxAgentSteps).toBe(3)
    expect(input.agent).toBe('base')
    expect(input.prompt).toBe('Hello')
    expect(input).not.toHaveProperty('maxBufferedEvents')
  })

  test('starts without waiting for an iterator to be created', async () => {
    const execute = mock(async () => state)
    const stream = createRunStream(options, execute)
    expect(await stream.result).toBe(state)
    expect(execute).toHaveBeenCalledTimes(1)
  })

  test('forwards callbacks exactly once while yielding their events', async () => {
    const handleEvent = mock(async () => {})
    const handleStreamChunk = mock(() => {})
    const stream = createRunStream(
      { ...options, handleEvent, handleStreamChunk },
      async (run) => {
        await run.handleEvent?.({ type: 'start', messageHistoryLength: 0 })
        await run.handleStreamChunk?.('Hello')
        return state
      },
    )
    expect((await collect(stream)).length).toBe(2)
    await stream.result
    expect(handleEvent).toHaveBeenCalledTimes(1)
    expect(handleStreamChunk).toHaveBeenCalledTimes(1)
  })

  test('waits for callbacks that the producer did not await', async () => {
    const callback = deferred<void>()
    const entered = deferred<void>()
    let settled = false
    const stream = createRunStream(
      {
        ...options,
        handleStreamChunk: async () => {
          entered.resolve()
          await callback.promise
        },
      },
      async (run) => {
        void run.handleStreamChunk?.('Hello')
        return state
      },
    )
    void stream.result.then(() => {
      settled = true
    })
    await entered.promise
    await Promise.resolve()
    expect(settled).toBe(false)
    callback.resolve()
    expect(await stream.result).toBe(state)
    expect(settled).toBe(true)
  })

  test('aborting wakes readers, drops queued events, and preserves the run result', async () => {
    const run = controlledRun()
    const stream = createRunStream(options, run.execute)
    const input = await run.started.promise
    await input.handleStreamChunk?.('queued')
    const reason = new Error('Stop now')
    stream.abort(reason)
    stream.abort(new Error('second abort'))
    expect(input.signal?.aborted).toBe(true)
    expect(input.signal?.reason).toBe(reason)
    await input.handleStreamChunk?.('late')
    expect(await collect(stream)).toEqual([])
    run.completed.resolve(state)
    expect(await stream.result).toBe(state)
  })

  test('breaking out of for await cancels the producer', async () => {
    const run = controlledRun()
    const stream = createRunStream(options, run.execute)
    const consume = (async () => {
      for await (const _event of stream) break
    })()
    const input = await run.started.promise
    await input.handleStreamChunk?.('first')
    await consume
    expect(input.signal?.aborted).toBe(true)
    run.completed.resolve(state)
    expect(await stream.result).toBe(state)
  })

  test('aborting releases every pending reader', async () => {
    const run = controlledRun()
    const stream = createRunStream(options, run.execute)
    const iterator = stream[Symbol.asyncIterator]()
    const pending = [iterator.next(), iterator.next()]
    await run.started.promise
    stream.abort()
    expect((await Promise.all(pending)).every((item) => item.done)).toBe(true)
    run.completed.resolve(state)
    await stream.result
  })

  test('forwards an external abort and its original reason', async () => {
    const run = controlledRun()
    const controller = new AbortController()
    const stream = createRunStream(
      { ...options, signal: controller.signal },
      run.execute,
    )
    const input = await run.started.promise
    const reason = new Error('External cancellation')
    controller.abort(reason)
    expect(input.signal?.aborted).toBe(true)
    expect(input.signal?.reason).toBe(reason)
    expect(await collect(stream)).toEqual([])
    run.completed.resolve(state)
    await stream.result
  })

  test('passes a pre-aborted signal to the run without yielding events', async () => {
    const controller = new AbortController()
    controller.abort('already cancelled')
    const execute = mock(async (run: RunOptions & CodebuffClientOptions) => {
      expect(run.signal?.aborted).toBe(true)
      expect(run.signal?.reason).toBe('already cancelled')
      await run.handleStreamChunk?.('late')
      return state
    })
    const stream = createRunStream(
      { ...options, signal: controller.signal },
      execute,
    )
    expect(await collect(stream)).toEqual([])
    expect(await stream.result).toBe(state)
  })

  test('detaches the external signal after completion', async () => {
    const controller = new AbortController()
    let input: (RunOptions & CodebuffClientOptions) | undefined
    const stream = createRunStream(
      { ...options, signal: controller.signal },
      async (run) => {
        input = run
        return state
      },
    )
    await stream.result
    controller.abort()
    expect(input?.signal?.aborted).toBe(false)
  })

  test('exposes executor failures to both pending readers and result', async () => {
    const run = controlledRun()
    const stream = createRunStream(options, run.execute)
    const iterator = stream[Symbol.asyncIterator]()
    const pending = iterator.next()
    const error = new Error('Execution failed')
    run.completed.reject(error)
    await expect(pending).rejects.toBe(error)
    await expect(stream.result).rejects.toBe(error)
    await expect(iterator.next()).rejects.toBe(error)
  })

  test('handles synchronous executor exceptions', async () => {
    const error = new Error('Setup failed')
    const stream = createRunStream(options, () => {
      throw error
    })
    await expect(collect(stream)).rejects.toBe(error)
    await expect(stream.result).rejects.toBe(error)
  })

  test('preserves executor failures after cancellation', async () => {
    const run = controlledRun()
    const stream = createRunStream(options, run.execute)
    await run.started.promise
    stream.abort()
    const error = new Error('Cleanup failed')
    run.completed.reject(error)
    await expect(stream.result).rejects.toBe(error)
  })

  test.each(['event', 'chunk'] as const)(
    'preserves an in-flight %s callback failure after cancellation',
    async (kind) => {
      const run = controlledRun()
      const callback = deferred<void>()
      const stream = createRunStream(
        {
          ...options,
          handleEvent: () => callback.promise,
          handleStreamChunk: () => callback.promise,
        },
        run.execute,
      )
      const input = await run.started.promise
      const pending =
        kind === 'event'
          ? input.handleEvent?.({ type: 'start', messageHistoryLength: 0 })
          : input.handleStreamChunk?.('Hello')
      const reason = new Error('Cancelled')
      stream.abort(reason)
      run.completed.resolve(state)
      const error = new Error('Handler failed after cancellation')
      callback.reject(error)
      await pending
      await expect(stream.result).rejects.toBe(error)
      expect(input.signal?.reason).toBe(reason)
    },
  )

  test('preserves buffer overflow when the executor rejects on abort', async () => {
    const stream = createRunStream(
      { ...options, maxBufferedEvents: 1 },
      async (run) => {
        await run.handleStreamChunk?.('one')
        await run.handleStreamChunk?.('two')
        throw new Error('Executor aborted')
      },
    )
    await expect(stream.result).rejects.toBeInstanceOf(
      RunStreamBufferOverflowError,
    )
    await expect(collect(stream)).rejects.toBeInstanceOf(
      RunStreamBufferOverflowError,
    )
  })

  test.each(['event', 'chunk'] as const)(
    'cancels when a %s callback rejects',
    async (kind) => {
      const error = new Error('Handler failed')
      let signal: AbortSignal | undefined
      const fail = async () => {
        throw error
      }
      const stream = createRunStream(
        { ...options, handleEvent: fail, handleStreamChunk: fail },
        async (run) => {
          signal = run.signal
          if (kind === 'event')
            await run.handleEvent?.({ type: 'start', messageHistoryLength: 0 })
          else await run.handleStreamChunk?.('Hello')
          return state
        },
      )
      await expect(collect(stream)).rejects.toBe(error)
      await expect(stream.result).rejects.toBe(error)
      expect(signal?.aborted).toBe(true)
    },
  )

  test('treats a callback throwing undefined as a failure', async () => {
    const stream = createRunStream(
      {
        ...options,
        handleEvent: () => {
          throw undefined
        },
      },
      async (run) => {
        await run.handleEvent?.({ type: 'start', messageHistoryLength: 0 })
        return state
      },
    )
    const errors: unknown[] = []
    await collect(stream).catch((error) => {
      errors.push(error)
    })
    await stream.result.catch((error) => {
      errors.push(error)
    })
    expect(errors).toEqual([undefined, undefined])
  })

  test('cancels and reports buffer overflow without silently dropping events', async () => {
    let signal: AbortSignal | undefined
    const stream = createRunStream(
      { ...options, maxBufferedEvents: 2 },
      async (run) => {
        signal = run.signal
        await run.handleStreamChunk?.('one')
        await run.handleStreamChunk?.('two')
        await run.handleStreamChunk?.('three')
        return state
      },
    )
    await expect(stream.result).rejects.toBeInstanceOf(
      RunStreamBufferOverflowError,
    )
    await expect(collect(stream)).rejects.toBeInstanceOf(
      RunStreamBufferOverflowError,
    )
    expect(signal?.aborted).toBe(true)
    expect(
      (signal?.reason as RunStreamBufferOverflowError).maxBufferedEvents,
    ).toBe(2)
  })

  test('uses a bounded default buffer', async () => {
    const stream = createRunStream(options, async (run) => {
      for (let i = 0; i <= 1_024; i++) await run.handleStreamChunk?.('delta')
      return state
    })
    await expect(stream.result).rejects.toBeInstanceOf(
      RunStreamBufferOverflowError,
    )
  })

  test('consuming events frees buffer capacity', async () => {
    const stream = createRunStream(
      { ...options, maxBufferedEvents: 1 },
      async (run) => {
        for (let i = 0; i < 20; i++) await run.handleStreamChunk?.(`delta-${i}`)
        return state
      },
    )
    expect((await collect(stream)).length).toBe(20)
    expect(await stream.result).toBe(state)
  })

  test.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid buffer capacity %s before starting a run',
    (maxBufferedEvents) => {
      const execute = mock(async () => state)
      expect(() =>
        createRunStream({ ...options, maxBufferedEvents }, execute),
      ).toThrow(RangeError)
      expect(execute).not.toHaveBeenCalled()
    },
  )

  test('rejects a second consumer', async () => {
    const stream = createRunStream(options, async () => state)
    stream[Symbol.asyncIterator]()
    expect(() => stream[Symbol.asyncIterator]()).toThrow(
      'only be consumed once',
    )
    await stream.result
  })

  test('iterator.throw cancels the run and propagates the consumer error', async () => {
    const run = controlledRun()
    const stream = createRunStream(options, run.execute)
    const iterator = stream[Symbol.asyncIterator]()
    const input = await run.started.promise
    const error = new Error('Consumer failed')
    await expect(iterator.throw!(error)).rejects.toBe(error)
    expect(input.signal?.reason).toBe(error)
    run.completed.resolve(state)
    await stream.result
  })

  test('return closes an iterator even when completion left buffered events', async () => {
    const stream = createRunStream(options, async (run) => {
      await run.handleStreamChunk?.('queued')
      return state
    })
    await stream.result
    const iterator = stream[Symbol.asyncIterator]()
    expect((await iterator.return!()).done).toBe(true)
    expect((await iterator.next()).done).toBe(true)
    expect(await stream.result).toBe(state)
  })
})
