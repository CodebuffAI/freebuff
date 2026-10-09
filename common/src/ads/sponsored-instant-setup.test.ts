import { describe, expect, test } from 'bun:test'

import {
  declaredInstantSetup,
  parseInstantSetupDeclaration,
  parseInstantSetupResponse,
  signupUrlHasEmailSlot,
  signupUrlWithEmail,
} from './sponsored-instant-setup'

const CREDENTIAL =
  'requires-credential: env=SIEVE_API_KEY label="Sieve API key" get_url=https://sieve.example/signup?bfcid={bfcid}'
const SETUP =
  'instant-setup: env=SIEVE_API_KEY endpoint=https://api.sieve.example/freebuff/instant-setup'

describe('declaredInstantSetup', () => {
  test('reads one declaration matching the one declared credential', () => {
    expect(
      declaredInstantSetup(['Step 1', CREDENTIAL, SETUP].join('\n')),
    ).toEqual({
      env: 'SIEVE_API_KEY',
      endpoint: 'https://api.sieve.example/freebuff/instant-setup',
    })
  })

  test.each([
    ['no credential', SETUP],
    ['no declaration', CREDENTIAL],
    ['a second line', [CREDENTIAL, SETUP, SETUP].join('\n')],
    [
      'another env',
      [
        CREDENTIAL,
        'instant-setup: env=OTHER_API_KEY endpoint=https://api.sieve.example/x',
      ].join('\n'),
    ],
    [
      'two credentials',
      [
        CREDENTIAL,
        'requires-credential: env=SIEVE_SECRET label=Secret',
        SETUP,
      ].join('\n'),
    ],
  ])('declares nothing with %s', (_, procedure) => {
    expect(declaredInstantSetup(procedure)).toBeNull()
  })

  test.each([
    'env=SIEVE_API_KEY endpoint=http://api.sieve.example/x',
    'env=SIEVE_API_KEY endpoint=https://user:pw@api.sieve.example/x',
    'env=SIEVE_API_KEY endpoint=https://api.sieve.example/x#frag',
    'env=SIEVE_API_KEY endpoint=https://api.sieve.example/x?bfcid={bfcid}',
    'env=PATH endpoint=https://api.sieve.example/x',
    'env=SIEVE_API_KEY',
    'env=SIEVE_API_KEY endpoint=https://api.sieve.example/x extra=1',
    'env=SIEVE_API_KEY endpoint=https://api.sieve.example/x stray',
  ])('refuses %s', (line) => {
    expect(parseInstantSetupDeclaration(line)).toBeNull()
  })
})

describe('parseInstantSetupResponse', () => {
  test('accepts a key with optional fields', () => {
    expect(
      parseInstantSetupResponse({
        api_key: 'sk_live_abcdefgh',
        scope: 'projects:write',
        expires_in: 86400,
        account: 'created',
        extra: true,
      }),
    ).toEqual({
      apiKey: 'sk_live_abcdefgh',
      scope: 'projects:write',
      expiresInSeconds: 86400,
      account: 'created',
    })
  })

  test.each([
    [null],
    [[]],
    [{}],
    [{ api_key: 'short' }],
    [{ api_key: 'has a space in it' }],
    [{ api_key: 'sk_live_abcdefgh', expires_in: -1 }],
    [{ api_key: 'sk_live_abcdefgh', expires_in: 1.5 }],
    [{ api_key: 'sk_live_abcdefgh', scope: 42 }],
    [{ api_key: 'sk_live_abcdefgh', account: 'maybe' }],
  ])('refuses %j', (body) => {
    expect(parseInstantSetupResponse(body)).toBeNull()
  })
})

describe('signupUrlWithEmail', () => {
  const url = 'https://sieve.example/signup?email={email}&bfcid=bfc_1.p.s'

  test('fills the slot with consent', () => {
    expect(signupUrlHasEmailSlot(url)).toBe(true)
    expect(signupUrlWithEmail(url, 'ada+test@example.com')).toBe(
      'https://sieve.example/signup?email=ada%2Btest%40example.com&bfcid=bfc_1.p.s',
    )
  })

  test('removes the parameter without consent', () => {
    expect(signupUrlWithEmail(url, null)).toBe(
      'https://sieve.example/signup?bfcid=bfc_1.p.s',
    )
  })

  test('accepts the URL-encoded slot', () => {
    expect(
      signupUrlWithEmail('https://sieve.example/s?e=%7Bemail%7D', null),
    ).toBe('https://sieve.example/s')
  })

  test('removes the parameter for an unusable address', () => {
    expect(signupUrlWithEmail(url, 'not an email')).toBe(
      'https://sieve.example/signup?bfcid=bfc_1.p.s',
    )
  })

  test('leaves a URL without a slot alone', () => {
    expect(signupUrlHasEmailSlot('https://sieve.example/s?bfcid=x')).toBe(false)
    expect(
      signupUrlWithEmail('https://sieve.example/s?bfcid=x', 'a@b.co'),
    ).toBe('https://sieve.example/s?bfcid=x')
  })

  test('refuses a slot it cannot remove', () => {
    expect(
      signupUrlWithEmail('https://sieve.example/{email}/signup', null),
    ).toBeNull()
    expect(
      signupUrlWithEmail('https://sieve.example/s?next=/x?e={email}', null),
    ).toBeNull()
  })
})
