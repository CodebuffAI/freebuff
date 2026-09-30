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

// The user writeup (2026-09-30) hit "model not found" with a local OmniRoute
// proxy: the model id was not one the proxy offers. `/byok validate` said only
// "is reachable", so the mistake surfaced at the first run.
const SYNTHETIC_KEY = 'synthetic-omniroute-key-canary'
const directories: string[] = []
afterEach(() => {
  resetCliByokStoreForTests()
  for (const dir of directories.splice(0))
    fs.rmSync(dir, { recursive: true, force: true })
})

function useProxy(ids: string[]) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'freebuff-byok-validate-'))
  directories.push(directory)
  setCliByokStoreForTests(
    createBunByokConnectionStore({
      directory,
      environment: { OMNIROUTE_API_KEY: SYNTHETIC_KEY } as NodeJS.ProcessEnv,
      fetch: (async () =>
        Response.json({ data: ids.map((id) => ({ id })) })) as unknown as typeof fetch,
    }),
  )
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

describe('/byok validate against a local proxy', () => {
  test('a listed model shows the HTTP status and no warning', async () => {
    useProxy(['mistral/codestral-latest'])
    const added = await run(
      'add omniroute openai-compatible mistral/codestral-latest OMNIROUTE_API_KEY http://localhost:20128/v1',
    )
    expect(added).toContain('The endpoint is reachable (HTTP 200)')
    expect(added).not.toContain('Warning')
    expect(await run('validate omniroute')).toContain('is reachable (HTTP 200)')
  })

  test('an unlisted model is named on add and validate, with the ids the proxy offers', async () => {
    const offered = Array.from({ length: 23 }, (_, i) => `vendor/model-${i}`)
    useProxy(offered)
    const added = await run(
      'add omniroute openai-compatible codestral-latest OMNIROUTE_API_KEY http://localhost:20128/v1',
    )
    expect(added).toContain("Warning: `codestral-latest` is not in this endpoint's model list.")
    expect(added).toContain('`vendor/model-0`, `vendor/model-1`')
    expect(added).toContain('`vendor/model-19` and 3 more.')
    expect(added).not.toContain('vendor/model-20`')
    expect(added).toContain('`/byok update omniroute <model>`')

    const validated = await run('validate omniroute')
    expect(validated).toContain('is reachable (HTTP 200)')
    expect(validated).toContain("`codestral-latest` is not in this endpoint's model list")
    expect(validated).not.toContain(SYNTHETIC_KEY)
  })
})
