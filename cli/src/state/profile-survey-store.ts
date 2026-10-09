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
  print = () => {}
  useProfileSurveyStore.setState({ survey: null, eligible: false })
}

/** Where completion and dismissal lines go (the chat transcript). */
export function setProfileSurveyPrinter(next: (text: string) => void): void {
  print = next
}

export function setProfileSurveyEligible(eligible: boolean): void {
  if (useProfileSurveyStore.getState().eligible !== eligible) {
    useProfileSurveyStore.setState({ eligible })
  }
}

/** First busy turn of the process: ask the server once. */
export async function startProfileSurveyOnce(now = Date.now()): Promise<void> {
  if (fetchStarted) return
  fetchStarted = true
  try {
    const response = await getClient().getState()
    const survey = createProfileSurveyState(response, now)
    if (survey) useProfileSurveyStore.setState({ survey })
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
  const { survey } = useProfileSurveyStore.getState()
  if (!survey) return
  const { state, effects } = transitionProfileSurvey(survey, input)
  if (state !== survey) useProfileSurveyStore.setState({ survey: state })
  for (const effect of effects) runEffect(effect)
}

/** The user started typing a prompt: close quietly, keep answers. */
export function closeProfileSurveyForTyping(): void {
  const { survey } = useProfileSurveyStore.getState()
  if (survey?.status === 'asking') dispatchProfileSurveyInput({ type: 'typed' })
}

/** Resolves once every POST queued so far has settled (tests). */
export function profileSurveyIdle(): Promise<void> {
  return postChain.then(() => undefined)
}

// Answers are POSTed strictly in order: the last one's response is the
// completion verdict, so an earlier answer still in flight must land first.
function enqueue(task: () => Promise<void>): void {
  postChain = postChain.then(task, task)
}

function runEffect(effect: ProfileSurveyEffect): void {
  const api = getClient()
  if (effect.type === 'dismiss') {
    const dismissCount = useProfileSurveyStore.getState().survey?.dismissCount ?? 0
    enqueue(async () => {
      const response = await api.post({
        action: 'dismiss',
        version: effect.version,
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
