/**
 * The CLI's in-session profile survey (COD-779), as a pure state machine.
 *
 * No React, no network, no clock: every transition takes the current state
 * and one input and returns the next state plus the effects the caller must
 * run (POST an answer, POST a dismissal, POST an engagement event).
 * `state/profile-survey-store.ts` owns the effects; `profile-survey-box.tsx` only draws `state`. The contract — the
 * question bank, the wire types and the validity rule — is
 * `@codebuff/common/constants/freebuff-profile-survey`.
 *
 * Numbering: the question's options other than its notApplicable one are
 * `1..n` in the order the server sent them (bank order, or this user's
 * shuffled order under the option-order A/B); the notApplicable option, when
 * the question has one, is `0`. An exclusive option that is not notApplicable ("Not shopping") keeps
 * its number.
 */

import { isValidProfileSurveyAnswer } from '@codebuff/common/constants/freebuff-profile-survey'

import { isPlainEnterKey } from './terminal-enter-detection'

import type {
  ProfileSurveyAnswer,
  ProfileSurveyClientEventKind,
  ProfileSurveyOption,
  ProfileSurveyQuestion,
  ProfileSurveyQuestionId,
  ProfileSurveyStateResponse,
} from '@codebuff/common/constants/freebuff-profile-survey'

/** Only digits 1–9 fit one keypress; a longer list would leave the tail
 *  unreachable, so the numbering stops there (the v1 bank tops out at 9). */
export const MAX_NUMBERED_OPTIONS = 9

export type ProfileSurveyStatus =
  /** On screen, waiting for a key. */
  | 'asking'
  /** The last answer was given; waiting for the server to say it is done. */
  | 'finishing'
  /** Answered everything. */
  | 'completed'
  /** Esc: snoozed or stopped server-side. */
  | 'dismissed'
  /** The user started typing a prompt. Answers so far are kept server-side;
   *  the survey may come back next session. */
  | 'closed'

export type ProfileSurveyState = {
  version: number
  questions: ProfileSurveyQuestion[]
  rewardFreebucks: number
  /** "Not now"s already on file, so the next one's snooze is known. */
  dismissCount: number
  /** Index into `questions`. Equals `questions.length` once finished. */
  step: number
  /** Committed answers by question id (server-resumed or given here). */
  answers: Record<string, string[]>
  /** Working selection on a multi-select question. */
  selection: string[]
  /** When the current question was shown, for `durationMs`. */
  questionShownAt: number
  /** When the box first came on screen (the `rendered` event), or null while
   *  it never has. Dismiss and abandon durations count from here. */
  renderedAt: number | null
  /** The question last reported as `question_viewed`, so a box that hides
   *  and comes back on the same question does not report it twice. */
  viewedQuestionId: ProfileSurveyQuestionId | null
  status: ProfileSurveyStatus
  /** Set when this is the day's sponsored survey (COD-839), driven through
   *  this machine; its effects go to `/api/sponsored-survey`. */
  sponsored?: { campaignId: string; sponsorName: string }
}

export type ProfileSurveyInput =
  | { type: 'digit'; digit: number; now: number }
  | { type: 'enter'; now: number }
  | { type: 'back'; now: number }
  | { type: 'escape'; now: number }
  | { type: 'typed'; now: number }
  /** The box is on screen right now (the store sends it after every change
   *  while eligible and asking). Idempotent: it only reports what is new. */
  | { type: 'shown'; now: number }

export type ProfileSurveyEffect =
  | {
      type: 'answer'
      version: number
      questionId: ProfileSurveyQuestionId
      optionIds: string[]
      durationMs: number
      /** True when this answer is the last unanswered one. */
      last: boolean
    }
  | {
      type: 'dismiss'
      version: number
      /** Time on screen since the box first rendered. */
      durationMs?: number
      questionId?: ProfileSurveyQuestionId
    }
  /** Fire-and-forget engagement event (the contract's `event` action). */
  | {
      type: 'event'
      version: number
      event: ProfileSurveyClientEventKind
      questionId?: ProfileSurveyQuestionId
      durationMs?: number
    }

export type ProfileSurveyTransition = {
  state: ProfileSurveyState
  effects: ProfileSurveyEffect[]
}

export type NumberedOption = { key: number; option: ProfileSurveyOption }

