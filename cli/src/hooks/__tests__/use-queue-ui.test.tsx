import { describe, expect, test } from 'bun:test'
import { createTestRenderer } from '@opentui/core/testing'
import { createRoot, flushSync } from '@opentui/react'
import React from 'react'

import { useQueueUi } from '../use-queue-ui'

import type { QueuedMessage } from '../use-message-queue'

const message = (content: string): QueuedMessage => ({
  id: content,
  content,
  attachments: [],
})

/** Renders the hook's title so the branches can be read off one string. */
const titleFor = async (params: {
  queuePaused: boolean
  queuedMessages: QueuedMessage[]
  terminalWidth: number
}) => {
  let title: string | undefined
  const Harness = () => {
    title = useQueueUi({ ...params, separatorWidth: params.terminalWidth })
      .inputBoxTitle
    return <text>x</text>
  }

  const setup = await createTestRenderer({ width: 20, height: 2 })
  const root = createRoot(setup.renderer)
  flushSync(() => root.render(<Harness />))
  await setup.renderOnce()
  flushSync(() => root.unmount())
  setup.renderer.destroy()
  return title
}

describe('useQueueUi inputBoxTitle', () => {
  test('is absent with an empty queue', async () => {
    expect(
      await titleFor({
        queuePaused: false,
        queuedMessages: [],
        terminalWidth: 100,
      }),
    ).toBeUndefined()
  })

  test('previews the latest queued message and advertises mouse expansion', async () => {
    const title = await titleFor({
      queuePaused: false,
      queuedMessages: [message('first task'), message('second task')],
      terminalWidth: 100,
    })

    expect(title).toContain('second task')
    expect(title).toContain('(+ 1)')
    expect(title).toContain('▸')
    expect(title).toContain('click to expand')
  })

  test('drops the hint on a narrow terminal rather than crowd the preview', async () => {
    const title = await titleFor({
      queuePaused: false,
      queuedMessages: [message('first task')],
      terminalWidth: 70,
    })

    expect(title).toContain('first task')
    expect(title).not.toContain('click to expand')
  })

  test('a paused queue says so, and is still editable', async () => {
    const title = await titleFor({
      queuePaused: true,
      queuedMessages: [message('first task')],
      terminalWidth: 100,
    })

    expect(title).toContain('⏸ 1 message queued')
    expect(title).toContain('click to expand')
  })
})

/** Renders the hook's composer placeholder for the given run/queue state. */
const placeholderFor = async (params: {
  queuePaused?: boolean
  queuedMessages?: QueuedMessage[]
  terminalWidth?: number
  steersRun?: boolean
}) => {
  let placeholder: string | undefined
  const terminalWidth = params.terminalWidth ?? 100
  const Harness = () => {
    placeholder = useQueueUi({
      queuePaused: params.queuePaused ?? false,
      queuedMessages: params.queuedMessages ?? [],
      separatorWidth: terminalWidth,
      terminalWidth,
      steersRun: params.steersRun,
    }).inputPlaceholder
    return <text>x</text>
  }

  const setup = await createTestRenderer({ width: 20, height: 2 })
  const root = createRoot(setup.renderer)
  flushSync(() => root.render(<Harness />))
  await setup.renderOnce()
  flushSync(() => root.unmount())
  setup.renderer.destroy()
  return placeholder
}

describe('useQueueUi inputPlaceholder', () => {
  test('idle: the ordinary prompt', async () => {
    expect(await placeholderFor({})).toBe(
      'Enter a coding task or / for commands',
    )
  })

  test('mid-run: says Enter adds to the current task', async () => {
    expect(await placeholderFor({ steersRun: true })).toBe(
      'Add to the current task (/ for commands)',
    )
    expect(await placeholderFor({ steersRun: true, terminalWidth: 50 })).toBe(
      'Add to the current task',
    )
  })

  test('mid-run with messages queued: no hint, since the next one queues too', async () => {
    expect(
      await placeholderFor({
        steersRun: true,
        queuedMessages: [message('first task')],
      }),
    ).toBe('Enter a coding task or / for commands')
  })

  test('a paused queue keeps its cancel hint', async () => {
    expect(
      await placeholderFor({
        steersRun: true,
        queuePaused: true,
        queuedMessages: [message('first task')],
      }),
    ).toBe('Ctrl-C to cancel queued messages')
  })
})
