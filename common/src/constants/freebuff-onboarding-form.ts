import {
  OTHER_OPTION_ID,
  type OnboardingAnswer,
  type OnboardingQuestion,
} from './freebuff-onboarding'

/**
 * The questionnaire's pure half: what has been answered, what to ask next, and
 * what to send. Shared by the Web form and Desktop's, so the two cannot differ
 * in what they post.
 *
 * Kept out of the components because all three are decisions rather than
 * rendering, and each has an edge that is easy to get wrong in a way nobody
 * notices for weeks — a resume that lands on an answered question, or an
 * "other" answer posted with no text and rejected by the server.
 */

/** Chosen option ids per question. Single-choice questions carry one entry. */
export type Selections = Record<string, string[]>

/** Free text accompanying an `other` choice, per question. */
export type OtherText = Record<string, string>

/**
 * Toggle one option, honouring single-choice and exclusive options.
 *
 * "None" and a list of tools cannot both be true, so picking either side drops
 * the other rather than leaving a contradiction on screen for the server to
 * reject at submit time.
 */
export function toggleOption(
  question: OnboardingQuestion,
  chosen: readonly string[],
  optionId: string,
): string[] {
  if (!question.multi) return [optionId]
  if (chosen.includes(optionId)) return chosen.filter((id) => id !== optionId)

  const isExclusive = question.options.find((o) => o.id === optionId)?.exclusive
  if (isExclusive) return [optionId]

  const exclusiveIds = new Set(
    question.options.filter((o) => o.exclusive).map((o) => o.id),
  )
  return [...chosen.filter((id) => !exclusiveIds.has(id)), optionId]
}

/**
 * Is this question ready to move on from?
 *
 * "Other" with no text is deliberately not ready: the server refuses it, so
 * advancing would silently drop the answer the person thought they gave.
 */
export function isAnswerReady(
  question: OnboardingQuestion,
  chosen: readonly string[],
  otherText: string | undefined,
): boolean {
  if (chosen.length === 0) return false
  if (!chosen.includes(OTHER_OPTION_ID)) return true
  return Boolean(otherText?.trim())
}

/**
 * Should picking this option advance the step on its own?
 *
 * A single-choice pick is a complete answer, so waiting for a second click on
 * Continue is a click that carries no information. "Other" is the exception: it
 * opens a text field, and advancing past it would discard the field.
 */
export function shouldAdvanceOnPick(
  question: OnboardingQuestion,
  optionId: string,
): boolean {
  return !question.multi && optionId !== OTHER_OPTION_ID
}

/** The answers to send: only questions with a real answer, `other` text kept
 *  only where `other` was chosen. Mirrors what the server will accept. */
export function toAnswerList(
  questions: readonly OnboardingQuestion[],
  selected: Selections,
  otherText: OtherText,
): OnboardingAnswer[] {
  const out: OnboardingAnswer[] = []
  for (const question of questions) {
    const optionIds = selected[question.id] ?? []
    if (optionIds.length === 0) continue
    const text = (otherText[question.id] ?? '').trim()
    if (optionIds.includes(OTHER_OPTION_ID) && !text) continue
    out.push({
      questionId: question.id as OnboardingAnswer['questionId'],
      optionIds,
      ...(optionIds.includes(OTHER_OPTION_ID) && text ? { otherText: text } : {}),
    })
  }
  return out
}

/** Rebuilds form state from answers already on file, so a returning user sees
 *  their picks rather than a blank form. */
export function selectionsFromAnswers(
  answers: readonly OnboardingAnswer[] | null | undefined,
): { selected: Selections; otherText: OtherText } {
  const selected: Selections = {}
  const otherText: OtherText = {}
  for (const answer of answers ?? []) {
    if (answer.optionIds.length === 0) continue
    selected[answer.questionId] = [...answer.optionIds]
    if (answer.otherText) otherText[answer.questionId] = answer.otherText
  }
  return { selected, otherText }
}

/**
 * Where to open the form.
 *
 * The first question with no answer, so someone who answered two and left is
 * not asked those two again. Everything answered → the last question, which is
 * only reachable when the caller decided to show the form at all.
 */
export function resumeIndex(
  questions: readonly OnboardingQuestion[],
  selected: Selections,
): number {
  const index = questions.findIndex(
    (q) => (selected[q.id] ?? []).length === 0,
  )
  return index === -1 ? Math.max(questions.length - 1, 0) : index
}

/**
 * The options in the order the form shows them.
 *
 * A question flagged `shuffleOptions` is dealt from a seed the form draws
 * once per mount, so the order is random across people but stable while one
 * person is looking at it — re-rendering must never move a chip out from
 * under a thumb. "Other" stays last: it is the escape hatch, not a channel,
 * and a list that sometimes leads with "Somewhere else" reads as broken.
 *
 * Fisher–Yates over a tiny deterministic generator rather than `sort` with a
 * random comparator, which is biased and, on some engines, not even a
 * permutation.
 */
export function orderOptionsForDisplay(
  question: OnboardingQuestion,
  seed: number,
): OnboardingQuestion['options'] {
  if (!question.shuffleOptions) return question.options
  const shuffled = question.options.filter((o) => o.id !== OTHER_OPTION_ID)
  const other = question.options.filter((o) => o.id === OTHER_OPTION_ID)
  // mulberry32: good enough to deal seven chips, and reproducible in a test.
  let state = Math.floor(seed * 2 ** 32) >>> 0
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32
  }
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1))
    ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
  }
  return [...shuffled, ...other]
}
