import fs from 'fs'
import os from 'os'
import path from 'path'

import { createBunByokConnectionStore } from '@codebuff/sdk'
import { afterEach, describe, expect, mock, test } from 'bun:test'

import { handleByokCommand } from '../byok'
import {
  resetCliByokStoreForTests,
  setCliByokStoreForTests,
} from '../../utils/byok'

import type { RouterParams } from '../command-registry'

// A connection saved without its /v1 (the user writeup, 2026-09-30: OmniRoute
// on http://localhost:20128/v1). `/byok update <name> <model> <base-url>` is
// the advertised fix, but the store refuses to carry a credential to a new
// endpoint implicitly and the CLI had no way to supply it: the update always
// failed with "Changing provider endpoints requires explicitly supplying the
// credential again".
const directories: string[] = []
afterEach(() => {
  resetCliByokStoreForTests()
  for (const dir of directories.splice(0))
    fs.rmSync(dir, { recursive: true, force: true })
})

function useStore() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'freebuff-byok-update-'))
  directories.push(directory)
  const store = createBunByokConnectionStore({
    directory,
    environment: { OMNIROUTE_API_KEY: 'synthetic-key' } as NodeJS.ProcessEnv,
    fetch: (async () => Response.json({ data: [] })) as unknown as typeof fetch,
  })
  setCliByokStoreForTests(store)
  return store
}

async function run(args: string) {
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
  await handleByokCommand(params, args)
  return messages.join('\n')
}

describe('/byok update to a new base URL', () => {
  test('asks for the key variable by name, then moves the connection', async () => {
    const store = useStore()
    await run('add omniroute openai-compatible mistral/codestral-latest OMNIROUTE_API_KEY http://localhost:20128')

    const asked = await run('update omniroute mistral/codestral-latest http://localhost:20128/v1')
    expect(asked).toContain('Changing the base URL sends OMNIROUTE_API_KEY to a new endpoint')
    expect(asked).toContain('`/byok update omniroute mistral/codestral-latest http://localhost:20128/v1 OMNIROUTE_API_KEY`')
    expect(asked).not.toContain('BYOK error')
    expect((await store.list())[0]).toMatchObject({ baseUrl: 'http://localhost:20128', revision: 1 })

    const updated = await run('update omniroute mistral/codestral-latest http://localhost:20128/v1 OMNIROUTE_API_KEY')
    expect(updated).toContain('Updated omniroute')
    expect((await store.list())[0]).toMatchObject({
      baseUrl: 'http://localhost:20128/v1',
      credentialRef: 'env:OMNIROUTE_API_KEY',
      revision: 2,
    })
  })

  test('the same endpoint (even with a trailing slash) needs no variable', async () => {
    const store = useStore()
    await run('add omniroute openai-compatible mistral/codestral-latest OMNIROUTE_API_KEY http://localhost:20128/v1')
    expect(await run('update omniroute mistral/codestral-2508 http://localhost:20128/v1/')).toContain('Updated omniroute')
    expect((await store.list())[0]).toMatchObject({ model: 'mistral/codestral-2508', revision: 2 })
  })

  test('the confirming variable survives a pasted line break in the URL, and a fifth word is still refused', async () => {
    const store = useStore()
    await run('add omniroute openai-compatible mistral/codestral-latest OMNIROUTE_API_KEY http://localhost:20128')
    expect(
      await run('update omniroute mistral/codestral-latest http://localhost:20128/\nv1 OMNIROUTE_API_KEY'),
    ).toContain('Updated omniroute')
    expect((await store.list())[0]).toMatchObject({ baseUrl: 'http://localhost:20128/v1', revision: 2 })
    expect(
      await run('update omniroute mistral/codestral-latest http://localhost:20128/v1 OMNIROUTE_API_KEY extra'),
    ).toContain('Unexpected extra argument for /byok update: extra')
  })

  test('a malformed variable name is refused', async () => {
    useStore()
    await run('add omniroute openai-compatible mistral/codestral-latest OMNIROUTE_API_KEY http://localhost:20128')
    expect(await run('update omniroute mistral/codestral-latest http://localhost:20128/v1 not-a-var')).toContain(
      'must be an environment-variable name',
    )
  })
})
