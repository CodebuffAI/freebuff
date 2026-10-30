import { describe, expect, test, beforeEach, afterEach } from 'bun:test'

import {
  createMessageUpdater,
  createBatchedMessageUpdater,
  DEFAULT_FLUSH_INTERVAL_MS,
} from '../message-updater'

import type { ChatMessage, ContentBlock, TextContentBlock } from '../../types/chat'

// Type for metadata with runState for testing
interface TestMessageMetadata {
  bashCwd?: string
  runState?: { id: string }
}

const baseMessages: ChatMessage[] = [
  {
    id: 'ai-1',
    variant: 'ai',
    content: '',
    blocks: [],
    timestamp: 'now',
  },
  {
    id: 'user-1',
    variant: 'user',
    content: 'hi',
    timestamp: 'now',
  },
]

describe('createMessageUpdater', () => {
  test('updates only the targeted AI message', () => {
    let state = [...baseMessages]
    const updater = createMessageUpdater('ai-1', (fn) => {
      state = fn(state)
    })

    updater.updateAiMessage((msg) => ({ ...msg, content: 'updated' }))

    expect(state[0].content).toBe('updated')
    expect(state[1].content).toBe('hi')
  })

  test('adds blocks and marks complete with metadata merge', () => {
    let state = [...baseMessages]

    const updater = createMessageUpdater('ai-1', (fn) => {
      state = fn(state)
    })

    const block: ContentBlock = { type: 'text', content: 'hello' }
    updater.addBlock(block)
    updater.markComplete({ metadata: { runState: { id: 'run-1' } } })

    expect(state[0].blocks?.[0]).toEqual(block)
    expect(state[0].isComplete).toBe(true)
    expect((state[0].metadata as TestMessageMetadata).runState).toEqual({ id: 'run-1' })
  })

  test('setError preserves content and blocks, sets userError, and marks complete', () => {
    let state: ChatMessage[] = [
      {
        id: 'ai-1',
        variant: 'ai',
        content: 'original content',
        blocks: [{ type: 'text', content: 'existing block' }],
        timestamp: 'now',
      },
    ]

    const updater = createMessageUpdater('ai-1', (fn) => {
      state = fn(state)
    })

    updater.setError('boom')

    // setError stores error in userError field, preserving content
    expect(state[0].content).toBe('original content')
    expect(state[0].userError).toBe('boom')
    expect(state[0].isComplete).toBe(true)
    expect(state[0].blocks).toHaveLength(1)
    expect((state[0].blocks![0] as TextContentBlock).content).toBe('existing block')
  })

  test('clearUserError removes userError field from message', () => {
    let state: ChatMessage[] = [
      {
        id: 'ai-1',
        variant: 'ai',
        content: 'original content',
        userError: 'previous error',
        timestamp: 'now',
      },
    ]

    const updater = createMessageUpdater('ai-1', (fn) => {
      state = fn(state)
    })

    updater.clearUserError()

    expect(state[0].content).toBe('original content')
    expect(state[0].userError).toBeUndefined()
  })

  test('clearUserError is a no-op if no userError exists', () => {
    let state: ChatMessage[] = [
      {
        id: 'ai-1',
        variant: 'ai',
        content: 'original content',
        timestamp: 'now',
      },
    ]

    const updater = createMessageUpdater('ai-1', (fn) => {
      state = fn(state)
    })

    updater.clearUserError()

    expect(state[0].content).toBe('original content')
    expect(state[0].userError).toBeUndefined()
  })
})

