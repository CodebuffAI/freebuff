import { afterEach, describe, expect, test } from 'bun:test'

import {
  profileSurveyQuestion,
  profileSurveyVersion,
} from '@codebuff/common/constants/freebuff-profile-survey'
import { createFakeSponsoredSurveyClient } from '@codebuff/common/constants/freebuff-sponsored-survey-client'

import {
  closeProfileSurveyForTyping,
  dispatchProfileSurveyInput,
  profileSurveyIdle,
  setProfileSurveyClientForTests,
  setProfileSurveyEligible,
  setSponsoredSurveyClientForTests,
  startProfileSurveyOnce,
} from '../../state/profile-survey-store'
import { createFakeProfileSurveyClient } from '../profile-survey-api'
import {
  createCliSurveyEventSender,
  flushSurveyEventsOnExit,
  setCliSurveyEventSinkForTests,
} from '../survey-events'

import type { ProfileSurveyStateResponse } from '@codebuff/common/constants/freebuff-profile-survey'
import type { SurveyEventInput } from '@codebuff/common/constants/freebuff-sponsored-survey'
import type { SponsoredSurveyOffer } from '@codebuff/common/constants/freebuff-sponsored-survey-client'
import type { SurveyEventSink } from '@codebuff/common/constants/freebuff-survey-events-client'

const QUESTIONS = profileSurveyVersion(1)!.questionIds.map(
  (id) => profileSurveyQuestion(id)!,
)
const PROFILE_SHOWN: ProfileSurveyStateResponse = {
  show: true,
  surveyId: 'profile',
  version: 1,
  questions: [...QUESTIONS],
  answers: [],
  resumeAt: 0,
  rewardFreebucks: 25,
  dismissCount: 0,
}

const OFFER: SponsoredSurveyOffer = {
  campaignId: 'c1',
  sponsorName: 'Acme',
  questions: [
    {
      id: 'q1',
      position: 0,
      prompt: 'Which editor?',
      kind: 'single',
      options: [
        { id: 'vim', label: 'Vim' },
        { id: 'code', label: 'VS Code' },
      ],
    },
    {
      id: 'q2',
      position: 1,
      prompt: 'Which languages?',
      kind: 'multi',
      options: [
        { id: 'ts', label: 'TypeScript' },
        { id: 'py', label: 'Python' },
      ],
    },
  ],
  resumeAt: 0,
  rewardFreebucks: 25,
}

function recordingSink() {
  const events: SurveyEventInput[] = []
  const listeners = new Set<() => void>()
  const sink: SurveyEventSink = {
    push: (e) => void events.push(e),
    flush: async () => {},
    unload: async () => {
      for (const l of listeners) l()
    },
    onUnload: (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    pending: () => 0,
  }
  return {
    sink,
    events,
    types: () => events.map((e) => [e.eventType, e.questionIndex]),
  }
}

/** The day's sponsored survey in the box (no profile survey to show). */
async function setup() {
  const rec = recordingSink()
  setProfileSurveyClientForTests(
    createFakeProfileSurveyClient({ show: false, reason: 'completed' }),
  )
  setSponsoredSurveyClientForTests(createFakeSponsoredSurveyClient(OFFER))
  setCliSurveyEventSinkForTests(rec.sink)
  await startProfileSurveyOnce(0)
  return rec
}

afterEach(() => {
  setProfileSurveyClientForTests(null)
  setCliSurveyEventSinkForTests(null)
})

describe('CLI sponsored survey funnel pings', () => {
  test('nothing until the box is on screen; then rendered, viewed, answered with dwell', async () => {
    const rec = await setup()
    expect(rec.events).toEqual([])
    setProfileSurveyEligible(true)
    expect(rec.types()).toEqual([
      ['card_rendered', undefined],
      ['question_viewed', 0],
    ])
    dispatchProfileSurveyInput({ type: 'digit', digit: 1, now: 2_500 })
    await profileSurveyIdle()
    expect(rec.types().slice(2)).toEqual([
      ['answered', 0],
      ['question_viewed', 1],
    ])
    expect(rec.events[2]).toMatchObject({
      surveyKind: 'sponsored',
      surveyRef: 'c1',
      surface: 'cli',
      questionId: 'q1',
      dwellMs: 2_500,
    })
    // hidden between turns and shown again: no second render or view
    setProfileSurveyEligible(false)
    setProfileSurveyEligible(true)
    expect(rec.events).toHaveLength(4)
  })

  test('Esc is dismissed, with no abandon after it', async () => {
    const rec = await setup()
    setProfileSurveyEligible(true)
    dispatchProfileSurveyInput({ type: 'escape', now: 1_000 })
    await profileSurveyIdle()
    await flushSurveyEventsOnExit()
    expect(rec.types()).toEqual([
      ['card_rendered', undefined],
      ['question_viewed', 0],
      ['dismissed', 0],
    ])
  })

  test('typing a prompt over an unanswered question is abandoned', async () => {
    const rec = await setup()
    setProfileSurveyEligible(true)
    closeProfileSurveyForTyping()
    expect(rec.events.at(-1)).toMatchObject({
      eventType: 'abandoned',
      questionIndex: 0,
    })
  })

  test('quitting with the survey open reports abandoned once', async () => {
    const rec = await setup()
    setProfileSurveyEligible(true)
    await flushSurveyEventsOnExit()
    await flushSurveyEventsOnExit()
    expect(rec.events.filter((e) => e.eventType === 'abandoned')).toHaveLength(
      1,
    )
  })

  test('the profile survey sends nothing here (its events are profile_survey_event, #6278)', async () => {
    const rec = recordingSink()
    setProfileSurveyClientForTests(createFakeProfileSurveyClient(PROFILE_SHOWN))
    setCliSurveyEventSinkForTests(rec.sink)
    await startProfileSurveyOnce(0)
    setProfileSurveyEligible(true)
    dispatchProfileSurveyInput({ type: 'digit', digit: 1, now: 2_500 })
    closeProfileSurveyForTyping()
    await profileSurveyIdle()
    await flushSurveyEventsOnExit()
    expect(rec.events).toEqual([])
  })
})

describe('createCliSurveyEventSender', () => {
  test('posts with the bearer to freebuff.com; no token sends nothing; errors are swallowed', async () => {
    const calls: Array<[string, RequestInit]> = []
    const send = createCliSurveyEventSender({
      baseUrl: 'https://freebuff.test/',
      getToken: () => 'tok',
      fetchImpl: (async (url: string, init: RequestInit) => {
        calls.push([url, init])
        return new Response(null, { status: 204 })
      }) as unknown as typeof fetch,
    })
    const batch = {
      events: [
        {
          surveyKind: 'sponsored' as const,
          surveyRef: 'c1',
          eventType: 'card_rendered' as const,
        },
      ],
    }
    await send(batch, { unloading: false })
    expect(calls[0][0]).toBe('https://freebuff.test/api/survey-events')
    expect(
      (calls[0][1].headers as Record<string, string>).authorization,
    ).toBe('Bearer tok')

    let fetched = 0
    await createCliSurveyEventSender({
      getToken: () => undefined,
      fetchImpl: (async () => {
        fetched++
        return new Response(null)
      }) as unknown as typeof fetch,
    })(batch, { unloading: false })
    expect(fetched).toBe(0)

    await createCliSurveyEventSender({
      getToken: () => 'tok',
      fetchImpl: (async () => {
        throw new Error('offline')
      }) as unknown as typeof fetch,
    })(batch, { unloading: true })
  })
})
