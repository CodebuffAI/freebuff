import { describe, expect, test } from 'bun:test'
import { parseActivationUrl } from '../src/lib/entitlement'
import { paddleConfigFromEnv } from '../src/lib/paddle'

describe('parseActivationUrl', () => {
  test('accepts the host form Paddle redirects to', () => {
    expect(
      parseActivationUrl('agentvoice://activate?key=PA-1234-5678'),
    ).toEqual({
      ok: true,
      key: 'PA-1234-5678',
    })
  })

  test('accepts the triple-slash form some platforms deliver', () => {
    expect(parseActivationUrl('agentvoice:///activate?key=PA-1234')).toEqual({
      ok: true,
      key: 'PA-1234',
    })
  })

  test('trims the key', () => {
    expect(parseActivationUrl('agentvoice://activate?key=%20PA-9%20')).toEqual({
      ok: true,
      key: 'PA-9',
    })
  })

  test('rejects foreign schemes, other actions and missing keys', () => {
    expect(parseActivationUrl('https://example.com/activate?key=PA-1')).toEqual(
      {
        ok: false,
        reason: 'malformed',
      },
    )
    expect(parseActivationUrl('not a url')).toEqual({
      ok: false,
      reason: 'malformed',
    })
    expect(parseActivationUrl('agentvoice://settings?key=PA-1')).toEqual({
      ok: false,
      reason: 'not-an-activation',
    })
    expect(parseActivationUrl('agentvoice://activate')).toEqual({
      ok: false,
      reason: 'missing-key',
    })
    expect(parseActivationUrl('agentvoice://activate?key=')).toEqual({
      ok: false,
      reason: 'missing-key',
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
