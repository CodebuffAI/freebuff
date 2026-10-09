/**
 * Where the CLI's profile survey (COD-779) lives between keypresses.
 *
 * The transitions are `utils/profile-survey-machine.ts`; this module holds the
 * one machine instance, runs its effects through a `ProfileSurveyClient`, and
 * tells the keyboard layer whether the box is on screen. It is a store rather
 * than component state because two places outside the box read it on every
 * key: the composer's intercept (`chat-input-bar.tsx`) and the chat keyboard
 * resolver (`chat.tsx` → `keyboard-actions.ts`).
 *
 * Once per CLI process: the first busy turn fetches; nothing fetches again,
 * whatever the answer was. Survey interactions never touch the ad
 * impression/click reporting.
 *
 * Engagement events (`rendered`, `question_viewed`, `abandoned`): after every
 * change that can put the box on screen or change its question, the store
 * feeds the machine a `shown` input while the box is drawn (eligible and
 * asking — exactly `ProfileSurveyBox`'s condition), and the machine says what
 * is new. Events are fire-and-forget: they never join the ordered answer
 * chain, never block a key, and a failure is only logged at debug.
 */

import { profileSurveySnoozeDays } from '@codebuff/common/constants/freebuff-profile-survey'
import { create } from 'zustand'

import { FREEBUFF_WEB_URL } from '../login/constants'
import { logger } from '../utils/logger'
import { createHttpProfileSurveyClient } from '../utils/profile-survey-api'
import {
  createProfileSurveyState,
  currentQuestion,
  finishProfileSurvey,
  profileSurveyCompletionLines,
  profileSurveyDismissLine,
  transitionProfileSurvey,
} from '../utils/profile-survey-machine'

import type { ProfileSurveyClient } from '../utils/profile-survey-api'
import type {
  ProfileSurveyEffect,
  ProfileSurveyInput,
  ProfileSurveyKeyContext,
  ProfileSurveyState,
} from '../utils/profile-survey-machine'

type ProfileSurveyStore = {
  survey: ProfileSurveyState | null
  /** The chat says the box may be drawn now: a turn is running, the draft is
   *  empty and no takeover screen owns the keyboard. */
  eligible: boolean
}

export const useProfileSurveyStore = create<ProfileSurveyStore>(() => ({
  survey: null,
  eligible: false,
}))

let client: ProfileSurveyClient | null = null
let fetchStarted = false
let print: (text: string) => void = () => {}
let postChain: Promise<unknown> = Promise.resolve()
/** Event POSTs in flight, so tests can wait for them; nothing else does. */
const pendingEvents = new Set<Promise<void>>()

function getClient(): ProfileSurveyClient {
  client ??= createHttpProfileSurveyClient()
  return client
}

/** Tests and local previews: swap the transport (null = the real one) and
 *  forget this process's fetch. */
export function setProfileSurveyClientForTests(
  next: ProfileSurveyClient | null,
): void {
  client = next
  fetchStarted = false
  postChain = Promise.resolve()
  pendingEvents.clear()
  print = () => {}
  useProfileSurveyStore.setState({ survey: null, eligible: false })
}

/** Where completion and dismissal lines go (the chat transcript). */
export function setProfileSurveyPrinter(next: (text: string) => void): void {
  print = next
}

export function setProfileSurveyEligible(
  eligible: boolean,
  now: number = Date.now(),
): void {
  if (useProfileSurveyStore.getState().eligible !== eligible) {
    useProfileSurveyStore.setState({ eligible })
  }
  reportOnScreen(now)
}

/** First busy turn of the process: ask the server once. `now` pins the
 *  clock (tests); by default it is read when the answer arrives. */
export async function startProfileSurveyOnce(now?: number): Promise<void> {
  if (fetchStarted) return
  fetchStarted = true
  try {
    const response = await getClient().getState()
    const at = now ?? Date.now()
    const survey = createProfileSurveyState(response, at)
    if (survey) {
      useProfileSurveyStore.setState({ survey })
      reportOnScreen(at)
    }
  } catch (error) {
    logger.debug({ error }, '[profile-survey] start failed')
  }
}

/** Whether the box is on screen, and with which question; null claims no
 *  keys. Read with `getState()` on every key, never from a stale render. */
export function getProfileSurveyKeyContext(): ProfileSurveyKeyContext | null {
  const { survey, eligible } = useProfileSurveyStore.getState()
  if (!eligible || !survey || survey.status !== 'asking') return null
  const question = currentQuestion(survey)
  return question ? { question } : null
}

