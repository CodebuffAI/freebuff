/**
 * The CLI's sponsored-survey funnel pings (COD-837): `card_rendered`,
 * `question_viewed`, `answered` (with dwell), `dismissed`, `abandoned`, sent
 * in batches to `/api/survey-events` on freebuff.com. The profile survey is
 * not tracked here: its engagement events go through `/api/profile-survey`
 * into `profile_survey_event` (#6278).
 *
 * Same origin, auth and User-Agent as `profile-survey-api.ts`. The batching
 * and the event rules are `@codebuff/common/constants/freebuff-survey-events-client`;
 * this file is the CLI's transport plus `observeSponsoredSurvey`, which reads
 * the survey store's state changes (the CLI has no card component to hook) and
 * drives one tracker per sponsored survey. Fire and forget: a failed send is logged at
 * debug and dropped, nothing retries, nothing throws into the TUI.
 * `flushSurveyEventsOnExit` runs from `exit-cleanly.ts`, so a survey left
 * open when the CLI quits reports `abandoned`.
 */

import {
  createSurveyCardTracker,
  createSurveyEventSink,
  SURVEY_EVENTS_PATH,
  type SurveyCardTracker,
  type SurveyEventSender,
  type SurveyEventSink,
} from '@codebuff/common/constants/freebuff-survey-events-client'

import { FREEBUFF_WEB_URL } from '../login/constants'

import { getCliAdRequestUserAgent } from './ad-client-identity'
import { getAuthToken } from './auth'
import { logger } from './logger'

import type { ProfileSurveyState } from './profile-survey-machine'

const REQUEST_TIMEOUT_MS = 5_000

export function createCliSurveyEventSender(
  deps: {
    baseUrl?: string
    getToken?: () => string | undefined
    fetchImpl?: typeof fetch
  } = {},
): SurveyEventSender {
  const base = (deps.baseUrl ?? FREEBUFF_WEB_URL).replace(/\/+$/, '')
  const getToken = deps.getToken ?? getAuthToken
  const fetchImpl = deps.fetchImpl ?? fetch
  return async (batch) => {
    const token = getToken()
    if (!token) return
    try {
      const response = await fetchImpl(`${base}${SURVEY_EVENTS_PATH}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'user-agent': getCliAdRequestUserAgent(),
          'content-type': 'application/json',
        },
        body: JSON.stringify(batch),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      if (!response.ok) {
        logger.debug(
          { status: response.status },
          '[survey-events] batch not recorded',
        )
      }
    } catch (error) {
      logger.debug({ error }, '[survey-events] POST failed')
    }
  }
}

let sink: SurveyEventSink | null = null

export function cliSurveyEventSink(): SurveyEventSink {
  sink ??= createSurveyEventSink({ send: createCliSurveyEventSender() })
  return sink
}

/** Tests: swap the sink (null = the real one on next use) and forget the
 *  tracker. */
export function setCliSurveyEventSinkForTests(next: SurveyEventSink | null) {
  sink = next
  tracked = null
}

/** From `exit-cleanly.ts`: an open survey reports `abandoned`, then the
 *  buffer goes out. */
export function flushSurveyEventsOnExit(): Promise<void> {
  return sink ? sink.unload() : Promise.resolve()
}

// ---- the store's state changes -> one tracker per sponsored survey -------

type Snapshot = { survey: ProfileSurveyState | null; eligible: boolean }

let tracked: {
  /** The sponsored campaign id. */
  key: string
  tracker: SurveyCardTracker
  off: () => void
} | null = null

const onScreen = (s: Snapshot) =>
  s.eligible && s.survey?.status === 'asking'

/**
 * Called on every survey store change (`profile-survey-store.ts` subscribes
 * it); a profile survey in the box is ignored. The box is "rendered" the first time it is on screen; each question it
 * shows is "viewed"; an answer advances `step`; Esc is "dismissed"; typing a
 * prompt closes it and, with the question unanswered, is "abandoned".
 */
export function observeSponsoredSurvey(
  next: Snapshot,
  prev: Snapshot,
  now: () => number = Date.now,
): void {
  try {
    const survey = next.survey
    if (!survey?.sponsored) return
    const key = survey.sponsored.campaignId
    if (!tracked || tracked.key !== key) {
      tracked?.off()
      const tracker = createSurveyCardTracker({
        sink: cliSurveyEventSink(),
        // the sponsored survey (COD-839) rides the profile survey's machine and box
        surveyKind: 'sponsored',
        surveyRef: key,
        surface: 'cli',
        now,
      })
      const off = cliSurveyEventSink().onUnload(() => tracker.ended())
      tracked = { key, tracker, off }
    }
    const { tracker } = tracked
    const before =
      prev.survey?.sponsored?.campaignId === key ? prev.survey : null

    // an answer: the step moved forward from a question that was asking
    if (before?.status === 'asking' && survey.step > before.step) {
      const answeredAt =
        survey.status === 'asking' ? survey.questionShownAt : now()
      tracker.answered(answeredAt - before.questionShownAt)
    }

    switch (survey.status) {
      case 'asking':
        if (onScreen(next)) {
          tracker.rendered()
          const question = survey.questions[survey.step]
          if (question) tracker.viewed(survey.step, question.id)
        }
        return
      case 'dismissed':
        if (before?.status === 'asking') tracker.dismissed()
        return
      case 'completed':
        tracker.completed()
        return
      case 'closed':
        tracker.ended()
        return
      case 'finishing':
        return
    }
  } catch (error) {
    logger.debug({ error }, '[survey-events] observe failed')
  }
}
