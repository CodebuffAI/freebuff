/**
 * The in-session profile survey (COD-779): the shared contract between the
 * question bank, the Postgres store, the API and every client (Desktop, Web,
 * CLI). Distinct from the post-signup onboarding questionnaire in
 * `freebuff-onboarding.ts` — different flow, table and gate.
 *
 * Versioning, three layers
 * ------------------------
 * 1. OPTION ids are stored verbatim and are append-only, exactly as in
 *    onboarding: relabel freely, never rename an id. Retire an option by
 *    moving it to `retiredOptions`.
 * 2. A QUESTION carries a `revision`. Bump it only when a wording change
 *    alters what an answer means; every stored answer records the revision it
 *    was given under, and an answer below the current revision counts as
 *    unanswered, so the question is asked again. A new question is a new id.
 * 3. A SURVEY VERSION is an ordered list of question ids and is IMMUTABLE once
 *    shipped (a test pins every shipped version). Change the survey by adding
 *    a version and pointing `ACTIVE_PROFILE_SURVEY_VERSION` at it. Answers are
 *    stored per question, so a question shared by two versions is not asked
 *    twice; the reward, the A/B arm and the dismissal count are per version.
 */

export const PROFILE_SURVEY_ID = 'profile'

export type ProfileSurveyOption = {
  /** Stored verbatim. Append-only. */
  id: string
  label: string
  /** Choosing it clears every other option, and vice versa. */
  exclusive?: boolean
  /** "Doesn't apply" / "Not sure": counts as an answer, but an all-
   *  notApplicable submission earns no reward. Always exclusive. */
  notApplicable?: boolean
}

export type ProfileSurveyQuestion = {
  id: string
  /** Starts at 1. See layer 2 above. */
  revision: number
  prompt: string
  multi: boolean
  options: ProfileSurveyOption[]
  retiredOptions?: ProfileSurveyOption[]
}

const notApplicable = (label = "Doesn't apply"): ProfileSurveyOption => ({
  id: 'na',
  label,
  exclusive: true,
  notApplicable: true,
})

