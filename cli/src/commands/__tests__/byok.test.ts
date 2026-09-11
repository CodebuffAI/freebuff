import { afterEach, describe, expect, mock, test } from 'bun:test'

import { handleByokCommand } from '../byok'
import {
  resetCliByokStoreForTests,
  setCliByokStoreForTests,
} from '../../utils/byok'

import type { RouterParams } from '../command-registry'
import type { ByokConnection, ByokConnectionStore } from '@codebuff/sdk'

const connection: ByokConnection = {
  id: '3f5cd55a-eaca-48f5-bd24-ef37618f89a8',
  revision: 1,
  name: 'router',
  provider: 'openrouter',
  model: 'openai/gpt-5',
  credentialRef: 'env:OPENROUTER_API_KEY',
  contextWindow: 32768,
  maxOutputTokens: 4096,
  createdAt: '2026-09-10T00:00:00.000Z',
  updatedAt: '2026-09-10T00:00:00.000Z',
}

const createParams = (inputValue: string) => {
  const messages: string[] = []
  const history: string[] = []
  const params = {
    inputValue,
    setMessages: (updater: (messages: never[]) => Array<{ content?: string }>) => {
      messages.push(...updater([]).map((message) => message.content ?? ''))
    },
    saveToHistory: (value: string) => history.push(value),
    setInputValue: mock(() => {}),
    clearMessages: mock(() => {}),
  } as unknown as RouterParams
  return { params, messages, history }
}

afterEach(() => resetCliByokStoreForTests())

describe('/byok', () => {
  test('never saves setup arguments with an unrecognized credential format to history', async () => {
    setCliByokStoreForTests({ list: async () => [] } as unknown as ByokConnectionStore)
    const syntheticKey = `${'a'.repeat(32)}.${'b'.repeat(32)}`
    const args = `add ollama openai-compatible model ${syntheticKey} https://example.test/v1`
    const { params, messages, history } = createParams(`/byok ${args}`)
    await handleByokCommand(params, args)
    expect(messages.join('\n')).toContain('environment-variable name')
    expect(history).toEqual(['/byok add [arguments omitted]'])
    expect(JSON.stringify({ messages, history })).not.toContain(syntheticKey)
  })

  test('adds an explicit environment reference without receiving an API key', async () => {
    const create = mock(async () => connection)
    const store = {
      create,
      list: async () => [],
      validate: async () => ({ ok: true, connection }),
    } as unknown as ByokConnectionStore
    setCliByokStoreForTests(store)
    const { params, messages } = createParams(
      '/byok add router openrouter openai/gpt-5 OPENROUTER_API_KEY',
    )

    await handleByokCommand(
      params,
      'add router openrouter openai/gpt-5 OPENROUTER_API_KEY',
    )

    expect(create).toHaveBeenCalledWith({
      name: 'router',
      provider: 'openrouter',
      model: 'openai/gpt-5',
      credentialRef: 'env:OPENROUTER_API_KEY',
    })
    expect(messages.join('\n')).toContain('authenticated')
  })

  test('rejects and redacts a credential-like command argument before history persistence', async () => {
    const store = { list: async () => [] } as unknown as ByokConnectionStore
    setCliByokStoreForTests(store)
    const { params, messages, history } = createParams(
      '/byok add router openrouter model sk-this-must-never-be-saved-123456',
    )

    await handleByokCommand(
      params,
      'add router openrouter model sk-this-must-never-be-saved-123456',
    )

    expect(messages.join('\n')).toContain('cannot be entered')
    expect(history).toEqual(['/byok [redacted credential]'])
  })

  test('labels compatible endpoint validation as reachability, not model qualification', async () => {
    const compatible = {
      ...connection,
      provider: 'openai-compatible' as const,
      baseUrl: 'https://example.test/v1',
    }
    const store = {
      list: async () => [compatible],
      validate: async () => ({ ok: true, connection: compatible }),
    } as unknown as ByokConnectionStore
    setCliByokStoreForTests(store)
    const { params, messages } = createParams('/byok validate router')

    await handleByokCommand(params, 'validate router')

    expect(messages.join('\n')).toContain('remains unqualified')
  })

  test('selects a Desktop connection with a quoted name', async () => {
    const compatible = {
      ...connection,
      name: 'Ollama test 120B',
      provider: 'openai-compatible' as const,
      model: 'gpt-oss:120b',
      baseUrl: 'https://ollama.com/v1',
    }
    const store = {
      list: async () => [compatible],
      validate: async () => ({ ok: true, connection: compatible }),
    } as unknown as ByokConnectionStore
    setCliByokStoreForTests(store)
    const { params, messages } = createParams('/byok select "Ollama test 120B"')

    await handleByokCommand(params, 'select "Ollama test 120B"')

    expect(messages.join('\n')).toContain('Using Ollama test 120B')
  })

  test('rejects unmatched quoted names without touching the store', async () => {
    const list = mock(async () => [])
    setCliByokStoreForTests({ list } as unknown as ByokConnectionStore)
    const { params, messages } = createParams('/byok select "Ollama test 120B')

    await handleByokCommand(params, 'select "Ollama test 120B')

    expect(messages.join('\n')).toContain('unmatched quote')
    expect(list).not.toHaveBeenCalled()
  })
})
