import { afterEach, describe, expect, test } from 'bun:test'

import { PROFILE_SURVEY_QUESTIONS } from '@codebuff/common/constants/freebuff-profile-survey'

import { createFakeProfileSurveyClient } from '../../utils/profile-survey-api'
import {
  closeProfileSurveyForTyping,
  dispatchProfileSurveyInput,
  getProfileSurveyKeyContext,
  profileSurveyIdle,
  setProfileSurveyClientForTests,
  setProfileSurveyEligible,
  setProfileSurveyPrinter,
  startProfileSurveyOnce,
  useProfileSurveyStore,
} from '../profile-survey-store'

import type {
  ProfileSurveyQuestion,
  ProfileSurveyStateResponse,
} from '@codebuff/common/constants/freebuff-profile-survey'

const QUESTIONS = PROFILE_SURVEY_QUESTIONS as readonly ProfileSurveyQuestion[]

const SHOWN: ProfileSurveyStateResponse = {
  show: true,
  surveyId: 'profile',
  version: 1,
  questions: [...QUESTIONS],
  answers: [],
  resumeAt: 0,
  rewardFreebucks: 25,
  dismissCount: 0,
}

async function setup(
  state: ProfileSurveyStateResponse = SHOWN,
  options?: Parameters<typeof createFakeProfileSurveyClient>[1],
) {
  const fake = createFakeProfileSurveyClient(state, options)
  setProfileSurveyClientForTests(fake)
  const printed: string[] = []
  setProfileSurveyPrinter((line) => printed.push(line))
  await startProfileSurveyOnce(0)
  return { fake, printed }
}

afterEach(() => setProfileSurveyClientForTests(null))

describe('profile survey store', () => {
  test('fetches once per process, whatever the answer', async () => {
    const { fake } = await setup({ show: false, reason: 'snoozed' })
    await startProfileSurveyOnce()
    await startProfileSurveyOnce()
    expect(fake.getCalls).toBe(1)
    expect(useProfileSurveyStore.getState().survey).toBeNull()
  })

  test('claims keys only while eligible and asking', async () => {
    await setup()
    expect(getProfileSurveyKeyContext()).toBeNull()
    setProfileSurveyEligible(true)
    expect(getProfileSurveyKeyContext()?.question.id).toBe('who_pays')
    setProfileSurveyEligible(false)
    expect(getProfileSurveyKeyContext()).toBeNull()
  })

  test('answers all ten in order, then prints the reward', async () => {
    const { fake, printed } = await setup()
    setProfileSurveyEligible(true)
    for (const question of QUESTIONS) {
      dispatchProfileSurveyInput({ type: 'digit', digit: 1, now: 0 })
      if (question.multi) dispatchProfileSurveyInput({ type: 'enter', now: 0 })
    }
    await profileSurveyIdle()
    expect(
      fake.requests.map((r): string =>
        r.action === 'answer' ? r.questionId : r.action,
      ),
    ).toEqual(QUESTIONS.map((x) => x.id))
    expect(useProfileSurveyStore.getState().survey?.status).toBe('completed')
    expect(getProfileSurveyKeyContext()).toBeNull()
    expect(printed).toHaveLength(1)
    expect(printed[0]).toStartWith('✓ +25 Freebucks added to your wallet\nedit answers: ')
    expect(printed[0]).toEndWith('/account')
  })

  test('no-reward copy when the server credits 0', async () => {
    const { printed } = await setup({ ...SHOWN, rewardFreebucks: 0 })
    for (const question of QUESTIONS) {
      dispatchProfileSurveyInput({ type: 'digit', digit: 1, now: 0 })
      if (question.multi) dispatchProfileSurveyInput({ type: 'enter', now: 0 })
    }
    await profileSurveyIdle()
    expect(printed[0]).toStartWith("✓ Thanks, that's all 10")
  })

  test('Esc POSTs dismiss and prints the snooze line', async () => {
    const { fake, printed } = await setup()
    dispatchProfileSurveyInput({ type: 'escape' })
    await profileSurveyIdle()
    expect(fake.requests).toEqual([{ action: 'dismiss', version: 1 }])
    expect(printed).toEqual(["Not now: we'll ask again in 7 days."])
  })

  test('Esc on the stopping dismissal says so', async () => {
    const { printed } = await setup(SHOWN, { stopped: true })
    dispatchProfileSurveyInput({ type: 'escape' })
    await profileSurveyIdle()
    expect(printed).toEqual(["Got it, we won't ask again."])
  })

  test('a failed dismiss prints nothing', async () => {
    const { printed } = await setup(SHOWN, { failPosts: true })
    dispatchProfileSurveyInput({ type: 'escape' })
    await profileSurveyIdle()
    expect(printed).toEqual([])
  })

  test('typing closes silently with no request', async () => {
    const { fake, printed } = await setup()
    setProfileSurveyEligible(true)
    closeProfileSurveyForTyping()
    await profileSurveyIdle()
    expect(useProfileSurveyStore.getState().survey?.status).toBe('closed')
    expect(getProfileSurveyKeyContext()).toBeNull()
    expect(fake.requests).toEqual([])
    expect(printed).toEqual([])
  })
})