export const PROFILE_SURVEY_QUESTIONS = [
  {
    id: 'who_pays',
    revision: 1,
    prompt: 'Who pays for your dev tools?',
    multi: false,
    options: [
      { id: 'me', label: 'Me' },
      { id: 'employer', label: 'My employer' },
      { id: 'both', label: 'Both' },
      { id: 'nobody', label: 'Nobody, I stick to free tools' },
      notApplicable(),
    ],
  },
  {
    id: 'tool_spend',
    revision: 1,
    prompt: 'What do you spend a month on dev tools and AI?',
    multi: false,
    options: [
      { id: 'zero', label: '$0' },
      { id: 'lt20', label: 'Under $20' },
      { id: '20_100', label: '$20–100' },
      { id: '100_500', label: '$100–500' },
      { id: '500_plus', label: '$500+' },
      notApplicable('Not sure'),
    ],
  },
  {
    id: 'team_size',
    revision: 1,
    prompt: 'How big is the team you build with?',
    multi: false,
    options: [
      { id: 'solo', label: 'Just me' },
      { id: '2_10', label: '2–10' },
      { id: '11_50', label: '11–50' },
      { id: '51_500', label: '51–500' },
      { id: '500_plus', label: '500+' },
      notApplicable(),
    ],
  },
  {
    id: 'building',
    revision: 1,
    prompt: 'What are you building right now?',
    multi: false,
    options: [
      { id: 'saas', label: 'SaaS product' },
      { id: 'ai_app', label: 'AI app or agent' },
      { id: 'internal_tool', label: 'Internal tool' },
      { id: 'mobile', label: 'Mobile app' },
      { id: 'store', label: 'Online store' },
      { id: 'website', label: 'Website' },
      { id: 'data_ml', label: 'Data or ML' },
      notApplicable(),
    ],
  },
  {
    id: 'shopping',
    revision: 1,
    prompt: 'Shopping for any of these in the next 3 months?',
    multi: true,
    options: [
      { id: 'hosting', label: 'Hosting' },
      { id: 'database', label: 'Database' },
      { id: 'auth', label: 'Auth' },
      { id: 'payments', label: 'Payments' },
      { id: 'monitoring', label: 'Monitoring' },
      { id: 'email', label: 'Email' },
      { id: 'ai_apis', label: 'AI APIs' },
      { id: 'code_review', label: 'Code review' },
      { id: 'none', label: 'Not shopping', exclusive: true },
    ],
  },
  {
    id: 'deploy',
    revision: 1,
    prompt: 'Where do you deploy?',
    multi: true,
    options: [
      { id: 'vercel', label: 'Vercel' },
      { id: 'aws', label: 'AWS' },
      { id: 'gcp', label: 'Google Cloud' },
      { id: 'cloudflare', label: 'Cloudflare' },
      { id: 'paas', label: 'Render, Railway or Fly' },
      { id: 'self_hosted', label: 'Self-hosted' },
      { id: 'not_yet', label: 'Not deploying yet', exclusive: true },
    ],
  },
  {
    id: 'database',
    revision: 1,
    prompt: 'Which databases or backends do you use?',
    multi: true,
    options: [
      { id: 'postgres', label: 'Postgres' },
      { id: 'supabase', label: 'Supabase' },
      { id: 'firebase', label: 'Firebase' },
      { id: 'mongodb', label: 'MongoDB' },
      { id: 'mysql', label: 'MySQL' },
      { id: 'sqlite', label: 'SQLite' },
      notApplicable(),
    ],
  },
  {
    id: 'languages',
    revision: 1,
    prompt: 'Which languages do you write?',
    multi: true,
    options: [
      { id: 'typescript', label: 'TypeScript' },
      { id: 'javascript', label: 'JavaScript' },
      { id: 'python', label: 'Python' },
      { id: 'go', label: 'Go' },
      { id: 'rust', label: 'Rust' },
      { id: 'jvm', label: 'Java or Kotlin' },
      { id: 'csharp', label: 'C#' },
      { id: 'php', label: 'PHP' },
      { id: 'swift', label: 'Swift' },
      notApplicable(),
    ],
  },
  {
    id: 'frameworks',
    revision: 1,
    prompt: 'Which frameworks?',
    multi: true,
    options: [
      { id: 'nextjs', label: 'Next.js' },
      { id: 'react', label: 'React' },
      { id: 'vue', label: 'Vue' },
      { id: 'svelte', label: 'Svelte' },
      { id: 'python_web', label: 'Django or FastAPI' },
      { id: 'rails', label: 'Rails' },
      { id: 'laravel', label: 'Laravel' },
      { id: 'cross_mobile', label: 'React Native or Flutter' },
      notApplicable(),
    ],
  },
  {
    id: 'industry',
    revision: 1,
    prompt: 'What industry is your work in?',
    multi: false,
    options: [
      { id: 'software', label: 'Software' },
      { id: 'finance', label: 'Finance' },
      { id: 'health', label: 'Health' },
      { id: 'education', label: 'Education' },
      { id: 'ecommerce', label: 'E-commerce' },
      { id: 'media', label: 'Media' },
      { id: 'agency', label: 'Agency' },
      { id: 'other', label: 'Other' },
      notApplicable(),
    ],
  },
  // Version 2 (2026-10-09). No notApplicable option on these: every one
  // applies to anyone using Freebuff.
  {
    id: 'role',
    revision: 1,
    prompt: 'What best describes you?',
    multi: false,
    options: [
      { id: 'student', label: 'Student' },
      { id: 'hobbyist', label: 'Hobbyist' },
      { id: 'freelancer', label: 'Freelancer or contractor' },
      { id: 'employed', label: 'Developer at a company' },
      { id: 'founder', label: 'Founder or indie hacker' },
      { id: 'other', label: 'Something else' },
    ],
  },
  {
    id: 'buy_timing',
    revision: 1,
    prompt: 'When will you next pay for a dev tool or service?',
    multi: false,
    options: [
      { id: 'this_month', label: 'This month' },
      { id: 'quarter', label: 'In the next 3 months' },
      { id: 'later', label: 'Later' },
      { id: 'never', label: 'Not planning to' },
    ],
  },
  {
    id: 'other_tools',
    revision: 1,
    prompt: 'Which other AI coding tools do you use?',
    multi: true,
    options: [
      { id: 'cursor', label: 'Cursor' },
      { id: 'claude_code', label: 'Claude Code' },
      { id: 'copilot', label: 'GitHub Copilot' },
      { id: 'codex', label: 'Codex' },
      { id: 'windsurf', label: 'Windsurf' },
      { id: 'cline', label: 'Cline or Roo' },
      { id: 'gemini_cli', label: 'Gemini CLI' },
      { id: 'other', label: 'Something else' },
      { id: 'none', label: 'Only Freebuff', exclusive: true },
    ],
  },
  {
    id: 'disappointment',
    revision: 1,
    prompt: 'How would you feel if you could no longer use Freebuff?',
    multi: false,
    options: [
      { id: 'very', label: 'Very disappointed' },
      { id: 'somewhat', label: 'Somewhat disappointed' },
      { id: 'not', label: 'Not disappointed' },
    ],
  },
  {
    id: 'pay_trigger',
    revision: 1,
    prompt: 'What would get you to pay for Freebuff?',
    multi: true,
    options: [
      { id: 'subscribed', label: 'I already pay', exclusive: true },
      { id: 'better_models', label: 'Better models' },
      { id: 'higher_limits', label: 'Higher limits' },
      { id: 'faster', label: 'Faster responses' },
      { id: 'cloud_agents', label: 'Cloud agents' },
      { id: 'fewer_ads', label: 'Fewer ads' },
      { id: 'lower_price', label: 'A lower price' },
      { id: 'nothing', label: "Nothing, I'll stay free", exclusive: true },
    ],
  },
] as const satisfies readonly ProfileSurveyQuestion[]

