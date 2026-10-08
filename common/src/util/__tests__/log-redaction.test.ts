import { APICallError } from 'ai'
import { describe, expect, test } from 'bun:test'

import { getErrorObject } from '../error'
import { serializeLogData } from '../log-data'
import {
  redactHeadersForLog,
  redactUrlForLog,
  summarizeRequestBodyForLog,
} from '../log-redaction'

const PROMPT = 'my private prompt about src/secret.ts'

function providerError() {
  return new APICallError({
    message: 'Bad Request',
    url: 'https://user:pass@api.example.com/v1/chat/completions?key=sk-query',
    requestBodyValues: {
      model: 'byok-model',
      messages: [
        { role: 'system', content: 'system prompt' },
        { role: 'user', content: PROMPT },
      ],
      tools: [],
    },
    statusCode: 400,
    responseHeaders: {
      'set-cookie': 'session=abc',
      'x-api-key': 'sk-header',
      'x-ratelimit-remaining-tokens': '1000',
      'content-type': 'application/json',
    },
    responseBody: '{"error":"bad"}',
  })
}

describe('redactUrlForLog', () => {
  test('keeps scheme, host and path; drops query, fragment and userinfo', () => {
    expect(
      redactUrlForLog(
        'https://u:p@freebuff.com:8443/api/auth/cli/status?fingerprintHash=h#x',
      ),
    ).toBe('https://freebuff.com:8443/api/auth/cli/status')
    expect(redactUrlForLog('https://freebuff.com/api/v1/me')).toBe(
      'https://freebuff.com/api/v1/me',
    )
  })

  test('strips the same parts from a relative or malformed URL', () => {
    expect(redactUrlForLog('/api/auth/cli/status?fingerprintHash=h')).toBe(
      '/api/auth/cli/status',
    )
    expect(redactUrlForLog('http://u:p@[bad/path?token=t')).toBe(
      'http://[bad/path',
    )
  })
})

describe('summarizeRequestBodyForLog', () => {
  test('keeps the shape of the request, never its content', () => {
    const summary = summarizeRequestBodyForLog({
      model: 'm',
      messages: [{ role: 'user', content: PROMPT }],
      temperature: 0,
    })
    expect(summary).toEqual({
      model: 'm',
      messageCount: 1,
      keys: ['model', 'messages', 'temperature'],
      bytes: expect.any(Number),
    })
    expect(JSON.stringify(summary)).not.toContain(PROMPT)
  })

  test('ignores values that are not a request body', () => {
    expect(summarizeRequestBodyForLog(undefined)).toBeUndefined()
    expect(summarizeRequestBodyForLog('text')).toBeUndefined()
    expect(summarizeRequestBodyForLog([1, 2])).toBeUndefined()
  })
})

describe('redactHeadersForLog', () => {
  test('redacts credential headers from records and Headers', () => {
    const expected = {
      authorization: '[redacted]',
      'x-goog-api-key': '[redacted]',
      'x-auth-token': '[redacted]',
      'x-ratelimit-remaining-tokens': '9',
      'content-type': 'text/plain',
    }
    const input = {
      authorization: 'Bearer sk-1',
      'x-goog-api-key': 'k',
      'x-auth-token': 't',
      'x-ratelimit-remaining-tokens': '9',
      'content-type': 'text/plain',
    }
    expect(redactHeadersForLog(input)).toEqual(expected)
    expect(redactHeadersForLog(new Headers(input))).toEqual(expected)
  })
})

describe('getErrorObject on an AI SDK APICallError', () => {
  test('summarizes the request body and strips the URL query', () => {
    const errorObject = getErrorObject(providerError())
    expect(JSON.stringify(errorObject)).not.toContain(PROMPT)
    expect(JSON.stringify(errorObject)).not.toContain('requestBodyValues')
    expect(errorObject.requestBody).toEqual({
      model: 'byok-model',
      messageCount: 2,
      keys: ['model', 'messages', 'tools'],
      bytes: expect.any(Number),
    })
    expect(errorObject.url).toBe('https://api.example.com/v1/chat/completions')
    expect(errorObject.statusCode).toBe(400)
    expect(errorObject.responseBody).toBe('{"error":"bad"}')
  })

  test('applies the same redaction to rawError, through causes', () => {
    const fetchError = Object.assign(new Error('Unable to connect'), {
      code: 'ConnectionRefused',
      path: 'https://freebuff.com/api/auth/cli/status?fingerprintHash=h',
    })
    const wrapper = new Error('Failed after 3 attempts') as Error & {
      lastError: unknown
    }
    // Assigned, as codebuff-api.ts does, so it is enumerable and serialized.
    wrapper.cause = fetchError
    wrapper.lastError = providerError()

    const { rawError } = getErrorObject(wrapper, { includeRawError: true })
    expect(rawError).toBeDefined()
    for (const secret of [
      PROMPT,
      'sk-query',
      'sk-header',
      'session=abc',
      'user:pass',
      'fingerprintHash',
    ]) {
      expect(rawError).not.toContain(secret)
    }
    const raw = JSON.parse(rawError!)
    expect(raw.lastError.requestBodyValues.messageCount).toBe(2)
    expect(raw.lastError.responseHeaders['x-ratelimit-remaining-tokens']).toBe(
      '1000',
    )
    expect(raw.lastError.url).toBe(
      'https://api.example.com/v1/chat/completions',
    )
    expect(raw.cause.path).toBe('https://freebuff.com/api/auth/cli/status')
  })
})

describe('serializeLogData on an AI SDK APICallError', () => {
  test('logs the request shape and redacted headers, not the prompt or keys', () => {
    const serialized = serializeLogData({ error: providerError() })!
    expect(serialized).not.toContain(PROMPT)
    expect(serialized).not.toContain('sk-header')
    expect(serialized).not.toContain('session=abc')
    expect(serialized).not.toContain('sk-query')
    const { error } = JSON.parse(serialized)
    expect(error.requestBodyValues).toMatchObject({
      model: 'byok-model',
      messageCount: 2,
    })
    expect(error.responseHeaders['content-type']).toBe('application/json')
    expect(error.message).toBe('Bad Request')
  })
})