/** The options as the box lists them: `1..n`, then `0` for notApplicable. */
export function numberedOptions(
  question: ProfileSurveyQuestion,
): NumberedOption[] {
  const regular = question.options
    .filter((o) => !o.notApplicable)
    .slice(0, MAX_NUMBERED_OPTIONS)
    .map((option, i) => ({ key: i + 1, option }))
  const na = question.options.find((o) => o.notApplicable)
  return na ? [...regular, { key: 0, option: na }] : regular
}

export function optionForDigit(
  question: ProfileSurveyQuestion,
  digit: number,
): ProfileSurveyOption | undefined {
  return numberedOptions(question).find((n) => n.key === digit)?.option
}

/** The machine for a `show: true` GET, or null for anything else. */
export function createProfileSurveyState(
  response: ProfileSurveyStateResponse,
  now: number,
): ProfileSurveyState | null {
  if (!response.show || response.questions.length === 0) return null
  const answers: Record<string, string[]> = {}
  for (const a of response.answers as ProfileSurveyAnswer[]) {
    answers[a.questionId] = [...a.optionIds]
  }
  const step = Math.min(
    Math.max(0, response.resumeAt),
    response.questions.length,
  )
  if (step >= response.questions.length) return null
  return {
    version: response.version,
    questions: response.questions,
    rewardFreebucks: response.rewardFreebucks,
    dismissCount: response.dismissCount,
    step,
    answers,
    selection: selectionFor(response.questions[step], answers),
    questionShownAt: now,
    renderedAt: null,
    viewedQuestionId: null,
    status: 'asking',
  }
}

export function currentQuestion(
  state: ProfileSurveyState,
): ProfileSurveyQuestion | undefined {
  return state.questions[state.step]
}

function selectionFor(
  question: ProfileSurveyQuestion | undefined,
  answers: Record<string, string[]>,
): string[] {
  if (!question?.multi) return []
  return [...(answers[question.id] ?? [])]
}

/** Toggle one option in a multi-select, honouring exclusivity both ways. */
export function toggleSelection(
  question: ProfileSurveyQuestion,
  selection: readonly string[],
  optionId: string,
): string[] {
  if (selection.includes(optionId)) {
    return selection.filter((id) => id !== optionId)
  }
  const option = question.options.find((o) => o.id === optionId)
  if (!option) return [...selection]
  if (option.exclusive || option.notApplicable) return [optionId]
  const exclusive = new Set(
    question.options
      .filter((o) => o.exclusive || o.notApplicable)
      .map((o) => o.id),
  )
  return [...selection.filter((id) => !exclusive.has(id)), optionId]
}

function commit(
  state: ProfileSurveyState,
  question: ProfileSurveyQuestion,
  optionIds: string[],
  now: number,
): ProfileSurveyTransition {
  const answers = { ...state.answers, [question.id]: optionIds }
  const nextStep = state.step + 1
  const remaining = state.questions
    .slice(nextStep)
    .some((q) => answers[q.id] === undefined)
  const last = nextStep >= state.questions.length
  const effect: ProfileSurveyEffect = {
    type: 'answer',
    version: state.version,
    questionId: question.id as ProfileSurveyQuestionId,
    optionIds,
    durationMs: Math.max(0, now - state.questionShownAt),
    last: last && !remaining,
  }
  if (last) {
    return {
      state: {
        ...state,
        answers,
        step: nextStep,
        selection: [],
        status: 'finishing',
      },
      effects: [effect],
    }
  }
  return {
    state: {
      ...state,
      answers,
      step: nextStep,
      selection: selectionFor(state.questions[nextStep], answers),
      questionShownAt: now,
    },
    effects: [effect],
  }
}

