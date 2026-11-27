import { afterEach, describe, expect, test } from 'bun:test'

import { LOCAL_USAGE, handleLocalCommand } from '../local'

import type { RouterParams } from '../command-registry'

/**
 * The handler only needs the slice of RouterParams it actually uses. Keeping
 * the fake this small means a new dependency in the handler fails to compile
 * instead of silently passing.
 */
function makeParams(): { params: RouterParams; messages: unknown[] } {
  const messages: unknown[] = []
  const params = {
    inputValue: '/local',
    setMessages: (
      value: unknown[] | ((prev: unknown[]) => unknown[]),
    ): void => {
      const next = typeof value === 'function' ? value(messages) : value
      messages.splice(0, messages.length, ...next)
    },
    clearMessages: (): void => {
      messages.length = 0
    },
    saveToHistory: (): void => {},
    setInputValue: (): void => {},
  } as unknown as RouterParams
  return { params, messages }
}

function transcript(messages: unknown[]): string {
  return JSON.stringify(messages)
}

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('handleLocalCommand', () => {
  test('shows usage with no arguments', async () => {
    const { params, messages } = makeParams()
    await handleLocalCommand(params, '')
    expect(transcript(messages)).toContain(
      'Run the agent on a model served by this machine.',
    )
    expect(transcript(messages)).toContain(LOCAL_USAGE.split('\n')[0]!)
  })

  test('shows usage when /local use is missing a model', async () => {
    const { params, messages } = makeParams()
    await handleLocalCommand(params, 'use ollama')
    expect(transcript(messages)).toContain(
      'Usage: /local use <runtime> <model> [--context-window=N]',
    )
  })

  test('rejects an unknown runtime before probing anything', async () => {
    const { params, messages } = makeParams()
    await handleLocalCommand(params, 'use not-a-runtime llama3:8b')
    expect(transcript(messages)).toContain('Unknown runtime not-a-runtime')
    expect(transcript(messages)).toContain('ollama, lmstudio, llamacpp, vllm')
  })

  test('rejects a non-numeric --context-window instead of ignoring it', async () => {
    const { params, messages } = makeParams()
    await handleLocalCommand(
      params,
      'use ollama qwen2.5-coder:7b --context-window=eight',
    )
    expect(transcript(messages)).toContain(
      '`--context-window` needs a positive whole number',
    )
    expect(transcript(messages)).not.toContain('Unknown runtime')
  })

  test('rejects a bare --context-window and a zero window', async () => {
    const bare = makeParams()
    await handleLocalCommand(bare.params, 'use ollama qwen --context-window')
    expect(transcript(bare.messages)).toContain(
      '`--context-window` needs a positive whole number',
    )

    const zero = makeParams()
    await handleLocalCommand(zero.params, 'use ollama qwen --context-window=0')
    expect(transcript(zero.messages)).toContain(
      '`--context-window` needs a positive whole number',
    )
  })

  test('rejects an unknown option', async () => {
    const { params, messages } = makeParams()
    await handleLocalCommand(params, 'use ollama qwen --context=8192')
    expect(transcript(messages)).toContain('Unknown option: --context=8192')
  })

  test('reports unknown runtimes for /local models', async () => {
    const { params, messages } = makeParams()
    globalThis.fetch = (async () => {
      throw new Error('connection refused')
    }) as unknown as typeof fetch
    await handleLocalCommand(params, 'models nope')
    expect(transcript(messages)).toContain('Unknown runtime nope')
  })

  test('reports when no runtime answers on loopback', async () => {
    globalThis.fetch = (async () => {
      throw new Error('connection refused')
    }) as unknown as typeof fetch
    const { params, messages } = makeParams()
    await handleLocalCommand(params, 'detect')
    expect(transcript(messages)).toContain('No local runtime answered on loopback')
    expect(transcript(messages)).toContain('Start one (for example `ollama serve`)')
  })
})
