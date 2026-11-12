import { randomBytes } from 'node:crypto'

import { describe, expect, test } from 'bun:test'

import {
  CLI_LOGIN_BIND_PARAM,
  cliLoginBindProof,
  cliLoginConfirmRedirect,
  cliLoginConfirmUrl,
  cliLoginLoopbackPort,
  isCliLoginChallenge,
  verifyCliLoginBindProof,
} from '../cli-login-loopback'

const HASH = 'a'.repeat(64)
const challenge = () => randomBytes(32).toString('base64url')

describe('cliLoginLoopbackPort', () => {
  test('accepts an unprivileged port as a string or number', () => {
    expect(cliLoginLoopbackPort('8787')).toBe(8787)
    expect(cliLoginLoopbackPort(54321)).toBe(54321)
    expect(cliLoginLoopbackPort('65535')).toBe(65535)
  })

  test('refuses privileged, out-of-range and malformed ports', () => {
    for (const value of [
      '80',
      '443',
      '1023',
      '65536',
      '08787',
      '8787 ',
      '8787.0',
      '-8787',
      '',
      null,
      undefined,
      ['8787'],
    ]) {
      expect(cliLoginLoopbackPort(value)).toBeNull()
    }
  })
})

describe('bind proof', () => {
  test('verifies the proof for the code it was made for', () => {
    const c = challenge()
    expect(isCliLoginChallenge(c)).toBe(true)
    const proof = cliLoginBindProof(HASH, c)
    expect(
      verifyCliLoginBindProof({ fingerprintHash: HASH, challenge: c, proof }),
    ).toBe(true)
  })

  test("another code's proof, or another challenge's, does not verify", () => {
    const c = challenge()
    const otherCode = cliLoginBindProof('b'.repeat(64), c)
    expect(
      verifyCliLoginBindProof({
        fingerprintHash: HASH,
        challenge: c,
        proof: otherCode,
      }),
    ).toBe(false)
    const otherChallenge = cliLoginBindProof(HASH, challenge())
    expect(
      verifyCliLoginBindProof({
        fingerprintHash: HASH,
        challenge: c,
        proof: otherChallenge,
      }),
    ).toBe(false)
  })

  test('no cookie, a malformed challenge or a missing proof never verifies', () => {
    const c = challenge()
    const proof = cliLoginBindProof(HASH, c)
    expect(
      verifyCliLoginBindProof({ fingerprintHash: HASH, challenge: null, proof }),
    ).toBe(false)
    expect(
      verifyCliLoginBindProof({
        fingerprintHash: HASH,
        challenge: 'short',
        proof: cliLoginBindProof(HASH, 'short'),
      }),
    ).toBe(false)
    expect(
      verifyCliLoginBindProof({
        fingerprintHash: HASH,
        challenge: c,
        proof: undefined,
      }),
    ).toBe(false)
    expect(
      verifyCliLoginBindProof({ fingerprintHash: '', challenge: c, proof }),
    ).toBe(false)
  })
})

describe('confirm URLs', () => {
  test('the confirm hop always targets 127.0.0.1', () => {
    const c = challenge()
    const url = new URL(cliLoginConfirmUrl(8787, c))
    expect(url.origin).toBe('http://127.0.0.1:8787')
    expect(url.pathname).toBe('/auth/login/confirm')
    expect(url.searchParams.get('challenge')).toBe(c)
  })

  test("the app's answer is its own login on /onboard, with the proof", () => {
    const c = challenge()
    const redirect = new URL(
      cliLoginConfirmRedirect({
        hostedLoginUrl:
          'https://freebuff.com/login?auth_code=tok_1234567890abcdefgh&desktop_flow=f&loopback_port=8787#x',
        fingerprintHash: HASH,
        challenge: c,
      }),
    )
    expect(redirect.origin).toBe('https://freebuff.com')
    expect(redirect.pathname).toBe('/onboard')
    expect(redirect.hash).toBe('')
    expect(redirect.searchParams.get('auth_code')).toBe(
      'tok_1234567890abcdefgh',
    )
    expect(redirect.searchParams.get('desktop_flow')).toBe('f')
    expect(redirect.searchParams.get('loopback_port')).toBe('8787')
    expect(redirect.searchParams.get(CLI_LOGIN_BIND_PARAM)).toBe(
      cliLoginBindProof(HASH, c),
    )
  })
})
