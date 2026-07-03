import { describe, expect, test, beforeEach, afterEach } from 'bun:test'

import { REQUESTY_ENV_VAR } from '@codebuff/common/constants/requesty'

describe('getModelForRequest Requesty direct route', () => {
  const previousRequestyKey = process.env[REQUESTY_ENV_VAR]

  beforeEach(() => {
    delete process.env[REQUESTY_ENV_VAR]
  })

  afterEach(() => {
    if (previousRequestyKey === undefined) {
      delete process.env[REQUESTY_ENV_VAR]
    } else {
      process.env[REQUESTY_ENV_VAR] = previousRequestyKey
    }
  })

  async function importFresh() {
    const mod = await import('../model-provider')
    mod.resetChatGptOAuthRateLimit()
    return mod
  }

  test('routes to Requesty when REQUESTY_API_KEY is set', async () => {
    process.env[REQUESTY_ENV_VAR] = 'test-requesty-key'

    const { getModelForRequest } = await importFresh()

    const result = await getModelForRequest({
      apiKey: 'test-codebuff-key',
      model: 'openai/gpt-4o-mini',
    })

    expect(result.isChatGptOAuth).toBe(false)
    expect(typeof result.model).not.toBe('string')
    if (typeof result.model !== 'string') {
      expect(result.model.provider).toBe('requesty')
    }
  })

  test('uses Codebuff backend when REQUESTY_API_KEY is not set', async () => {
    const { getModelForRequest } = await importFresh()

    const result = await getModelForRequest({
      apiKey: 'test-codebuff-key',
      model: 'openai/gpt-4o-mini',
    })

    expect(result.isChatGptOAuth).toBe(false)
    if (typeof result.model !== 'string') {
      expect(result.model.provider).toBe('codebuff')
    }
  })
})
