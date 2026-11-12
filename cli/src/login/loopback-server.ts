/**
 * The CLI's half of the loopback proof (@codebuff/common/util/cli-login-loopback),
 * so a terminal sign-in connects without the Connect click on any network,
 * as Desktop's does.
 *
 * While the login modal waits, a tiny server on 127.0.0.1 opens the login in
 * the browser through itself (`/auth/login/launch/<token>`, adding
 * `loopback_port` to the hosted URL) and answers `/onboard`'s challenge for
 * this attempt's own code (`/auth/login/confirm`). The URL printed for copying
 * stays the plain one: a browser on another machine never reaches this
 * server, so it keeps the network rule and the button.
 *
 * Only where the browser the CLI opens runs on this machine: macOS and
 * Windows, outside SSH and cloud IDEs. Linux is left out on purpose for now:
 * containers, WSL and forwarded X sessions open a browser that cannot reach
 * this loopback, and a failed launch would hide the login page.
 */
import { randomBytes } from 'node:crypto'

import { CLI_AUTH_CODE_LIFETIME_MS } from '@codebuff/common/constants/auth'
import {
  CLI_LOGIN_CHALLENGE_PARAM,
  CLI_LOGIN_CONFIRM_PATH,
  CLI_LOGIN_LOOPBACK_PORT_PARAM,
  cliLoginConfirmRedirect,
  cliLoginLoopbackPort,
  isCliLoginChallenge,
} from '@codebuff/common/util/cli-login-loopback'

import { cloudIdeOf } from '../utils/client-environment'

import type { CliEnv } from '../types/env'

const LAUNCH_PREFIX = '/auth/login/launch/'

export interface LoginLoopback {
  /** Open this in the browser instead of the hosted URL. */
  launchUrl: string
  stop(): void
}

/** Whether a browser the CLI opens will run on this machine. */
export function loginLoopbackSupported(
  env: CliEnv,
  platform: NodeJS.Platform,
): boolean {
  if (platform !== 'darwin' && platform !== 'win32') return false
  if (env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY) return false
  return cloudIdeOf(env) === 'none'
}

/** `127.0.0.1:<port>` or `localhost:<port>`: refuses a DNS-rebound page. */
function isOwnHost(host: string | null, port: number): boolean {
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`
}

const text = (body: string, status: number) =>
  new Response(body, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  })

const redirect = (location: string) =>
  new Response(null, {
    status: 302,
    headers: {
      location,
      'referrer-policy': 'no-referrer',
      'cache-control': 'no-store',
    },
  })

let active: LoginLoopback | null = null

/**
 * Starts the server for one login attempt, replacing any earlier one. Null
 * when it cannot listen: the caller opens the hosted URL as before.
 */
export function startLoginLoopback(params: {
  hostedLoginUrl: string
  fingerprintHash: string
  lifetimeMs?: number
}): LoginLoopback | null {
  stopLoginLoopback()
  try {
    const launchToken = randomBytes(32).toString('base64url')
    let hostedWithPort = params.hostedLoginUrl
    let port = 0
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(req) {
        if (req.method !== 'GET' || !isOwnHost(req.headers.get('host'), port)) {
          return text('forbidden', 403)
        }
        const url = new URL(req.url)
        if (url.pathname.startsWith(LAUNCH_PREFIX)) {
          return url.pathname.slice(LAUNCH_PREFIX.length) === launchToken
            ? redirect(hostedWithPort)
            : text('This sign-in link has expired. Start again from the terminal.', 410)
        }
        if (url.pathname === CLI_LOGIN_CONFIRM_PATH) {
          const challenge = url.searchParams.get(CLI_LOGIN_CHALLENGE_PARAM)
          return isCliLoginChallenge(challenge)
            ? redirect(
                cliLoginConfirmRedirect({
                  hostedLoginUrl: hostedWithPort,
                  fingerprintHash: params.fingerprintHash,
                  challenge,
                }),
              )
            : text('Start again from the terminal.', 410)
        }
        return text('not found', 404)
      },
    })
    const listening = cliLoginLoopbackPort(server.port)
    if (!listening) {
      server.stop(true)
      return null
    }
    port = listening
    const hosted = new URL(params.hostedLoginUrl)
    hosted.searchParams.set(CLI_LOGIN_LOOPBACK_PORT_PARAM, String(port))
    hostedWithPort = hosted.toString()

    // Never outlives the code it answers for, even if nothing stops it.
    const timer = setTimeout(
      () => stop(),
      params.lifetimeMs ?? CLI_AUTH_CODE_LIFETIME_MS,
    )
    timer.unref?.()
    const handle: LoginLoopback = {
      launchUrl: `http://127.0.0.1:${port}${LAUNCH_PREFIX}${launchToken}`,
      stop,
    }
    function stop() {
      clearTimeout(timer)
      server.stop(true)
      if (active === handle) active = null
    }
    active = handle
    return handle
  } catch {
    return null
  }
}

export function stopLoginLoopback(): void {
  active?.stop()
}
