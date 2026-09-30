import fs from 'fs'
import os from 'os'
import path from 'path'

import { ByokCredentialError, createBunByokConnectionStore } from '@codebuff/sdk'
import { afterEach, describe, expect, mock, test } from 'bun:test'

import { handleByokCommand } from '../byok'
import {
  byokLoadFailureMessage,
  resetCliByokStoreForTests,
  setCliByokStoreForTests,
} from '../../utils/byok'

import type { RouterParams } from '../command-registry'

// The user writeup (2026-09-30): OmniRoute on http://localhost:20128/v1 with
// its key in OMNIROUTE_API_KEY, exported AFTER Freebuff started.
const ADD =
  'add omniroute openai-compatible mistral/codestral-latest OMNIROUTE_API_KEY http://localhost:20128/v1'
const SYNTHETIC_KEY = 'synthetic-omniroute-key-canary'

const directories: string[] = []
afterEach(() => {
  resetCliByokStoreForTests()
  for (const dir of directories.splice(0))
    fs.rmSync(dir, { recursive: true, force: true })
})

function useStore(
  environment: Record<string, string | undefined>,
  fetch?: typeof globalThis.fetch,
) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'freebuff-byok-cred-'))
  directories.push(directory)
  const store = createBunByokConnectionStore({
    directory,
    environment: environment as NodeJS.ProcessEnv,
    fetch,
  })
  setCliByokStoreForTests(store)
  return store
}

function run(args: string) {
  const messages: string[] = []
  const params = {
    inputValue: `/byok ${args}`,
    setMessages: (updater: (messages: never[]) => Array<{ content?: string }>) => {
      messages.push(...updater([]).map((message) => message.content ?? ''))
    },
    saveToHistory: () => {},
    setInputValue: mock(() => {}),
    clearMessages: mock(() => {}),
  } as unknown as RouterParams
  return handleByokCommand(params, args).then(() => messages.join('\n'))
}

describe('/byok with an environment-variable key', () => {
  test('add with the variable unset saves the connection and says exactly what to fix', async () => {
    const store = useStore({})

    const added = await run(ADD)

    expect(added).toContain('Saved omniroute (OpenAI-compatible · mistral/codestral-latest)')
    expect(added).toContain(
      'OMNIROUTE_API_KEY is not set in this Freebuff process. Set it and restart Freebuff from that terminal.',
    )
    expect(added).toContain('/byok validate omniroute')
    expect(added).not.toContain('BYOK error')
    expect(await store.list()).toHaveLength(1)

    // validate and select give the same precise reason instead of throwing.
    expect(await run('validate omniroute')).toContain('OMNIROUTE_API_KEY is not set')
    expect(await run('select omniroute')).toContain('OMNIROUTE_API_KEY is not set')
  })

  test('a set key the proxy refuses reports the 401 and never prints the key', async () => {
    useStore({ OMNIROUTE_API_KEY: SYNTHETIC_KEY }, (async () =>
      new Response(`denied ${SYNTHETIC_KEY}`, { status: 401 })) as unknown as typeof fetch)

    const added = await run(ADD)

    expect(added).toContain('The provider rejected the key in OMNIROUTE_API_KEY (HTTP 401)')
    expect(added).not.toContain('is not set')
    expect(added).not.toContain(SYNTHETIC_KEY)
  })

  test('a run start shows the credential reason, and only a credential reason', () => {
    expect(
      byokLoadFailureMessage(
        new ByokCredentialError(
          'OMNIROUTE_API_KEY is not set in this Freebuff process. Set it and restart Freebuff from that terminal.',
        ),
      ),
    ).toBe(
      '⚠️ Unable to load the selected BYOK connection: OMNIROUTE_API_KEY is not set in this Freebuff process. Set it and restart Freebuff from that terminal.',
    )
    // Arbitrary errors may carry anything; they keep the fixed line.
    expect(byokLoadFailureMessage(new Error(`boom ${SYNTHETIC_KEY}`))).toBe(
      '⚠️ Unable to load the selected BYOK connection. Check its credential and select it again.',
    )
  })
})
