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
import {
  isValidSponsoredSurveyAnswer,
  SPONSORED_SURVEY_LIMITS,
  type SponsoredSurveyQuestionKind,
} from '@codebuff/common/constants/freebuff-sponsored-survey'
import { formatHoursWithUnit } from '@codebuff/common/util/freebuff-hours'
import { sanitizeTerminalStrings } from '@codebuff/common/util/terminal-safe-text'

import { isPlainEnterKey } from './terminal-enter-detection'

import type {
  ProfileSurveyAnswer,
  ProfileSurveyClientEventKind,
  ProfileSurveyOption,
  ProfileSurveyQuestion,
  ProfileSurveyQuestionId,
  ProfileSurveyStateResponse,
} from '@codebuff/common/constants/freebuff-profile-survey'

/** The profile bank fits the digit shortcuts; sponsored surveys also use a–c. */
export const MAX_NUMBERED_OPTIONS = 9

/** Sponsored surveys can also ask for an ordering or a written answer. */
export type SurveyMachineQuestion = ProfileSurveyQuestion & {
  sponsoredKind?: SponsoredSurveyQuestionKind
}

/** Sponsored choices 10–12 use a–c so every option has a single-key shortcut. */
export function surveyOptionKey(key: number): string {
  return key <= 9 ? String(key) : String.fromCharCode(97 + key - 10)
}

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
  questions: SurveyMachineQuestion[]
  rewardFreebucks: number
  /** "Not now"s already on file, so the next one's snooze is known. */
  dismissCount: number
  /** Index into `questions`. Equals `questions.length` once finished. */
  step: number
  /** Committed answers by question id (server-resumed or given here). */
  answers: Record<string, string[]>
  /** Working selection on a multi-select, or the selected ranking order. */
  selection: string[]
  textAnswers?: Record<string, string>
  textAnswer?: string
  /** Enter explicitly focuses a written answer; ordinary prompt typing still works. */
  textEditing?: boolean
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
  | { type: 'text'; text: string; now: number }
  | { type: 'delete-text'; now: number }
  /** The box is on screen right now (the store sends it after every change
   *  while eligible and asking). Idempotent: it only reports what is new. */
  | { type: 'shown'; now: number }

export type ProfileSurveyEffect =
  | {
      type: 'answer'
      version: number
      questionId: ProfileSurveyQuestionId
      optionIds: string[]
      textAnswer?: string
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
  question: SurveyMachineQuestion,
): NumberedOption[] {
  const regular = question.options
    .filter((o) => !o.notApplicable)
    .slice(
      0,
      question.sponsoredKind
        ? SPONSORED_SURVEY_LIMITS.optionsMax
        : MAX_NUMBERED_OPTIONS,
    )
    .map((option, i) => ({ key: i + 1, option }))
  const na = question.options.find((o) => o.notApplicable)
  return na ? [...regular, { key: 0, option: na }] : regular
}

export function optionForDigit(
  question: SurveyMachineQuestion,
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
): SurveyMachineQuestion | undefined {
  return state.questions[state.step]
}

function selectionFor(
  question: SurveyMachineQuestion | undefined,
  answers: Record<string, string[]>,
): string[] {
  if (!question?.multi && question?.sponsoredKind !== 'ranking') return []
  return [...(answers[question.id] ?? [])]
}

