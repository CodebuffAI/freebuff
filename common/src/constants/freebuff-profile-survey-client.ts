import {
  ACTIVE_PROFILE_SURVEY_VERSION,
  earnsProfileSurveyReward,
  firstUnansweredIndex,
  isValidProfileSurveyAnswer,
  PROFILE_SURVEY_DAY_MS,
  PROFILE_SURVEY_ID,
  PROFILE_SURVEY_VERSIONS,
  profileSurveyQuestion,
  profileSurveySnoozeDays,
  profileSurveyVersion,
  type ProfileSurveyAnswer,
  type ProfileSurveyAnswersResponse,
  type ProfileSurveyQuestion,
  type ProfileSurveyQuestionId,
  type ProfileSurveyRequest,
  type ProfileSurveyResponse,
  type ProfileSurveyStateResponse,
} from './freebuff-profile-survey'

/**
 * The one seam every survey surface talks through (COD-779). Desktop and Web
 * each build the HTTP implementation over their own transport — Desktop's
 * orchestrator proxy (which holds the bearer), Web's same-origin fetch — and
 * the previews and tests use the in-memory fake, which follows the server's
 * contract closely enough to click through every state.
 */
export interface ProfileSurveyClient {
  getState(): Promise<ProfileSurveyStateResponse>
  /** Never rejects: a transport failure comes back as `{ ok: false }`. */
  post(request: ProfileSurveyRequest): Promise<ProfileSurveyResponse>
  getAnswers(): Promise<ProfileSurveyAnswersResponse>
}

export const PROFILE_SURVEY_PATH = '/api/profile-survey'
export const PROFILE_SURVEY_ANSWERS_PATH = '/api/profile-survey/answers'

/** GET and POST JSON, rejecting on a non-2xx with the server's message. */
export interface ProfileSurveyTransport {
  get<T>(path: string): Promise<T>
  post<T>(path: string, body: unknown): Promise<T>
}

export function createHttpProfileSurveyClient(
  transport: ProfileSurveyTransport,
): ProfileSurveyClient {
  return {
    getState: () =>
      transport.get<ProfileSurveyStateResponse>(PROFILE_SURVEY_PATH),
    async post(request) {
      try {
        return await transport.post<ProfileSurveyResponse>(
          PROFILE_SURVEY_PATH,
          request,
        )
      } catch (error) {
        return {
          ok: false,
          error:
            error instanceof Error && error.message
              ? error.message
              : 'Could not save your answer.',
        }
      }
    },
    getAnswers: () =>
      transport.get<ProfileSurveyAnswersResponse>(PROFILE_SURVEY_ANSWERS_PATH),
  }
}

/** A `fetch`-based transport: same-origin cookies on Web, any base URL. */
export function createFetchProfileSurveyTransport(
  options: {
    baseUrl?: string
    fetchFn?: typeof fetch
    init?: () => RequestInit
  } = {},
): ProfileSurveyTransport {
  const fetchFn = options.fetchFn ?? ((...args) => fetch(...args))
  const base = options.baseUrl ?? ''
  const send = async <T>(path: string, init: RequestInit): Promise<T> => {
    const extra = options.init?.() ?? {}
    const response = await fetchFn(`${base}${path}`, {
      credentials: 'same-origin',
      cache: 'no-store',
      ...extra,
      ...init,
      headers: {
        accept: 'application/json',
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...(extra.headers as Record<string, string> | undefined),
      },
    })
    const body = (await response.json().catch(() => null)) as unknown
    if (!response.ok) {
      const message =
        body && typeof body === 'object'
          ? ((body as { error?: unknown; message?: unknown }).error ??
            (body as { message?: unknown }).message)
          : undefined
      throw new Error(
        typeof message === 'string' && message
          ? message
          : `Request failed (${response.status})`,
      )
    }
    return body as T
  }
  return {
    get: (path) => send(path, { method: 'GET' }),
    post: (path, body) =>
      send(path, { method: 'POST', body: JSON.stringify(body) }),
  }
}

// ---- in-memory fake ------------------------------------------------------

export type FakeProfileSurveyOptions = {
  /** Freebucks for completing (the arm's reward). Default 25. */
  rewardFreebucks?: number
  version?: number | null
  now?: () => number
  /** Simulated round trip, so loading states are visible in a preview. */
  latencyMs?: number
  /** Answers already on file. */
  answers?: Array<Pick<ProfileSurveyAnswer, 'questionId' | 'optionIds'>>
}

export type ProfileSurveyEventRequest = Extract<
  ProfileSurveyRequest,
  { action: 'event' }
>

export interface FakeProfileSurveyClient extends ProfileSurveyClient {
  /** Every request posted, in order (tests and the preview's log). */
  readonly requests: ProfileSurveyRequest[]
  /** The `event` requests among them, in order. */
  readonly events: ProfileSurveyEventRequest[]
  /** Forget everything: answers, dismissals, completion, reward. */
  reset(options?: FakeProfileSurveyOptions): void
}

type FakeState = {
  answers: Map<string, { optionIds: string[]; revision: number; at: number }>
  dismissCount: number
  snoozedUntil: number | null
  stopped: boolean
  completed: boolean
  rewardPaid: boolean
}

