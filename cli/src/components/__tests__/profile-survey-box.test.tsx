import { beforeAll, describe, expect, test } from 'bun:test'
import { createTestRenderer } from '@opentui/core/testing'
import { createRoot, flushSync } from '@opentui/react'
import React from 'react'

import {
  profileSurveyQuestion,
  profileSurveyVersion,
} from '@codebuff/common/constants/freebuff-profile-survey'

import { initializeThemeStore } from '../../hooks/use-theme'
import {
  createProfileSurveyState,
  transitionProfileSurvey,
} from '../../utils/profile-survey-machine'
import {
  packOptionLabels,
  profileSurveyProgressBar,
  ProfileSurveyBoxView,
} from '../profile-survey-box'

import type { ProfileSurveyQuestion } from '@codebuff/common/constants/freebuff-profile-survey'
import type { ProfileSurveyState } from '../../utils/profile-survey-machine'
import { sponsoredOfferToSurveyState } from '../../utils/sponsored-survey-api'

beforeAll(() => {
  initializeThemeStore()
})

/** Version 1's ten questions: the CLI is version-agnostic, and these pin its copy. */
const QUESTIONS: readonly ProfileSurveyQuestion[] = profileSurveyVersion(
  1,
)!.questionIds.map((id) => profileSurveyQuestion(id)!)

function stateAt(resumeAt: number, rewardFreebucks = 25): ProfileSurveyState {
  return createProfileSurveyState(
    {
      show: true,
      surveyId: 'profile',
      version: 1,
      questions: [...QUESTIONS],
      answers: [],
      resumeAt,
      rewardFreebucks,
      dismissCount: 0,
    },
    0,
  )!
}

const renderFrame = async (node: React.ReactNode, width = 80, height = 12) => {
  const setup = await createTestRenderer({ width, height })
  const root = createRoot(setup.renderer)
  flushSync(() => root.render(node))
  try {
    await setup.renderOnce()
    return setup.captureCharFrame()
  } finally {
    flushSync(() => root.unmount())
    setup.renderer.destroy()
  }
}

describe('ProfileSurveyBoxView', () => {
  test('draws ranking positions and a written-answer input with its own focus hint', async () => {
    const offer = {
      campaignId: 'c',
      sponsorName: 'Acme',
      resumeAt: 0,
      rewardFreebucks: 0,
      questions: [
        {
          id: 'q',
          prompt: 'Rank these',
          position: 0,
          kind: 'ranking',
          options: [
            { id: 'a', label: 'Speed' },
            { id: 'b', label: 'Reliability' },
          ],
        },
      ],
    }
    const ranking = sponsoredOfferToSurveyState(offer, 0)!
    ranking.selection = ['b', 'a']
    const rankFrame = await renderFrame(
      <ProfileSurveyBoxView state={ranking} width={100} />,
      100,
      14,
    )
    expect(rankFrame).toContain('1 #2 Speed')
    expect(rankFrame).toContain('2 #1 Reliability')
    expect(rankFrame).toContain('pick in rank order')
    const text = sponsoredOfferToSurveyState(
      {
        ...offer,
        questions: [{ ...offer.questions[0]!, kind: 'text', options: [] }],
      },
      0,
    )!
    text.textEditing = true
    text.textAnswer = 'Better docs'
    const textFrame = await renderFrame(
      <ProfileSurveyBoxView state={text} width={100} />,
      100,
      14,
    )
    expect(textFrame).toContain('Better docs')
    expect(textFrame).toContain('enter continue')
    expect(textFrame).toContain('11/2000')
  })

  test('header, progress, reward, prompt, numbered options and hints', async () => {
    const frame = await renderFrame(
      <ProfileSurveyBoxView state={stateAt(2)} width={80} />,
    )
    expect(frame).toContain('quick question 3/10')
    expect(frame).toContain('■■□□□□□□□□')
    expect(frame).toContain('+5 hours for all 10')
    expect(frame).toContain('How big is the team you build with?')
    expect(frame).toContain('1 Just me')
    expect(frame).toContain("0 Doesn't apply")
    expect(frame).toContain(
      "1–5 pick · 0 doesn't apply · ← back · esc not now",
    )
  })

  test('no reward copy when the arm pays nothing; no back on the first', async () => {
    const frame = await renderFrame(
      <ProfileSurveyBoxView state={stateAt(0, 0)} width={80} />,
    )
    expect(frame).not.toContain('hours')
    expect(frame).not.toContain('← back')
    expect(frame).toContain('quick question 1/10')
  })

  test('multi-select marks toggled options and offers Enter', async () => {
    const t = transitionProfileSurvey(stateAt(4), {
      type: 'digit',
      digit: 2,
      now: 0,
    })
    const frame = await renderFrame(
      <ProfileSurveyBoxView state={t.state} width={80} />,
      80,
      14,
    )
    expect(frame).toContain('2 ◉ Database')
    expect(frame).toContain('1 ○ Hosting')
    expect(frame).toContain('1–9 toggle · enter continue')
    expect(frame).not.toContain("0 doesn't apply")
  })
})

describe('layout helpers', () => {
  test('progress bar clamps', () => {
    expect(profileSurveyProgressBar(0, 3)).toBe('□□□')
    expect(profileSurveyProgressBar(5, 3)).toBe('■■■')
  })

  test('options pack into rows that fit', () => {
    expect(packOptionLabels(['1 aaaa', '2 bbbb', '3 cccc'], 15)).toEqual([
      '1 aaaa   2 bbbb',
      '3 cccc',
    ])
  })
})
