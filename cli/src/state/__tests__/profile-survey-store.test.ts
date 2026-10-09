import { afterEach, describe, expect, test } from 'bun:test'

import {
  profileSurveyQuestion,
  profileSurveyVersion,
} from '@codebuff/common/constants/freebuff-profile-survey'

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
  ProfileSurveyQuestionId,
  ProfileSurveyStateResponse,
} from '@codebuff/common/constants/freebuff-profile-survey'
import type { CliProfileSurveyRequest } from '../../utils/profile-survey-api'

/** Version 1's ten questions: the CLI is version-agnostic, and these pin its copy. */
const QUESTIONS: readonly ProfileSurveyQuestion[] =
  profileSurveyVersion(1)!.questionIds.map((id) => profileSurveyQuestion(id)!)
/** The second question, as the wire's id type. */
const SECOND = QUESTIONS[1].id as ProfileSurveyQuestionId

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

const nonEvents = (requests: CliProfileSurveyRequest[]) =>
  requests.filter((r) => r.action !== 'event')
const events = (requests: CliProfileSurveyRequest[]) =>
  requests.filter((r) => r.action === 'event')

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
      nonEvents(fake.requests).map((r): string =>
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
    dispatchProfileSurveyInput({ type: 'escape', now: 0 })
    await profileSurveyIdle()
    // Never on screen: no events, and no on-screen duration.
    expect(fake.requests).toEqual([
      { action: 'dismiss', version: 1, questionId: 'who_pays', surface: 'cli' },
    ])
    expect(printed).toEqual(["Not now: we'll ask again in 3 days."])
  })

  test('Esc on the stopping dismissal says so', async () => {
    const { printed } = await setup(SHOWN, { stopped: true })
    dispatchProfileSurveyInput({ type: 'escape', now: 0 })
    await profileSurveyIdle()
    expect(printed).toEqual(["Got it, we won't ask again."])
  })

  test('a failed dismiss prints nothing', async () => {
    const { printed } = await setup(SHOWN, { failPosts: true })
    dispatchProfileSurveyInput({ type: 'escape', now: 0 })
    await profileSurveyIdle()
    expect(printed).toEqual([])
  })

  test('typing closes silently: no answer or dismiss request, no line', async () => {
    const { fake, printed } = await setup()
    setProfileSurveyEligible(true)
    closeProfileSurveyForTyping()
    await profileSurveyIdle()
    expect(useProfileSurveyStore.getState().survey?.status).toBe('closed')
    expect(getProfileSurveyKeyContext()).toBeNull()
    expect(nonEvents(fake.requests)).toEqual([])
    expect(printed).toEqual([])
  })
})

describe('profile survey engagement events', () => {
  test('nothing is posted before the box is on screen', async () => {
    const { fake } = await setup()
    setProfileSurveyEligible(false, 10)
    await profileSurveyIdle()
    expect(fake.requests).toEqual([])
  })

  test('rendered once and question_viewed on first show', async () => {
    const { fake } = await setup()
    setProfileSurveyEligible(true, 100)
    // Hidden between turns and shown again on the same question: nothing new.
    setProfileSurveyEligible(false, 200)
    setProfileSurveyEligible(true, 300)
    await profileSurveyIdle()
    expect(fake.requests).toEqual([
      { action: 'event', version: 1, event: 'rendered', surface: 'cli' },
      {
        action: 'event',
        version: 1,
        event: 'question_viewed',
        questionId: 'who_pays',
        surface: 'cli',
      },
    ])
  })

  test('shows when the fetch lands while already eligible', async () => {
    const fake = createFakeProfileSurveyClient(SHOWN)
    setProfileSurveyClientForTests(fake)
    setProfileSurveyEligible(true, 0)
    await startProfileSurveyOnce(50)
    await profileSurveyIdle()
    expect(events(fake.requests).map((r) => r.action === 'event' && r.event)).toEqual([
      'rendered',
      'question_viewed',
    ])
  })

  test('question_viewed follows each question on screen; answers unaffected', async () => {
    const { fake } = await setup()
    setProfileSurveyEligible(true, 0)
    dispatchProfileSurveyInput({ type: 'digit', digit: 1, now: 10 })
    dispatchProfileSurveyInput({ type: 'back', now: 20 })
    await profileSurveyIdle()
    expect(
      events(fake.requests).map((r) =>
        r.action === 'event' ? `${r.event}:${r.questionId ?? ''}` : '',
      ),
    ).toEqual([
      'rendered:',
      'question_viewed:who_pays',
      `question_viewed:${SECOND}`,
      'question_viewed:who_pays',
    ])
    expect(nonEvents(fake.requests)).toEqual([
      {
        action: 'answer',
        version: 1,
        questionId: 'who_pays',
        optionIds: ['me'],
        durationMs: 10,
        surface: 'cli',
      },
    ])
  })

  test('Esc after render: dismiss carries time on screen and the question', async () => {
    const { fake, printed } = await setup()
    setProfileSurveyEligible(true, 1_000)
    dispatchProfileSurveyInput({ type: 'digit', digit: 1, now: 1_500 })
    dispatchProfileSurveyInput({ type: 'escape', now: 4_000 })
    await profileSurveyIdle()
    expect(nonEvents(fake.requests).at(-1)).toEqual({
      action: 'dismiss',
      version: 1,
      durationMs: 3_000,
      questionId: SECOND,
      surface: 'cli',
    })
    expect(events(fake.requests).some((r) => r.action === 'event' && r.event === 'abandoned')).toBe(false)
    expect(printed).toEqual(["Not now: we'll ask again in 3 days."])
  })

  test('typing a prompt after render reports abandoned', async () => {
    const { fake, printed } = await setup()
    setProfileSurveyEligible(true, 1_000)
    closeProfileSurveyForTyping(7_500)
    await profileSurveyIdle()
    expect(events(fake.requests).at(-1)).toEqual({
      action: 'event',
      version: 1,
      event: 'abandoned',
      questionId: 'who_pays',
      durationMs: 6_500,
      surface: 'cli',
    })
    expect(printed).toEqual([])
  })

  test('typing before the box was ever on screen reports nothing', async () => {
    const { fake } = await setup()
    closeProfileSurveyForTyping(7_500)
    await profileSurveyIdle()
    expect(useProfileSurveyStore.getState().survey?.status).toBe('closed')
    expect(fake.requests).toEqual([])
  })

  test('a failing event POST never blocks or prints', async () => {
    const { fake, printed } = await setup(SHOWN, { failPosts: true })
    setProfileSurveyEligible(true, 0)
    closeProfileSurveyForTyping(5)
    await profileSurveyIdle()
    expect(events(fake.requests)).toHaveLength(3)
    expect(printed).toEqual([])
  })

  test('a throwing client is swallowed', async () => {
    const fake = createFakeProfileSurveyClient(SHOWN)
    fake.post = async () => {
      throw new Error('boom')
    }
    setProfileSurveyClientForTests(fake)
    await startProfileSurveyOnce(0)
    setProfileSurveyEligible(true, 0)
    await profileSurveyIdle()
    expect(getProfileSurveyKeyContext()?.question.id).toBe('who_pays')
  })
})
