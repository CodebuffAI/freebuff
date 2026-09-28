import { describe, expect, it } from 'bun:test'

import {
  FREEBUFF_ONBOARDING_QUESTIONS,
  OTHER_OPTION_ID,
  validateOnboardingSubmission,
} from '../freebuff-onboarding'
import {
  isAnswerReady,
  orderOptionsForDisplay,
  resumeIndex,
  selectionsFromAnswers,
  shouldAdvanceOnPick,
  toAnswerList,
  toggleOption,
} from '../freebuff-onboarding-form'

import type {
  OnboardingAnswer,
  OnboardingQuestion,
} from '../freebuff-onboarding'

const question = (id: string, overrides: Partial<OnboardingQuestion> = {}) =>
  ({
    id,
    prompt: `${id}?`,
    multi: false,
    options: [
      { id: 'a', label: 'A' },
      { id: 'b', label: 'B' },
      { id: OTHER_OPTION_ID, label: 'Other' },
    ],
    ...overrides,
  }) as OnboardingQuestion

const multi = (id: string) =>
  question(id, {
    multi: true,
    options: [
      { id: 'none', label: 'None', exclusive: true },
      { id: 'a', label: 'A' },
      { id: 'b', label: 'B' },
      { id: OTHER_OPTION_ID, label: 'Other' },
    ],
  })

describe('toggleOption', () => {
  it('replaces the answer on a single-choice question', () => {
    expect(toggleOption(question('q'), ['a'], 'b')).toEqual(['b'])
  })

  it('does not let a single-choice pick be un-picked into nothing', () => {
    // Tapping the selected chip again on a single-choice question would leave
    // the step unanswerable with no visible cause. Skip is the way out.
    expect(toggleOption(question('q'), ['a'], 'a')).toEqual(['a'])
  })

  it('accumulates and removes on a multi-select question', () => {
    expect(toggleOption(multi('q'), ['a'], 'b')).toEqual(['a', 'b'])
    expect(toggleOption(multi('q'), ['a', 'b'], 'a')).toEqual(['b'])
  })

  it('drops everything else when an exclusive option is picked', () => {
    expect(toggleOption(multi('q'), ['a', 'b'], 'none')).toEqual(['none'])
  })

  it('drops the exclusive option when a normal one is picked', () => {
    expect(toggleOption(multi('q'), ['none'], 'a')).toEqual(['a'])
  })
})

describe('isAnswerReady', () => {
  it('is false with nothing chosen', () => {
    expect(isAnswerReady(question('q'), [], undefined)).toBe(false)
  })

  it('is true for a plain choice', () => {
    expect(isAnswerReady(question('q'), ['a'], undefined)).toBe(true)
  })

  it('needs text when Other is chosen', () => {
    // The server refuses `other` with no text, so advancing without it would
    // drop an answer the person believes they gave.
    expect(isAnswerReady(question('q'), [OTHER_OPTION_ID], '   ')).toBe(false)
    expect(isAnswerReady(question('q'), [OTHER_OPTION_ID], 'a blog')).toBe(true)
  })
})

describe('shouldAdvanceOnPick', () => {
  it('advances on a single-choice pick', () => {
    expect(shouldAdvanceOnPick(question('q'), 'a')).toBe(true)
  })

  it('waits on multi-select', () => {
    expect(shouldAdvanceOnPick(multi('q'), 'a')).toBe(false)
  })

  it('waits on Other, which opens a text field', () => {
    expect(shouldAdvanceOnPick(question('q'), OTHER_OPTION_ID)).toBe(false)
  })
})

