import { describe, expect, mock, test } from 'bun:test'

import { fetchWeb, searchWeb } from '../parallel-api'

const page = {
  title: 'React docs',
  url: 'https://react.dev/reference',
  publish_date: '2026-01-01',
  excerpts: ['First paragraph.', 'Another section.'],
}
function setup(body: unknown = { results: [page] }, status = 200) {
  const transport = mock(async (_url: RequestInfo | URL, _init?: RequestInit) =>
    Response.json(body, { status }),
  )
  return {
    searchQueries: ['@tanstack/react-query 日本語'],
    url: page.url,
    serverEnv: { PARALLEL_API_KEY: crypto.randomUUID() },
    logger: { info: mock(), warn: mock(), error: mock(), debug: mock() },
    fetch: Object.assign(transport, { preconnect: () => {} }),
  }
}

describe('Parallel search', () => {
  test('batches original keywords in one indexed Fast request and returns excerpts with citable sources', async () => {
    const deps = setup()
    const sessionId = crypto.randomUUID()
    const searchQueries = [...deps.searchQueries, 'React 1,000 examples']
    const objective = 'Find code samples for the current React release.'
    expect(
      await searchWeb({ ...deps, searchQueries, objective, sessionId }),
    ).toEqual({
      results: [
        {
          title: page.title,
          url: page.url,
          publishDate: page.publish_date,
          snippet: page.excerpts.join('\n\n'),
        },
      ],
    })
    expect(deps.fetch).toHaveBeenCalledTimes(1)
    const [[url, init]] = deps.fetch.mock.calls
    expect(url).toBe('https://api.parallel.ai/v1/search')
    expect(init).toMatchObject({
      method: 'POST',
      redirect: 'error',
      headers: { 'x-api-key': deps.serverEnv.PARALLEL_API_KEY },
      signal: expect.any(AbortSignal),
    })
    const body = JSON.parse(String(init?.body))
    expect(body).toMatchObject({
      mode: 'fast',
      search_queries: searchQueries,
      session_id: sessionId,
      objective,
      advanced_settings: { max_results: 10 },
    })
    expect(body.advanced_settings.fetch_policy).toBeUndefined()
  })

  test('explicit freshness refuses stale fallback', async () => {
    const deps = setup()
    await searchWeb({ ...deps, live: true })
    expect(
      JSON.parse(String(deps.fetch.mock.calls[0][1]?.body)).advanced_settings
        .fetch_policy,
    ).toMatchObject({ max_age_seconds: 600, disable_cache_fallback: true })
  })

  test('distinguishes no matches from malformed, oversized or failed requests', async () => {
    expect(await searchWeb(setup({ results: [] }))).toEqual({ results: [] })
    for (const body of [
      {},
      { results: [{}] },
      { results: [{ ...page, url: 'javascript:alert(0)' }] },
      { results: [{ ...page, excerpts: ['x'.repeat(1024 * 1024)] }] },
    ]) {
      expect(await searchWeb(setup(body))).toBeNull()
    }
    for (const status of [401, 402, 429, 503]) {
      const deps = setup({ error: 'can contain private information' }, status)
      expect(await searchWeb(deps)).toBeNull()
      expect(deps.fetch).toHaveBeenCalledTimes(1)
      expect(deps.logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ provider: 'parallel', status }),
        expect.any(String),
      )
      expect(JSON.stringify(deps.logger.error.mock.calls)).not.toContain(
        'private information',
      )
    }
  })

  test('clamps upstream output even if Parallel ignores the requested limits', async () => {
    const many = Array(20).fill({
      ...page,
      title: null,
      publish_date: null,
      excerpts: ['a'.repeat(9000)],
    })
    const response = await searchWeb(setup({ results: many }))
    expect(response?.results).toHaveLength(10)
    expect(response?.results[0].snippet.length).toBeLessThan(9000)
    expect(response?.results[0].title).toBe(page.url)
  })

  test('skips upstream calls on invalid queries or a missing credential', async () => {
    const deps = setup()
    for (const searchQueries of [
      [],
      ['  '],
      Array(6).fill('hi'),
      ['x'.repeat(201)],
    ]) {
      expect(await searchWeb({ ...deps, searchQueries })).toBeNull()
    }
    expect(await searchWeb({ ...deps, serverEnv: {} })).toBeNull()
    expect(deps.fetch).not.toHaveBeenCalled()
  })
})

describe('Parallel extract', () => {
  test('reads bounded page markdown and detects truncation', async () => {
    const limit = 1000
    const deps = setup({
      results: [{ ...page, full_content: 'a'.repeat(limit + 1) }],
      errors: [],
    })
    expect(await fetchWeb({ ...deps, maxChars: limit })).toMatchObject({
      url: page.url,
      content: 'a'.repeat(limit),
      truncated: true,
    })
    const [[url, init]] = deps.fetch.mock.calls
    expect(url).toBe('https://api.parallel.ai/v1/extract')
    const body = JSON.parse(String(init?.body))
    expect(body).toMatchObject({
      urls: [page.url],
      advanced_settings: { full_content: { max_chars_per_result: limit + 1 } },
    })
    expect(body.advanced_settings.fetch_policy).toBeUndefined()
  })

  test('returns focused excerpts for an objective in a live follow-up', async () => {
    const deps = setup({ results: [page], errors: [] })
    const objective = 'Find the documented function signature.'
    const sessionId = 'search-followup'
    expect(
      await fetchWeb({ ...deps, objective, live: true, sessionId }),
    ).toMatchObject({ content: page.excerpts.join('\n\n'), truncated: false })
    const body = JSON.parse(String(deps.fetch.mock.calls[0][1]?.body))
    expect(body).toMatchObject({
      objective,
      session_id: sessionId,
      advanced_settings: {
        full_content: false,
        fetch_policy: { max_age_seconds: 600, disable_cache_fallback: true },
      },
    })
  })

  test('returns actionable per-page errors on HTTP 200 or empty content', async () => {
    expect(
      await fetchWeb(
        setup({
          results: [],
          errors: [
            {
              url: page.url,
              http_status_code: 403,
              error_type: 'fetch_error',
              content: 'arbitrary upstream text',
            },
          ],
        }),
      ),
    ).toEqual({
      url: page.url,
      error: 'Could not retrieve this page (HTTP 403).',
    })
    expect(
      await fetchWeb(setup({ results: [page], errors: [] })),
    ).toMatchObject({ error: expect.any(String) })
  })

  test('does not send embedded credentials or non-HTTP URLs to Parallel', async () => {
    const deps = setup()
    for (const url of [
      'https://user:pass@example.com/',
      'file:///etc/passwd',
      'hello',
    ])
      expect(await fetchWeb({ ...deps, url })).toBeNull()
    expect(deps.fetch).not.toHaveBeenCalled()
  })
})