export type ProfileSurveyQuestionId =
  (typeof PROFILE_SURVEY_QUESTIONS)[number]['id']

export type ProfileSurveyVersion = {
  surveyId: typeof PROFILE_SURVEY_ID
  /** Positive integer, never reused. */
  version: number
  /** Asked in this order. Immutable once shipped. */
  questionIds: readonly ProfileSurveyQuestionId[]
}

export const PROFILE_SURVEY_VERSIONS = [
  {
    surveyId: PROFILE_SURVEY_ID,
    version: 1,
    questionIds: [
      'who_pays',
      'tool_spend',
      'team_size',
      'building',
      'shopping',
      'deploy',
      'database',
      'languages',
      'frameworks',
      'industry',
    ],
  },
  {
    // Drops v1's four stack questions (deploy, database, languages,
    // frameworks): the agent can read those from the project. Shared
    // questions answered under v1 are not asked again.
    surveyId: PROFILE_SURVEY_ID,
    version: 2,
    questionIds: [
      'who_pays',
      'tool_spend',
      'team_size',
      'role',
      'building',
      'shopping',
      'buy_timing',
      'industry',
      'other_tools',
      'disappointment',
      'pay_trigger',
    ],
  },
] as const satisfies readonly ProfileSurveyVersion[]

/** The version clients are shown. The launch gate: nothing is shown unless
 *  this names a version (null = survey off), never an env var. Version 1
 *  launched 2026-10-07, version 2 on 2026-10-09. The dev and admin previews
 *  run on the fake client and ignore it. */
export const ACTIVE_PROFILE_SURVEY_VERSION: number | null = 2

/** Freebucks per arm. Index = arm; assignment is per user per version.
 *  Arm 2 paid 25 until 2026-10-07, when 5 proved enough; it now pays 5 too, so
 *  no one is re-bucketed. A state row keeps the reward it was created with, so
 *  analyse by `reward_freebucks`, not `arm`. */
export const PROFILE_SURVEY_REWARD_ARMS = [0, 5, 5] as const
export type ProfileSurveyArm = 0 | 1 | 2

export const PROFILE_SURVEY_ARM_SALT = 'profile_survey_reward_arm_2026_10'
export const PROFILE_SURVEY_MIN_ACCOUNT_AGE_MS = 24 * 60 * 60 * 1000
/** Days each "Not now" snoozes for, by dismissal (1st, 2nd, ...). The
 *  dismissal after the last entry stops this version for good. */
