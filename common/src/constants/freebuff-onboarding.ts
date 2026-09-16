/**
 * The post-signup onboarding questionnaire.
 *
 * Five questions, each a fixed option list plus a free-text "Other". Shared
 * between the form, the persistence layer and the admin view so a renamed
 * option cannot silently split one answer into two in the analytics.
 *
 * Why the option ids are opaque and permanent
 * -------------------------------------------
 * The stored value is the id, never the label. Labels are copy and will be
 * reworded; ids are data. Changing a label is free, changing an id
 * retroactively rewrites history — so ids here are append-only. Retire an
 * option by removing it from the list, never by renaming it.
 *
 * When an option is retired or broadened, its old answers do not disappear:
 * `ONBOARDING_LEGACY_OPTION_IDS` below maps the retired id onto whichever
 * current option now covers it, and the admin tally applies that at read time.
 * Nothing rewrites what is stored — the stored answer stays exactly what the
 * person picked on the day they picked it.
 */

export type OnboardingQuestionId =
  | 'referral_source'
  | 'role'
  | 'proficiency'
  | 'intended_use'
  | 'subscriptions'

export type OnboardingOption = {
  /** Stored verbatim. Append-only — see the note above. */
  id: string
  label: string
  /** Choosing this clears every other option, and vice versa. Only meaningful
   *  on a multi-select — "none of them" and "these ones" cannot both be true. */
  exclusive?: boolean
}

export type OnboardingQuestion = {
  id: OnboardingQuestionId
  prompt: string
  options: OnboardingOption[]
  /** Whether more than one option may be chosen. */
  multi: boolean
  /** `scale` renders as a slider: the options are an ordered ramp, so the
   *  distance between two answers means something and the control should say
   *  so. Everything else is a chip list. Storage is identical either way. */
  kind?: 'choice' | 'scale'
  /** Present the options in a random order, once per form mount, with the
   *  "other" option pinned last. For a question with no natural order the
   *  first chip wins on position alone; shuffling spreads that bias evenly
   *  instead of handing it to whichever channel happens to be listed first. */
  shuffleOptions?: boolean
}

/** Every question offers this. The accompanying free text is stored separately
 *  so "other" stays countable while the text stays readable. */
export const OTHER_OPTION_ID = 'other'

export const FREEBUFF_ONBOARDING_QUESTIONS: readonly OnboardingQuestion[] = [
  {
    id: 'referral_source',
    prompt: 'Where did you hear about Freebuff?',
    // Attribution is the one answer we cannot reconstruct later: referrer
    // headers are stripped, and self-report is the only signal for word of
    // mouth, which is where most of it actually comes from.
    //
    // Instagram leads because it was the single largest write-in by a distance,
    // and it shares an audience with TikTok closely enough that splitting them
    // would buy two thin numbers instead of one usable one.
    options: [
      // Keeps the `tiktok` id: those answers are the same audience, and a new
      // id would restart the count from zero for the sake of a tidier string.
      { id: 'tiktok', label: 'Instagram / TikTok' },
      { id: 'youtube', label: 'YouTube' },
      { id: 'x_twitter', label: 'X / Twitter' },
      { id: 'search', label: 'Google / AI search' },
      { id: 'friend', label: 'A friend' },
      { id: OTHER_OPTION_ID, label: 'Somewhere else' },
    ],
    multi: false,
    shuffleOptions: true,
  },
  {
    id: 'role',
    prompt: 'What best describes you?',
    options: [
      { id: 'professional_dev', label: 'Developer' },
      { id: 'founder', label: 'Founder' },
      { id: 'student', label: 'Student' },
      { id: 'hobbyist', label: 'Hobbyist' },
      { id: OTHER_OPTION_ID, label: 'Something else' },
    ],
    multi: false,
  },
  {
    id: 'proficiency',
    prompt: 'How much do you code?',
    options: [
      { id: 'none', label: 'Not at all' },
      { id: 'beginner', label: 'Beginner' },
      { id: 'intermediate', label: 'Intermediate' },
      { id: 'advanced', label: 'Advanced' },
      { id: 'expert', label: 'Expert' },
    ],
    // No Other: this is an ordered scale, and a free-text answer on an ordinal
    // question is unusable for the segmentation it exists to support.
    multi: false,
    kind: 'scale',
  },
  {
    id: 'intended_use',
    prompt: 'What will you build with Freebuff?',
    options: [
      { id: 'website', label: 'Websites and apps' },
      { id: 'work', label: 'Work projects' },
      { id: 'side_projects', label: 'Side projects' },
      { id: 'learning', label: 'Learning to code' },
      { id: 'automation', label: 'Scripts and automation' },
      { id: OTHER_OPTION_ID, label: 'Something else' },
    ],
    multi: true,
  },
  {
    id: 'subscriptions',
    prompt: 'Current subscriptions that you’ve had, cancelled or will cancel',
    // The one question here that prices the product rather than describing the
    // user: what someone already pays for — and is willing to stop paying for —
    // says who we actually compete with. Deliberately loose about tense, since
    // "about to cancel" is the same competitive signal as "already did" and
    // splitting the two would buy two thin numbers instead of one usable one.
    options: [
      { id: 'none', label: 'None', exclusive: true },
      { id: 'claude_code', label: 'Claude Code' },
      { id: 'cursor', label: 'Cursor' },
      { id: 'opencode', label: 'opencode' },
      { id: 'codex', label: 'Codex' },
      { id: 'gemini', label: 'Gemini' },
      { id: 'app_builder', label: 'Lovable / Replit' },
      { id: OTHER_OPTION_ID, label: 'Something else' },
    ],
    multi: true,
  },
] as const