describe('createBatchedMessageUpdater', () => {
  test('queues updates and does not apply immediately', () => {
    let state = [...baseMessages]
    let setMessagesCallCount = 0

    const updater = createBatchedMessageUpdater(
      'ai-1',
      (fn) => {
        setMessagesCallCount++
        state = fn(state)
      },
      1000, // Long interval so it won't auto-flush during test
    )

    // Queue several updates
    updater.updateAiMessage((msg) => ({ ...msg, content: 'first' }))
    updater.updateAiMessage((msg) => ({ ...msg, content: 'second' }))
    updater.updateAiMessage((msg) => ({ ...msg, content: 'third' }))

    // State should not have changed yet
    expect(state[0].content).toBe('')
    expect(setMessagesCallCount).toBe(0)

    // Clean up
    updater.dispose()
  })

  test('flush applies all queued updates in a single setMessages call', () => {
    let state = [...baseMessages]
    let setMessagesCallCount = 0

    const updater = createBatchedMessageUpdater(
      'ai-1',
      (fn) => {
        setMessagesCallCount++
        state = fn(state)
      },
      1000,
    )

    // Queue several updates
    updater.updateAiMessage((msg) => ({ ...msg, content: 'first' }))
    updater.updateAiMessageBlocks((blocks) => [
      ...blocks,
      { type: 'text', content: 'block1' },
    ])
    updater.addBlock({ type: 'text', content: 'block2' })

    // Manually flush
    updater.flush()

    // All updates should be applied in a single call
    expect(setMessagesCallCount).toBe(1)
    expect(state[0].content).toBe('first')
    expect(state[0].blocks).toHaveLength(2)
    expect((state[0].blocks![0] as TextContentBlock).content).toBe('block1')
    expect((state[0].blocks![1] as TextContentBlock).content).toBe('block2')

    updater.dispose()
  })

  test('markComplete flushes pending updates then applies completion', () => {
    let state = [...baseMessages]
    let setMessagesCallCount = 0

    const updater = createBatchedMessageUpdater(
      'ai-1',
      (fn) => {
        setMessagesCallCount++
        state = fn(state)
      },
      1000,
    )

    // Queue an update
    updater.updateAiMessage((msg) => ({ ...msg, content: 'updated' }))

    // markComplete should flush + apply completion
    updater.markComplete({ credits: 0.5 })

    // Should have 2 calls: flush + markComplete
    expect(setMessagesCallCount).toBe(2)
    expect(state[0].content).toBe('updated')
    expect(state[0].isComplete).toBe(true)
    expect(state[0].credits).toBe(0.5)
  })

  test('setError flushes pending updates and preserves existing content and blocks', () => {
    let state: ChatMessage[] = [
      {
        id: 'ai-1',
        variant: 'ai',
        content: 'original content',
        blocks: [{ type: 'text', content: 'existing block' }],
        timestamp: 'now',
      },
    ]
    let setMessagesCallCount = 0

    const updater = createBatchedMessageUpdater(
      'ai-1',
      (fn) => {
        setMessagesCallCount++
        state = fn(state)
      },
      1000,
    )

    // Queue an update that should be flushed before applying the error
    updater.addBlock({ type: 'text', content: 'pending block' })

    updater.setError('something went wrong')

    // Should have 2 calls: flush + setError
    expect(setMessagesCallCount).toBe(2)
    // setError stores error in userError field, preserving content
    expect(state[0].content).toBe('original content')
    expect(state[0].userError).toBe('something went wrong')
    expect(state[0].isComplete).toBe(true)
    // Existing blocks are preserved and pending block was flushed
    expect(state[0].blocks).toHaveLength(2)
    expect((state[0].blocks![0] as TextContentBlock).content).toBe('existing block')
    expect((state[0].blocks![1] as TextContentBlock).content).toBe('pending block')
  })

  test('updates after dispose are applied immediately', () => {
    let state = [...baseMessages]
    let setMessagesCallCount = 0

    const updater = createBatchedMessageUpdater(
      'ai-1',
      (fn) => {
        setMessagesCallCount++
        state = fn(state)
      },
      1000,
    )

    updater.dispose()

    // Updates after dispose should apply immediately
    updater.updateAiMessage((msg) => ({ ...msg, content: 'immediate' }))

    expect(setMessagesCallCount).toBe(1)
    expect(state[0].content).toBe('immediate')
  })

  test('flush with empty queue does nothing', () => {
    let setMessagesCallCount = 0

    const updater = createBatchedMessageUpdater(
      'ai-1',
      () => {
        setMessagesCallCount++
      },
      1000,
    )

    // Flush with nothing queued
    updater.flush()

    expect(setMessagesCallCount).toBe(0)

    updater.dispose()
  })

  test('composes multiple updates in correct order', () => {
    let state = [...baseMessages]

    const updater = createBatchedMessageUpdater(
      'ai-1',
      (fn) => {
        state = fn(state)
      },
      1000,
    )

    // Queue updates that depend on order
    updater.updateAiMessage((msg) => ({ ...msg, content: 'a' }))
    updater.updateAiMessage((msg) => ({ ...msg, content: msg.content + 'b' }))
    updater.updateAiMessage((msg) => ({ ...msg, content: msg.content + 'c' }))

    updater.flush()

    // Should be composed in order
    expect(state[0].content).toBe('abc')

    updater.dispose()
  })

  test('calling dispose() multiple times is safe', () => {
    const updater = createBatchedMessageUpdater('ai-1', () => {}, 1000)

    // Should not throw when called multiple times
    updater.dispose()
    updater.dispose()
    updater.dispose()

    // Verify it's still in disposed state
    let callCount = 0
    const updater2 = createBatchedMessageUpdater(
      'ai-1',
      () => {
        callCount++
      },
      1000,
    )
    updater2.dispose()
    updater2.dispose()
    // Updates after dispose apply immediately
    updater2.updateAiMessage((msg) => msg)
    expect(callCount).toBe(1)
  })

  test('markComplete preserves existing metadata', () => {
    const messagesWithMetadata: ChatMessage[] = [
      {
        id: 'ai-1',
        variant: 'ai',
        content: '',
        timestamp: 'now',
        metadata: { bashCwd: '/existing/path' },
      },
    ]
    let state = [...messagesWithMetadata]

    const updater = createBatchedMessageUpdater(
      'ai-1',
      (fn) => {
        state = fn(state)
      },
      1000,
    )

    updater.markComplete({ metadata: { runState: { id: 'run-123' } } })

    // Both existing and new metadata should be present
    expect(state[0].metadata?.bashCwd).toBe('/existing/path')
    expect((state[0].metadata as TestMessageMetadata)?.runState).toEqual({ id: 'run-123' })
    expect(state[0].isComplete).toBe(true)
  })

  test('accepts and uses custom flush interval', () => {
    let flushCount = 0

    // Use a very short interval to verify it's respected
    const updater = createBatchedMessageUpdater(
      'ai-1',
      () => {
        flushCount++
      },
      10, // 10ms interval
    )

    // Queue an update
    updater.updateAiMessage((msg) => ({ ...msg, content: 'test' }))

    // Wait for auto-flush
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(flushCount).toBeGreaterThanOrEqual(1)
        updater.dispose()
        resolve()
      }, 50)
    })
  })

  test('flush then queue more then flush again works correctly', () => {
    let state = [...baseMessages]
    let setMessagesCallCount = 0

    const updater = createBatchedMessageUpdater(
      'ai-1',
      (fn) => {
        setMessagesCallCount++
        state = fn(state)
      },
      1000,
    )

    // First batch
    updater.updateAiMessage((msg) => ({ ...msg, content: 'first' }))
    updater.flush()

    expect(setMessagesCallCount).toBe(1)
    expect(state[0].content).toBe('first')

    // Second batch
    updater.updateAiMessage((msg) => ({ ...msg, content: 'second' }))
    updater.addBlock({ type: 'text', content: 'block' })
    updater.flush()

    expect(setMessagesCallCount).toBe(2)
    expect(state[0].content).toBe('second')
    expect(state[0].blocks).toHaveLength(1)

    updater.dispose()
  })
})

