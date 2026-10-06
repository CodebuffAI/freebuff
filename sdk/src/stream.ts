import type { CodebuffClientOptions, RunOptions } from './run'
import type { RunState } from './run-state'
import type { PrintModeEvent } from '@codebuff/common/types/print-mode'

/** Text, subagent, or reasoning deltas emitted during an agent run. */
export type StreamChunk = Parameters<
  NonNullable<CodebuffClientOptions['handleStreamChunk']>
>[0]

export type RunStreamEvent =
  | { type: 'event'; event: PrintModeEvent }
  | { type: 'chunk'; chunk: StreamChunk }

export type RunStreamOptions = RunOptions &
  CodebuffClientOptions & {
    /** Maximum unread events, including chunks. Defaults to 1,024. */
    maxBufferedEvents?: number
  }

export interface RunStream extends AsyncIterable<RunStreamEvent> {
  /** Final run state, including partial progress after cancellation. */
  readonly result: Promise<RunState>
  /** Stop receiving events and cancel the underlying run. */
  abort(reason?: unknown): void
}

/** A consumer failed to read events before the stream's buffer filled. */
export class RunStreamBufferOverflowError extends Error {
  constructor(public readonly maxBufferedEvents: number) {
    super(
      `Run stream exceeded ${maxBufferedEvents} unread events. Consume the stream as it runs or increase maxBufferedEvents.`,
    )
    this.name = 'RunStreamBufferOverflowError'
  }
}

type RunExecutor = (
  options: RunOptions & CodebuffClientOptions,
) => Promise<RunState>

/** @internal Injecting the executor lets lifecycle tests run without a backend. */
export function createRunStream(
  options: RunStreamOptions,
  executeRun: RunExecutor,
): RunStream {
  const {
    maxBufferedEvents = 1_024,
    signal,
    handleEvent,
    handleStreamChunk,
    ...runOptions
  } = options

  if (!Number.isSafeInteger(maxBufferedEvents) || maxBufferedEvents < 1) {
    throw new RangeError('maxBufferedEvents must be a positive safe integer')
  }

  const controller = new AbortController()
  const queue: RunStreamEvent[] = []
  const readers: {
    resolve: (result: IteratorResult<RunStreamEvent>) => void
    reject: (error: unknown) => void
  }[] = []
  let closed = false
  let claimed = false
  let failure: { error: unknown } | undefined

  const close = (discard: boolean) => {
    closed = true
    if (discard) queue.length = 0
    for (const reader of readers.splice(0)) {
      if (failure) reader.reject(failure.error)
      else reader.resolve({ done: true, value: undefined })
    }
  }

  const abort = (reason?: unknown) => {
    const wasClosed = closed
    close(true)
    if (!wasClosed) controller.abort(reason)
  }

  const fail = (error: unknown) => {
    // Cancellation closes iteration, but an in-flight handler can still fail.
    if (failure) return
    failure = { error }
    close(true)
    controller.abort(error)
  }

  const push = (event: RunStreamEvent) => {
    if (closed) return
    const reader = readers.shift()
    if (reader) {
      reader.resolve({ done: false, value: event })
    } else if (queue.length < maxBufferedEvents) {
      queue.push(event)
    } else {
      fail(new RunStreamBufferOverflowError(maxBufferedEvents))
    }
  }

  // Some runtime producers do not await callback promises. Track callbacks so
  // result cannot settle before a handler has finished or reported a failure.
  const callbacks = new Set<Promise<void>>()
  const deliver = (
    event: RunStreamEvent,
    callback: () => void | Promise<void>,
  ) => {
    if (closed) return Promise.resolve()
    push(event)
    if (closed) return Promise.resolve()
    const pending = (async () => {
      try {
        await callback()
      } catch (error) {
        fail(error)
      }
    })()
    callbacks.add(pending)
    void pending.then(() => callbacks.delete(pending))
    return pending
  }

  const onAbort = () => abort(signal?.reason)
  if (signal?.aborted) onAbort()
  else signal?.addEventListener('abort', onAbort, { once: true })

  const result = Promise.resolve()
    .then(() =>
      executeRun({
        ...runOptions,
        signal: controller.signal,
        handleEvent: (event) =>
          deliver({ type: 'event', event }, () => handleEvent?.(event)),
        handleStreamChunk: (chunk) =>
          deliver({ type: 'chunk', chunk }, () => handleStreamChunk?.(chunk)),
      }),
    )
    .then(async (state) => {
      while (callbacks.size > 0) await Promise.all(callbacks)
      if (failure) throw failure.error
      return state
    })
    .catch((error: unknown) => {
      fail(error)
      throw failure ? failure.error : error
    })
    .finally(() => {
      signal?.removeEventListener('abort', onAbort)
      close(false)
    })

  // Iteration also exposes failures. A caller that only consumes events should
  // not receive an unhandled rejection for the separate result promise.
  void result.catch(() => {})

  return {
    result,
    abort,
    [Symbol.asyncIterator]() {
      if (claimed) throw new Error('A run stream can only be consumed once')
      claimed = true
      let ended = false
      return {
        next(): Promise<IteratorResult<RunStreamEvent>> {
          if (ended) return Promise.resolve({ done: true, value: undefined })
          if (failure) return Promise.reject(failure.error)
          const event = queue.shift()
          if (event) return Promise.resolve({ done: false, value: event })
          if (closed) return Promise.resolve({ done: true, value: undefined })
          return new Promise((resolve, reject) => {
            readers.push({ resolve, reject })
          })
        },
        return(): Promise<IteratorResult<RunStreamEvent>> {
          ended = true
          abort()
          return Promise.resolve({ done: true, value: undefined })
        },
        throw(error?: unknown): Promise<IteratorResult<RunStreamEvent>> {
          ended = true
          abort(error)
          return Promise.reject(error)
        },
      }
    },
  }
}
