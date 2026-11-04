import { describe, expect, mock, test } from 'bun:test'

import { searchWeb } from '../ceramic-api'

const item = {
  title: 'React documentation',
  url: 'https://react.dev',
  description: 'Learn React.',
}
const response = (results = [item]) => ({
  requestId: 'request-id',
  result: {
    results,
    totalResults: results.length,
    searchMetadata: { executionTime: 0.1 },
  },
})

function setup(body: unknown = response(), status = 200) {
  return {
    query: 'React tutorial',
    serverEnv: { CERAMIC_API_KEY: 'test-ceramic-key' },
    logger: {
      info: mock(() => {}),
      warn: mock(() => {}),
      error: mock(() => {}),
      debug: mock(() => {}),
    },
    fetch: Object.assign(
      mock(async () => Response.json(body, { status })),
      { preconnect: () => {} },
    ),
  }
}

describe('Ceramic search', () => {
  test.each(['standard', 'deep'] as const)(
    'normalizes %s results and authenticates server-side',
    async (depth) => {
      const deps = setup()
      const result = await searchWeb({ ...deps, depth })
      expect(JSON.parse(result!)).toEqual({
        results: [
          { title: item.title, url: item.url, snippet: item.description },
        ],
      })
      expect(deps.fetch).toHaveBeenCalledWith(
        'https://api.ceramic.ai/search',
        expect.objectContaining({
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer test-ceramic-key',
          },
          body: JSON.stringify({
            query: 'React tutorial',
            maxResults: depth === 'deep' ? 20 : 10,
            maxDescriptionLength: 1000,
          }),
          signal: expect.any(AbortSignal),
        }),
      )
    },
  )

  test('empty search is successful, not a provider failure', async () => {
    expect(JSON.parse((await searchWeb(setup(response([]))))!)).toEqual({
      results: [],
    })
  })

  test('missing key fails without making a request or claiming success', async () => {
    const deps = setup()
    expect(await searchWeb({ ...deps, serverEnv: {} })).toBeNull()
    expect(deps.fetch).not.toHaveBeenCalled()
    expect(deps.logger.error).toHaveBeenCalled()
  })

  test.each([
    '   ',
    Array(51).fill('word').join(' '),
    'next/navigation useRouter migration',
    '@tanstack/react-query useQuery typescript',
    'https://react.dev/reference/react',
    '/api/auth/callback error',
    String.raw`C:\src\app.ts error`,
    'postgres 1,000,000 rows',
    'React 日本語 documentation',
    'React документация',
    'React وثائق',
  ])('invalid query avoids a billed request', async (query) => {
    const deps = setup()
    expect(await searchWeb({ ...deps, query })).toBeNull()
    expect(deps.fetch).not.toHaveBeenCalled()
  })

  test.each([
    'Next.js navigation useRouter',
    'tanstack react-query useQuery typescript',
    'postgres 1000000 rows',
    'site:github.com (React OR Vue) "server components"',
    'C++ C# .NET café cafe\u0301',
    'React, Vue comparison',
    Array(50).fill('word').join(' '),
  ])('keeps supported keywords and operators unchanged: %s', async (query) => {
    const deps = setup()
    expect(await searchWeb({ ...deps, query })).not.toBeNull()
    expect(deps.fetch).toHaveBeenCalledTimes(1)
    expect(deps.fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        body: JSON.stringify({
          query,
          maxResults: 10,
          maxDescriptionLength: 1000,
        }),
      }),
    )
  })

  test('whitespace is normalized without changing keywords', async () => {
    const deps = setup()
    await searchWeb({ ...deps, query: '  React\n tutorial  ' })
    expect(deps.fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        body: JSON.stringify({
          query: 'React tutorial',
          maxResults: 10,
          maxDescriptionLength: 1000,
        }),
      }),
    )
  })

  test.each([401, 402, 429, 500])(
    'HTTP %i is an operational failure',
    async (status) => {
      const deps = setup({ error: 'provider error' }, status)
      expect(await searchWeb(deps)).toBeNull()
      expect(deps.fetch).toHaveBeenCalledTimes(1)
      expect(deps.logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ provider: 'ceramic', status }),
        expect.any(String),
      )
    },
  )

  test.each([
    null,
    [],
    {},
    { result: {} },
    { result: { results: [{}] } },
    response([{ ...item, url: 'javascript:alert(1)' }]),
  ])('malformed response is not empty success: %j', async (body) => {
    expect(await searchWeb(setup(body))).toBeNull()
  })

  test('bounds result count and snippet sizes even when upstream ignores the limits', async () => {
    const deps = setup(
      response(
        Array.from({ length: 30 }, () => ({
          ...item,
          description: 'x'.repeat(8000),
        })),
      ),
    )
    const result = JSON.parse((await searchWeb(deps))!)
    expect(result.results).toHaveLength(10)
    expect(result.results[0].snippet).toHaveLength(1000)
  })

  test('malformed JSON and body/network failures return null', async () => {
    for (const fetch of [
      async () => new Response('invalid json'),
      async () => {
        throw new Error('Network failure')
      },
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new DOMException('Timed out', 'TimeoutError'))
            },
          }),
        ),
    ]) {
      expect(
        await searchWeb({
          ...setup(),
          fetch: Object.assign(fetch, { preconnect: () => {} }),
        }),
      ).toBeNull()
    }
  })
})
