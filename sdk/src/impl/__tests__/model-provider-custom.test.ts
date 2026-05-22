import { describe, expect, test, afterEach, mock } from 'bun:test'

describe('getModelForRequest with customProvider', () => {
  afterEach(() => {
    mock.restore()
  })

  test('returns isCustomProvider: true when customProvider.baseUrl is set', async () => {
    const { getModelForRequest } = await import('../model-provider')

    const result = await getModelForRequest({
      apiKey: 'cb-test-key',
      model: 'gemma2:9b',
      customProvider: { baseUrl: 'http://localhost:11434/v1', apiKey: 'ollama' },
    })

    expect(result.isCustomProvider).toBe(true)
    expect(result.isChatGptOAuth).toBe(false)
    expect(result.model).toBeDefined()
    expect((result.model as any).modelId).toBe('gemma2:9b')
  })

  test('does not return isCustomProvider when baseUrl is missing', async () => {
    const { getModelForRequest } = await import('../model-provider')

    const result = await getModelForRequest({
      apiKey: 'cb-test-key',
      model: 'anthropic/claude-sonnet-4',
    })

    expect(result.isCustomProvider).toBe(false)
  })

  test('customProvider takes precedence over ChatGPT OAuth eligibility', async () => {
    const { getModelForRequest } = await import('../model-provider')

    const result = await getModelForRequest({
      apiKey: 'cb-test-key',
      model: 'openai/gpt-5.3',
      customProvider: { baseUrl: 'http://localhost:11434/v1' },
    })

    expect(result.isCustomProvider).toBe(true)
    expect(result.isChatGptOAuth).toBe(false)
  })

  test('trims trailing slash from baseUrl (constructs cleanly)', async () => {
    const { getModelForRequest } = await import('../model-provider')

    const result = await getModelForRequest({
      apiKey: 'cb-test-key',
      model: 'gemma2:9b',
      customProvider: { baseUrl: 'http://localhost:11434/v1/' },
    })

    expect(result.isCustomProvider).toBe(true)
  })

  test('omitting apiKey is allowed', async () => {
    const { getModelForRequest } = await import('../model-provider')

    const result = await getModelForRequest({
      apiKey: 'cb-test-key',
      model: 'gemma2:9b',
      customProvider: { baseUrl: 'http://localhost:11434/v1' },
    })

    expect(result.isCustomProvider).toBe(true)
  })

  test('customProvider arg drives selection regardless of env (precedence contract)', async () => {
    // This documents the contract: getModelForRequest receives the *resolved*
    // customProvider — the caller (promptAiSdkStream) is responsible for
    // applying the agent > client > env precedence ladder before calling.
    process.env.CODEBUFF_BASE_URL = 'http://from-env:11434/v1'
    process.env.CODEBUFF_PROVIDER_API_KEY = 'env-key'

    const { getModelForRequest } = await import('../model-provider')
    const result = await getModelForRequest({
      apiKey: 'cb-key',
      model: 'gemma2:9b',
      customProvider: {
        baseUrl: 'http://from-agent:11434/v1',
        apiKey: 'agent-key',
      },
    })

    expect(result.isCustomProvider).toBe(true)
    expect(result.model).toBeDefined()

    delete process.env.CODEBUFF_BASE_URL
    delete process.env.CODEBUFF_PROVIDER_API_KEY
  })
})