/**
 * Retired option id → the current option that now covers it.
 *
 * Read-time only, applied by the admin tally. A retired option's answers are
 * still real answers; folding them into their successor keeps a broadened
 * option's count honest instead of resetting it to zero on the day of the edit.
 * An id with no successor here is simply not counted.
 */
export const ONBOARDING_LEGACY_OPTION_IDS: Partial<
  Record<OnboardingQuestionId, Record<string, string>>
> = {
  // Discord, blog/newsletter, Reddit and GitHub were dropped as options; all
  // are honestly "somewhere else" rather than any of the channels that remain.
  referral_source: {
    discord: OTHER_OPTION_ID,
    blog_news: OTHER_OPTION_ID,
    reddit: OTHER_OPTION_ID,
    github: OTHER_OPTION_ID,
  },
  // Data/ML folded into the broader developer bucket. Designer-or-PM and
  // non-technical were retired without a successor (2026-09-16), so they and
  // the older `designer` id that used to fold into PM all read as "something
  // else".
  role: {
    data_ml: 'professional_dev',
    designer: OTHER_OPTION_ID,
    pm: OTHER_OPTION_ID,
    non_technical: OTHER_OPTION_ID,
  },
  // Prototypes and demos are websites and apps; code review has no successor
  // narrow enough to claim it, so it goes to "something else".
  intended_use: { prototyping: 'website', debugging: OTHER_OPTION_ID },
  // GitHub Copilot was dropped as an option (2026-09-16).
  subscriptions: { copilot: OTHER_OPTION_ID },
}

/**
 * Write-in text → the option it should have been.
 *
 * People type an answer that already exists on the list, at volume: Instagram
 * was the top write-in on a question that did not offer it, and every variant
 * of "ChatGPT" is the AI-search answer. Matching is read-time and deliberately
 * narrow — a pattern that fires on an ambiguous word buys a wrong count, which
 * is worse than the "other" bucket it came from.
 */
export const ONBOARDING_OTHER_TEXT_RULES: Partial<
  Record<OnboardingQuestionId, { optionId: string; pattern: RegExp }[]>
> = {
  referral_source: [
    { optionId: 'tiktok', pattern: /insta|\btiktok\b|\btik tok\b|\big\b/i },
    {
      optionId: 'search',
      pattern:
        /\bai\b|chat\s?gpt|\bgpt\b|claude|gemini|perplexity|copilot|grok|deepseek/i,
    },
  ],
}

/**
 * Which option a write-in should be counted as, if any.
 *
 * Rules are tried in order and the first match wins, so the more specific
 * pattern must come first — "insta" before the AI catch-all, since "instagram
 * AI" is an Instagram answer.
 */
