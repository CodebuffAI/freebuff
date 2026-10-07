import { describe, expect, it } from 'bun:test'

import {
  ACTIVE_PROFILE_SURVEY_VERSION,
  earnsProfileSurveyReward,
  firstUnansweredIndex,
  isValidProfileSurveyAnswer,
  PROFILE_SURVEY_QUESTIONS,
  PROFILE_SURVEY_REWARD_ARMS,
  PROFILE_SURVEY_VERSIONS,
  profileSurveyArm,
  profileSurveyQuestion,
  profileSurveyRewardKey,
  profileSurveyVersion,
  type ProfileSurveyAnswer,
  type ProfileSurveyQuestion,
} from '../freebuff-profile-survey'

function q(id: string): ProfileSurveyQuestion {
  const question = profileSurveyQuestion(id)
  if (!question) throw new Error(`no question ${id}`)
  return question
}

function answer(
  questionId: string,
  optionIds: string[],
  questionRevision = q(questionId).revision,
): ProfileSurveyAnswer {
  return {
    questionId: questionId as ProfileSurveyAnswer['questionId'],
    questionRevision,
    optionIds,
  }
}

describe('profileSurveyArm', () => {
  it('is roughly uniform over the three arms across 30k ids', () => {
    const counts = [0, 0, 0]
    for (let i = 0; i < 30_000; i++) {
      counts[profileSurveyArm(`user-${i}-${(i * 7919) % 1000}`, 1)]++
    }
    for (const n of counts) {
      // 10k expected per arm; ±5% is far outside sampling noise (~±1%).
      expect(n).toBeGreaterThan(9_500)
      expect(n).toBeLessThan(10_500)
    }
  })

  it('is deterministic per user and version', () => {
    for (const id of ['a', 'user_123', 'c8b2f1e0-0000-4000-8000-000000000000']) {
      expect(profileSurveyArm(id, 1)).toBe(profileSurveyArm(id, 1))
    }
  })

  it('re-draws per version', () => {
    let differ = 0
    for (let i = 0; i < 300; i++) {
      if (profileSurveyArm(`u${i}`, 1) !== profileSurveyArm(`u${i}`, 2)) differ++
    }
    expect(differ).toBeGreaterThan(100)
  })

  it('only returns arms with a reward', () => {
    for (let i = 0; i < 100; i++) {
      expect(PROFILE_SURVEY_REWARD_ARMS[profileSurveyArm(`x${i}`, 1)]).toBeDefined()
    }
  })
})

describe('profileSurveyRewardKey', () => {
  it('is one key per user per version', () => {
    expect(profileSurveyRewardKey('u1', 1)).toBe('survey:profile:1:u1')
    expect(profileSurveyRewardKey('u1', 2)).not.toBe(profileSurveyRewardKey('u1', 1))
  })
})

describe('isValidProfileSurveyAnswer', () => {
  it('accepts one known option on a single-choice question', () => {
    expect(isValidProfileSurveyAnswer(q('who_pays'), ['me'])).toBe(true)
    expect(isValidProfileSurveyAnswer(q('who_pays'), ['na'])).toBe(true)
  })

  it('refuses two options on a single-choice question', () => {
    expect(isValidProfileSurveyAnswer(q('who_pays'), ['me', 'employer'])).toBe(false)
  })

  it('refuses empty, duplicate and unknown ids', () => {
    expect(isValidProfileSurveyAnswer(q('deploy'), [])).toBe(false)
    expect(isValidProfileSurveyAnswer(q('deploy'), ['aws', 'aws'])).toBe(false)
    expect(isValidProfileSurveyAnswer(q('deploy'), ['heroku'])).toBe(false)
    expect(isValidProfileSurveyAnswer(q('deploy'), ['aws', 'heroku'])).toBe(false)
  })

  it('accepts several options on a multi-choice question', () => {
    expect(isValidProfileSurveyAnswer(q('deploy'), ['aws', 'vercel'])).toBe(true)
  })

  it('lets an exclusive option stand only alone', () => {
    expect(isValidProfileSurveyAnswer(q('deploy'), ['not_yet'])).toBe(true)
    expect(isValidProfileSurveyAnswer(q('deploy'), ['not_yet', 'aws'])).toBe(false)
    expect(isValidProfileSurveyAnswer(q('shopping'), ['none', 'auth'])).toBe(false)
    expect(isValidProfileSurveyAnswer(q('database'), ['na', 'postgres'])).toBe(false)
  })
})

describe('firstUnansweredIndex', () => {
  const ids = PROFILE_SURVEY_VERSIONS[0].questionIds

  it('is 0 with no answers and length when complete', () => {
    expect(firstUnansweredIndex(ids, [])).toBe(0)
    const all = ids.map((id) => answer(id, [q(id).options[0].id]))
    expect(firstUnansweredIndex(ids, all)).toBe(ids.length)
  })

  it('resumes at the first gap, not after the last answer', () => {
    const some = [answer('who_pays', ['me']), answer('team_size', ['solo'])]
    expect(firstUnansweredIndex(ids, some)).toBe(1)
  })

  it('treats an answer below the current revision as unanswered', () => {
    const stale = [answer('who_pays', ['me'], 0), answer('tool_spend', ['zero'])]
    expect(firstUnansweredIndex(ids, stale)).toBe(0)
  })

  it('ignores answers to unknown questions', () => {
    const odd = [
      { questionId: 'gone', questionRevision: 9, optionIds: ['x'] } as never,
    ]
    expect(firstUnansweredIndex(ids, odd)).toBe(0)
  })
})

