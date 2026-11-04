import { readFileSync } from 'fs'
import { join } from 'path'

import { describe, expect, test } from 'bun:test'

import {
  WHEEL_SCROLL_LINES,
  wheelScrollAcceleration,
} from '../wheel-scroll-acceleration'

const repoRoot = join(import.meta.dir, '../../../..')
const read = (relative: string) =>
  readFileSync(join(repoRoot, relative), 'utf8')

describe('wheel scroll acceleration', () => {
  test('every notch moves the same three lines', () => {
    expect(WHEEL_SCROLL_LINES).toBe(3)
    expect(wheelScrollAcceleration.tick()).toBe(3)
  })

  test('the multiplier does not ramp with scroll speed', () => {
    // OpenTUI calls tick() once per wheel event and multiplies the notch
    // delta by the result. MacOSScrollAccel ramps here; this must not, or a
    // fast flick overshoots by far more than the three lines asked for.
    const now = Date.now()
    const burst = [now, now + 1, now + 2, now + 3, now + 4].map((at) =>
      wheelScrollAcceleration.tick(at),
    )

    expect(burst).toEqual([3, 3, 3, 3, 3])
  })

  test('reset leaves the multiplier where it was', () => {
    wheelScrollAcceleration.tick()
    wheelScrollAcceleration.reset()

    expect(wheelScrollAcceleration.tick()).toBe(WHEEL_SCROLL_LINES)
  })

  test('only the chat transcript opts in', () => {
    // Three lines per notch suits a long transcript. The prompt editor is a
    // few rows tall, so the same jump would skip most of its content -- it
    // keeps OpenTUI's one-line default deliberately.
    expect(read('cli/src/chat.tsx')).toContain('wheelScrollAcceleration')
    expect(read('cli/src/components/multiline-input.tsx')).not.toContain(
      'wheelScrollAcceleration',
    )
  })
})
