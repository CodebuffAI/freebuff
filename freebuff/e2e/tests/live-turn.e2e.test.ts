/**
 * Live smoke: the built Freebuff binary reaches the REAL backend and completes one DeepSeek V4.1
 * Flash turn through its TUI, then ends the session so a scheduled run leaves nothing open.
 *
 * Every other file here runs offline against a binary pointed at a dead loopback port. This one
 * needs a binary built with the production public env (.github/workflows/prod-smoke.yml has the
 * values) and FREEBUFF_SMOKE_API_KEY or CODEBUFF_API_KEY; it skips without a key. The CLI gets its
 * own FREEBUFF_CONFIG_DIR, so the machine's real profile is never touched.
 *
 * The CLI is chat-first (#4170): it opens straight into chat, `/model` only records which model
 * the next send uses, and the first send admits the session (asking first when it spends).
 */

import fs from 'fs'
import os from 'os'
import path from 'path'

import { afterEach, describe, expect, test } from 'bun:test'

import {
  FREEBUFF_CHAT_READY_TEXT,
  FreebuffSession,
  requireFreebuffBinary,
} from '../utils'

const FLASH_DISPLAY_NAME = 'DeepSeek V4.1 Flash'
// Not arithmetic (Flash once answered 4187 + 2359 with 6536), and "seven" never
// appears in the echoed prompt.
const SMOKE_PROMPT =
  'Reply with only the English word for the number 7, in lowercase.'
const SMOKE_ANSWER = 'seven'

// The first-send admission box (cli/src/components/freebuff-chat-controls.tsx).
const ADMISSION_CONFIRM = 'Enter: confirm and send'
const ADMISSION_RETRY = 'Enter: retry'
const ADMISSION_TAKEOVER = 'Enter: take over'
const ADMISSION_OPEN = 'Esc: back to draft'
// The `/model` picker's key hint, shown while it holds the composer's place.
const MODEL_PICKER_OPEN = 'Enter select · Esc cancel'
// The footer under the composer: "<model>[ • <effort>] · <cwd> · /model to change · …".
const FLASH_FOOTER = new RegExp(`${FLASH_DISPLAY_NAME}( • \\w+)? · `)

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
 * Walk the `/model` picker until `name` is the focused row (drawn with the `›` cursor). The chat
 * picker opens expanded with the cursor on the saved preference; Down moves it and wraps, and a
 * collapse toggle at the end carries no cursor, so stepping forward reaches every row.
 */
async function focusModelRow(
  session: FreebuffSession,
  name: string,
): Promise<void> {
  for (let step = 0; step < 30; step++) {
    const output = await session.capture()
    if (output.includes(`› ${name}`)) return
    await session.sendKey('Down')
    await sleep(300)
  }
  throw new Error(
    `Could not focus the "${name}" row.\nLast output:\n${await session.capture()}`,
  )
}

/**
 * Send the first message and wait for `answer`. The send asks the backend for a session on the
 * chosen model; one that spends Freebucks asks first in a box that Enter confirms, and anything
 * else the box offers (retry, take over) is a failed admission.
 */