export const PROFILE_SURVEY_SNOOZE_DAYS = [3, 3, 7, 7, 14] as const
/** The dismissal that stops this version for good. */
export const PROFILE_SURVEY_MAX_DISMISSALS = PROFILE_SURVEY_SNOOZE_DAYS.length + 1
/** Days the `dismissal`th "Not now" (1-based) snoozes for; null when it
 *  stops the survey instead. */
export function profileSurveySnoozeDays(dismissal: number): number | null {
  if (dismissal >= PROFILE_SURVEY_MAX_DISMISSALS) return null
  return PROFILE_SURVEY_SNOOZE_DAYS[Math.max(dismissal, 1) - 1]
}
export const PROFILE_SURVEY_DAY_MS = 24 * 60 * 60 * 1000
/** An answer given faster than this (client-measured) is flagged `fast`:
 *  it still counts for completion, but targeting readers exclude it. */
export const PROFILE_SURVEY_FAST_ANSWER_MS = 800

/** Which client sent a request. Optional on the wire; stored for analysis. */
export const PROFILE_SURVEY_SURFACES = ['desktop', 'web', 'cli'] as const
export type ProfileSurveySurface = (typeof PROFILE_SURVEY_SURFACES)[number]

/**
 * Engagement events, stored append-only in `profile_survey_event`. Clients
 * send `rendered`, `question_viewed` and `abandoned` with the `event` action;
 * the server writes `dismissed` itself from the `dismiss` action. Events are
 * fire-and-forget: a client never waits on one or shows its failure.
 *  - rendered: the card/box actually appeared on screen (once per mount).
 *    GET's `first_shown_at` only means "fetched".
 *  - question_viewed: a question came on screen (`questionId`).
 *  - abandoned: the card/box went away with no answer completing it and no
 *    "Not now" (CLI: the user typed a prompt; Desktop/Web: unmounted).
 *    `durationMs` = time it was on screen, `questionId` = the one showing.
 *  - dismissed: written by the server on `dismiss`, with the request's
 *    `durationMs` (time on screen) and `questionId`.
 */
export const PROFILE_SURVEY_EVENTS = [
  'rendered',
  'question_viewed',
  'abandoned',
  'dismissed',
] as const
export type ProfileSurveyEventKind = (typeof PROFILE_SURVEY_EVENTS)[number]
/** The kinds a client may send with the `event` action. */
export const PROFILE_SURVEY_CLIENT_EVENTS = [
  'rendered',
  'question_viewed',
  'abandoned',
] as const
export type ProfileSurveyClientEventKind =
  (typeof PROFILE_SURVEY_CLIENT_EVENTS)[number]

/** One stored answer, as every layer sees it. */
export type ProfileSurveyAnswer = {
  questionId: ProfileSurveyQuestionId
  questionRevision: number
  optionIds: string[]
}

// ---- wire contract: GET/POST /api/profile-survey (freebuff/web) ----------

/** GET /api/profile-survey */
export type ProfileSurveyStateResponse =
  | { show: false; reason: ProfileSurveyHiddenReason }
  | {
      show: true
      surveyId: typeof PROFILE_SURVEY_ID
      version: number
      /** Only the questions of this version, in order, with current labels. */
      questions: ProfileSurveyQuestion[]
      /** Current-revision answers already on file, for resuming. */
      answers: ProfileSurveyAnswer[]
      /** Index into `questions` of the first unanswered question. */
      resumeAt: number
      /** Freebucks paid on completion; 0 = show no reward copy. */
      rewardFreebucks: number
      dismissCount: number
    }

export type ProfileSurveyHiddenReason =
  | 'no_active_version'
  | 'account_too_new'
  | 'completed'
  | 'snoozed'
  | 'stopped'
  | 'signed_out'

