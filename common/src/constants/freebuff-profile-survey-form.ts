import {
  isValidProfileSurveyAnswer,
  PROFILE_SURVEY_MAX_DISMISSALS,
  type ProfileSurveyAnswer,
  type ProfileSurveyQuestion,
} from './freebuff-profile-survey'

/**
 * The profile survey's pure half (COD-779): what a tap does, what the card
 * says, and what to send. Shared by Desktop's card, the Web card and the
 * account page's editor, so the three cannot differ in what they post or
 * promise. The wire contract itself is `freebuff-profile-survey.ts`.
 *
 * Mirrors the onboarding form's helpers (`freebuff-onboarding-form.ts`) for
 * the survey's own question type rather than importing them: onboarding's
 * `OnboardingQuestion` carries its "other" text field and kinds, which the
 * survey deliberately does not have.
 */

/** Chosen option ids per question id. */
export type ProfileSurveySelections = Record<string, string[]>

/**
 * Toggle one option. Single-choice replaces; an exclusive option (every
 * "Doesn't apply", "Not shopping", "Not deploying yet") clears the rest, and
 * picking anything else clears the exclusive ones, so a contradiction never
 * reaches the server to be refused.
 */
export function toggleProfileSurveyOption(
  question: ProfileSurveyQuestion,
  chosen: readonly string[],
  optionId: string,
): string[] {
  if (!question.multi) return [optionId]
  if (chosen.includes(optionId)) return chosen.filter((id) => id !== optionId)
  const option = question.options.find((o) => o.id === optionId)
  if (option?.exclusive || option?.notApplicable) return [optionId]
  const exclusive = new Set(
    question.options
      .filter((o) => o.exclusive || o.notApplicable)
      .map((o) => o.id),
  )
  return [...chosen.filter((id) => !exclusive.has(id)), optionId]
}

/** A tap on a single-choice question is the whole answer: post and advance. */
export function profileSurveyPickAdvances(question: ProfileSurveyQuestion) {
  return !question.multi
}

/** Ready to post: exactly what the server will accept. */
export function isProfileSurveyAnswerReady(
  question: ProfileSurveyQuestion,
  chosen: readonly string[],
): boolean {
  return isValidProfileSurveyAnswer(question, chosen)
}

export function profileSurveyHint(question: ProfileSurveyQuestion): string {
  return question.multi ? 'Pick all that apply' : 'Tap one to continue'
}

/** Rebuild selections from answers on file, so Back shows what was picked. */
export function profileSurveySelections(
  answers: readonly Pick<ProfileSurveyAnswer, 'questionId' | 'optionIds'>[],
): ProfileSurveySelections {
  const out: ProfileSurveySelections = {}
  for (const answer of answers) {
    if (answer.optionIds.length) out[answer.questionId] = [...answer.optionIds]
  }
  return out
}

/** Answered questions among `questions`, counting only valid selections. */
export function profileSurveyAnsweredCount(
  questions: readonly ProfileSurveyQuestion[],
  selections: ProfileSurveySelections,
): number {
  return questions.filter((q) =>
    isValidProfileSurveyAnswer(q, selections[q.id] ?? []),
  ).length
}

/** The start index, clamped: `resumeAt` is the server's, but a stale or
 *  out-of-range value must never render an empty card. */
export function profileSurveyStartIndex(
  resumeAt: number,
  questionCount: number,
): number {
  if (!Number.isFinite(resumeAt) || resumeAt < 0) return 0
  return Math.min(Math.floor(resumeAt), Math.max(questionCount - 1, 0))
}

/** Every chosen option is a notApplicable one ("Doesn't apply", "Not sure"). */
export function isAllNotApplicable(
  questions: readonly ProfileSurveyQuestion[],
  selections: ProfileSurveySelections,
): boolean {
  return questions.every((q) =>
    (selections[q.id] ?? []).every(
      (id) => q.options.find((o) => o.id === id)?.notApplicable,
    ),
  )
}

/** Labels of an answer, in the question's option order ("Vercel, AWS"). */
export function formatProfileSurveyAnswer(
  question: ProfileSurveyQuestion,
  optionIds: readonly string[],
): string {
  const all = [...question.options, ...(question.retiredOptions ?? [])]
  const labels = all.filter((o) => optionIds.includes(o.id)).map((o) => o.label)
  return labels.length ? labels.join(', ') : 'Not answered'
}

// ---- copy -------------------------------------------------------------

export const PROFILE_SURVEY_PRIVACY_COPY =
  'Used to pick the sponsors you see. Never sent to ad networks.'
export const PROFILE_SURVEY_EDIT_LINK_COPY = 'Edit anytime'

export function profileSurveyHeader(index: number, total: number): string {
  return `Quick question · ${index + 1} of ${total}`
}

export function profileSurveyRewardCopy(
  rewardFreebucks: number,
  total: number,
): string | null {
  return rewardFreebucks > 0
    ? `Answer all ${total} to get ${rewardFreebucks} Freebucks`
    : null
}

export function profileSurveyDismissCopy(input: {
  answered: number
  stopped: boolean
}): string {
  if (input.stopped)
    return `That's the ${ordinal(PROFILE_SURVEY_MAX_DISMISSALS)} “Not now”, so we won't ask again for this survey.`
  const answers =
    input.answered === 1 ? 'Your 1 answer so far is' : `Your ${input.answered} answers so far are`
  return input.answered > 0
    ? `Got it. We'll ask again in 7 days. ${answers} saved.`
    : `Got it. We'll ask again in 7 days.`
}

export type ProfileSurveyCompletionCopy =
  | { kind: 'paid'; title: string; detail: string }
  | { kind: 'unpaid'; title: string; detail: string | null }

/**
 * What the completion card says. `rewardedFreebucks` is the server's word on
 * what THIS completion credited; the card never claims a credit it did not
 * report. Arm 0 shows no reward copy at all.
 */
export function profileSurveyCompletionCopy(input: {
  rewardFreebucks: number
  rewardedFreebucks: number
  allNotApplicable: boolean
}): ProfileSurveyCompletionCopy {
  if (input.rewardedFreebucks > 0)
    return {
      kind: 'paid',
      title: `+${input.rewardedFreebucks} Freebucks`,
      detail: 'Added to your wallet. Thanks.',
    }
  if (input.rewardFreebucks > 0 && input.allNotApplicable)
    return {
      kind: 'unpaid',
      title: 'Thanks.',
      detail: `Every answer was “Doesn't apply”, so this one didn't earn the ${input.rewardFreebucks} Freebucks.`,
    }
  return { kind: 'unpaid', title: "Thanks, that's everything.", detail: null }
}

function ordinal(n: number): string {
  return n === 1 ? 'first' : n === 2 ? 'second' : n === 3 ? 'third' : `${n}th`
}

/** The account page section, on freebuff.com. */
export const PROFILE_ANSWERS_ACCOUNT_PATH = '/?settings=account&focus=profile-answers'