describe('earnsProfileSurveyReward', () => {
  it('pays nothing when every answer is notApplicable', () => {
    const ids = PROFILE_SURVEY_VERSIONS[0].questionIds
    const naOnly = ids
      .filter((id) => q(id).options.some((o) => o.notApplicable))
      .map((id) => answer(id, ['na']))
    expect(naOnly.length).toBeGreaterThan(0)
    expect(earnsProfileSurveyReward(naOnly)).toBe(false)
    expect(earnsProfileSurveyReward([])).toBe(false)
  })

  it('pays when any answer is a real option', () => {
    expect(
      earnsProfileSurveyReward([answer('who_pays', ['na']), answer('deploy', ['aws'])]),
    ).toBe(true)
    // An exclusive non-notApplicable option ("Not shopping") is a real answer.
    expect(earnsProfileSurveyReward([answer('shopping', ['none'])])).toBe(true)
  })
})

describe('contract lookups', () => {
  it('finds questions and versions', () => {
    expect(profileSurveyQuestion('nope')).toBeUndefined()
    expect(profileSurveyVersion(1)?.questionIds.length).toBe(10)
    expect(profileSurveyVersion(999)).toBeUndefined()
  })

  it('points the gate at a shipped version (or null)', () => {
    if (ACTIVE_PROFILE_SURVEY_VERSION !== null) {
      expect(profileSurveyVersion(ACTIVE_PROFILE_SURVEY_VERSION)).toBeDefined()
    }
  })

  it('every version names only bank questions, no repeats, unique version numbers', () => {
    const versions = PROFILE_SURVEY_VERSIONS.map((v) => v.version)
    expect(new Set(versions).size).toBe(versions.length)
    for (const v of PROFILE_SURVEY_VERSIONS) {
      expect(new Set(v.questionIds).size).toBe(v.questionIds.length)
      for (const id of v.questionIds) expect(profileSurveyQuestion(id)).toBeDefined()
    }
  })

  it('notApplicable options are exclusive; option ids are unique per question', () => {
    for (const question of PROFILE_SURVEY_QUESTIONS as readonly ProfileSurveyQuestion[]) {
      const ids = [
        ...question.options,
        ...(question.retiredOptions ?? []),
      ].map((o) => o.id)
      expect(new Set(ids).size).toBe(ids.length)
      for (const o of question.options) {
        if (o.notApplicable) expect(o.exclusive).toBe(true)
      }
    }
  })
})

/**
 * SHIPPED VERSIONS ARE IMMUTABLE.
 *
 * If this test fails because you edited the survey: do not change these
 * pins. Stored answers and paid rewards are keyed on these ids.
 *  - To change which questions are asked or their order, ADD a new entry to
 *    PROFILE_SURVEY_VERSIONS and point ACTIVE_PROFILE_SURVEY_VERSION at it,
 *    then pin the new version here too.
 *  - Option ids are append-only: add new ones at the end of the pin; retire
 *    one by moving it to `retiredOptions` (it stays pinned below).
 *  - A wording change that alters an answer's meaning bumps the question's
 *    `revision`; it never renames the question id.
 */
describe('shipped profile survey versions are immutable', () => {
  const SHIPPED_VERSIONS: Record<number, readonly string[]> = {
    1: [
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
  }

  const SHIPPED_OPTION_IDS: Record<string, readonly string[]> = {
    who_pays: ['me', 'employer', 'both', 'nobody', 'na'],
    tool_spend: ['zero', 'lt20', '20_100', '100_500', '500_plus', 'na'],
    team_size: ['solo', '2_10', '11_50', '51_500', '500_plus', 'na'],
    building: [
      'saas',
      'ai_app',
      'internal_tool',
      'mobile',
      'store',
      'website',
      'data_ml',
      'na',
    ],
    shopping: [
      'hosting',
      'database',
      'auth',
      'payments',
      'monitoring',
      'email',
      'ai_apis',
      'code_review',
      'none',
    ],
    deploy: ['vercel', 'aws', 'gcp', 'cloudflare', 'paas', 'self_hosted', 'not_yet'],
    database: ['postgres', 'supabase', 'firebase', 'mongodb', 'mysql', 'sqlite', 'na'],
    languages: [
      'typescript',
      'javascript',
      'python',
      'go',
      'rust',
      'jvm',
      'csharp',
      'php',
      'swift',
      'na',
    ],
    frameworks: [
      'nextjs',
      'react',
      'vue',
      'svelte',
      'python_web',
      'rails',
      'laravel',
      'cross_mobile',
      'na',
    ],
    industry: [
      'software',
      'finance',
      'health',
      'education',
      'ecommerce',
      'media',
      'agency',
      'other',
      'na',
    ],
  }

  it('every pinned version still exists with exactly its question list', () => {
    for (const [version, questionIds] of Object.entries(SHIPPED_VERSIONS)) {
      expect(profileSurveyVersion(Number(version))?.questionIds).toEqual(
        questionIds as never,
      )
    }
  })

  it('every pinned option id still exists on its question (append-only)', () => {
    for (const [questionId, pinned] of Object.entries(SHIPPED_OPTION_IDS)) {
      const question = q(questionId)
      const all = [
        ...question.options,
        ...(question.retiredOptions ?? []),
      ].map((o) => o.id)
      // Live or retired, never gone.
      for (const id of pinned) expect(all).toContain(id)
    }
  })

  it('every bank question is pinned', () => {
    for (const question of PROFILE_SURVEY_QUESTIONS) {
      expect(SHIPPED_OPTION_IDS[question.id]).toBeDefined()
    }
  })
})
