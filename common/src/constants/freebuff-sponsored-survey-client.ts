/**
 * The sponsored survey's client seam (COD-839): the wire types of
 * `GET/POST /api/sponsored-survey` and an HTTP client every surface (Desktop,
 * Web, CLI) builds over its own transport, plus an in-memory fake for
 * previews and tests. Public code: imports only the public contract.
 *
 * A sponsored survey is shown only where the profile survey card would be and
 * only when the profile survey is not showing; the server enforces that (it
 * offers one only to users who completed or stopped the profile survey) and
 * at most one per Pacific day. See docs/freebuff-sponsored-surveys.md.
 */
import type {
  SponsoredSurveyOption,
  SponsoredSurveyQuestionKind,
  SponsoredSurveySurface,
} from './freebuff-sponsored-survey'

export const SPONSORED_SURVEY_PATH = '/api/sponsored-survey'

export type SponsoredSurveyWireQuestion = {
  id: string
  position: number
  prompt: string
  kind: SponsoredSurveyQuestionKind | string
  options: SponsoredSurveyOption[]
}

/** The day's offer, as the server sends it. */
export type SponsoredSurveyOffer = {
  campaignId: string
  /** Shown as "Sponsored by <sponsorName>". */
  sponsorName: string
  questions: SponsoredSurveyWireQuestion[]
  /** First unanswered question. */
  resumeAt: number
  /** Freebucks for a clean complete (Expedited only); 0 = no reward copy. */
  rewardFreebucks: number
}

export type SponsoredSurveyStateResponse =
  | { show: false }
  | { show: true; survey: SponsoredSurveyOffer }

export type SponsoredSurveyRequest =
  | {
      action: 'answer'
      campaignId: string
      questionId: string
      optionIds: string[]
      durationMs?: number
      surface?: SponsoredSurveySurface
    }
  | { action: 'dismiss'; campaignId: string; surface?: SponsoredSurveySurface }

export type SponsoredSurveyAnswerResponse =
  | { ok: true; completed: false }
  | { ok: true; completed: true; billed: boolean; rewardedFreebucks: number }
  | { ok: false; error: string }

export type SponsoredSurveyDismissResponse =
  | { ok: true; dismissed: true }
  | { ok: false; error: string }

export interface SponsoredSurveyClient {
  /** Never rejects: a failure reads as nothing to show. */
  getState(surface?: SponsoredSurveySurface): Promise<SponsoredSurveyStateResponse>
  /** Never rejects: a transport failure comes back as `{ ok: false }`. */
  answer(
    request: Extract<SponsoredSurveyRequest, { action: 'answer' }>,
  ): Promise<SponsoredSurveyAnswerResponse>
  dismiss(
    request: Extract<SponsoredSurveyRequest, { action: 'dismiss' }>,
  ): Promise<SponsoredSurveyDismissResponse>
}

/** GET and POST JSON, rejecting on a non-2xx with the server's message (the
 *  profile survey's `ProfileSurveyTransport` fits). */
export interface SponsoredSurveyTransport {
  get<T>(path: string): Promise<T>
  post<T>(path: string, body: unknown): Promise<T>
}

function message(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback
}

export function createHttpSponsoredSurveyClient(
  transport: SponsoredSurveyTransport,
): SponsoredSurveyClient {
  return {
    async getState(surface) {
      try {
        const path = surface
          ? `${SPONSORED_SURVEY_PATH}?surface=${encodeURIComponent(surface)}`
          : SPONSORED_SURVEY_PATH
        const state = await transport.get<SponsoredSurveyStateResponse>(path)
        return state && state.show === true && state.survey
          ? state
          : { show: false }
      } catch {
        return { show: false }
      }
    },
    async answer(request) {
      try {
        return await transport.post<SponsoredSurveyAnswerResponse>(
          SPONSORED_SURVEY_PATH,
          request,
        )
      } catch (error) {
        return { ok: false, error: message(error, 'Could not save your answer.') }
      }
    },
    async dismiss(request) {
      try {
        return await transport.post<SponsoredSurveyDismissResponse>(
          SPONSORED_SURVEY_PATH,
          request,
        )
      } catch (error) {
        return { ok: false, error: message(error, 'Could not dismiss.') }
      }
    },
  }
}

/** Single needs exactly one; an exclusive option stands alone. */
export function isSponsoredAnswerReady(
  question: SponsoredSurveyWireQuestion,
  optionIds: readonly string[],
): boolean {
  if (optionIds.length === 0) return false
  if (question.kind === 'single') return optionIds.length === 1
  const exclusive = new Set(
    question.options.filter((o) => o.exclusive).map((o) => o.id),
  )
  return optionIds.length === 1 || !optionIds.some((id) => exclusive.has(id))
}

/** Toggle `optionId` in a multi-choice selection; an exclusive option clears
 *  the rest, and any other option clears an exclusive one. */
export function toggleSponsoredOption(
  question: SponsoredSurveyWireQuestion,
  selected: readonly string[],
  optionId: string,
): string[] {
  if (question.kind === 'single') return [optionId]
  if (selected.includes(optionId)) return selected.filter((id) => id !== optionId)
  const option = question.options.find((o) => o.id === optionId)
  if (option?.exclusive) return [optionId]
  const exclusive = new Set(
    question.options.filter((o) => o.exclusive).map((o) => o.id),
  )
  return [...selected.filter((id) => !exclusive.has(id)), optionId]
}

/** The card's reward line, or null for no reward copy. */
export function sponsoredRewardLine(rewardFreebucks: number): string | null {
  return rewardFreebucks > 0 ? `Earn ${rewardFreebucks} Freebucks` : null
}

// ---- in-memory fake ------------------------------------------------------

export interface FakeSponsoredSurveyClient extends SponsoredSurveyClient {
  readonly requests: SponsoredSurveyRequest[]
}

export function createFakeSponsoredSurveyClient(
  offer: SponsoredSurveyOffer | null,
): FakeSponsoredSurveyClient {
  const requests: SponsoredSurveyRequest[] = []
  const answered = new Set<string>()
  let dismissed = false
  return {
    requests,
    async getState() {
      if (!offer || dismissed || answered.size >= offer.questions.length)
        return { show: false }
      return { show: true, survey: offer }
    },
    async answer(request) {
      requests.push(request)
      if (!offer || request.campaignId !== offer.campaignId)
        return { ok: false, error: 'not_offered' }
      answered.add(request.questionId)
      return answered.size >= offer.questions.length
        ? {
            ok: true,
            completed: true,
            billed: true,
            rewardedFreebucks: offer.rewardFreebucks,
          }
        : { ok: true, completed: false }
    },
    async dismiss(request) {
      requests.push(request)
      dismissed = true
      return { ok: true, dismissed: true }
    },
  }
}