describe('createBatchedMessageUpdater timer behavior', () => {
  let originalSetInterval: typeof setInterval
  let originalClearInterval: typeof clearInterval
  let intervalCallbacks: Map<number, () => void>
  let nextIntervalId: number
  let clearedIntervals: number[]
  let createdIntervals: Array<{ id: number; ms: number }>

  beforeEach(() => {
    originalSetInterval = globalThis.setInterval
    originalClearInterval = globalThis.clearInterval
    intervalCallbacks = new Map()
    nextIntervalId = 1
    clearedIntervals = []
    createdIntervals = []

    // Mock setInterval
    globalThis.setInterval = ((callback: () => void, ms: number) => {
      const id = nextIntervalId++
      intervalCallbacks.set(id, callback)
      createdIntervals.push({ id, ms })
      return id as unknown as ReturnType<typeof setInterval>
    }) as typeof setInterval

    // Mock clearInterval
    globalThis.clearInterval = ((id: ReturnType<typeof clearInterval>) => {
      clearedIntervals.push(id as unknown as number)
      intervalCallbacks.delete(id as unknown as number)
    }) as typeof clearInterval
  })

  afterEach(() => {
    globalThis.setInterval = originalSetInterval
    globalThis.clearInterval = originalClearInterval
  })

  test('creates interval with correct flush interval', () => {
    const updater = createBatchedMessageUpdater('ai-1', () => {}, 150)

    expect(createdIntervals).toHaveLength(1)
    expect(createdIntervals[0].ms).toBe(150)

    updater.dispose()
  })

  test('uses DEFAULT_FLUSH_INTERVAL_MS when not specified', () => {
    const updater = createBatchedMessageUpdater('ai-1', () => {})

    expect(createdIntervals).toHaveLength(1)
    expect(createdIntervals[0].ms).toBe(DEFAULT_FLUSH_INTERVAL_MS)

    updater.dispose()
  })

  test('auto-flush fires via interval callback', () => {
    let state = [...baseMessages]
    let flushCount = 0

    const updater = createBatchedMessageUpdater(
      'ai-1',
      (fn) => {
        flushCount++
        state = fn(state)
      },
      100,
    )

    // Queue an update
    updater.updateAiMessage((msg) => ({ ...msg, content: 'auto-flushed' }))

    // State should not have changed yet
    expect(flushCount).toBe(0)
    expect(state[0].content).toBe('')

    // Simulate the interval firing
    const intervalId = createdIntervals[0].id
    const callback = intervalCallbacks.get(intervalId)
    expect(callback).toBeDefined()
    callback!()

    // Now the update should be applied
    expect(flushCount).toBe(1)
    expect(state[0].content).toBe('auto-flushed')

    updater.dispose()
  })

  test('dispose clears the interval', () => {
    const updater = createBatchedMessageUpdater('ai-1', () => {}, 100)

    expect(createdIntervals).toHaveLength(1)
    const intervalId = createdIntervals[0].id

    updater.dispose()

    expect(clearedIntervals).toContain(intervalId)
  })

  test('markComplete clears the interval', () => {
    let state = [...baseMessages]
    const updater = createBatchedMessageUpdater(
      'ai-1',
      (fn) => {
        state = fn(state)
      },
      100,
    )

    const intervalId = createdIntervals[0].id

    updater.markComplete()

    expect(clearedIntervals).toContain(intervalId)
  })

  test('setError clears the interval', () => {
    let state = [...baseMessages]
    const updater = createBatchedMessageUpdater(
      'ai-1',
      (fn) => {
        state = fn(state)
      },
      100,
    )

    const intervalId = createdIntervals[0].id

    updater.setError('error message')

    expect(clearedIntervals).toContain(intervalId)
  })

  test('clearUserError applies immediately (bypasses batch queue)', () => {
    let state: ChatMessage[] = [
      {
        id: 'ai-1',
        variant: 'ai',
        content: 'content',
        userError: 'previous error',
        timestamp: 'now',
      },
    ]
    let setMessagesCallCount = 0

    const updater = createBatchedMessageUpdater(
      'ai-1',
      (fn) => {
        setMessagesCallCount++
        state = fn(state)
      },
      1000, // Long interval so it won't auto-flush
    )

    // Queue an update (should NOT be applied yet)
    updater.updateAiMessage((msg) => ({ ...msg, content: 'updated' }))
    expect(setMessagesCallCount).toBe(0)
    expect(state[0].content).toBe('content')

    // clearUserError should apply immediately
    updater.clearUserError()

    // Should have 1 call from clearUserError (applied immediately)
    expect(setMessagesCallCount).toBe(1)
    expect(state[0].userError).toBeUndefined()
    // Content should still be 'content' since the queued update wasn't flushed
    expect(state[0].content).toBe('content')

    updater.dispose()
  })

  test('clearUserError is a no-op if no userError exists', () => {
    let state: ChatMessage[] = [
      {
        id: 'ai-1',
        variant: 'ai',
        content: 'content',
        timestamp: 'now',
      },
    ]
    let setMessagesCallCount = 0

    const updater = createBatchedMessageUpdater(
      'ai-1',
      (fn) => {
        setMessagesCallCount++
        state = fn(state)
      },
      1000,
    )

    updater.clearUserError()

    // Should have 1 call but message unchanged
    expect(setMessagesCallCount).toBe(1)
    expect(state[0].userError).toBeUndefined()
    expect(state[0].content).toBe('content')

    updater.dispose()
  })

  test('no stray timers after all termination methods', () => {
    // Test that each termination method properly cleans up
    const updater1 = createBatchedMessageUpdater('ai-1', () => {}, 100)
    const updater2 = createBatchedMessageUpdater('ai-2', () => {}, 100)
    const updater3 = createBatchedMessageUpdater('ai-3', () => {}, 100)

    expect(createdIntervals).toHaveLength(3)

    updater1.dispose()
    updater2.markComplete()
    updater3.setError('error')

    // All 3 intervals should be cleared
    expect(clearedIntervals).toHaveLength(3)
    expect(intervalCallbacks.size).toBe(0)
  })
})
