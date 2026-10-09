/**
 * The CLI's transport for the profile survey (COD-779): GET/POST
 * `/api/profile-survey` on freebuff.com, wire types from the shared contract.
 *
 * Same origin, auth and User-Agent as the sponsored-proposal calls
 * (`sponsored-proposal-api.ts`): `FREEBUFF_WEB_URL` (localhost:3002 in a dev
 * build), the CLI's session token as a Bearer, and the product User-Agent.
 *
 * Fails soft. A survey is optional; a network error reads as "don't show" on
 * GET and as `{ ok: false }` on POST, logged at debug, never surfaced.
 */

import { sanitizeTerminalStrings } from '@codebuff/common/util/terminal-safe-text'

import { FREEBUFF_WEB_URL } from '../login/constants'

import { getCliAdRequestUserAgent } from './ad-client-identity'
import { getAuthToken } from './auth'
import { logger } from './logger'

import type {
  ProfileSurveyRequest,
  ProfileSurveyResponse,
  ProfileSurveyStateResponse,
} from '@codebuff/common/constants/freebuff-profile-survey'

export const PROFILE_SURVEY_PATH = '/api/profile-survey'
const REQUEST_TIMEOUT_MS = 10_000

/**
 * A request as the CLI sends it: the contract's request, with `surface`
 * (where the contract has one) pinned to `'cli'`.
 */
export type CliProfileSurveyRequest = ProfileSurveyRequest & {
  surface?: 'cli'
}

export interface ProfileSurveyClient {
  getState(): Promise<ProfileSurveyStateResponse>
  post(request: CliProfileSurveyRequest): Promise<ProfileSurveyResponse>
}

const SIGNED_OUT: ProfileSurveyStateResponse = {
  show: false,
  reason: 'signed_out',
}

type HttpClientDeps = {
  baseUrl?: string
  getToken?: () => string | undefined
  fetchImpl?: typeof fetch
}

export function createHttpProfileSurveyClient(
  deps: HttpClientDeps = {},
): ProfileSurveyClient {
  const base = (deps.baseUrl ?? FREEBUFF_WEB_URL).replace(/\/+$/, '')
  const getToken = deps.getToken ?? getAuthToken
  const fetchImpl = deps.fetchImpl ?? fetch

  const request = async (
    method: 'GET' | 'POST',
    token: string,
    payload?: CliProfileSurveyRequest,
  ): Promise<unknown> => {
    const response = await fetchImpl(`${base}${PROFILE_SURVEY_PATH}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        'user-agent': getCliAdRequestUserAgent(),
        ...(payload ? { 'content-type': 'application/json' } : {}),
      },
      ...(payload ? { body: JSON.stringify(payload) } : {}),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    const body = await response.json().catch(() => null)
    if (!response.ok) {
      const error =
        body && typeof body === 'object' && 'error' in body
          ? String((body as { error: unknown }).error)
          : `http_${response.status}`
      return { ok: false, error }
    }
    return body
  }

  return {
    async getState() {
      const token = getToken()
      if (!token) return SIGNED_OUT
      try {
        const body = await request('GET', token)
        // Question and option labels are drawn in the terminal: strip escape
        // sequences at the source, as every other server-text path does.
        const state = sanitizeTerminalStrings(body) as ProfileSurveyStateResponse
        if (!isStateResponse(state)) {
          return { show: false, reason: 'no_active_version' }
        }
        return state
      } catch (error) {
        logger.debug({ error }, '[profile-survey] GET failed')
        return { show: false, reason: 'no_active_version' }
      }
    },
    async post(payload) {
      const token = getToken()
      if (!token) return { ok: false, error: 'signed_out' }
      try {
        const body = (await request('POST', token, payload)) as
          | ProfileSurveyResponse
          | null
        if (!body || typeof body !== 'object' || !('ok' in body)) {
          return { ok: false, error: 'bad_response' }
        }
        return body
      } catch (error) {
        logger.debug({ error, action: payload.action }, '[profile-survey] POST failed')
        return { ok: false, error: 'network' }
      }
    },
  }
}

function isStateResponse(value: unknown): value is ProfileSurveyStateResponse {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  if (v.show === false) return true
  return (
    v.show === true &&
    typeof v.version === 'number' &&
    Array.isArray(v.questions) &&
    Array.isArray(v.answers) &&
    typeof v.resumeAt === 'number' &&
    typeof v.rewardFreebucks === 'number'
  )
}

// ---- fake, for tests and local previews -------------------------------

export type FakeProfileSurveyClient = ProfileSurveyClient & {
  requests: CliProfileSurveyRequest[]
  getCalls: number
}

/**
 * An in-memory server: engagement events are recorded (and only listed in
 * `requests`), answers are stored, the last one completes and pays
 * `rewardFreebucks` once (0 when every answer is notApplicable is the
 * server's rule; the fake keeps it simple and pays whatever it was given).
 */
export function createFakeProfileSurveyClient(
  state: ProfileSurveyStateResponse,
  options: { stopped?: boolean; failPosts?: boolean } = {},
): FakeProfileSurveyClient {
  const answered = new Set<string>(
    state.show ? state.answers.map((a) => a.questionId) : [],
  )
  let paid = false
  const client: FakeProfileSurveyClient = {
    requests: [],
    getCalls: 0,
    async getState() {
      client.getCalls++
      return state
    },
    async post(request) {
      client.requests.push(request)
      if (options.failPosts) return { ok: false, error: 'fake_failure' }
      if (request.action === 'dismiss') {
        return {
          ok: true,
          dismissed: true,
          stopped: options.stopped ?? false,
          snoozedUntil: options.stopped
            ? null
            : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        }
      }
      if (request.action === 'clear') return { ok: true, cleared: true }
      if (request.action === 'event') return { ok: true, recorded: true }
      answered.add(request.questionId)
      const total = state.show ? state.questions.length : 0
      if (answered.size < total) return { ok: true, completed: false }
      const reward = !paid && state.show ? state.rewardFreebucks : 0
      paid = true
      return { ok: true, completed: true, rewardedFreebucks: reward }
    },
  }
  return client
}