export function transitionProfileSurvey(
  state: ProfileSurveyState,
  input: ProfileSurveyInput,
): ProfileSurveyTransition {
  const unchanged = { state, effects: [] }
  if (state.status !== 'asking') return unchanged
  const question = currentQuestion(state)
  if (!question) return unchanged

  const questionId = question.id as ProfileSurveyQuestionId
  const onScreenFor = (now: number) =>
    state.renderedAt === null ? {} : { durationMs: Math.max(0, now - state.renderedAt) }

  switch (input.type) {
    case 'shown': {
      const effects: ProfileSurveyEffect[] = []
      if (state.renderedAt === null) {
        effects.push({ type: 'event', version: state.version, event: 'rendered' })
      }
      if (state.viewedQuestionId !== questionId) {
        effects.push({
          type: 'event',
          version: state.version,
          event: 'question_viewed',
          questionId,
        })
      }
      if (effects.length === 0) return unchanged
      return {
        state: {
          ...state,
          renderedAt: state.renderedAt ?? input.now,
          viewedQuestionId: questionId,
        },
        effects,
      }
    }

    case 'typed':
      // Abandoned only if it was ever on screen: a box the user never saw
      // was not walked away from.
      return {
        state: { ...state, status: 'closed' },
        effects:
          state.renderedAt === null
            ? []
            : [
                {
                  type: 'event',
                  version: state.version,
                  event: 'abandoned',
                  questionId,
                  ...onScreenFor(input.now),
                },
              ],
      }

    case 'escape':
      return {
        state: { ...state, status: 'dismissed' },
        effects: [
          {
            type: 'dismiss',
            version: state.version,
            questionId,
            ...onScreenFor(input.now),
          },
        ],
      }

    case 'back': {
      if (state.step === 0) return unchanged
      const step = state.step - 1
      return {
        state: {
          ...state,
          step,
          selection: selectionFor(state.questions[step], state.answers),
          questionShownAt: input.now,
        },
        effects: [],
      }
    }

    case 'digit': {
      const option = optionForDigit(question, input.digit)
      if (!option) return unchanged
      if (!question.multi) return commit(state, question, [option.id], input.now)
      return {
        state: {
          ...state,
          selection: toggleSelection(question, state.selection, option.id),
        },
        effects: [],
      }
    }

    case 'enter': {
      if (!question.multi) return unchanged
      if (!isValidProfileSurveyAnswer(question, state.selection)) {
        return unchanged
      }
      return commit(state, question, [...state.selection], input.now)
    }
  }
}

/** What finishing resolved to, from the last answer's POST. */
export function finishProfileSurvey(
  state: ProfileSurveyState,
  completed: boolean,
): ProfileSurveyState {
  if (state.status !== 'finishing') return state
  return { ...state, status: completed ? 'completed' : 'closed' }
}

// ---- keys -------------------------------------------------------------

/** The key fields the CLI's handlers see (a subset of OpenTUI's KeyEvent). */
export type ProfileSurveyKey = {
  name?: string
  sequence?: string
  shift?: boolean
  ctrl?: boolean
  meta?: boolean
  option?: boolean
}

/** What the keyboard layer needs to know about the box, or null when the
 *  box is not on screen (then it claims nothing). */
export type ProfileSurveyKeyContext = {
  question: ProfileSurveyQuestion
}

/**
 * The one place that decides whether a key belongs to the survey. Both the
 * composer's intercept and the chat keyboard resolver call it, so they can
 * never disagree about a key. Callers must already have checked that the
 * draft is empty and the input mode is default: the survey never claims a
 * key while the user has started a prompt.
 *
 * Claimed: a digit that names an option on this question, ← (back), Esc
 * (not now), and Enter on a multi-select. Everything else — letters, a digit
 * with no option, modified keys — falls through to the composer, where it
 * starts a prompt and closes the box.
 */
export function profileSurveyInputForKey(
  key: ProfileSurveyKey,
  context: ProfileSurveyKeyContext | null | undefined,
  now: number = Date.now(),
): ProfileSurveyInput | null {
  if (!context) return null
  if (key.ctrl || key.meta || key.option) return null
  if (key.name === 'escape') return { type: 'escape', now }
  if (key.name === 'left' && !key.shift) return { type: 'back', now }
  if (context.question.multi && isPlainEnterKey(key)) {
    return { type: 'enter', now }
  }
  const char = key.sequence ?? key.name
  if (char && /^[0-9]$/.test(char)) {
    const digit = Number(char)
    if (optionForDigit(context.question, digit)) {
      return { type: 'digit', digit, now }
    }
  }
  return null
}

// ---- copy -------------------------------------------------------------

export function profileSurveyCompletionLines(
  rewardedFreebucks: number,
  total: number,
  accountUrl: string,
): string {
  const head =
    rewardedFreebucks > 0
      ? `✓ +${rewardedFreebucks} Freebucks added to your wallet`
      : `✓ Thanks, that's all ${total}`
  return `${head}\nedit answers: ${accountUrl}`
}

export function profileSurveyDismissLine(snoozeDays: number | null): string {
  return snoozeDays === null
    ? "Got it, we won't ask again."
    : `Not now: we'll ask again in ${snoozeDays} days.`
}
