/**
 * Live smoke: the built Freebuff binary reaches the REAL backend and completes one DeepSeek V4.1
 * Flash turn through its TUI, then ends the session so a scheduled run leaves nothing open.
 *
 * Every other file here runs offline against a binary pointed at a dead loopback port. This one
 * needs a binary built with the production public env (.github/workflows/prod-smoke.yml has the
 * values) and FREEBUFF_SMOKE_API_KEY or CODEBUFF_API_KEY; it skips without a key. The CLI gets its
 * own FREEBUFF_CONFIG_DIR, so the machine's real profile is never touched.
 */

import fs from 'fs'
import os from 'os'
import path from 'path'

import { afterEach, describe, expect, test } from 'bun:test'

import { FreebuffSession, requireFreebuffBinary } from '../utils'

const FLASH_DISPLAY_NAME = 'DeepSeek V4.1 Flash'
// Not arithmetic (Flash once answered 4187 + 2359 with 6536), and "seven" never
// appears in the echoed prompt.
const SMOKE_PROMPT =
  'Reply with only the English word for the number 7, in lowercase.'
const SMOKE_ANSWER = 'seven'

const apiKey =
  process.env.FREEBUFF_SMOKE_API_KEY || process.env.CODEBUFF_API_KEY || null
const live = apiKey ? test : test.skip

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** The backend's own view of the account's session: `none` once it has been ended. */
async function backendSessionStatus(): Promise<string> {
  const res = await fetch('https://www.codebuff.com/api/v1/freebuff/session', {
    headers: { Authorization: `Bearer ${apiKey}` },
  })
  return (
    ((await res.json()) as { status?: string }).status ?? `http ${res.status}`
  )
}

/**
 * Walk the landing picker until `name` is the focused row (drawn with the `›` cursor). The picker
 * opens collapsed on the recommended model, and a saved preference does not change that. The
 * "See all" toggle follows the rows in the navigation order and carries no cursor, so "no row has
 * the cursor" while collapsed means the toggle is focused: Enter expands in place, the toggle keeps
 * focus, and every row is above it.
 */
async function focusModelRow(
  session: FreebuffSession,
  name: string,
): Promise<void> {
  let expanded = false
  for (let step = 0; step < 16; step++) {
    const output = await session.capture()
    if (output.includes(`› ${name}`)) return
    if (!expanded && !/›\s*\S/.test(output) && output.includes('See all')) {
      await session.sendKey('Enter')
      expanded = true
      await sleep(600)
      continue
    }
    await session.sendKey(expanded ? 'Up' : 'Down')
    await sleep(300)
  }
  throw new Error(
    `Could not focus the "${name}" row.\nLast output:\n${await session.capture()}`,
  )
}

describe('Freebuff: live turn against the backend', () => {
  let session: FreebuffSession | null = null
  let configDir: string | null = null

  afterEach(async () => {
    await session?.captureLabeled('final')
    await session?.stop()
    session = null
    if (configDir) fs.rmSync(configDir, { recursive: true, force: true })
    configDir = null
  })

  live(
    `completes one ${FLASH_DISPLAY_NAME} turn through the TUI and ends the session`,
    async () => {
      configDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'freebuff-smoke-config-'),
      )
      // no first-run card between the test and the picker
      fs.writeFileSync(
        path.join(configDir, 'settings.json'),
        JSON.stringify({ freebucksIntroSeenAt: new Date().toISOString() }),
      )
      session = await FreebuffSession.start(requireFreebuffBinary(), {
        waitSeconds: 5,
        height: 50, // tall enough that the expanded picker never scrolls a row off screen
        env: { CODEBUFF_API_KEY: apiKey!, FREEBUFF_CONFIG_DIR: configDir },
      })

      const landing = await session.waitForText('Start coding for free', 90_000)
      expect(landing).not.toContain('Press ENTER to login')
      await session.waitForText('›', 30_000) // rows render once the session snapshot arrived
      await sleep(1_500)
      await focusModelRow(session, FLASH_DISPLAY_NAME)

      // Enter commits the focused row; a row that costs something asks first and commits on the
      // second Enter.
      await session.sendKey('Enter')
      const chat = await session
        .waitForText('Enter a coding task', 8_000)
        .catch(async () => {
          await session!.sendKey('Enter')
          return session!.waitForText('Enter a coding task', 120_000)
        })
      expect(chat).toContain('V4.1 Flash')

      await session.send(SMOKE_PROMPT)
      await session.waitForText(SMOKE_ANSWER, 180_000)

      // End the session the way a user does; the landing screen returns once the backend
      // confirmed the end, and the backend is then asked directly.
      await session.send('/end-session')
      await session.waitForText('Start coding for free', 60_000)
      let status = await backendSessionStatus()
      for (let i = 0; i < 15 && status !== 'none'; i++) {
        await sleep(2_000)
        status = await backendSessionStatus()
      }
      expect(status).toBe('none')
    },
    300_000,
  )
})
