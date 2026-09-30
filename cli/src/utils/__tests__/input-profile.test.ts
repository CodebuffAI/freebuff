import { beforeEach, describe, expect, test } from 'bun:test'

import {
  encodeInputProfile,
  InputProfileCounter,
  recordPastedInput,
  recordTypedInput,
  resetInputProfileForTest,
  sealInputProfile,
  takeInputProfile,
  withPasteCount,
} from '../input-profile'

describe('InputProfileCounter', () => {
  test('human-paced typing', () => {
    const counter = new InputProfileCounter()
    // 40 characters, one every 150ms (~6.7 cps).
    for (let i = 0; i < 40; i++) counter.recordTyped('a', 1_000 + i * 150)
    const profile = counter.snapshot(1_000 + 39 * 150 + 500)
    expect(profile.typedChars).toBe(40)
    expect(profile.keypressEvents).toBe(40)
    expect(profile.multiCharKeypressEvents).toBe(0)
    expect(profile.pastedChars).toBe(0)
    expect(profile.composeMs).toBe(39 * 150 + 500)
    // Characters at 0, 150, …, 900ms of any window: 7 fit in one second.
    expect(profile.maxTypedCharsPerSecond).toBe(7)
  })

  test('a paste counts as a paste, not typing', () => {
    const counter = new InputProfileCounter()
    counter.recordPaste(5_000, 100)
    counter.recordTyped('\n', 200)
    const profile = counter.snapshot(300)
    expect(profile.pastedChars).toBe(5_000)
    expect(profile.pasteEvents).toBe(1)
    expect(profile.typedChars).toBe(1)
    expect(profile.maxTypedCharsPerSecond).toBe(1)
    expect(profile.composeMs).toBe(200)
  })

  test('a machine-speed write reads as a burst', () => {
    const counter = new InputProfileCounter()
    // 500 characters as individual key events in the same millisecond.
    for (let i = 0; i < 500; i++) counter.recordTyped('x', 5_000)
    // Plus one multi-character chunk.
    counter.recordTyped('hello world', 5_001)
    const profile = counter.snapshot(5_002)
    expect(profile.typedChars).toBe(511)
    expect(profile.keypressEvents).toBe(501)
    expect(profile.multiCharKeypressEvents).toBe(1)
    expect(profile.maxTypedCharsPerSecond).toBe(511)
    expect(profile.composeMs).toBe(2)
  })

  test('the window slides: old characters stop counting', () => {
    const counter = new InputProfileCounter()
    for (let i = 0; i < 30; i++) counter.recordTyped('a', 0)
    for (let i = 0; i < 5; i++) counter.recordTyped('b', 1_000 + i)
    expect(counter.snapshot(2_000).maxTypedCharsPerSecond).toBe(30)
  })

  test('no input has no compose time', () => {
    const profile = new InputProfileCounter().snapshot(10)
    expect(profile.composeMs).toBeNull()
    expect(encodeInputProfile(profile)).toBe(
      'v1;tc=0;ke=0;mc=0;pc=0;pe=0;cps=0',
    )
  })
})

describe('seal and take', () => {
  beforeEach(() => resetInputProfileForTest())

  test('counts reset per prompt and are taken once', () => {
    recordTypedInput('h', 0)
    recordTypedInput('i', 100)
    sealInputProfile('  hi  ', 400)
    recordTypedInput('x', 500)
    sealInputProfile('second', 600)

    expect(takeInputProfile('hi')).toBe(
      'v1;tc=2;ke=2;mc=0;pc=0;pe=0;ms=400;cps=2',
    )
    expect(takeInputProfile('hi')).toBeUndefined()
    expect(takeInputProfile('second')).toBe(
      'v1;tc=1;ke=1;mc=0;pc=0;pe=0;ms=100;cps=1',
    )
  })

  test('the encoded profile never contains the text', () => {
    recordTypedInput('secret', 0)
    recordPastedInput('also secret', 10)
    sealInputProfile('secretalso secret', 20)
    const encoded = takeInputProfile('secretalso secret')!
    expect(encoded).not.toContain('secret')
    expect(encoded).toContain('pc=11')
  })

  test('a prompt that did not come from the composer has no profile', () => {
    expect(takeInputProfile('suggested prompt')).toBeUndefined()
  })

  test('withPasteCount counts before handing the paste on', () => {
    const seen: Array<string | undefined> = []
    const handler = withPasteCount((text) => seen.push(text))
    handler('pasted')
    handler(undefined)
    expect(seen).toEqual(['pasted', undefined])
    sealInputProfile('pasted')
    expect(takeInputProfile('pasted')).toContain('pe=2;')
  })
})
