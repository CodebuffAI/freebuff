import { describe, expect, test } from 'bun:test'

import {
  HostedServiceUnavailableError,
  callWebSearchAPI,
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