export function classifyOnboardingOtherText(
  questionId: OnboardingQuestionId,
  text: string,
): string | null {
  const rules = ONBOARDING_OTHER_TEXT_RULES[questionId]
  if (!rules) return null
  for (const rule of rules) {
    if (rule.pattern.test(text)) return rule.optionId
  }
  return null
}

/** Per question, per current option id: how many respondents it counts. */
export type OnboardingTally = Record<string, Record<string, number>>

/** A stored answer as the database hands it back: ids are plain strings there,
 *  because a question retired since the row was written is still a row. */
export type StoredOnboardingAnswer = {
  questionId: string
  optionIds: readonly string[]
  otherText?: string
}

/**
 * Bump whenever the mapping below would count an existing answer
 * differently: an option retired or added, a legacy id remapped, a write-in
 * rule changed. The stored aggregate in Convex carries the version it was
 * built under, and a mismatch is what triggers a full rebuild — so forgetting
 * this bump leaves the admin bars counting history under the old rules.
 */
export const ONBOARDING_TALLY_VERSION = 3

/** Every current option at zero, so a question nobody has answered still
 *  renders its full bar list rather than vanishing. */
export function emptyOnboardingTally(
  questions: readonly OnboardingQuestion[] = FREEBUFF_ONBOARDING_QUESTIONS,
): OnboardingTally {
  return Object.fromEntries(
    questions.map((q) => [
      q.id,
      Object.fromEntries(q.options.map((o) => [o.id, 0])),
    ]),
  )
}

/**
 * Add one respondent's answers into a tally, IN PLACE, under the current
 * rules: retired ids fold into their successor, a write-in that names an
 * option we now offer counts as that option, and ids the current question set
 * does not define are dropped. `sign` of -1 removes the same answers again,
 * which is how a resubmission (replace, not append) keeps the running
 * aggregate honest.
 *
 * Returns the write-in texts that stayed "other", per question, so a caller
 * listing them never disagrees with the bars about the same answer.
 */
export function applyOnboardingAnswersToTally(
  tally: OnboardingTally,
  answers: readonly StoredOnboardingAnswer[] | null | undefined,
  sign: 1 | -1 = 1,
  questions: readonly OnboardingQuestion[] = FREEBUFF_ONBOARDING_QUESTIONS,
): Record<string, string[]> {
  const otherTexts: Record<string, string[]> = {}
  const known = new Set(questions.map((q) => q.id))
  for (const answer of answers ?? []) {
    if (!known.has(answer.questionId as OnboardingQuestionId)) continue
    const questionId = answer.questionId as OnboardingQuestionId
    const bucket = (tally[questionId] ??= {})
    const legacy = ONBOARDING_LEGACY_OPTION_IDS[questionId] ?? {}
    const text = answer.otherText?.trim()
    const reclassified = text ? classifyOnboardingOtherText(questionId, text) : null
    for (const rawId of answer.optionIds ?? []) {
      const id =
        rawId === OTHER_OPTION_ID && reclassified
          ? reclassified
          : (legacy[rawId] ?? rawId)
      // Only ids the current question set defines: a retired option with no
      // successor would otherwise appear as an unexplained row in the UI.
      if (id in bucket) bucket[id] += sign
    }
    if (text && !reclassified) (otherTexts[questionId] ??= []).push(text)
  }
  return otherTexts
}

export type OnboardingAnswer = {
  questionId: OnboardingQuestionId
  /** Chosen option ids. Single-choice questions carry exactly one. */
  optionIds: string[]
  /** Free text, only when `other` is among the chosen ids. */
  otherText?: string
}

export type OnboardingSubmission = {
  answers: OnboardingAnswer[]
}

export const ONBOARDING_OTHER_TEXT_MAX = 200

/**
 * Where a submission was made. Stored on the row for segmentation. `web` is
 * the dashboard dialog; `cli_login` is the browser landing page every CLI and
 * Desktop sign-in ends on (the two are indistinguishable there — both redeem
 * the same auth code).
 */
