import { afterEach, expect, test } from 'bun:test'

import { useByokSelectionStore } from '../../utils/byok'
import {
  shouldValidateAgentsRemotely,
  validateSelectedAgentDefinitions,
} from '../use-agent-validation'

const originalFetch = globalThis.fetch

const recordingFetch = (calls: string[]): typeof fetch =>
  Object.assign(
    async (input: URL | RequestInfo) => {
      calls.push(String(input))
      return new Response(JSON.stringify({ validationErrors: [] }))
    },
    { preconnect: originalFetch.preconnect },
  ) as typeof fetch

afterEach(() => {
  useByokSelectionStore.getState().setSelected(undefined)
  globalThis.fetch = originalFetch
})

test('uses local agent validation without a hosted request while BYOK is selected', async () => {
  useByokSelectionStore.getState().setSelected({
    id: 'byok-connection',
    revision: 1,
    provider: 'openai-compatible',
    model: 'gpt-oss:120b',
  })
  const calls: string[] = []
  globalThis.fetch = recordingFetch(calls)

  const result = await validateSelectedAgentDefinitions([], {
    isFreebuff: true,
  })

  expect(shouldValidateAgentsRemotely(true)).toBe(false)
  expect(result.success).toBe(true)
  expect(calls).toEqual([])
})

test('uses the hosted validator after switching back to Freebuff', async () => {
  const calls: string[] = []
  globalThis.fetch = recordingFetch(calls)

  const result = await validateSelectedAgentDefinitions([], {
    isFreebuff: true,
  })

  expect(shouldValidateAgentsRemotely(true)).toBe(true)
  expect(result.success).toBe(true)
  expect(calls).toHaveLength(1)
  expect(new URL(calls[0]).pathname).toBe('/api/agents/validate')
})

test('keeps remote validation in a non-Freebuff CLI even with a stale BYOK selection', () => {
  useByokSelectionStore.getState().setSelected({
    id: 'stale-byok-connection',
    revision: 1,
  })

  expect(shouldValidateAgentsRemotely(false)).toBe(true)
})
