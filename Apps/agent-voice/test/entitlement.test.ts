import { describe, expect, test } from 'bun:test'
import { parseActivationUrl } from '../src/lib/entitlement'
import { paddleConfigFromEnv } from '../src/lib/paddle'

const TXN = 'txn_01m45q62gzqns1n98dwp38038q'

describe('parseActivationUrl', () => {
  test('accepts the host form Paddle redirects to', () => {
    expect(parseActivationUrl(`agentvoice://activate?code=${TXN}`)).toEqual({
      ok: true,
      code: TXN,
    })
  })

  test('accepts the triple-slash form some platforms deliver', () => {
    expect(parseActivationUrl('agentvoice:///activate?code=txn_01abc')).toEqual(
      {
        ok: true,
        code: 'txn_01abc',
      },
    )
  })

  test('trims the code', () => {
    expect(
      parseActivationUrl('agentvoice://activate?code=%20txn_9%20'),
    ).toEqual({
      ok: true,
      code: 'txn_9',
    })
  })

  test('still accepts the legacy key parameter', () => {
    expect(parseActivationUrl(`agentvoice://activate?key=${TXN}`)).toEqual({
      ok: true,
      code: TXN,
    })
  })

  test('rejects foreign schemes, other actions and missing codes', () => {
    expect(
      parseActivationUrl(`https://example.com/activate?code=${TXN}`),
    ).toEqual({
      ok: false,
      reason: 'malformed',
    })
    expect(parseActivationUrl('not a url')).toEqual({
      ok: false,
      reason: 'malformed',
    })
    expect(parseActivationUrl(`agentvoice://settings?code=${TXN}`)).toEqual({
      ok: false,
      reason: 'not-an-activation',
    })
    expect(parseActivationUrl('agentvoice://activate')).toEqual({
      ok: false,
      reason: 'missing-code',
    })
    expect(parseActivationUrl('agentvoice://activate?code=')).toEqual({
      ok: false,
      reason: 'missing-code',
    })
  })
})

describe('paddleConfigFromEnv', () => {
  test('returns null without a token or price id', () => {
    expect(paddleConfigFromEnv({}, 'device-1')).toBeNull()
    expect(
      paddleConfigFromEnv({ VITE_PADDLE_TOKEN: 'tok' }, 'device-1'),
    ).toBeNull()
    expect(
      paddleConfigFromEnv({ VITE_PADDLE_PRICE_ID: 'pri' }, 'device-1'),
    ).toBeNull()
  })

  test('defaults to the sandbox environment', () => {
    const config = paddleConfigFromEnv(
      { VITE_PADDLE_TOKEN: 'tok', VITE_PADDLE_PRICE_ID: 'pri' },
      'device-9',
    )
    expect(config).toEqual({
      token: 'tok',
      priceId: 'pri',
      environment: 'sandbox',
      deviceId: 'device-9',
    })
  })

  test('honours an explicit production flag', () => {
    expect(
      paddleConfigFromEnv(
        {
          VITE_PADDLE_TOKEN: 'tok',
          VITE_PADDLE_PRICE_ID: 'pri',
          VITE_PADDLE_ENV: 'production',
        },
        'd',
      )?.environment,
    ).toBe('production')
  })
})
