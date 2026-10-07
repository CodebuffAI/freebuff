import { describe, expect, test } from 'bun:test'

import { createHttpProfileSurveyClient } from '../profile-survey-api'

type Call = { url: string; init: RequestInit }

function fakeFetch(status: number, body: unknown) {
  const calls: Call[] = []
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return new Response(JSON.stringify(body), { status })
  }) as unknown as typeof fetch
  return { calls, impl }
}

describe('createHttpProfileSurveyClient', () => {
  test('GET carries the bearer token to /api/profile-survey', async () => {
    const { calls, impl } = fakeFetch(200, { show: false, reason: 'snoozed' })
    const client = createHttpProfileSurveyClient({
      baseUrl: 'http://localhost:3002/',
      getToken: () => 'tok',
      fetchImpl: impl,
    })
    expect(await client.getState()).toEqual({ show: false, reason: 'snoozed' })
    expect(calls[0].url).toBe('http://localhost:3002/api/profile-survey')
    expect(calls[0].init.method).toBe('GET')
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe(
      'Bearer tok',
    )
  })

  test('signed out: no request at all', async () => {
    const { calls, impl } = fakeFetch(200, {})
    const client = createHttpProfileSurveyClient({
      getToken: () => undefined,
      fetchImpl: impl,
    })
    expect(await client.getState()).toEqual({ show: false, reason: 'signed_out' })
    expect(await client.post({ action: 'dismiss', version: 1 })).toEqual({
      ok: false,
      error: 'signed_out',
    })
    expect(calls).toHaveLength(0)
  })

  test('a malformed or failed GET reads as hidden', async () => {
    for (const [status, body] of [
      [200, { show: true }],
      [500, { error: 'boom' }],
    ] as const) {
      const { impl } = fakeFetch(status, body)
      const client = createHttpProfileSurveyClient({
        getToken: () => 'tok',
        fetchImpl: impl,
      })
      expect((await client.getState()).show).toBe(false)
    }
  })

  test('POST sends the JSON body and surfaces server errors as ok:false', async () => {
    const { calls, impl } = fakeFetch(401, { error: 'unauthorized' })
    const client = createHttpProfileSurveyClient({
      baseUrl: 'http://x',
      getToken: () => 'tok',
      fetchImpl: impl,
    })
    const response = await client.post({
      action: 'answer',
      version: 1,
      questionId: 'who_pays',
      optionIds: ['me'],
      durationMs: 1200,
      surface: 'cli',
    })
    expect(response).toEqual({ ok: false, error: 'unauthorized' })
    expect(calls[0].init.method).toBe('POST')
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      action: 'answer',
      version: 1,
      questionId: 'who_pays',
      optionIds: ['me'],
      durationMs: 1200,
      surface: 'cli',
    })
  })

  test('question text is stripped of terminal escapes', async () => {
    const { impl } = fakeFetch(200, {
      show: true,
      surveyId: 'profile',
      version: 1,
      questions: [
        {
          id: 'who_pays',
          revision: 1,
          prompt: 'Who\u001b[2J pays?',
          multi: false,
          options: [{ id: 'me', label: 'Me' }],
        },
      ],
      answers: [],
      resumeAt: 0,
      rewardFreebucks: 5,
      dismissCount: 0,
    })
    const client = createHttpProfileSurveyClient({
      getToken: () => 'tok',
      fetchImpl: impl,
    })
    const state = await client.getState()
    expect(state.show && state.questions[0].prompt).not.toContain('\u001b')
  })
})