async function sendAndAwaitAnswer(
  session: FreebuffSession,
  prompt: string,
  answer: string,
  timeoutMs: number,
): Promise<void> {
  await session.send(prompt)
  const deadline = Date.now() + timeoutMs
  let confirmed = false
  while (Date.now() < deadline) {
    const { match, output } = await session.waitForAnyText(
      [answer, ADMISSION_CONFIRM, ADMISSION_RETRY, ADMISSION_TAKEOVER],
      Math.max(1, deadline - Date.now()),
    )
    if (match === answer) return
    if (match === ADMISSION_CONFIRM) {
      if (!confirmed) {
        // The question names the model it is about to admit.
        expect(output).toContain(FLASH_DISPLAY_NAME)
        await session.sendKey('Enter')
        confirmed = true
      }
      await sleep(1_000) // the box closes once the admission starts
      continue
    }
    throw new Error(
      `Session admission did not go through (${match}).\nLast output:\n${output}`,
    )
  }
  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for "${answer}".\nLast output:\n${await session.capture()}`,
  )
}

describe('Freebuff: live turn against the backend', () => {
  let session: FreebuffSession | null = null
  let configDir: string | null = null
  // set once the test has ended its own session; otherwise afterEach does it, so a failed
  // assertion does not leave an hour-long session open on the account (the first CI run did)
  let ended = false

  afterEach(async () => {
    await session?.captureLabeled('final')
    if (session && !ended) {
      // Enter in the admission box or the picker confirms/selects instead of submitting, so close
      // them first. Esc in the admission box also releases a claim still in flight and puts the
      // held message back in the composer, which Ctrl-C then clears.
      const output = await session.capture()
      if (output.includes(ADMISSION_OPEN) || output.includes(MODEL_PICKER_OPEN)) {
        await session.sendKey('Escape')
        await sleep(3_000)
        if (output.includes(ADMISSION_OPEN)) await session.sendKey('C-c')
        await sleep(500)
      }
      const after = await session.capture()
      if (!after.includes(ADMISSION_OPEN) && !after.includes(MODEL_PICKER_OPEN)) {
        await session.send('/end-session')
        for (let i = 0; i < 15; i++) {
          if ((await backendSessionStatus().catch(() => '')) === 'none') break
          await sleep(2_000)
        }
      }
    }
    await session?.stop()
    session = null
    ended = false
    if (configDir) fs.rmSync(configDir, { recursive: true, force: true })
    configDir = null
  })

  live(
    `completes one ${FLASH_DISPLAY_NAME} turn through the TUI and ends the session`,
    async () => {
      configDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'freebuff-smoke-config-'),
      )
      // no first-run card between the test and the chat
      fs.writeFileSync(
        path.join(configDir, 'settings.json'),
        JSON.stringify({ freebucksIntroSeenAt: new Date().toISOString() }),
      )
      session = await FreebuffSession.start(requireFreebuffBinary(), {
        waitSeconds: 5,
        height: 50, // tall enough that the picker shows most rows without scrolling
        env: { CODEBUFF_API_KEY: apiKey!, FREEBUFF_CONFIG_DIR: configDir },
      })

      // Nothing is admitted until the first send, and the chat header says so.
      const chat = await session.waitForText(FREEBUFF_CHAT_READY_TEXT, 90_000)
      expect(chat).not.toContain('Press ENTER to login')

      // Picking a model is a preference for the next send.
      await session.send('/model')
      await session.waitForText(MODEL_PICKER_OPEN, 30_000)
      await session.waitForText('›', 30_000) // rows render once the session snapshot arrived
      await sleep(1_500)
      await focusModelRow(session, FLASH_DISPLAY_NAME)
      await session.sendKey('Enter')

      // The picker closes and the footer under the composer names the model the send will admit.
      let footer = await session.capture()
      for (
        let i = 0;
        i < 30 && (footer.includes(MODEL_PICKER_OPEN) || !FLASH_FOOTER.test(footer));
        i++
      ) {
        await sleep(500)
        footer = await session.capture()
      }
      expect(footer).not.toContain(MODEL_PICKER_OPEN)
      expect(footer).toMatch(FLASH_FOOTER)

      await sendAndAwaitAnswer(session, SMOKE_PROMPT, SMOKE_ANSWER, 180_000)

      // End the session the way a user does, then ask the backend directly.
      await session.send('/end-session')
      await session.waitForText('Ending session.', 30_000)
      let status = await backendSessionStatus()
      for (let i = 0; i < 30 && status !== 'none'; i++) {
        await sleep(2_000)
        status = await backendSessionStatus()
      }
      expect(status).toBe('none')
      ended = true
      expect(await session.capture()).not.toContain(
        'Could not confirm the session ended',
      )
    },
    300_000,
  )
})
