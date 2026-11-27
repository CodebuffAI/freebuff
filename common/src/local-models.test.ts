import { describe, expect, test } from 'bun:test'

import {
  LOCAL_RUNTIMES,
  discoverLocalModels,
  estimateLocalFit,
  isLoopbackBaseUrl,
  localByokInput,
  localConnectionName,
  parameterBillions,
  parseLocalModels,
} from './local-models'

describe('parseLocalModels', () => {
  test('reads an OpenAI models listing and its context window', () => {
    const models = parseLocalModels({
      object: 'list',
      data: [
        { id: 'qwen2.5-coder:7b', context_length: 32768 },
        { id: 'llama3.1:8b' },
      ],
    })
    expect(models).toEqual([
      { id: 'llama3.1:8b' },
      { id: 'qwen2.5-coder:7b', contextWindow: 32768 },
    ])
  })

  test('accepts vLLM and LM Studio field spellings', () => {
    expect(
      parseLocalModels({
        data: [
          { id: 'a', max_model_len: 8192 },
          { id: 'b', loaded_context_length: 16384 },
          { id: 'c', details: { context_length: 4096 } },
        ],
      }),
    ).toEqual([
      { id: 'a', contextWindow: 8192 },
      { id: 'b', contextWindow: 16384 },
      { id: 'c', contextWindow: 4096 },
    ])
  })

  test('ignores malformed entries instead of throwing', () => {
    expect(parseLocalModels({ data: [null, 3, { id: 42 }, { id: 'ok' }] })).toEqual([
      { id: 'ok' },
    ])
    expect(parseLocalModels(null)).toEqual([])
  })
})

describe('discoverLocalModels', () => {
  test('reports reachable runtimes and their models', async () => {
    const fetchImpl = (async (url: string | URL | Request) => {
      const target = String(url)
      if (target.includes(':11434')) {
        return new Response(
          JSON.stringify({ data: [{ id: 'qwen2.5-coder:7b', context_length: 32768 }] }),
          { status: 200 },
        )
      }
      throw new Error('connection refused')
    }) as unknown as typeof fetch

    const statuses = await discoverLocalModels({ fetchImpl })
    const ollama = statuses.find((status) => status.id === 'ollama')!
    expect(ollama.reachable).toBe(true)
    expect(ollama.models).toEqual([
      { id: 'qwen2.5-coder:7b', contextWindow: 32768 },
    ])

    const lmstudio = statuses.find((status) => status.id === 'lmstudio')!
    expect(lmstudio.reachable).toBe(false)
    expect(lmstudio.error).toBe('not running')
  })

  test('times out a silent runtime instead of hanging', async () => {
    const fetchImpl = ((_url: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const error = new Error('aborted')
          error.name = 'AbortError'
          reject(error)
        })
      })) as unknown as typeof fetch

    const statuses = await discoverLocalModels({
      fetchImpl,
      timeoutMs: 30,
      runtimes: [LOCAL_RUNTIMES[0]!],
    })
    expect(statuses[0]!.reachable).toBe(false)
    expect(statuses[0]!.error).toBe('timed out')
  })

  test('refuses a runtime that is not loopback', async () => {
    const statuses = await discoverLocalModels({
      fetchImpl: (async () => {
        throw new Error('must not be called')
      }) as unknown as typeof fetch,
      runtimes: [
        { id: 'vllm', label: 'Remote vLLM', baseUrl: 'https://models.example.com/v1' },
      ],
    })
    expect(statuses[0]!.reachable).toBe(false)
    expect(statuses[0]!.error).toContain('not a loopback')
  })
})

describe('local BYOK connections', () => {
  test('builds a loopback openai-compatible connection', () => {
    const connection = localByokInput({
      runtime: { id: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1/' },
      model: 'qwen2.5-coder:7b',
      modelInfo: { contextWindow: 32768 },
    })
    expect(connection.provider).toBe('openai-compatible')
    expect(connection.baseUrl).toBe('http://127.0.0.1:11434/v1')
    expect(connection.model).toBe('qwen2.5-coder:7b')
    expect(connection.contextWindow).toBe(32768)
    expect(localConnectionName('ollama', 'Qwen2.5-Coder:7B')).toBe(
      'local:ollama:qwen2.5-coder-7b',
    )
  })

  test('refuses to label a remote endpoint local', () => {
    expect(isLoopbackBaseUrl('http://localhost:1234/v1')).toBe(true)
    expect(isLoopbackBaseUrl('http://[::1]:8080/v1')).toBe(true)
    expect(isLoopbackBaseUrl('https://api.example.com/v1')).toBe(false)
    expect(() =>
      localByokInput({
        runtime: { id: 'vllm', baseUrl: 'https://api.example.com/v1' },
        model: 'remote-model',
      }),
    ).toThrow(/loopback/)
  })
})

describe('local fit guidance', () => {
  test('reads parameter counts from common model ids', () => {
    expect(parameterBillions('qwen2.5-coder:7b')).toBe(7)
    expect(parameterBillions('Llama-3.1-8B-Instruct')).toBe(8)
    expect(parameterBillions('mistral:latest')).toBeUndefined()
  })

  test('estimates memory fit and stays honest about unknown models', () => {
    const eightGb = 8 * 1024 ** 3
    expect(estimateLocalFit({ model: 'tiny:1.5b', totalMemoryBytes: eightGb })).toBe(
      'comfortable',
    )
    expect(estimateLocalFit({ model: 'big:32b', totalMemoryBytes: eightGb })).toBe(
      'too-large',
    )
    expect(estimateLocalFit({ model: 'mystery', totalMemoryBytes: eightGb })).toBe(
      'unknown',
    )
  })

  test('is a non-authoritative rule of thumb with overridable constants', () => {
    const eightGb = 8 * 1024 ** 3
    // A caller that knows the weights are 8-bit passes twice the bytes and
    // gets a stricter answer from the same heuristic.
    expect(
      estimateLocalFit({
        model: 'small:4b',
        totalMemoryBytes: eightGb,
        bytesPerBillionParams: 1.4 * 1024 ** 3,
      }),
    ).toBe('too-large')
    expect(
      estimateLocalFit({
        model: 'big:16b',
        totalMemoryBytes: eightGb,
        usableMemoryFraction: 1,
      }),
    ).toBe('too-large')
    expect(
      estimateLocalFit({
        model: 'small:4b',
        totalMemoryBytes: eightGb,
        usableMemoryFraction: 0.2,
      }),
    ).toBe('too-large')
  })
})
