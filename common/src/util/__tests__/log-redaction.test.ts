import { APICallError } from 'ai'
import { describe, expect, test } from 'bun:test'

import { getErrorObject } from '../error'
import { serializeLogData } from '../log-data'
import {
  redactConvexKeysForLog,
  redactHeadersForLog,
  redactQueryErrorForLog,
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

  // The Axiom / Convex-ingest path used to redact fewer fields than
  // getErrorObject's raw dump (AB827V0 finding 342, 186 residual).
  test('redacts request headers and a URL-valued path, like getErrorObject', () => {
    const error = Object.assign(new Error('fetch failed'), {
      requestHeaders: { authorization: 'Bearer sk-request-header' },
      path: 'https://freebuff.com/api/auth/cli/status?fingerprintHash=fp-secret',
    })
    const serialized = serializeLogData({ error })!
    expect(serialized).not.toContain('sk-request-header')
    expect(serialized).not.toContain('fp-secret')
    expect(JSON.parse(serialized).error.path).toBe(
      'https://freebuff.com/api/auth/cli/status',
    )
  })
})

describe('redactQueryErrorForLog', () => {
  // freebuff-web's 2026-10-19 `LinkAccountError` line: drizzle's message
  // carried the Google access token and ID token being inserted.
  const query =
    'insert into "account" ("userId", "access_token", "id_token") values ($1, $2, $3)'
  const params = ['user-1', 'ya29.access-secret', 'eyJ.id-secret']
  function queryError() {
    const cause = Object.assign(new Error('duplicate key value'), {
      code: '23505',
    })
    const error = new Error(`Failed query: ${query}\nparams: ${params}`, {
      cause,
    })
    error.name = 'DrizzleQueryError'
    return Object.assign(error, { query, params })
  }

  test('keeps the statement and cause, never the params', () => {
    const redacted = redactQueryErrorForLog(queryError())
    expect(redacted).toBeInstanceOf(Error)
    expect(redacted.name).toBe('DrizzleQueryError')
    expect(redacted.message).toBe(
      `Failed query: ${query}\nparams: [3 params omitted]`,
    )
    expect(redacted.stack).toStartWith(`DrizzleQueryError: ${redacted.message}`)
    expect(redacted.stack).toContain('    at ')
    expect(redacted.query).toBe(query)
    expect(redacted.params).toBe('[3 params omitted]' as never)
    expect((redacted.cause as { code: string }).code).toBe('23505')
    for (const out of [
      JSON.stringify({ ...redacted }),
      redacted.message,
      redacted.stack,
      serializeLogData({ error: queryError() }),
      JSON.stringify(getErrorObject(queryError(), { includeRawError: true })),
    ]) {
      expect(out).not.toContain('ya29.access-secret')
      expect(out).not.toContain('eyJ.id-secret')
    }
  })

  test('returns any other value unchanged', () => {
    const plain = new Error('boom')
    expect(redactQueryErrorForLog(plain)).toBe(plain)
    expect(redactQueryErrorForLog('text')).toBe('text')
    expect(redactQueryErrorForLog(undefined)).toBeUndefined()
  })
})

describe('redactConvexKeysForLog', () => {
  // Synthetic, in the shape Convex mints (base64 JSON starting `{"v2":`).
  const TOKEN = 'eyJ2MiI6ImFiY2RlZjAxMjM0NTY3ODkwYWJjZGVmIn0='

  test('keeps the deployment name of a deploy key, drops the token', () => {
    // The create_deploy_key response body management_api logged until 2026-10-27.
    const body = JSON.stringify({ deployKey: `dev:brave-otter-123|${TOKEN}` })
    expect(redactConvexKeysForLog(body)).toBe(
      '{"deployKey":"dev:brave-otter-123|[redacted]"}',
    )
    expect(redactConvexKeysForLog(`prod:calm-fox-9|${TOKEN}`)).toBe(
      'prod:calm-fox-9|[redacted]',
    )
    expect(redactConvexKeysForLog(`preview:team:project:branch|${TOKEN}`)).toBe(
      'preview:team:project:branch|[redacted]',
    )
  })

  test('admin keys in a request header and in a CLI error URL', () => {
    expect(
      redactConvexKeysForLog(`Authorization: 'Convex calm-fox-9|${TOKEN}'`),
    ).toBe("Authorization: 'Convex calm-fox-9|[redacted]'")
    // `convex env list` handed a key where it wanted a deployment name.
    expect(
      redactConvexKeysForLog(
        `✖ Error fetching GET  https://api.convex.dev/api/deployment/calm-fox-9|${TOKEN} 400 Bad Request`,
      ),
    ).toBe(
      '✖ Error fetching GET  https://api.convex.dev/api/deployment/calm-fox-9|[redacted] 400 Bad Request',
    )
    expect(redactConvexKeysForLog(`my-instance|${'a1'.repeat(32)}`)).toBe(
      'my-instance|[redacted]',
    )
  })

  test('bare access tokens and command-line assignments', () => {
    expect(redactConvexKeysForLog(`Authorization: 'Bearer ${TOKEN}'`)).toBe(
      "Authorization: 'Bearer [redacted]'",
    )
    expect(
      redactConvexKeysForLog(
        `CONVEX_DEPLOY_KEY='prod:calm-fox-9|${TOKEN}' bun run convex deploy`,
      ),
    ).toBe("CONVEX_DEPLOY_KEY='[redacted]' bun run convex deploy")
    expect(
      redactConvexKeysForLog('CONVEX_SELF_HOSTED_ADMIN_KEY=abc123 npx convex'),
    ).toBe('CONVEX_SELF_HOSTED_ADMIN_KEY=[redacted] npx convex')
  })

  test('leaves key references and ordinary text alone', () => {
    for (const text of [
      'CONVEX_DEPLOY_KEY=$(cat $HOME/.vly-convex/dev.key) npx convex export',
      '[Management API] Creating deploy key for: calm-fox-9',
      'Request failed with status code 401',
      'a | b',
    ]) {
      expect(redactConvexKeysForLog(text)).toBe(text)
    }
  })
})