/** POST /api/profile-survey — one action per request. */
export type ProfileSurveyRequest =
  | {
      action: 'answer'
      version: number
      questionId: ProfileSurveyQuestionId
      optionIds: string[]
      /** Client-measured time on this question, for quality flags. */
      durationMs?: number
      /** Optional: which client answered. */
      surface?: ProfileSurveySurface
    }
  | {
      action: 'dismiss'
      version: number
      /** Time the card/box was on screen before "Not now". */
      durationMs?: number
      /** The question showing when dismissed. */
      questionId?: ProfileSurveyQuestionId
      surface?: ProfileSurveySurface
    }
  | {
      action: 'event'
      version: number
      event: ProfileSurveyClientEventKind
      questionId?: ProfileSurveyQuestionId
      durationMs?: number
      surface?: ProfileSurveySurface
    }
  /** Account page: erase every answer (history included). The reward stays. */
  | { action: 'clear' }

/** GET /api/profile-survey/answers — the account page's view: every bank
 *  question the user has a current-revision answer for, any version. Editing
 *  is the `answer` action, which is accepted after completion too. */
export type ProfileSurveyAnswersResponse = {
  answers: Array<
    ProfileSurveyAnswer & { answeredAt: string; question: ProfileSurveyQuestion }
  >
}

export type ProfileSurveyResponse =
  | { ok: true; cleared: true }
  | { ok: true; completed: false }
  | {
      ok: true
      completed: true
      /** Freebucks credited by THIS request (0 when already paid, arm 0, or
       *  every answer notApplicable). */
      rewardedFreebucks: number
    }
  | { ok: true; dismissed: true; snoozedUntil: string | null; stopped: boolean }
  | { ok: true; recorded: true }
  | { ok: false; error: string }

// ---- pure helpers ------------------------------------------------------

export function profileSurveyQuestion(
  id: string,
): ProfileSurveyQuestion | undefined {
  return (PROFILE_SURVEY_QUESTIONS as readonly ProfileSurveyQuestion[]).find(
    (q) => q.id === id,
  )
}

export function profileSurveyVersion(
  version: number,
): ProfileSurveyVersion | undefined {
  return PROFILE_SURVEY_VERSIONS.find((v) => v.version === version)
}

/** Deterministic, uniform-enough arm from a salted FNV-1a over the user id.
 *  Pure so every surface and the server agree without a round trip. */
export function profileSurveyArm(
  userId: string,
  version: number,
): ProfileSurveyArm {
  const input = `${PROFILE_SURVEY_ARM_SALT}:${version}:${userId}`
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return (hash % PROFILE_SURVEY_REWARD_ARMS.length) as ProfileSurveyArm
}

/** The wallet credit idempotency key: one reward per account per version. */
export function profileSurveyRewardKey(userId: string, version: number) {
  return `survey:${PROFILE_SURVEY_ID}:${version}:${userId}`
}

/** Whether an answer is valid for the CURRENT revision of its question:
 *  known option ids, single-choice has one, exclusive options stand alone. */
export function isValidProfileSurveyAnswer(
  question: ProfileSurveyQuestion,
  optionIds: readonly string[],
): boolean {
  if (optionIds.length === 0) return false
  if (new Set(optionIds).size !== optionIds.length) return false
  if (!question.multi && optionIds.length !== 1) return false
  const byId = new Map(question.options.map((o) => [o.id, o]))
  if (!optionIds.every((id) => byId.has(id))) return false
  if (optionIds.length > 1 && optionIds.some((id) => byId.get(id)?.exclusive))
    return false
  return true
}

/** Index of the first question in `questionIds` with no current-revision
 *  answer, or `questionIds.length` when complete. */
export function firstUnansweredIndex(
  questionIds: readonly string[],
  answers: readonly ProfileSurveyAnswer[],
): number {
  const answered = new Set(
    answers
      .filter(
        (a) =>
          a.questionRevision >=
          (profileSurveyQuestion(a.questionId)?.revision ?? Infinity),
      )
      .map((a) => a.questionId),
  )
  const i = questionIds.findIndex(
    (id) => !answered.has(id as ProfileSurveyQuestionId),
  )
  return i === -1 ? questionIds.length : i
}

/** A complete submission earns its arm's reward unless every answer is a
 *  notApplicable option. */
export function earnsProfileSurveyReward(
  answers: readonly ProfileSurveyAnswer[],
): boolean {
  return answers.some((a) => {
    const q = profileSurveyQuestion(a.questionId)
    return a.optionIds.some(
      (id) => !q?.options.find((o) => o.id === id)?.notApplicable,
    )
  })
}
