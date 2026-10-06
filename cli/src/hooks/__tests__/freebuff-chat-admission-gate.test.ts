import { describe, expect, test } from 'bun:test'

import { freebuffChatAdmissionMayStart } from '../use-freebuff-chat-admission'

describe('freebuffChatAdmissionMayStart', () => {
  const ready = {
    chainInProgress: false,
    streamStatus: 'idle' as const,
    queuedCount: 1,
    queuePaused: false,
  }

  test('admits for an idle queue that holds a message', () => {
    expect(freebuffChatAdmissionMayStart(ready)).toBe(true)
  })

  // A paused queue sends nothing, so the hour it bought went unused and was
  // refunded five minutes later.
  test('waits while the user has paused the queue', () => {
    expect(freebuffChatAdmissionMayStart({ ...ready, queuePaused: true })).toBe(
      false,
    )
  })

  test('waits for an empty queue, a running chain or a live stream', () => {
    expect(freebuffChatAdmissionMayStart({ ...ready, queuedCount: 0 })).toBe(
      false,
    )
    expect(
      freebuffChatAdmissionMayStart({ ...ready, chainInProgress: true }),
    ).toBe(false)
    expect(
      freebuffChatAdmissionMayStart({ ...ready, streamStatus: 'streaming' }),
    ).toBe(false)
  })
})
