import fs from 'fs'
import os from 'os'
import path from 'path'

import { createBunByokConnectionStore } from '@codebuff/sdk'
import { afterEach, describe, expect, mock, test } from 'bun:test'

import { BYOK_USAGE, handleByokCommand } from '../byok'
import {
  resetCliByokStoreForTests,
  setCliByokStoreForTests,
} from '../../utils/byok'

import type { RouterParams } from '../command-registry'

const directories: string[] = []
afterEach(() => {
  resetCliByokStoreForTests()
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true })
})

function useStore() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'freebuff-byok-help-'))
  directories.push(directory)
  const requests: string[] = []
  const store = createBunByokConnectionStore({
    directory,
    environment: { PROVIDER_API_KEY: '<your-provider-api-key>' } as NodeJS.ProcessEnv,
    fetch: (async (url: string | URL | Request) => {
      requests.push(String(url))
      return Response.json({ data: [{ id: 'gpt-oss:120b' }] })
    }) as typeof fetch,
  })
  setCliByokStoreForTests(store)
  return { store, requests }
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

describe('/byok setup help', () => {
  test.each([
    ['OpenRouter', 'openrouter', 'openai/gpt-oss-120b', 'https://openrouter.ai/api/v1/key'],
    ['Ollama Cloud', 'openai-compatible', 'gpt-oss:120b', 'https://ollama.com/v1/models'],
  ])('%s quickstart can be copied into add and validate', async (label, provider, model, validationUrl) => {
    const { store, requests } = useStore()
    const help = await run('help')
    const line = help.split('\n').find((line) => line.startsWith(`${label}:`))
    const command = line?.match(/`\/byok ([^`]+)`/)?.[1]
    expect(command).toBeDefined()

    expect(await run(command!)).toContain('Saved')
    expect(await store.list()).toMatchObject([
      { name: 'my-provider', provider, model, credentialRef: 'env:PROVIDER_API_KEY' },
    ])
    expect(await run('validate my-provider')).not.toContain('unavailable')
    expect(requests).toEqual([validationUrl, validationUrl])
  })

  test.each(['$PROVIDER_API_KEY', '${PROVIDER_API_KEY}', '$env:PROVIDER_API_KEY', 'env:PROVIDER_API_KEY', 'PROVIDER_API_KEY=<placeholder>'])(
    'explains a shell-style key reference (%s) and permits a corrected retry',
    async (reference) => {
      const { store, requests } = useStore()
      const message = await run(`add my-provider openrouter openai/gpt-oss-120b ${reference}`)
      expect(message).toContain('Use the NAME only')
      expect(message).toContain('no restart is needed')
      expect(message).toContain('/byok help')
      expect(await store.list()).toEqual([])
      expect(requests).toEqual([])

      expect(await run('add my-provider openrouter openai/gpt-oss-120b PROVIDER_API_KEY')).toContain('authenticated')
      expect(await store.list()).toHaveLength(1)
    },
  )

  test('incomplete setup points to the quickstart without dumping all of help', async () => {
    const { store } = useStore()
    const message = await run('add my-provider openrouter')
    expect(message).toContain('is missing `<model>`, `<ENV_VAR>`')
    expect(message).toContain('/byok help')
    expect(message).not.toContain(BYOK_USAGE)
    expect(await store.list()).toEqual([])
  })
})
