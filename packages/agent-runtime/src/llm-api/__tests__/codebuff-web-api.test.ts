import { describe, expect, test } from 'bun:test'

import {
  HostedServiceUnavailableError,
  callWebSearchAPI,
  callWebFetchAPI,
} from '../codebuff-web-api'

import type { ClientEnv, CiEnv } from '@codebuff/common/types/contracts/env'
import type { Logger } from '@codebuff/common/types/contracts/logger'

const logger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

const env = {
  clientEnv: {
    NEXT_PUBLIC_CODEBUFF_APP_URL: 'https://example.test',
  } as ClientEnv,
  ciEnv: { CODEBUFF_API_KEY: 'test-key' } as CiEnv,
}

describe('callCodebuffV1 retries', () => {
  test('a fetch that can never reach the hosted service fails on the first attempt', async () => {
    let calls = 0
    const fetch = (async () => {
      calls += 1
      throw new HostedServiceUnavailableError(
        'Hosted service tools are unavailable in a direct BYOK run',
      )
    }) as unknown as typeof globalThis.fetch

    const started = Date.now()
    const result = await callWebSearchAPI({ query: 'q', fetch, logger, env })

    expect(result).toEqual({
      error: 'Hosted service tools are unavailable in a direct BYOK run',
    })
    expect(calls).toBe(1)
    // The network-error path would wait 1s + 2s before giving up.
    expect(Date.now() - started).toBeLessThan(1_000)
  })
})

describe('hosted web research transport', () => {
  test('extracts through the authenticated web API and returns readable page content', async () => {
    const url = 'https://docs.example.org/v5'
    const fetch = (async (input, init) => {
      expect(String(input)).toBe('https://example.test/api/v1/web-fetch')
      expect(init?.redirect).toBe('error')
      expect(new Headers(init?.headers).get('authorization')).toBe(
        `Bearer ${env.ciEnv.CODEBUFF_API_KEY}`,
      )
      expect(JSON.parse(String(init?.body))).toEqual({
        url,
        objective: 'Find the v5 migration',
        live: true,
        maxChars: 3000,
        sessionId: 'turn-1',
      })
      return Response.json({
        result: {
          url,
          title: 'v5',
          content: 'Use the new API.',
          truncated: true,
        },
        creditsUsed: 0,
      })
    }) as typeof globalThis.fetch
    expect(
      await callWebFetchAPI({
        url,
        objective: 'Find the v5 migration',
        live: true,
        maxChars: 3000,
        sessionId: 'turn-1',
        logger,
        env,
        fetch,
      }),
    ).toEqual({ url, title: 'v5', text: 'Use the new API.', truncated: true })
  })

  test('keeps a per-page extraction failure actionable', async () => {
    const url = 'https://docs.example.org/private'
    const fetch = Object.assign(
      async () =>
        Response.json({ result: { url, error: 'Page could not be read' } }),
      { preconnect() {} },
    )
    expect(await callWebFetchAPI({ url, logger, env, fetch })).toEqual({
      url,
      errorMessage: 'Page could not be read',
    })
  })

  test('a transient response does not replay a billable search', async () => {
    let calls = 0
    const fetch = Object.assign(
      async () => {
        calls++
        return new Response('Proxy failed', { status: 502 })
      },
      { preconnect() {} },
    )
    const res = await callWebSearchAPI({
      query: 'release notes',
      logger,
      env,
      fetch,
    })
    expect(calls).toBe(1)
    expect(res.error).toContain('502')
  })
})
