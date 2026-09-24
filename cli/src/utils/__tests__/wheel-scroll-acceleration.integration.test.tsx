import { createTestRenderer } from '@opentui/core/testing'
import { createRoot, flushSync } from '@opentui/react'
import { describe, expect, test } from 'bun:test'

import { wheelScrollAcceleration } from '../wheel-scroll-acceleration'

import type { ScrollBoxRenderable } from '@opentui/core'

// The unit tests pin what ConstantScrollAccel returns. They cannot show that
// the JSX prop reaches the field OpenTUI's wheel handler reads -- that path
// runs through @opentui/react's reconciler and the terminal's mouse parser,
// neither of which is ours. This drives real wheel events at a rendered
// scrollbox and watches scrollTop, so the whole chain is covered by a test
// rather than by reading the dependency's source.
//
// The line counts below are written out rather than taken from
// WHEEL_SCROLL_LINES: three is what issue #1268 asked for, and a test that
// reads the constant it is meant to pin would follow it anywhere.

const WIDTH = 40
const HEIGHT = 10
const CONTENT_LINES = 200

// Somewhere inside the scrollbox, so the renderer routes the event to it.
const CURSOR_X = 5
const CURSOR_Y = 5

// @opentui/react's own testRender helper wraps the render in React's act(),
// which the tests cannot use: they run under NODE_ENV=production, and act is
// stripped from React's production build. flushSync commits the tree just as
// synchronously, and without a dev-only import.
const renderTranscript = async (
  scrollAcceleration?: ScrollBoxRenderable['scrollAcceleration'],
) => {
  let box: ScrollBoxRenderable | null = null

  const setup = await createTestRenderer({ width: WIDTH, height: HEIGHT })
  const root = createRoot(setup.renderer)

  flushSync(() => {
    root.render(
      <scrollbox
        ref={(instance: ScrollBoxRenderable | null) => {
          box = instance
        }}
        scrollX={false}
        scrollAcceleration={scrollAcceleration}
        style={{ width: WIDTH, height: HEIGHT }}
      >
        {Array.from({ length: CONTENT_LINES }, (_, i) => (
          <text key={i}>line {i}</text>
        ))}
      </scrollbox>,
    )
  })
  await setup.flush()

  if (!box) throw new Error('scrollbox never mounted')
  return { ...setup, box: box as ScrollBoxRenderable }
}

describe('wheel scrolling the transcript', () => {
  test('one notch moves three lines', async () => {
    const { box, mockMouse, flush } = await renderTranscript(
      wheelScrollAcceleration,
    )

    const before = box.scrollTop
    await mockMouse.scroll(CURSOR_X, CURSOR_Y, 'down')
    await flush()

    expect(box.scrollTop - before).toBe(3)
  })

  test('without the prop a notch still moves one line', async () => {
    // Guards the assertion above against passing for some reason other than
    // our accelerator -- e.g. if OpenTUI ever changed its own default.
    const { box, mockMouse, flush } = await renderTranscript()

    const before = box.scrollTop
    await mockMouse.scroll(CURSOR_X, CURSOR_Y, 'down')
    await flush()

    expect(box.scrollTop - before).toBe(1)
  })

  test('three notches move nine lines, not more', async () => {
    // MacOSScrollAccel would ramp across a burst like this.
    const { box, mockMouse, flush } = await renderTranscript(
      wheelScrollAcceleration,
    )

    const before = box.scrollTop
    for (let i = 0; i < 3; i++) {
      await mockMouse.scroll(CURSOR_X, CURSOR_Y, 'down')
    }
    await flush()

    expect(box.scrollTop - before).toBe(9)
  })

  test('scrolling back up moves three lines a notch too', async () => {
    const { box, mockMouse, flush } = await renderTranscript(
      wheelScrollAcceleration,
    )

    for (let i = 0; i < 5; i++) {
      await mockMouse.scroll(CURSOR_X, CURSOR_Y, 'down')
    }
    await flush()

    const before = box.scrollTop
    await mockMouse.scroll(CURSOR_X, CURSOR_Y, 'up')
    await flush()

    expect(before - box.scrollTop).toBe(3)
  })
})
