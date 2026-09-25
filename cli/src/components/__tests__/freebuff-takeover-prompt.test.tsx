import { afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { createTestRenderer } from '@opentui/core/testing'
import { createRoot, flushSync } from '@opentui/react'
import React from 'react'

import { TakeoverPrompt } from '../freebuff-landing-screen'
import { initializeThemeStore } from '../../hooks/use-theme'

let cleanupRenderer: (() => void) | undefined
const originalDateNow = Date.now

beforeAll(() => {
  initializeThemeStore()
})

afterEach(() => {
  Date.now = originalDateNow
  cleanupRenderer?.()
  cleanupRenderer = undefined
})

const mountPrompt = async ({
  failure = null,
  onTakeOver = async () => {},
  message,
  onBack,
}: Partial<React.ComponentProps<typeof TakeoverPrompt>> = {}) => {
  const setup = await createTestRenderer({ width: 90, height: 12 })
  const root = createRoot(setup.renderer)
  cleanupRenderer = () => {
    flushSync(() => root.unmount())
    setup.renderer.destroy()
  }
  flushSync(() =>
    root.render(
      <TakeoverPrompt
        failure={failure}
        onTakeOver={onTakeOver}
        message={message}
        onBack={onBack}
      />,
    ),
  )
  await setup.renderOnce()
  return Object.assign(setup, {
    rerenderPrompt: async (
      next: React.ComponentProps<typeof TakeoverPrompt>,
    ) => {
      flushSync(() => root.render(<TakeoverPrompt {...next} />))
      await setup.renderOnce()
    },
  })
}

describe('TakeoverPrompt', () => {
  test('capacity copy offers a model choice without displacing the holder', async () => {
    let backs = 0
    let takeovers = 0
    const setup = await mountPrompt({
      message:
        'Your concurrent-session limit across CLI and Desktop is reached.',
      onBack: async () => {
        backs++
      },
      onTakeOver: async () => {
        takeovers++
      },
    })
    const frame = setup.captureCharFrame()
    expect(frame).toContain('CLI and Desktop')
    expect(frame).toContain('Choose model')
    expect(frame).not.toContain('Only one freebuff instance')
    setup.mockInput.pressEscape()
    // A lone ESC waits for the terminal parser's sequence timeout.
    await Bun.sleep(50)
    expect(backs).toBe(1)
    expect(takeovers).toBe(0)
  })
  test('shows retry status for a retryable timeout', async () => {
    const setup = await mountPrompt({
      failure: {
        type: 'timeout',
        message: 'runtime-specific abort message',
        retry: { attempt: 2, retryAtMs: Date.now() + 60_000 },
        outcomeUnknown: false,
      },
    })
    const frame = setup.captureCharFrame()

    expect(frame).toContain(
      'The takeover request timed out while Freebuff was busy.',
    )
    expect(frame).toContain('Retrying automatically in')
    expect(frame).toContain('(attempt 2).')
    expect(frame).toContain('Retry now')
  })

  test('allows an explicit retry after a takeover timeout with an unknown outcome', async () => {
    let calls = 0
    const setup = await mountPrompt({
      failure: {
        type: 'timeout',
        message: 'The operation timed out',
        retry: null,
        outcomeUnknown: true,
      },
      onTakeOver: async () => {
        calls++
      },
    })

    setup.mockInput.pressEnter()
    await Promise.resolve()

    const frame = setup.captureCharFrame()
    const normalizedFrame = frame.replace(/\s+/g, ' ')
    expect(calls).toBe(1)
    expect(normalizedFrame).toContain('may have succeeded')
    expect(frame).toContain('Try takeover again')
    expect(frame).not.toContain('Retrying automatically')
  })

  test('turns a 503 response into actionable copy', async () => {
    const setup = await mountPrompt({
      failure: {
        type: 'http',
        statusCode: 503,
        message: 'runtime-specific service error',
        retry: null,
        outcomeUnknown: false,
      },
    })
    const frame = setup.captureCharFrame()

    expect(frame).toContain(
      "Freebuff is busy and couldn't complete the takeover yet.",
    )
    expect(frame).not.toContain('runtime-specific service error')
  })

  test('does not render a blank message for an empty unexpected error', async () => {
    const setup = await mountPrompt({
      failure: {
        type: 'other',
        message: '',
        retry: null,
        outcomeUnknown: false,
      },
    })

    expect(setup.captureCharFrame()).toContain(
      'The takeover failed unexpectedly.',
    )
  })

  test('submits only once when Enter repeats before React rerenders', async () => {
    let calls = 0
    let finishTakeover: (() => void) | undefined
    const pendingTakeover = new Promise<void>((resolve) => {
      finishTakeover = resolve
    })
    const setup = await mountPrompt({
      onTakeOver: () => {
        calls++
        return pendingTakeover
      },
    })

    flushSync(() => {
      setup.mockInput.pressEnter()
      setup.mockInput.pressEnter()
    })
    await setup.renderOnce()

    expect(calls).toBe(1)
    expect(setup.captureCharFrame()).toContain('Taking over...')

    finishTakeover!()
    await pendingTakeover
  })

  test('lets the user retry immediately during automatic backoff', async () => {
    let calls = 0
    const setup = await mountPrompt({
      failure: {
        type: 'http',
        statusCode: 503,
        message: 'freebuff session POST failed: 503',
        retry: { attempt: 3, retryAtMs: Date.now() + 30_000 },
        outcomeUnknown: false,
      },
      onTakeOver: async () => {
        calls++
      },
    })

    setup.mockInput.pressEnter()
    await Promise.resolve()

    expect(calls).toBe(1)
    expect(setup.captureCharFrame()).toContain('Retry now')
  })

  test('starts a newly appearing retry countdown from the current time', async () => {
    let now = 1_000
    Date.now = () => now
    const setup = await mountPrompt()

    now += 60 * 60 * 1_000
    await setup.rerenderPrompt({
      failure: {
        type: 'timeout',
        message: 'request timed out',
        retry: { attempt: 2, retryAtMs: now + 30_000 },
        outcomeUnknown: false,
      },
    })

    expect(setup.captureCharFrame()).toContain('Retrying automatically in 30s')
  })

  test('allows an explicit retry when a non-timeout POST result is unknown', async () => {
    let calls = 0
    const setup = await mountPrompt({
      failure: {
        type: 'other',
        message: 'fetch failed',
        retry: null,
        outcomeUnknown: true,
      },
      onTakeOver: async () => {
        calls++
      },
    })

    setup.mockInput.pressEnter()
    await Promise.resolve()

    const frame = setup.captureCharFrame().replace(/\s+/g, ' ')
    expect(calls).toBe(1)
    expect(frame).toContain("couldn't confirm whether the takeover succeeded")
    expect(frame).toContain('Try takeover again')
  })
})
