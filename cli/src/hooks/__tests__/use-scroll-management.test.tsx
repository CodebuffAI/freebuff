import { createTestRenderer } from '@opentui/core/testing'
import { createRoot, flushSync } from '@opentui/react'
import { afterEach, describe, expect, test } from 'bun:test'
import React, { useRef, useState } from 'react'

import { useChatScrollbox } from '../use-scroll-management'

import type { ScrollBoxRenderable } from '@opentui/core'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

async function mountChat() {
  const setup = await createTestRenderer({ width: 80, height: 12 })
  const root = createRoot(setup.renderer)
  let controls!: ReturnType<typeof useChatScrollbox>
  let scrollbox!: ScrollBoxRenderable
  let updateMessages!: React.Dispatch<React.SetStateAction<string[]>>
  const isUserCollapsing = () => false
  const scrollAcceleration = { tick: () => 4, reset: () => {} }

  function Host() {
    const [messages, setMessages] = useState(() =>
      Array.from({ length: 100 }, (_, i) => `Line ${i}`),
    )
    updateMessages = setMessages
    const ref = useRef<ScrollBoxRenderable | null>(null)
    controls = useChatScrollbox(ref, messages, isUserCollapsing)
    return (
      <scrollbox
        ref={(value) => {
          ref.current = value
          if (value) scrollbox = value
        }}
        height={10}
        width={80}
        stickyScroll
        stickyStart="bottom"
        scrollAcceleration={scrollAcceleration}
      >
        <text content={messages.join('\n')} />
      </scrollbox>
    )
  }

  cleanups.push(() => {
    flushSync(() => root.unmount())
    setup.renderer.destroy()
  })
  // Exercise real OpenTUI layout/events throughout the animation, including
  // content updates that emit no scroll event because the position is unchanged.
  const settle = async (ms = 280) => {
    const until = Date.now() + ms
    do {
      await setup.renderOnce()
      await new Promise((resolve) => setTimeout(resolve, 10))
    } while (Date.now() < until)
  }
  flushSync(() => root.render(<Host />))
  await settle(80)
  return {
    setup,
    settle,
    get controls() {
      return controls
    },
    get scrollbox() {
      return scrollbox
    },
    get bottom() {
      return scrollbox.scrollHeight - scrollbox.viewport.height
    },
    update(addLines = 1) {
      flushSync(() =>
        updateMessages((messages) => [
          ...messages,
          ...Array.from({ length: addLines }, () => 'Streamed output'),
        ]),
      )
    },
  }
}

describe('chat scroll following', () => {
  test('PageUp stays in history across streaming updates, then PageDown resumes following', async () => {
    const chat = await mountChat()
    expect(chat.scrollbox.scrollTop).toBe(chat.bottom)
    chat.controls.scrollUp()
    await chat.settle(70)
    chat.update()
    await chat.settle()
    const historyPosition = chat.scrollbox.scrollTop
    expect(historyPosition).toBeLessThan(chat.bottom - 1)
    expect(chat.controls.isAtBottom).toBe(false)

    chat.update()
    await chat.settle(80)
    expect(chat.scrollbox.scrollTop).toBe(historyPosition)
    chat.controls.scrollDown()
    await chat.settle()
    chat.controls.scrollDown()
    await chat.settle()
    expect(chat.controls.isAtBottom).toBe(true)
    chat.update()
    await chat.settle(80)
    expect(chat.scrollbox.scrollTop).toBe(chat.bottom)
  })

  test('a no-op auto-scroll does not swallow the next mouse scroll', async () => {
    const chat = await mountChat()
    chat.update(0)
    await chat.settle(80)
    await chat.setup.mockMouse.scroll(5, 5, 'up')
    await chat.settle(20)
    const historyPosition = chat.scrollbox.scrollTop
    expect(historyPosition).toBeLessThan(chat.bottom - 1)
    expect(chat.controls.isAtBottom).toBe(false)
    chat.update()
    await chat.settle(80)
    expect(chat.scrollbox.scrollTop).toBe(historyPosition)
  })

  test('scroll to latest reaches a moving bottom and follows subsequent output', async () => {
    const chat = await mountChat()
    chat.controls.scrollUp()
    await chat.settle()
    chat.controls.scrollToLatest()
    await chat.settle(70)
    chat.update(10)
    await chat.settle()
    expect(chat.scrollbox.scrollTop).toBe(chat.bottom)
    expect(chat.controls.isAtBottom).toBe(true)
    chat.update()
    await chat.settle(80)
    expect(chat.scrollbox.scrollTop).toBe(chat.bottom)
  })

  test('mouse input interrupts a scroll-to-latest animation', async () => {
    const chat = await mountChat()
    chat.controls.scrollUp()
    await chat.settle()
    chat.controls.scrollToLatest()
    await chat.settle(40)
    await chat.setup.mockMouse.scroll(5, 5, 'up')
    const position = chat.scrollbox.scrollTop
    await chat.settle()
    expect(chat.scrollbox.scrollTop).toBe(position)
    expect(chat.controls.isAtBottom).toBe(false)
    chat.update()
    await chat.settle(80)
    expect(chat.scrollbox.scrollTop).toBe(position)
  })
})
