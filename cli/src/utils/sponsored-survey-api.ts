/**
 * The CLI's sponsored survey (COD-839): GET/POST `/api/sponsored-survey` on
 * freebuff.com, and the adapter that drives it through the profile survey's
 * machine and box (`profile-survey-machine.ts`), so its keys, numbering and
 * box are the profile survey's. Asked only when the profile survey has
 * nothing to show; the server offers at most one per Pacific day.
 *
 * Same origin, auth and User-Agent as `profile-survey-api.ts`. Fails soft: a
 * network error reads as "nothing to show" on GET and `{ ok: false }` on POST.
 */

import {
  createHttpSponsoredSurveyClient,
  SPONSORED_SURVEY_PATH,
  type SponsoredSurveyClient,
  type SponsoredSurveyOffer,
} from '@codebuff/common/constants/freebuff-sponsored-survey-client'
import { sanitizeTerminalStrings } from '@codebuff/common/util/terminal-safe-text'

import { FREEBUFF_WEB_URL } from '../login/constants'

import { getCliAdRequestUserAgent } from './ad-client-identity'
import { getAuthToken } from './auth'

import type { ProfileSurveyState } from './profile-survey-machine'
import type { ProfileSurveyQuestion } from '@codebuff/common/constants/freebuff-profile-survey'

export { SPONSORED_SURVEY_PATH }

const REQUEST_TIMEOUT_MS = 10_000

export function createCliSponsoredSurveyClient(
  deps: {
    baseUrl?: string
    getToken?: () => string | undefined
    fetchImpl?: typeof fetch
  } = {},
): SponsoredSurveyClient {
  const base = (deps.baseUrl ?? FREEBUFF_WEB_URL).replace(/\/+$/, '')
  const getToken = deps.getToken ?? getAuthToken
  const fetchImpl = deps.fetchImpl ?? fetch
  const send = async <T>(path: string, init: RequestInit): Promise<T> => {
    const token = getToken()
    if (!token) throw new Error('signed_out')
    const response = await fetchImpl(`${base}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        'user-agent': getCliAdRequestUserAgent(),
        ...(init.body ? { 'content-type': 'application/json' } : {}),
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    const body = (await response.json().catch(() => null)) as unknown
    if (!response.ok) {
      const error =
        body && typeof body === 'object' && 'error' in body
          ? String((body as { error: unknown }).error)
          : `http_${response.status}`
      throw new Error(error)
    }
    // Prompts and labels are drawn in the terminal: strip escape sequences.
    return sanitizeTerminalStrings(body) as T
  }
  return createHttpSponsoredSurveyClient({
    get: (path) => send(path, { method: 'GET' }),
    post: (path, body) => send(path, { method: 'POST', body: JSON.stringify(body) }),
  })
}

/** The offer as the profile survey machine's state; null when empty. */
export function sponsoredOfferToSurveyState(
  offer: SponsoredSurveyOffer,
  now: number,
): ProfileSurveyState | null {
  const questions: ProfileSurveyQuestion[] = offer.questions.map((q) => ({
    id: q.id,
    revision: 1,
    prompt: q.prompt,
    multi: q.kind === 'multi',
    options: q.options.map((o) => ({
      id: o.id,
      label: o.label,
      ...(o.exclusive ? { exclusive: true } : {}),
    })),
  }))
  const step = Math.min(Math.max(0, offer.resumeAt), questions.length)
  if (questions.length === 0 || step >= questions.length) return null
  return {
    version: 0,
    questions,
    rewardFreebucks: offer.rewardFreebucks,
    dismissCount: 0,
    step,
    answers: {},
    selection: [],
    questionShownAt: now,
    renderedAt: null,
    viewedQuestionId: null,
    status: 'asking',
    sponsored: { campaignId: offer.campaignId, sponsorName: offer.sponsorName },
  }
}

export function sponsoredCompletionLine(rewardedFreebucks: number): string {
  return rewardedFreebucks > 0
    ? `✓ +${rewardedFreebucks} Freebucks added to your wallet`
    : '✓ Thanks for answering'
}