/** Toggle one option in a multi-select, honouring exclusivity both ways. */
export function toggleSelection(
  question: SurveyMachineQuestion,
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
  question: SurveyMachineQuestion,
  optionIds: string[],
  now: number,
  textAnswer?: string,
): ProfileSurveyTransition {
  const answers = { ...state.answers, [question.id]: optionIds }
  const textAnswers =
    textAnswer === undefined
      ? state.textAnswers
      : { ...state.textAnswers, [question.id]: textAnswer }
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
    ...(textAnswer === undefined ? {} : { textAnswer }),
    durationMs: Math.max(0, now - state.questionShownAt),
    last: last && !remaining,
  }
  if (last) {
    return {
      state: {
        ...state,
        answers,
        textAnswers,
        textAnswer: '',
        textEditing: false,
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
      textAnswers,
      textAnswer: textAnswers?.[state.questions[nextStep]!.id] ?? '',
      textEditing: false,
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
    state.renderedAt === null
      ? {}
      : { durationMs: Math.max(0, now - state.renderedAt) }

  switch (input.type) {
    case 'shown': {
      const effects: ProfileSurveyEffect[] = []
      if (state.renderedAt === null) {
        effects.push({
          type: 'event',
          version: state.version,
          event: 'rendered',
        })
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
      if (state.textEditing)
        return { state: { ...state, textEditing: false }, effects: [] }
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
          textAnswer: state.textAnswers?.[state.questions[step]!.id] ?? '',
          textEditing: false,
          questionShownAt: input.now,
        },
        effects: [],
      }
    }

    case 'digit': {
      const option = optionForDigit(question, input.digit)
      if (!option) return unchanged
      if (!question.multi && question.sponsoredKind !== 'ranking')
        return commit(state, question, [option.id], input.now)
      return {
        state: {
          ...state,
          selection: toggleSelection(question, state.selection, option.id),
        },
        effects: [],
      }
    }

    case 'enter': {
      if (question.sponsoredKind === 'text') {
        if (!state.textEditing)
          return { state: { ...state, textEditing: true }, effects: [] }
        if (
          !isValidSponsoredSurveyAnswer(
            { ...question, kind: 'text' },
            [],
            state.textAnswer,
          )
        )
          return unchanged
        return commit(state, question, [], input.now, state.textAnswer!.trim())
      }
      if (question.sponsoredKind === 'ranking') {
        if (
          !isValidSponsoredSurveyAnswer(
            { ...question, kind: 'ranking' },
            state.selection,
          )
        )
          return unchanged
        return commit(state, question, [...state.selection], input.now)
      }
      if (!question.multi) return unchanged
      if (!isValidProfileSurveyAnswer(question, state.selection)) {
        return unchanged
      }
      return commit(state, question, [...state.selection], input.now)
    }
    case 'text': {
      if (question.sponsoredKind !== 'text' || !state.textEditing)
        return unchanged
      const text = sanitizeTerminalStrings(input.text).replace(
        /[\u0000-\u0008\u000b-\u001f\u007f]/g,
        '',
      )
      const textAnswer = (state.textAnswer ?? '') + text
      if (textAnswer.length > SPONSORED_SURVEY_LIMITS.textAnswerMax)
        return unchanged
      return { state: { ...state, textAnswer }, effects: [] }
    }
    case 'delete-text': {
      if (question.sponsoredKind !== 'text' || !state.textEditing)
        return unchanged
      return {
        state: {
          ...state,
          textAnswer: Array.from(state.textAnswer ?? '')
            .slice(0, -1)
            .join(''),
        },
        effects: [],
      }
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
  question: SurveyMachineQuestion
  textEditing?: boolean
}

/**
 * The one place that decides whether a key belongs to the survey. Both the
 * composer's intercept and the chat keyboard resolver call it, so they can
 * never disagree about a key. Callers must already have checked that the
 * draft is empty and the input mode is default: the survey never claims a
 * key while the user has started a prompt.
 *
 * Choice keys, ← (back), Esc (not now), and Enter for questions requiring
 * confirmation belong to the survey. Written answers claim typing only
 * after Enter focuses them; Esc releases that focus. Otherwise ordinary
 * typing falls through to the composer and closes the box.
 */
export function profileSurveyInputForKey(
  key: ProfileSurveyKey,
  context: ProfileSurveyKeyContext | null | undefined,
  now: number = Date.now(),
): ProfileSurveyInput | null {
  if (!context) return null
  if (key.ctrl || key.meta || key.option) return null
  if (key.name === 'escape') return { type: 'escape', now }
  if (context.question.sponsoredKind === 'text') {
    if (isPlainEnterKey(key)) return { type: 'enter', now }
    if (context.textEditing) {
      if (key.name === 'backspace') return { type: 'delete-text', now }
      if (key.sequence && !/[\u0000-\u001f\u007f]/.test(key.sequence))
        return { type: 'text', text: key.sequence, now }
      // Keep navigation keys out of the empty composer while this answer has focus.
      return { type: 'text', text: '', now }
    }
  }
  if (key.name === 'left' && !key.shift) return { type: 'back', now }
  if (
    (context.question.multi || context.question.sponsoredKind === 'ranking') &&
    isPlainEnterKey(key)
  ) {
    return { type: 'enter', now }
  }
  const char = key.sequence ?? key.name
  if (
    char &&
    (/^[0-9]$/.test(char) ||
      (context.question.sponsoredKind && /^[a-c]$/.test(char)))
  ) {
    const digit = /^[a-c]$/.test(char)
      ? char.charCodeAt(0) - 97 + 10
      : Number(char)
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
      ? `✓ +${formatHoursWithUnit(rewardedFreebucks)} added to your wallet`
      : `✓ Thanks, that's all ${total}`
  return `${head}\nedit answers: ${accountUrl}`
}

/** The line after esc. It never says when the survey comes back (COD-1552). */
export function profileSurveyDismissLine(stopped: boolean): string {
  return stopped ? "Got it, we won't ask again." : 'Got it, not now.'
}
