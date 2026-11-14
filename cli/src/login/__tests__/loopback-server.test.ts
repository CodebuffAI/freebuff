import { afterEach, describe, expect, test } from 'bun:test'

import { cliLoginBindProof } from '@codebuff/common/util/cli-login-loopback'

import {
  loginLoopbackSupported,
  startLoginLoopback,
  stopLoginLoopback,
} from '../loopback-server'

import type { CliEnv } from '../../types/env'

const HOSTED =
  'https://freebuff.com/login?auth_code=ownToken1234567890abc&cli_flow=5b6e7cae-dae8-4ea0-95cb-bc6c38efdd33'
const HASH = 'a'.repeat(64)
const CHALLENGE = 'c'.repeat(43)

const env = (vars: Partial<CliEnv> = {}) => vars as CliEnv

/** A navigation to the server, as a browser makes it: no redirect following. */
function get(url: string, host?: string) {
  const target = new URL(url)
  return fetch(url, {
    redirect: 'manual',
    headers: { host: host ?? target.host },
  })
}

afterEach(() => stopLoginLoopback())

describe('loginLoopbackSupported', () => {
  test('macOS and Windows terminals, where the opened browser is on this machine', () => {
    expect(loginLoopbackSupported(env(), 'darwin')).toBe(true)
    expect(loginLoopbackSupported(env(), 'win32')).toBe(true)
  })

  test('not Linux, SSH sessions or cloud IDEs: the browser may be elsewhere', () => {
    expect(loginLoopbackSupported(env(), 'linux')).toBe(false)
    expect(
      loginLoopbackSupported(env({ SSH_CONNECTION: '1.2.3.4 5 6.7.8.9 22' }), 'darwin'),
    ).toBe(false)
    expect(loginLoopbackSupported(env({ SSH_TTY: '/dev/ttys001' }), 'win32')).toBe(false)
    expect(loginLoopbackSupported(env({ CODESPACES: 'true' }), 'darwin')).toBe(false)
  })
})

describe('startLoginLoopback', () => {
  test('the launch URL opens the hosted login with this server\'s port', async () => {
    const loopback = startLoginLoopback({ hostedLoginUrl: HOSTED, fingerprintHash: HASH })!
    const launch = new URL(loopback.launchUrl)
    expect(launch.hostname).toBe('127.0.0.1')

    const res = await get(loopback.launchUrl)
    expect(res.status).toBe(302)
    const hosted = new URL(res.headers.get('location')!)
    expect(hosted.origin).toBe('https://freebuff.com')
    expect(hosted.searchParams.get('auth_code')).toBe('ownToken1234567890abc')
    expect(hosted.searchParams.get('loopback_port')).toBe(launch.port)
    expect(res.headers.get('referrer-policy')).toBe('no-referrer')
  })

  test('only the exact launch token redirects', async () => {
    const loopback = startLoginLoopback({ hostedLoginUrl: HOSTED, fingerprintHash: HASH })!
    const res = await get(`${loopback.launchUrl}x`)
    expect(res.status).toBe(410)
    expect(res.headers.get('location')).toBeNull()
  })

  test("a challenge is answered for this attempt's own code, on /onboard, with the proof", async () => {
    const loopback = startLoginLoopback({ hostedLoginUrl: HOSTED, fingerprintHash: HASH })!
    const port = new URL(loopback.launchUrl).port
    const res = await get(
      `http://127.0.0.1:${port}/auth/login/confirm?challenge=${CHALLENGE}`,
    )
    expect(res.status).toBe(302)
    const answer = new URL(res.headers.get('location')!)
    expect(answer.pathname).toBe('/onboard')
    expect(answer.searchParams.get('auth_code')).toBe('ownToken1234567890abc')
    expect(answer.searchParams.get('cli_flow')).toBe('5b6e7cae-dae8-4ea0-95cb-bc6c38efdd33')
    expect(answer.searchParams.get('loopback_port')).toBe(port)
    expect(answer.searchParams.get('cli_bind')).toBe(cliLoginBindProof(HASH, CHALLENGE))
  })

  test('a malformed challenge gets no proof', async () => {
    const loopback = startLoginLoopback({ hostedLoginUrl: HOSTED, fingerprintHash: HASH })!
    const port = new URL(loopback.launchUrl).port
    const res = await get(`http://127.0.0.1:${port}/auth/login/confirm?challenge=short`)
    expect(res.status).toBe(410)
    expect(res.headers.get('location')).toBeNull()
  })

  test('a foreign Host (a DNS-rebound page) is refused', async () => {
    const loopback = startLoginLoopback({ hostedLoginUrl: HOSTED, fingerprintHash: HASH })!
    const port = new URL(loopback.launchUrl).port
    for (const host of ['evil.example', `evil.example:${port}`, '127.0.0.1:1']) {
      const res = await get(
        `http://127.0.0.1:${port}/auth/login/confirm?challenge=${CHALLENGE}`,
        host,
      )
      expect(res.status).toBe(403)
    }
  })

  test('stopping it, or starting the next attempt, closes the port', async () => {
    const first = startLoginLoopback({ hostedLoginUrl: HOSTED, fingerprintHash: HASH })!
    const second = startLoginLoopback({ hostedLoginUrl: HOSTED, fingerprintHash: 'b'.repeat(64) })!
    await expect(get(first.launchUrl)).rejects.toThrow()
    expect((await get(second.launchUrl)).status).toBe(302)
    stopLoginLoopback()
    await expect(get(second.launchUrl)).rejects.toThrow()
  })

  test('it stops by itself when the code would have expired', async () => {
    const loopback = startLoginLoopback({
      hostedLoginUrl: HOSTED,
      fingerprintHash: HASH,
      lifetimeMs: 10,
    })!
    await Bun.sleep(50)
    await expect(get(loopback.launchUrl)).rejects.toThrow()
  })
})