export const ONBOARDING_SURFACES = ['web', 'cli_login'] as const
export type OnboardingSurface = (typeof ONBOARDING_SURFACES)[number]

/** A client-supplied surface, or `web` for anything unknown: an older form
 *  sends none, and a forged value must not become a segment. */
export function parseOnboardingSurface(raw: unknown): OnboardingSurface {
  return (ONBOARDING_SURFACES as readonly unknown[]).includes(raw)
    ? (raw as OnboardingSurface)
    : 'web'
}

export type OnboardingValidationError = {
  /** Null when the complaint is about the submission as a whole rather than
   *  about one question — the only such case is an entirely empty one. */
  questionId: OnboardingQuestionId | null
  message: string
}

/**
 * Validate a submission against the question set.
 *
 * Deliberately strict about ids and lenient about text: an unknown option id
 * means the client is out of date or forged, and accepting it would put a value
 * in the analytics that no question can explain. Free text is merely trimmed
 * and truncated — it is never interpreted, only displayed.
 *
 * **Partial submissions are valid.** Every question is individually skippable,
 * so an unanswered one is a user's choice rather than a broken client, and the
 * questions someone did answer are real data. Requiring the full set here is
 * how partial answers used to be discarded: the form posted only what was
 * filled in, this rejected it with a 400, and the person was told their
 * answers could not be saved. Only an entirely empty submission is refused,
 * because saving nothing would still mark the questionnaire as dealt with.
 */
export function validateOnboardingSubmission(
  submission: OnboardingSubmission,
  questions: readonly OnboardingQuestion[] = FREEBUFF_ONBOARDING_QUESTIONS,
): { ok: true; answers: OnboardingAnswer[] } | { ok: false; errors: OnboardingValidationError[] } {
  const errors: OnboardingValidationError[] = []
  const cleaned: OnboardingAnswer[] = []

  for (const question of questions) {
    const answer = submission.answers.find((a) => a.questionId === question.id)
    const optionIds = answer?.optionIds ?? []

    // Skipped, not malformed. Carries no answer and no complaint.
    if (optionIds.length === 0) continue
    if (!question.multi && optionIds.length > 1) {
      errors.push({ questionId: question.id, message: 'Choose one option.' })
      continue
    }

    const valid = new Set(question.options.map((o) => o.id))
    const unknown = optionIds.filter((id) => !valid.has(id))
    if (unknown.length > 0) {
      errors.push({ questionId: question.id, message: 'Unrecognised option.' })
      continue
    }

    const exclusive = question.options.filter((o) => o.exclusive).map((o) => o.id)
    if (optionIds.length > 1 && optionIds.some((id) => exclusive.includes(id))) {
      errors.push({
        questionId: question.id,
        message: 'That answer cannot be combined with the others.',
      })
      continue
    }

    const wantsOther = optionIds.includes(OTHER_OPTION_ID)
    const otherText = answer?.otherText?.trim()
    if (wantsOther && !otherText) {
      errors.push({
        questionId: question.id,
        message: 'Tell us a little more.',
      })
      continue
    }

    cleaned.push({
      questionId: question.id,
      optionIds,
      // Dropped unless `other` was chosen, so stray text cannot ride along on
      // an answer that has nowhere to show it.
      ...(wantsOther && otherText
        ? { otherText: otherText.slice(0, ONBOARDING_OTHER_TEXT_MAX) }
        : {}),
    })
  }

  if (errors.length > 0) return { ok: false, errors }
  if (cleaned.length === 0) {
    return {
      ok: false,
      errors: [{ questionId: null, message: 'Choose at least one answer.' }],
    }
  }
  return { ok: true, answers: cleaned }
}

/** Every question answered. Decides only whether someone who returns to the
 *  form still sees it — nothing is withheld either way. */
export function isOnboardingComplete(
  answers: readonly OnboardingAnswer[] | null | undefined,
  questions: readonly OnboardingQuestion[] = FREEBUFF_ONBOARDING_QUESTIONS,
): boolean {
  if (!answers || answers.length === 0) return false
  const answered = new Set(
    answers.filter((a) => a.optionIds.length > 0).map((a) => a.questionId),
  )
  return questions.every((q) => answered.has(q.id))
}
