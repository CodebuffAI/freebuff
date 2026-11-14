import { describe, expect, test } from 'bun:test'
import { createTestRenderer } from '@opentui/core/testing'
import { createRoot, flushSync } from '@opentui/react'
import React from 'react'

import { useMessageQueue } from '../use-message-queue'

/**
 * Mounts the queue with the stream held busy, so nothing drains and the tests
 * can act on a queue that stays put — the state the queue editor works in.
 */
async function mountBusyQueue() {
  const isChainInProgressRef = { current: true }
  const activeAgentStreamsRef = { current: 0 }
  const sent: Array<{ content: string; attachments: unknown[] }> = []
  let queue: ReturnType<typeof useMessageQueue> | undefined

  const Harness = () => {
    queue = useMessageQueue(
      async (message) => {
        sent.push({
          content: message.content,
          attachments: message.attachments,
        })
      },
      isChainInProgressRef,
      activeAgentStreamsRef,
    )
    return <text>{String(queue.queuedMessages.length)}</text>
  }

  const setup = await createTestRenderer({ width: 20, height: 2 })
  const root = createRoot(setup.renderer)
  flushSync(() => root.render(<Harness />))
  await setup.renderOnce()

  const act = async (fn: () => void) => {
    flushSync(fn)
    await setup.renderOnce()
    await new Promise((resolve) => setTimeout(resolve, 10))
    await setup.renderOnce()
  }

  return {
    get queue() {
      return queue!
    },
    contents: () => queue!.queuedMessages.map((message) => message.content),
    /** What the agent was actually handed, in the order it was handed over. */
    sent: () => sent,
    act,
    /** The in-flight run finishes, so the queue is free to drain. */
    async finishRun() {
      await act(() => {
        isChainInProgressRef.current = false
        queue!.setCanProcessQueue(false)
      })
      await act(() => queue!.setCanProcessQueue(true))
      for (let pass = 0; pass < 5; pass++) await act(() => {})
    },
    dispose() {
      flushSync(() => root.unmount())
      setup.renderer.destroy()
    },
  }
}

describe('queue editing', () => {
  test('edits, deletes, and reorders queued messages by id', async () => {
    const harness = await mountBusyQueue()
    try {
      await harness.act(() => {
        harness.queue.addToQueue('one')
        harness.queue.addToQueue('two')
        harness.queue.addToQueue('three')
      })
      expect(harness.contents()).toEqual(['one', 'two', 'three'])

      const ids = harness.queue.queuedMessages.map((message) => message.id)
      expect(new Set(ids).size).toBe(3)

      await harness.act(() => {
        expect(harness.queue.editQueuedMessage(ids[1]!, 'two (edited)')).toBe(
          true,
        )
      })
      expect(harness.contents()).toEqual(['one', 'two (edited)', 'three'])

      // Moving keeps the id, so the caller's selection survives the reorder.
      await harness.act(() => {
        expect(harness.queue.moveQueuedMessage(ids[2]!, 0)).toBe(true)
      })
      expect(harness.contents()).toEqual(['three', 'one', 'two (edited)'])
      expect(harness.queue.queuedMessages[0]!.id).toBe(ids[2]!)

      await harness.act(() => {
        expect(harness.queue.removeQueuedMessage(ids[0]!)).toBe(true)
      })
      expect(harness.contents()).toEqual(['three', 'two (edited)'])
    } finally {
      harness.dispose()
    }
  })

  test('a move past either end clamps instead of dropping the message', async () => {
    const harness = await mountBusyQueue()
    try {
      await harness.act(() => {
        harness.queue.addToQueue('one')
        harness.queue.addToQueue('two')
      })
      const ids = harness.queue.queuedMessages.map((message) => message.id)

      await harness.act(() => {
        expect(harness.queue.moveQueuedMessage(ids[0]!, -3)).toBe(false)
      })
      expect(harness.contents()).toEqual(['one', 'two'])

      await harness.act(() => {
        expect(harness.queue.moveQueuedMessage(ids[0]!, 99)).toBe(true)
      })
      expect(harness.contents()).toEqual(['two', 'one'])
    } finally {
      harness.dispose()
    }
  })

  test('editing a message that is no longer queued reports failure', async () => {
    const harness = await mountBusyQueue()
    try {
      await harness.act(() => harness.queue.addToQueue('one'))
      const [id] = harness.queue.queuedMessages.map((message) => message.id)

      await harness.act(() => {
        harness.queue.clearQueue()
      })

      await harness.act(() => {
        expect(harness.queue.editQueuedMessage(id!, 'too late')).toBe(false)
        expect(harness.queue.removeQueuedMessage(id!)).toBe(false)
        expect(harness.queue.moveQueuedMessage(id!, 0)).toBe(false)
      })
      expect(harness.contents()).toEqual([])
    } finally {
      harness.dispose()
    }
  })

  test('the agent is handed the edited queue, not the original', async () => {
    const harness = await mountBusyQueue()
    try {
      await harness.act(() => {
        harness.queue.addToQueue('one')
        harness.queue.addToQueue('two', [{ kind: 'image' } as never])
        harness.queue.addToQueue('three')
      })
      // Nothing may drain while the run that caused the queuing is in flight.
      expect(harness.sent()).toEqual([])

      const ids = harness.queue.queuedMessages.map((message) => message.id)
      await harness.act(() => {
        harness.queue.editQueuedMessage(ids[1]!, 'two (edited)')
        harness.queue.moveQueuedMessage(ids[2]!, 0)
        harness.queue.removeQueuedMessage(ids[0]!)
      })
      expect(harness.sent()).toEqual([])

      await harness.finishRun()

      // The whole point of the feature: what the user rewrote is what runs,
      // in the order they put it in, without the message they deleted.
      expect(harness.sent().map((send) => send.content)).toEqual([
        'three',
        'two (edited)',
      ])
      // Editing the text leaves the message's attachments alone.
      expect(harness.sent()[1]!.attachments).toEqual([{ kind: 'image' }])
      expect(harness.contents()).toEqual([])
    } finally {
      harness.dispose()
    }
  })

  test('a message put back at the head is addressable like any other', async () => {
    const harness = await mountBusyQueue()
    try {
      await harness.act(() => harness.queue.addToQueue('one'))

      // An aborted send returns its message without an id; the queue mints one
      // so the editor can still act on the row.
      await harness.act(() => {
        harness.queue.addToQueueFront({ content: 'zero', attachments: [] })
      })
      expect(harness.contents()).toEqual(['zero', 'one'])

      const [restoredId] = harness.queue.queuedMessages.map(
        (message) => message.id,
      )
      expect(restoredId).toBeTruthy()

      await harness.act(() => {
        expect(harness.queue.removeQueuedMessage(restoredId!)).toBe(true)
      })
      expect(harness.contents()).toEqual(['one'])
    } finally {
      harness.dispose()
    }
  })

  test('copies of a refused message are dropped; everything else still runs', async () => {
    const harness = await mountBusyQueue()
    try {
      await harness.act(() => {
        harness.queue.addToQueue('refused text')
        harness.queue.addToQueue('something else')
        harness.queue.addToQueue('  refused text\n')
        harness.queue.addToQueue('refused text')
      })

      await harness.act(() => {
        expect(harness.queue.dropQueuedCopies('refused text')).toBe(3)
        expect(harness.queue.dropQueuedCopies('refused text')).toBe(0)
      })
      expect(harness.contents()).toEqual(['something else'])

      await harness.finishRun()
      expect(harness.sent().map((send) => send.content)).toEqual([
        'something else',
      ])
    } finally {
      harness.dispose()
    }
  })
})
