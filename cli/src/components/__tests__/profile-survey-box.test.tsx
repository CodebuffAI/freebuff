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

beforeAll(() => {
  initializeThemeStore()
})

/** Version 1's ten questions: the CLI is version-agnostic, and these pin its copy. */
const QUESTIONS: readonly ProfileSurveyQuestion[] =
  profileSurveyVersion(1)!.questionIds.map((id) => profileSurveyQuestion(id)!)

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
  test('header, progress, reward, prompt, numbered options and hints', async () => {
    const frame = await renderFrame(
      <ProfileSurveyBoxView state={stateAt(2)} width={80} />,
    )
    expect(frame).toContain('quick question 3/10')
    expect(frame).toContain('■■□□□□□□□□')
    expect(frame).toContain('+25 Freebucks for all 10')
    expect(frame).toContain('How big is the team you build with?')
    expect(frame).toContain('1 Just me')
    expect(frame).toContain("0 Doesn't apply")
    expect(frame).toContain("1–5 pick · 0 doesn't apply · ← back · esc not now (3 days)")
  })

  test('no reward copy when the arm pays nothing; no back on the first', async () => {
    const frame = await renderFrame(
      <ProfileSurveyBoxView state={stateAt(0, 0)} width={80} />,
    )
    expect(frame).not.toContain('Freebucks')
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
