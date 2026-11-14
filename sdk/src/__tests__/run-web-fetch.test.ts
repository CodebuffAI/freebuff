import * as runtime from '@codebuff/agent-runtime/main-prompt'
import { afterEach, expect, mock, spyOn, test } from 'bun:test'

import { CodebuffClient } from '../client'
import { getWebsiteUrl } from '../constants'

import type { ToolResultOutput } from '@codebuff/common/types/messages/content-part'

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
  mock.restore()
})

async function readPage(client: CodebuffClient, url: string) {
  let output: ToolResultOutput[] = []
  let sessionId = ''
  spyOn(runtime, 'callMainPrompt').mockImplementation(async (params) => {
    sessionId = params.clientSessionId
    const result = await params.requestToolCall({
      userInputId: params.promptId,
      toolName: 'read_url',
      input: {
        url,
        objective: 'Find the default',
        live: true,
        max_chars: 2000,
      },
    })
    output = result.output
    throw new Error('scripted end of run')
  })
  await client.run({
    agent: 'base2',
    prompt: 'Read the page',
    apiKeyUserId: 'test-user',
  })
  return { output, sessionId }
}

test('hosted read_url uses the authenticated extract route and the current search session', async () => {
  const url = 'https://docs.example.org/reference'
  const post = mock(async (_url: unknown, _init?: RequestInit) =>
    Response.json({
      result: { url, content: 'The default is 5.', truncated: false },
    }),
  )
  globalThis.fetch = post as unknown as typeof fetch
  const { output, sessionId } = await readPage(
    new CodebuffClient({ apiKey: 'test-user-credential' }),
    url,
  )

  expect(post).toHaveBeenCalledTimes(1)
  const [endpoint, init] = post.mock.calls[0]!
  expect(String(endpoint)).toBe(`${getWebsiteUrl()}/api/v1/web-fetch`)
  expect(new Headers(init?.headers).get('authorization')).toBe(
    'Bearer test-user-credential',
  )
  expect(JSON.parse(String(init?.body))).toEqual({
    url,
    objective: 'Find the default',
    live: true,
    maxChars: 2000,
    sessionId,
  })
  expect(output).toEqual([
    {
      type: 'json',
      value: { url, text: 'The default is 5.', truncated: false },
    },
  ])
})

test('a host override stays authoritative and can deny hosted extraction', async () => {
  const fetch = mock(async () => {
    throw new Error('network must be unreachable')
  })
  globalThis.fetch = fetch as unknown as typeof globalThis.fetch
  const { output } = await readPage(
    new CodebuffClient({
      apiKey: 'test-user-credential',
      overrideTools: {
        read_url: async () => [
          { type: 'json', value: { errorMessage: 'Denied by host' } },
        ],
      },
    }),
    'https://docs.example.org/reference',
  )
  expect(fetch).not.toHaveBeenCalled()
  expect(output).toEqual([
    { type: 'json', value: { errorMessage: 'Denied by host' } },
  ])
})

test('a direct BYOK run keeps its local URL policy and makes no hosted request', async () => {
  const fetch = mock(async () => {
    throw new Error('unexpected hosted call')
  })
  globalThis.fetch = fetch as unknown as typeof globalThis.fetch
  const client = new CodebuffClient({
    byok: {
      id: 'local',
      revision: 1,
      name: 'local',
      provider: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:9876/v1',
      model: 'test-model',
      credentialRef: 'connection:local:1',
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01',
      apiKey: 'test-user-credential',
    },
  })
  const { output } = await readPage(client, 'http://127.0.0.1/private')
  expect(fetch).not.toHaveBeenCalled()
  expect(JSON.stringify(output)).toContain('Refusing to fetch private or reserved address')
  expect(JSON.stringify(output)).toContain('errorMessage')
})
