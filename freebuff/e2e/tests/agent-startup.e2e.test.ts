import { afterEach, describe, expect, test } from 'bun:test'

import { FreebuffSession, requireFreebuffBinary } from '../utils'

const TEST_TIMEOUT = 60_000

describe('Freebuff: Agent startup smoke', () => {
  let session: FreebuffSession | null = null

  afterEach(async () => {
    if (session) {
      await session.stop()
      session = null
    }
  })

  test(
    'starts the CLI and renders visible output',
    async () => {
      const binary = requireFreebuffBinary()
      session = await FreebuffSession.start(binary)

      const output = await session.waitForBootSignal()

      expect(output.trim().length).toBeGreaterThan(0)
      expect(output).not.toContain('Fatal error during startup')
      expect(output).not.toContain('FATAL')
      expect(output).not.toContain('panic')
      expect(output).not.toContain('Segmentation fault')
    },
    TEST_TIMEOUT,
  )

  test(
    'can open help from the running CLI when chat input is available',
    async () => {
      const binary = requireFreebuffBinary()
      session = await FreebuffSession.start(binary)
      await session.waitForReady()

      const initialOutput = await session.capture()
      if (!initialOutput.includes('Enter a coding task')) {
        console.log(
          'Skipping /help assertion: Freebuff is not on the chat input screen.',
        )
        return
      }

      await session.sendKey('C-u')
      for (const key of ['/', 'h', 'e', 'l', 'p']) {
        await session.sendKey(key)
      }
      await session.waitForText('/help', 10_000)
      await session.sendKey('Enter')

      const output = await session.waitForText('Keyboard shortcuts', 10_000)
      expect(output).toMatch(/shortcut|ctrl|esc/i)
    },
    TEST_TIMEOUT,
  )
})
