import {
  FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID,
  FREEBUFF_MIMO_V25_MODEL_ID,
} from '@codebuff/common/constants/freebuff-models'
import { createTestRenderer } from '@opentui/core/testing'
import { createRoot, flushSync } from '@opentui/react'
import { describe, expect, test } from 'bun:test'
import React from 'react'

import { useFreebuffChatStore } from '../../state/freebuff-chat-store'
import { useFreebuffModelStore } from '../../state/freebuff-model-store'
import { useFreebuffSessionStore } from '../../state/freebuff-session-store'
import {
  freebuffChatAdmissionMayStart,
  useFreebuffChatAdmission,
} from '../use-freebuff-chat-admission'

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

test('a send before the first session response runs the default it resolved', async () => {
  // The send captured the launch seed (MiMo); the response moved the selection
  // to Flash. `freebucks: null` stops admission at confirm, before the network.
  useFreebuffModelStore.setState({
    hasExplicitPick: false,
    selectedModel: FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID,
  })
  useFreebuffSessionStore.getState().setSession({
    status: 'none',
    accessTier: 'full',
    freebucks: null,
  } as never)
  useFreebuffChatStore.setState({
    admission: {
      phase: 'requested',
      model: FREEBUFF_MIMO_V25_MODEL_ID,
      metadataChecked: true,
    },
  })
  const setup = await createTestRenderer({ width: 20, height: 2 })
  const root = createRoot(setup.renderer)
  const Harness = () => {
    useFreebuffChatAdmission(true)
    return React.createElement('text', null, 'x')
  }
  flushSync(() => root.render(React.createElement(Harness)))
  await setup.renderOnce()
  expect(useFreebuffChatStore.getState().admission).toMatchObject({
    phase: 'confirm',
    model: FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID,
  })
  flushSync(() => root.unmount())
  setup.renderer.destroy()
})
