import { afterEach, describe, expect, test } from 'bun:test'

import { createFakeSponsoredSurveyClient } from '@codebuff/common/constants/freebuff-sponsored-survey-client'

import { createFakeProfileSurveyClient } from '../../utils/profile-survey-api'
import { sponsoredOfferToSurveyState } from '../../utils/sponsored-survey-api'
import {
  dispatchProfileSurveyInput,
  getProfileSurveyKeyContext,
  profileSurveyIdle,
  setProfileSurveyClientForTests,
  setProfileSurveyEligible,
  setProfileSurveyPrinter,
  setSponsoredSurveyClientForTests,
  startProfileSurveyOnce,
  useProfileSurveyStore,
} from '../profile-survey-store'

import type { SponsoredSurveyOffer } from '@codebuff/common/constants/freebuff-sponsored-survey-client'

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

async function setup(offer: SponsoredSurveyOffer | null) {
  setProfileSurveyClientForTests(
    createFakeProfileSurveyClient({ show: false, reason: 'completed' }),
  )
  const fake = createFakeSponsoredSurveyClient(offer)
  setSponsoredSurveyClientForTests(fake)
  const printed: string[] = []
  setProfileSurveyPrinter((line) => printed.push(line))
  await startProfileSurveyOnce(0)
  return { fake, printed }
}

afterEach(() => setProfileSurveyClientForTests(null))

describe('sponsored survey in the CLI box', () => {
  test('maps an offer onto the machine', () => {
    const state = sponsoredOfferToSurveyState({ ...OFFER, resumeAt: 1 }, 5)
    expect(state?.step).toBe(1)
    expect(state?.questions[1]?.multi).toBe(true)
    expect(state?.sponsored).toEqual({ campaignId: 'c1', sponsorName: 'Acme' })
    expect(sponsoredOfferToSurveyState({ ...OFFER, resumeAt: 2 }, 5)).toBeNull()
  })

  test('takes the box when the profile survey has nothing to show, answers to completion', async () => {
    const { fake, printed } = await setup(OFFER)
    setProfileSurveyEligible(true)
    expect(getProfileSurveyKeyContext()?.question.id).toBe('q1')
    dispatchProfileSurveyInput({ type: 'digit', digit: 2, now: 1000 })
    dispatchProfileSurveyInput({ type: 'digit', digit: 1, now: 2000 })
    dispatchProfileSurveyInput({ type: 'digit', digit: 2, now: 2000 })
    dispatchProfileSurveyInput({ type: 'enter', now: 3000 })
    await profileSurveyIdle()
    expect(fake.requests).toEqual([
      {
        action: 'answer',
        campaignId: 'c1',
        questionId: 'q1',
        optionIds: ['code'],
        durationMs: 1000,
        surface: 'cli',
      },
      {
        action: 'answer',
        campaignId: 'c1',
        questionId: 'q2',
        optionIds: ['ts', 'py'],
        durationMs: 2000,
        surface: 'cli',
      },
    ])
    expect(useProfileSurveyStore.getState().survey?.status).toBe('completed')
    expect(printed).toEqual(['✓ +25 Freebucks added to your wallet'])
  })

  test('esc dismisses through the sponsored endpoint', async () => {
    const { fake } = await setup(OFFER)
    setProfileSurveyEligible(true)
    dispatchProfileSurveyInput({ type: 'escape', now: 1_000 })
    await profileSurveyIdle()
    expect(fake.requests).toEqual([
      { action: 'dismiss', campaignId: 'c1', surface: 'cli' },
    ])
  })

  test('nothing sponsored today: no box', async () => {
    await setup(null)
    expect(useProfileSurveyStore.getState().survey).toBeNull()
  })
})
