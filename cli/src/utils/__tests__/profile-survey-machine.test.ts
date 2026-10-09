import { describe, expect, test } from 'bun:test'

import {
  profileSurveyQuestion,
  profileSurveyVersion,
} from '@codebuff/common/constants/freebuff-profile-survey'

import {
  createProfileSurveyState,
  currentQuestion,
  finishProfileSurvey,
  numberedOptions,
  profileSurveyCompletionLines,
  profileSurveyDismissLine,
  profileSurveyInputForKey,
  toggleSelection,
  transitionProfileSurvey,
} from '../profile-survey-machine'

import type {
  ProfileSurveyQuestion,
  ProfileSurveyStateResponse,
} from '@codebuff/common/constants/freebuff-profile-survey'
import type {
  ProfileSurveyInput,
  ProfileSurveyState,
} from '../profile-survey-machine'

/** Version 1's ten questions: the machine is version-agnostic, and these pin it. */
const QUESTIONS: readonly ProfileSurveyQuestion[] =
  profileSurveyVersion(1)!.questionIds.map((id) => profileSurveyQuestion(id)!)
const q = (id: string) => profileSurveyQuestion(id)!

function shown(
  overrides: Partial<Extract<ProfileSurveyStateResponse, { show: true }>> = {},
): ProfileSurveyStateResponse {
  return {
    show: true,
    surveyId: 'profile',
    version: 1,
    questions: [...QUESTIONS],
    answers: [],
    resumeAt: 0,
    rewardFreebucks: 25,
    dismissCount: 0,
    ...overrides,
  }
}

function start(
  overrides?: Partial<Extract<ProfileSurveyStateResponse, { show: true }>>,
): ProfileSurveyState {
  const state = createProfileSurveyState(shown(overrides), 1_000)
  if (!state) throw new Error('expected a survey')
  return state
}

function run(state: ProfileSurveyState, ...inputs: ProfileSurveyInput[]) {
  const effects = []
  for (const input of inputs) {
    const t = transitionProfileSurvey(state, input)
    state = t.state
    effects.push(...t.effects)
  }
  return { state, effects }
}

const digit = (d: number, now = 2_000): ProfileSurveyInput => ({
  type: 'digit',
  digit: d,
  now,
})

describe('createProfileSurveyState', () => {
  test('null for a hidden response', () => {
    expect(
      createProfileSurveyState({ show: false, reason: 'snoozed' }, 0),
    ).toBeNull()
  })

  test('resumes at resumeAt with the answers on file', () => {
    const state = start({
      resumeAt: 2,
      answers: [
        { questionId: 'who_pays', questionRevision: 1, optionIds: ['me'] },
        { questionId: 'tool_spend', questionRevision: 1, optionIds: ['zero'] },
      ],
    })
    expect(state.step).toBe(2)
    expect(currentQuestion(state)?.id).toBe('team_size')
    expect(state.answers.who_pays).toEqual(['me'])
    expect(state.status).toBe('asking')
  })

  test('null when resumeAt is already past the end', () => {
    expect(
      createProfileSurveyState(shown({ resumeAt: QUESTIONS.length }), 0),
    ).toBeNull()
  })

  test('a multi-select resumed onto keeps its stored selection', () => {
    const state = start({
      resumeAt: 4,
      answers: [
        {
          questionId: 'shopping',
          questionRevision: 1,
          optionIds: ['hosting', 'auth'],
        },
      ],
    })
    expect(currentQuestion(state)?.id).toBe('shopping')
    expect(state.selection).toEqual(['hosting', 'auth'])
  })
})

describe('numberedOptions', () => {
  test('regular options are 1..n and notApplicable is 0', () => {
    const numbered = numberedOptions(q('who_pays'))
    expect(numbered.map((n) => [n.key, n.option.id])).toEqual([
      [1, 'me'],
      [2, 'employer'],
      [3, 'both'],
      [4, 'nobody'],
      [0, 'na'],
    ])
  })

  test('an exclusive option that is not notApplicable keeps its number', () => {
    const numbered = numberedOptions(q('shopping'))
    expect(numbered.at(-1)).toEqual({
      key: 9,
      option: expect.objectContaining({ id: 'none' }),
    })
    expect(numbered.some((n) => n.key === 0)).toBe(false)
  })

  test('every v1 question fits single-digit keys', () => {
    for (const question of QUESTIONS) {
      const regular = question.options.filter((o) => !o.notApplicable)
      expect(regular.length).toBeLessThanOrEqual(9)
      expect(numberedOptions(question)).toHaveLength(question.options.length)
    }
  })
})

