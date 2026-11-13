/**
 * Loopback proof for CLI and Desktop sign-in: how `/onboard` connects an app
 * without the Connect click on any network (RFC 8252 §7.3, loopback redirect).
 *
 * A login code is minted without authentication, so a link that connected on
 * sight would hand the signed-in person's session to whoever minted it. The
 * Connect click guards that. The same-place rule
 * (`@codebuff/auth/cli-login-network`) skips it when the app and the browser
 * are in the same country and neither is on a VPN or other anonymizing
 * network; this skips it on any network, VPN included, because the proof
 * travels through the app itself:
 *
 * 1. The app runs an HTTP server on 127.0.0.1 and opens the login through it,
 *    so the hosted login URL it hands the browser carries `loopback_port`.
 * 2. When `/onboard` would otherwise show Connect, it stores a fresh random
 *    challenge in an HttpOnly cookie and sends the browser to
 *    `http://127.0.0.1:<port>/auth/login/confirm?challenge=…`.
 * 3. The app answers with a redirect to `/onboard` for ITS OWN code, carrying
 *    `cli_bind` = HMAC(fingerprintHash, challenge).
 * 4. `/onboard` recomputes it from the cookie and the code's hash. A match
 *    proves this browser just passed through the app holding the code's
 *    polling secret (`fingerprintHash`, which no browser ever sees), on this
 *    machine. The approval then submits itself.
 *
 * A link minted by someone else cannot pass. Its challenge goes to the
 * victim's own loopback, where the attacker's app is not; the attacker knows
 * their code's hash but never sees the challenge (it lives in the victim's
 * cookie and the victim's loopback request); and an app that is listening
 * there answers for its own code, never for the one in the link. Anything
 * missing or wrong falls back to the same-place rule and then the button.
 *
 * Nothing here is secret: the HMAC key is the per-code hash the app already
 * holds. Shared by the web app (verifier), Desktop and the CLI (provers).
 */
import { constantTimeEquals, hmacSha256Base64Url } from './hmac'

/** On the hosted login URL: the app's loopback port. Added only by the app's
 *  own loopback redirect, so a browser that has it reached that server. */
export const CLI_LOGIN_LOOPBACK_PORT_PARAM = 'loopback_port'
/** On the app's redirect back to `/onboard`: the proof. */
export const CLI_LOGIN_BIND_PARAM = 'cli_bind'
/** On the redirect to the app: the challenge `/onboard` stored. */
export const CLI_LOGIN_CHALLENGE_PARAM = 'challenge'
/** The app's route that answers a challenge. Not under `/api/`: a browser
 *  navigates to it, like the launch route. */
export const CLI_LOGIN_CONFIRM_PATH = '/auth/login/confirm'

const DOMAIN = 'freebuff-cli-login-bind:v1'
/** 32 random bytes, and an HMAC-SHA256, are both 43 base64url characters. */
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/
const PORT_RE = /^[1-9][0-9]{3,4}$/

/** The loopback port a login URL names, or null. Privileged ports are
 *  refused: no app of ours listens below 1024. */
export function cliLoginLoopbackPort(value: unknown): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const text = String(value)
  if (!PORT_RE.test(text)) return null
  const port = Number(text)
  return port >= 1024 && port <= 65_535 ? port : null
}

export function isCliLoginChallenge(value: unknown): value is string {
  return typeof value === 'string' && TOKEN_RE.test(value)
}

/** What the app sends back for a challenge, keyed by its code's hash. */
export function cliLoginBindProof(
  fingerprintHash: string,
  challenge: string,
): string {
  return hmacSha256Base64Url(fingerprintHash, `${DOMAIN}\n${challenge}`)
}

/** Whether `proof` answers `challenge` for the code whose hash is given.
 *  False for anything missing or malformed. */
export function verifyCliLoginBindProof(params: {
  fingerprintHash: string
  challenge: string | null | undefined
  proof: unknown
}): boolean {
  if (!params.fingerprintHash) return false
  if (!isCliLoginChallenge(params.challenge)) return false
  if (typeof params.proof !== 'string' || !TOKEN_RE.test(params.proof)) {
    return false
  }
  return constantTimeEquals(
    cliLoginBindProof(params.fingerprintHash, params.challenge),
    params.proof,
  )
}

/** Where `/onboard` sends the browser: always 127.0.0.1, whatever the link
 *  says. Only the port comes from the link. */
export function cliLoginConfirmUrl(port: number, challenge: string): string {
  const url = new URL(`http://127.0.0.1:${port}${CLI_LOGIN_CONFIRM_PATH}`)
  url.searchParams.set(CLI_LOGIN_CHALLENGE_PARAM, challenge)
  return url.toString()
}

/**
 * The app's answer to a challenge: its own hosted login URL, moved to
 * `/onboard` and carrying the proof. `hostedLoginUrl` is the URL the app was
 * issued (with whatever the app added); every parameter on it is kept, so the
 * flow's attribution and the loopback port survive a fresh sign-in.
 */
export function cliLoginConfirmRedirect(params: {
  hostedLoginUrl: string
  fingerprintHash: string
  challenge: string
}): string {
  const url = new URL(params.hostedLoginUrl)
  url.pathname = '/onboard'
  url.hash = ''
  url.searchParams.set(
    CLI_LOGIN_BIND_PARAM,
    cliLoginBindProof(params.fingerprintHash, params.challenge),
  )
  return url.toString()
}
