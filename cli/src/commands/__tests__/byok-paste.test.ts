import { afterEach, describe, expect, mock, test } from 'bun:test'

import { BYOK_USAGE, handleByokCommand } from '../byok'
import {
  resetCliByokStoreForTests,
  setCliByokStoreForTests,
} from '../../utils/byok'

import type { RouterParams } from '../command-registry'
import type { ByokConnection, ByokConnectionStore } from '@codebuff/sdk'

// The user writeup (2026-09-30) lists "usage/help text instead of execution"
// when a /byok command was split onto two lines by a paste. Two shapes:
// a terminal without bracketed paste submits the first line alone, and a
// wrapped copy puts a line break inside an argument.
const saved: ByokConnection = {
  id: '3f5cd55a-eaca-48f5-bd24-ef37618f89a8',
  revision: 1,
  name: 'omniroute',
  provider: 'openai-compatible',
  model: 'mistral/codestral-latest',
  baseUrl: 'http://localhost:20128/v1',
  credentialRef: 'env:OMNIROUTE_API_KEY',
  contextWindow: 32768,
  maxOutputTokens: 4096,
  createdAt: '2026-09-30T00:00:00.000Z',
  updatedAt: '2026-09-30T00:00:00.000Z',
}

afterEach(() => resetCliByokStoreForTests())

function useStore(connections: ByokConnection[] = []) {
  const create = mock(async () => saved)
  const update = mock(async () => ({ ...saved, revision: 2 }))
  setCliByokStoreForTests({
    create,
    update,
    list: async () => connections,
    validate: async () => ({ ok: true, connection: saved }),
  } as unknown as ByokConnectionStore)
  return { create, update }
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

const expectedAdd = {
  name: 'omniroute',
  provider: 'openai-compatible',
  model: 'mistral/codestral-latest',
  baseUrl: 'http://localhost:20128/v1',
  credentialRef: 'env:OMNIROUTE_API_KEY',
}

describe('/byok split by a pasted line break', () => {
  test('a first line submitted alone names what is missing instead of printing usage', async () => {
    const { create } = useStore()
    const message = await run('add omniroute openai-compatible mistral/codestral-latest')
    expect(message).toContain('is missing `<ENV_VAR>`, `<base-url>`.')
    expect(message).toContain('paste it again as one line')
    expect(message).not.toContain(BYOK_USAGE)
    expect(create).not.toHaveBeenCalled()

    const noUrl = await run('add omniroute openai-compatible mistral/codestral-latest OMNIROUTE_API_KEY')
    expect(noUrl).toContain('requires a base URL')
    expect(noUrl).toContain('paste it again as one line')
    expect(create).not.toHaveBeenCalled()
  })

  test('a line break in place of a space runs as typed', async () => {
    const { create } = useStore()
    await run('add omniroute openai-compatible mistral/codestral-latest\nOMNIROUTE_API_KEY http://localhost:20128/v1')
    expect(create).toHaveBeenCalledWith(expectedAdd)
  })

  test('a line break inside the URL is joined, not dropped', async () => {
    // Before: "v1" was silently ignored and the connection saved http://localhost:20128.
    const { create } = useStore()
    await run('add omniroute openai-compatible mistral/codestral-latest OMNIROUTE_API_KEY http://localhost:20128/\nv1')
    expect(create).toHaveBeenCalledWith(expectedAdd)
  })

  test('a line break inside the provider type or model is joined (CRLF too)', async () => {
    const { create } = useStore()
    await run('add omniroute openai-\r\ncompatible mistral/codestral-latest OMNIROUTE_API_KEY http://localhost:20128/v1')
    await run('add omniroute openai-compatible mistral/\ncodestral-latest OMNIROUTE_API_KEY http://localhost:20128/v1')
    expect(create).toHaveBeenNthCalledWith(1, expectedAdd)
    expect(create).toHaveBeenNthCalledWith(2, expectedAdd)
  })

  test('an ambiguous split is reported with the extra words, never guessed', async () => {
    const { create } = useStore()
    // Two bare breaks but only one extra argument: one of them replaced a space.
    const message = await run('add omniroute openai-compatible mistral/\ncodestral-latest OMNIROUTE_API_KEY\nhttp://localhost:20128/v1')
    expect(message).toContain('Unexpected extra argument for /byok add: http://localhost:20128/v1')
    expect(message).toContain('paste it again as one line')
    expect(create).not.toHaveBeenCalled()
  })

  test('extra words after a complete command are refused rather than ignored', async () => {
    const { create, update } = useStore([saved])
    expect(await run('add omniroute openai-compatible mistral/codestral-latest OMNIROUTE_API_KEY http://localhost:20128/ v1')).toContain(
      'Unexpected extra argument for /byok add: v1',
    )
    expect(await run('update omniroute mistral/codestral-latest http://localhost:20128/v1 extra')).toContain(
      'Unexpected extra argument for /byok update: extra',
    )
    expect(create).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
  })

  test('update joins a split base URL; a split that fits its optional argument is reported', async () => {
    const { update } = useStore([saved])
    await run('update omniroute mistral/codestral-latest http://localhost:\n20128/v1')
    expect(update).toHaveBeenCalledWith({
      id: saved.id,
      revision: 1,
      patch: { model: 'mistral/codestral-latest', baseUrl: 'http://localhost:20128/v1' },
    })
    // "mistral/" + "codestral-2508" also reads as <model> <base-url>: not guessed.
    const message = await run('update omniroute mistral/\ncodestral-2508')
    expect(message).toContain('base URL is invalid: codestral-2508')
    expect(message).toContain('paste it again as one line')
    expect(update).toHaveBeenCalledTimes(1)
  })

  test('an unknown provider type is named', async () => {
    useStore()
    expect(await run('add omniroute openai mistral/codestral-latest OMNIROUTE_API_KEY http://localhost:20128/v1')).toContain(
      'Unknown BYOK provider type: openai',
    )
  })
})