describe('single choice', () => {
  test('a digit answers and advances, emitting one answer effect', () => {
    const { state, effects } = run(start(), digit(2, 1_750))
    expect(state.step).toBe(1)
    expect(state.answers.who_pays).toEqual(['employer'])
    expect(state.questionShownAt).toBe(1_750)
    expect(effects).toEqual([
      {
        type: 'answer',
        version: 1,
        questionId: 'who_pays',
        optionIds: ['employer'],
        durationMs: 750,
        last: false,
      },
    ])
  })

  test('0 picks the notApplicable option', () => {
    const { effects } = run(start(), digit(0))
    expect(effects[0]).toMatchObject({ optionIds: ['na'] })
  })

  test('a digit with no option does nothing', () => {
    const before = start()
    const { state, effects } = run(before, digit(7))
    expect(state).toBe(before)
    expect(effects).toEqual([])
  })

  test('Enter does nothing on a single-choice question', () => {
    const before = start()
    const { state, effects } = run(before, { type: 'enter', now: 0 })
    expect(state).toBe(before)
    expect(effects).toEqual([])
  })
})

describe('multi-select', () => {
  const atShopping = () => start({ resumeAt: 4 })

  test('digits toggle and Enter continues', () => {
    const { state, effects } = run(
      atShopping(),
      digit(1),
      digit(3),
      digit(1),
      digit(2),
      { type: 'enter', now: 5_000 },
    )
    expect(effects).toEqual([
      expect.objectContaining({
        questionId: 'shopping',
        optionIds: ['auth', 'database'],
        durationMs: 4_000,
      }),
    ])
    expect(currentQuestion(state)?.id).toBe('deploy')
  })

  test('an exclusive option clears the others, and vice versa', () => {
    const question = q('shopping')
    expect(toggleSelection(question, ['hosting', 'auth'], 'none')).toEqual([
      'none',
    ])
    expect(toggleSelection(question, ['none'], 'hosting')).toEqual(['hosting'])
    const db = q('database')
    expect(toggleSelection(db, ['postgres'], 'na')).toEqual(['na'])
    expect(toggleSelection(db, ['na'], 'sqlite')).toEqual(['sqlite'])
  })

  test('Enter with nothing selected does nothing', () => {
    const before = atShopping()
    const { state, effects } = run(before, { type: 'enter', now: 0 })
    expect(state).toBe(before)
    expect(effects).toEqual([])
  })
})

describe('back', () => {
  test('goes to the previous question with its answer preselected', () => {
    const { state } = run(
      start({ resumeAt: 4 }),
      digit(1),
      digit(2),
      { type: 'enter', now: 0 },
      { type: 'back', now: 9_000 },
    )
    expect(currentQuestion(state)?.id).toBe('shopping')
    expect(state.selection).toEqual(['hosting', 'database'])
    expect(state.questionShownAt).toBe(9_000)
  })

  test('is a no-op on the first question', () => {
    const before = start()
    expect(run(before, { type: 'back', now: 0 }).state).toBe(before)
  })

  test('re-answering a question emits a fresh answer', () => {
    const { effects } = run(start(), digit(1), { type: 'back', now: 0 }, digit(3))
    expect(effects.map((e) => e.type === 'answer' && e.optionIds)).toEqual([
      ['me'],
      ['both'],
    ])
  })
})

describe('escape and typing', () => {
  test('Esc dismisses with one effect', () => {
    const { state, effects } = run(start(), { type: 'escape' })
    expect(state.status).toBe('dismissed')
    expect(effects).toEqual([{ type: 'dismiss', version: 1 }])
  })

  test('typing closes silently and keeps answers', () => {
    const { state, effects } = run(start(), digit(1), { type: 'typed' })
    expect(state.status).toBe('closed')
    expect(state.answers.who_pays).toEqual(['me'])
    expect(effects).toHaveLength(1) // only the answer, no dismiss
  })

  test('a closed survey ignores every further input', () => {
    const closed = run(start(), { type: 'typed' }).state
    for (const input of [digit(1), { type: 'escape' } as const]) {
      const t = transitionProfileSurvey(closed, input)
      expect(t.state).toBe(closed)
      expect(t.effects).toEqual([])
    }
  })
})