/** Follows the server's contract: resume, 7-day snooze, stop on the third
 *  dismissal, one reward per version, nothing for an all-notApplicable set,
 *  edits accepted after completion, clear keeps the reward. */
export function createFakeProfileSurveyClient(
  initial: FakeProfileSurveyOptions = {},
): FakeProfileSurveyClient {
  let options = initial
  let state: FakeState
  const requests: ProfileSurveyRequest[] = []
  const events: ProfileSurveyEventRequest[] = []
  const now = () => (options.now ?? Date.now)()

  const seed = () => {
    state = {
      answers: new Map(
        (options.answers ?? []).map((a) => [
          a.questionId,
          {
            optionIds: [...a.optionIds],
            revision: profileSurveyQuestion(a.questionId)?.revision ?? 1,
            at: now(),
          },
        ]),
      ),
      dismissCount: 0,
      snoozedUntil: null,
      stopped: false,
      completed: false,
      rewardPaid: false,
    }
  }
  seed()

  // The fake backs the dev and admin previews, which must work before the
  // launch gate opens: with the gate off it serves the newest version.
  const versionNumber = () =>
    options.version !== undefined
      ? options.version
      : (ACTIVE_PROFILE_SURVEY_VERSION ??
        PROFILE_SURVEY_VERSIONS[PROFILE_SURVEY_VERSIONS.length - 1].version)
  const questions = (): ProfileSurveyQuestion[] => {
    const v = versionNumber()
    const survey = v === null ? undefined : profileSurveyVersion(v)
    return (survey?.questionIds ?? []).flatMap((id) => {
      const q = profileSurveyQuestion(id)
      return q ? [q] : []
    })
  }
  const answerList = (): ProfileSurveyAnswer[] =>
    [...state.answers].map(([questionId, a]) => ({
      questionId: questionId as ProfileSurveyQuestionId,
      questionRevision: a.revision,
      optionIds: [...a.optionIds],
    }))
  const wait = () =>
    options.latencyMs
      ? new Promise<void>((r) => setTimeout(r, options.latencyMs))
      : Promise.resolve()

  return {
    requests,
    events,
    reset(next) {
      if (next) options = next
      requests.length = 0
      events.length = 0
      seed()
    },

    async getState() {
      await wait()
      const v = versionNumber()
      if (v === null || !profileSurveyVersion(v))
        return { show: false, reason: 'no_active_version' }
      if (state.stopped) return { show: false, reason: 'stopped' }
      if (state.completed) return { show: false, reason: 'completed' }
      if (state.snoozedUntil !== null && state.snoozedUntil > now())
        return { show: false, reason: 'snoozed' }
      const qs = questions()
      const answers = answerList()
      return {
        show: true,
        surveyId: PROFILE_SURVEY_ID,
        version: v,
        questions: qs,
        answers,
        resumeAt: firstUnansweredIndex(
          qs.map((q) => q.id),
          answers,
        ),
        rewardFreebucks: options.rewardFreebucks ?? 25,
        dismissCount: state.dismissCount,
      }
    },

    async post(request) {
      requests.push(request)
      await wait()
      if (request.action === 'clear') {
        state.answers.clear()
        return { ok: true, cleared: true }
      }
      if (request.action === 'event') {
        events.push(request)
        return { ok: true, recorded: true }
      }
      if (request.action === 'dismiss') {
        state.dismissCount++
        const snoozeDays = profileSurveySnoozeDays(state.dismissCount)
        state.stopped = snoozeDays === null
        state.snoozedUntil =
          snoozeDays === null ? null : now() + snoozeDays * PROFILE_SURVEY_DAY_MS
        return {
          ok: true,
          dismissed: true,
          snoozedUntil:
            state.snoozedUntil === null
              ? null
              : new Date(state.snoozedUntil).toISOString(),
          stopped: state.stopped,
        }
      }
      const question = profileSurveyQuestion(request.questionId)
      if (!question || !isValidProfileSurveyAnswer(question, request.optionIds))
        return { ok: false, error: 'That answer is not valid.' }
      state.answers.set(question.id, {
        optionIds: [...request.optionIds],
        revision: question.revision,
        at: now(),
      })
      const qs = questions()
      const answers = answerList()
      const complete =
        firstUnansweredIndex(
          qs.map((q) => q.id),
          answers,
        ) === qs.length
      if (!complete) return { ok: true, completed: false }
      state.completed = true
      const earns =
        !state.rewardPaid &&
        earnsProfileSurveyReward(
          answers.filter((a) => qs.some((q) => q.id === a.questionId)),
        )
      const reward = earns ? (options.rewardFreebucks ?? 25) : 0
      if (reward > 0) state.rewardPaid = true
      return { ok: true, completed: true, rewardedFreebucks: reward }
    },

    async getAnswers() {
      await wait()
      return {
        answers: [...state.answers].flatMap(([questionId, a]) => {
          const question = profileSurveyQuestion(questionId)
          if (!question || a.revision < question.revision) return []
          return [
            {
              questionId: question.id as ProfileSurveyQuestionId,
              questionRevision: a.revision,
              optionIds: [...a.optionIds],
              answeredAt: new Date(a.at).toISOString(),
              question,
            },
          ]
        }),
      }
    },
  }
}