export function isProfileSurveyOnScreen(): boolean {
  return getProfileSurveyKeyContext() !== null
}

export function dispatchProfileSurveyInput(input: ProfileSurveyInput): void {
  apply(input)
  // A key may have moved the box to another question.
  reportOnScreen(input.now)
}

function apply(input: ProfileSurveyInput): void {
  const { survey } = useProfileSurveyStore.getState()
  if (!survey) return
  const { state, effects } = transitionProfileSurvey(survey, input)
  if (state !== survey) useProfileSurveyStore.setState({ survey: state })
  for (const effect of effects) runEffect(effect)
}

/** While the box is drawn, let the machine report what is newly on screen
 *  (the first render, a question it has not reported yet). */
function reportOnScreen(now: number): void {
  if (isProfileSurveyOnScreen()) apply({ type: 'shown', now })
}

/** The user started typing a prompt: close quietly (no transcript line),
 *  keep answers. Reports `abandoned` if the box was ever on screen. */
export function closeProfileSurveyForTyping(now: number = Date.now()): void {
  const { survey } = useProfileSurveyStore.getState()
  if (survey?.status === 'asking') {
    dispatchProfileSurveyInput({ type: 'typed', now })
  }
}

/** Resolves once every POST queued so far, events included, has settled
 *  (tests). */
export async function profileSurveyIdle(): Promise<void> {
  await postChain
  await Promise.all([...pendingEvents])
}

// Answers are POSTed strictly in order: the last one's response is the
// completion verdict, so an earlier answer still in flight must land first.
function enqueue(task: () => Promise<void>): void {
  postChain = postChain.then(task, task)
}

function runEffect(effect: ProfileSurveyEffect): void {
  const api = getClient()
  if (effect.type === 'event') {
    sendEvent(api, effect)
    return
  }
  if (effect.type === 'dismiss') {
    const dismissCount = useProfileSurveyStore.getState().survey?.dismissCount ?? 0
    enqueue(async () => {
      const response = await api.post({
        action: 'dismiss',
        version: effect.version,
        ...(effect.durationMs !== undefined
          ? { durationMs: effect.durationMs }
          : {}),
        ...(effect.questionId ? { questionId: effect.questionId } : {}),
        surface: 'cli',
      })
      if (response.ok && 'dismissed' in response) {
        print(
          profileSurveyDismissLine(
            response.stopped ? null : profileSurveySnoozeDays(dismissCount + 1),
          ),
        )
      } else {
        logger.debug({ response }, '[profile-survey] dismiss not recorded')
      }
    })
    return
  }

  enqueue(async () => {
    const response = await api.post({
      action: 'answer',
      version: effect.version,
      questionId: effect.questionId,
      optionIds: effect.optionIds,
      durationMs: effect.durationMs,
      surface: 'cli',
    })
    if (!response.ok) {
      logger.debug(
        { response, questionId: effect.questionId },
        '[profile-survey] answer not recorded',
      )
    }
    const current = useProfileSurveyStore.getState().survey
    if (!current || current.status !== 'finishing' || !effect.last) return
    const completed = response.ok && 'completed' in response && response.completed
    useProfileSurveyStore.setState({
      survey: finishProfileSurvey(current, completed),
    })
    if (completed) {
      print(
        profileSurveyCompletionLines(
          response.rewardedFreebucks,
          current.questions.length,
          `${FREEBUFF_WEB_URL.replace(/\/+$/, '')}/account`,
        ),
      )
    }
  })
}

/** Fire-and-forget: not on the answer chain, never awaited by a caller. */
function sendEvent(
  api: ProfileSurveyClient,
  effect: Extract<ProfileSurveyEffect, { type: 'event' }>,
): void {
  const task = (async () => {
    try {
      const response = await api.post({
        action: 'event',
        version: effect.version,
        event: effect.event,
        ...(effect.questionId ? { questionId: effect.questionId } : {}),
        ...(effect.durationMs !== undefined
          ? { durationMs: effect.durationMs }
          : {}),
        surface: 'cli',
      })
      if (!response.ok) {
        logger.debug(
          { response, event: effect.event },
          '[profile-survey] event not recorded',
        )
      }
    } catch (error) {
      logger.debug({ error, event: effect.event }, '[profile-survey] event failed')
    }
  })()
  pendingEvents.add(task)
  void task.finally(() => pendingEvents.delete(task))
}