describe('finishing', () => {
  test('the last answer marks the effect last and waits for the server', () => {
    const { state, effects } = run(start({ resumeAt: 9 }), digit(1))
    expect(state.status).toBe('finishing')
    expect(state.step).toBe(QUESTIONS.length)
    expect(effects).toEqual([
      expect.objectContaining({ questionId: 'industry', last: true }),
    ])
    expect(finishProfileSurvey(state, true).status).toBe('completed')
    expect(finishProfileSurvey(state, false).status).toBe('closed')
  })

  test('a full run answers all ten in order', () => {
    let state = start()
    const ids: string[] = []
    while (state.status === 'asking') {
      const question = currentQuestion(state)!
      const inputs: ProfileSurveyInput[] = question.multi
        ? [digit(1), { type: 'enter', now: 0 }]
        : [digit(1)]
      const t = run(state, ...inputs)
      state = t.state
      for (const e of t.effects) if (e.type === 'answer') ids.push(e.questionId)
    }
    expect(ids).toEqual(QUESTIONS.map((x) => x.id))
    expect(state.status).toBe('finishing')
  })
})

describe('profileSurveyInputForKey', () => {
  const single = { question: q('who_pays') }
  const multi = { question: q('shopping') }

  test('claims nothing without a context', () => {
    expect(profileSurveyInputForKey({ name: '1', sequence: '1' }, null, 0)).toBeNull()
    expect(profileSurveyInputForKey({ name: 'escape' }, null, 0)).toBeNull()
  })

  test('claims digits that name an option, and only those', () => {
    expect(
      profileSurveyInputForKey({ name: '2', sequence: '2' }, single, 5),
    ).toEqual({ type: 'digit', digit: 2, now: 5 })
    expect(
      profileSurveyInputForKey({ name: '0', sequence: '0' }, single, 5),
    ).toEqual({ type: 'digit', digit: 0, now: 5 })
    // who_pays has 4 regular options: 7 is typed into the prompt.
    expect(profileSurveyInputForKey({ name: '7', sequence: '7' }, single, 5)).toBeNull()
    // shopping has no notApplicable option: 0 is typed into the prompt.
    expect(profileSurveyInputForKey({ name: '0', sequence: '0' }, multi, 5)).toBeNull()
  })

  test('claims ← and Esc; Enter only on multi-select', () => {
    expect(profileSurveyInputForKey({ name: 'left' }, single, 1)).toEqual({
      type: 'back',
      now: 1,
    })
    expect(profileSurveyInputForKey({ name: 'escape' }, single, 1)).toEqual({
      type: 'escape',
    })
    expect(profileSurveyInputForKey({ name: 'return' }, single, 1)).toBeNull()
    expect(profileSurveyInputForKey({ name: 'return' }, multi, 1)).toEqual({
      type: 'enter',
      now: 1,
    })
  })

  test('never claims letters or modified keys', () => {
    expect(profileSurveyInputForKey({ name: 'a', sequence: 'a' }, single, 0)).toBeNull()
    expect(
      profileSurveyInputForKey({ name: '1', sequence: '1', ctrl: true }, single, 0),
    ).toBeNull()
    expect(
      profileSurveyInputForKey({ name: 'left', shift: true }, single, 0),
    ).toBeNull()
    expect(
      profileSurveyInputForKey({ name: 'escape', meta: true }, single, 0),
    ).toBeNull()
  })
})

describe('copy', () => {
  test('completion with and without a reward', () => {
    expect(profileSurveyCompletionLines(25, 10, 'https://x/account')).toBe(
      '✓ +25 Freebucks added to your wallet\nedit answers: https://x/account',
    )
    expect(profileSurveyCompletionLines(0, 10, 'https://x/account')).toBe(
      "✓ Thanks, that's all 10\nedit answers: https://x/account",
    )
  })

  test('dismissal', () => {
    expect(profileSurveyDismissLine(7)).toBe("Not now: we'll ask again in 7 days.")
    expect(profileSurveyDismissLine(null)).toContain("won't ask again")
  })
})