describe('toAnswerList', () => {
  const questions = [question('q1'), multi('q2')]
  /** The synthetic question ids above are not in the real id union. */
  const expected = (...answers: unknown[]) => answers as OnboardingAnswer[]

  it('omits unanswered questions', () => {
    expect(toAnswerList(questions, { q1: ['a'] }, {})).toEqual(
      expected({ questionId: 'q1', optionIds: ['a'] }),
    )
  })

  it('keeps Other text and drops an Other with none', () => {
    expect(
      toAnswerList(questions, { q1: [OTHER_OPTION_ID] }, { q1: '  reddit ' }),
    ).toEqual(
      expected({
        questionId: 'q1',
        optionIds: [OTHER_OPTION_ID],
        otherText: 'reddit',
      }),
    )
    expect(toAnswerList(questions, { q1: [OTHER_OPTION_ID] }, {})).toEqual([])
  })

  it('does not attach stray text to an answer that did not choose Other', () => {
    expect(toAnswerList(questions, { q1: ['a'] }, { q1: 'ignored' })).toEqual(
      expected({ questionId: 'q1', optionIds: ['a'] }),
    )
  })

  it('produces something the real server accepts', () => {
    // The contract that actually matters: a partial set of picks made in the UI
    // must survive validation, or the answers are lost at the last step.
    const [first, , third] = FREEBUFF_ONBOARDING_QUESTIONS
    const answers = toAnswerList(
      FREEBUFF_ONBOARDING_QUESTIONS,
      {
        [first!.id]: [first!.options[0]!.id],
        [third!.id]: [third!.options[1]!.id],
      },
      {},
    )
    const result = validateOnboardingSubmission({ answers })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.answers).toHaveLength(2)
  })
})

describe('resumeIndex', () => {
  const questions = [question('q1'), question('q2'), question('q3')]

  it('starts at the top for a fresh form', () => {
    expect(resumeIndex(questions, {})).toBe(0)
  })

  it('skips past questions already answered', () => {
    expect(resumeIndex(questions, { q1: ['a'] })).toBe(1)
    expect(resumeIndex(questions, { q1: ['a'], q2: ['b'] })).toBe(2)
  })

  it('does not skip a gap in the middle', () => {
    // Answering out of order is possible via Back; resume must land on the
    // hole, not past it.
    expect(resumeIndex(questions, { q1: ['a'], q3: ['b'] })).toBe(1)
  })

  it('lands on the last question when everything is answered', () => {
    expect(resumeIndex(questions, { q1: ['a'], q2: ['b'], q3: ['b'] })).toBe(2)
  })
})

describe('selectionsFromAnswers', () => {
  it('round-trips through toAnswerList', () => {
    const questions = [question('q1'), multi('q2')]
    const selected = { q1: [OTHER_OPTION_ID], q2: ['a', 'b'] }
    const otherText = { q1: 'a friend' }
    const restored = selectionsFromAnswers(
      toAnswerList(questions, selected, otherText),
    )
    expect(restored.selected).toEqual(selected)
    expect(restored.otherText).toEqual(otherText)
  })

  it('tolerates null', () => {
    expect(selectionsFromAnswers(null)).toEqual({ selected: {}, otherText: {} })
  })
})

describe('orderOptionsForDisplay', () => {
  const shuffled: OnboardingQuestion = {
    id: 'referral_source',
    prompt: 'Where?',
    multi: false,
    shuffleOptions: true,
    options: [
      { id: 'a', label: 'A' },
      { id: 'b', label: 'B' },
      { id: 'c', label: 'C' },
      { id: 'd', label: 'D' },
      { id: OTHER_OPTION_ID, label: 'Other' },
    ],
  }

  it('leaves an unflagged question in its declared order', () => {
    const q = { ...shuffled, shuffleOptions: false }
    expect(orderOptionsForDisplay(q, 0.42)).toEqual(q.options)
  })

  it('is a permutation with "other" pinned last, stable for one seed', () => {
    const once = orderOptionsForDisplay(shuffled, 0.42)
    expect(once.at(-1)?.id).toBe(OTHER_OPTION_ID)
    expect(once.map((o) => o.id).sort()).toEqual(
      shuffled.options.map((o) => o.id).sort(),
    )
    expect(orderOptionsForDisplay(shuffled, 0.42)).toEqual(once)
  })

  it('actually varies across seeds', () => {
    const orders = new Set(
      Array.from({ length: 20 }, (_, i) =>
        orderOptionsForDisplay(shuffled, i / 20)
          .map((o) => o.id)
          .join(','),
      ),
    )
    expect(orders.size).toBeGreaterThan(1)
  })
})
