import { describe, expect, it } from 'bun:test'

import {
  applyOnboardingAnswersToTally,
  classifyOnboardingOtherText,
  emptyOnboardingTally,
  FREEBUFF_ONBOARDING_QUESTIONS,
  isOnboardingComplete,
  ONBOARDING_LEGACY_OPTION_IDS,
  ONBOARDING_OTHER_TEXT_MAX,
  onboardingSourceProperties,
  OTHER_OPTION_ID,
  parseOnboardingSurface,
  resumableOnboardingAnswers,
  type OnboardingAnswer,
  validateOnboardingSubmission,
} from '../freebuff-onboarding'

/** A complete, valid submission. */
function fullAnswers(overrides: OnboardingAnswer[] = []): OnboardingAnswer[] {
  const base: OnboardingAnswer[] = [
    { questionId: 'referral_source', optionIds: ['youtube'] },
    { questionId: 'role', optionIds: ['professional_dev'] },
    { questionId: 'proficiency', optionIds: ['advanced'] },
    { questionId: 'intended_use', optionIds: ['work', 'side_projects'] },
    { questionId: 'subscriptions', optionIds: ['cursor'] },
  ]
  return base.map((a) => overrides.find((o) => o.questionId === a.questionId) ?? a)
}

describe('the question set itself', () => {
  it('gives every option a unique id within its question', () => {
    // A duplicate id would silently merge two distinct answers in the analytics.
    for (const q of FREEBUFF_ONBOARDING_QUESTIONS) {
      const ids = q.options.map((o) => o.id)
      expect(new Set(ids).size).toBe(ids.length)
    }
  })

  it('offers Other everywhere except the ordinal scale', () => {
    // Free text on an ordered scale is unusable for the segmentation the
    // question exists to support.
    for (const q of FREEBUFF_ONBOARDING_QUESTIONS) {
      const hasOther = q.options.some((o) => o.id === OTHER_OPTION_ID)
      expect(hasOther).toBe(q.id !== 'proficiency')
    }
  })

  it('maps every legacy option onto an option that still exists', () => {
    // A successor that no longer exists silently drops the answers it was
    // supposed to rescue — the exact failure the map exists to prevent.
    for (const [questionId, map] of Object.entries(ONBOARDING_LEGACY_OPTION_IDS)) {
      const question = FREEBUFF_ONBOARDING_QUESTIONS.find((q) => q.id === questionId)
      expect(question).toBeDefined()
      const live = new Set(question!.options.map((o) => o.id))
      for (const [retired, successor] of Object.entries(map ?? {})) {
        expect(live.has(retired)).toBe(false)
        expect(live.has(successor)).toBe(true)
      }
    }
  })

  it('only marks options exclusive on multi-select questions', () => {
    // On a single-choice question "exclusive" is meaningless, and reading as
    // though it does something is worse than not having it.
    for (const q of FREEBUFF_ONBOARDING_QUESTIONS) {
      if (q.multi) continue
      expect(q.options.some((o) => o.exclusive)).toBe(false)
    }
  })
})

describe('classifyOnboardingOtherText — write-ins folded into real options', () => {
  it('counts every Instagram, TikTok and Facebook spelling as its own option', () => {
    for (const text of ['insta', 'Instagram', 'instagram ads', 'IG']) {
      expect(classifyOnboardingOtherText('referral_source', text)).toBe('instagram')
    }
    for (const text of ['tiktok', 'TikTok ad', 'tik tok']) {
      expect(classifyOnboardingOtherText('referral_source', text)).toBe('tiktok_only')
    }
    for (const text of ['facebook', 'Facebook group', 'face book', 'FB ads']) {
      expect(classifyOnboardingOtherText('referral_source', text)).toBe('facebook')
    }
  })

  it('counts AI assistants as the Google / AI search option', () => {
    for (const text of ['ChatGPT', 'chat gpt', 'AI', 'gemini', 'perplexity']) {
      expect(classifyOnboardingOtherText('referral_source', text)).toBe('search')
    }
  })

  it('prefers the more specific rule when a write-in matches both', () => {
    expect(classifyOnboardingOtherText('referral_source', 'instagram AI page')).toBe(
      'instagram',
    )
    expect(classifyOnboardingOtherText('referral_source', 'facebook AI group')).toBe(
      'facebook',
    )
  })

  it('leaves genuinely other answers alone', () => {
    // The AI rule is the dangerous one: a substring match would swallow
    // "email", "said", "chair" and quietly inflate a channel that never
    // referred anyone.
    for (const text of ['forums', 'my brother', 'email newsletter', 'a fair', 'fbi']) {
      expect(classifyOnboardingOtherText('referral_source', text)).toBeNull()
    }
  })

  it('does nothing on questions with no rules', () => {
    expect(classifyOnboardingOtherText('role', 'instagram')).toBeNull()
  })
})

describe('validateOnboardingSubmission', () => {
  it('accepts a complete submission', () => {
    const result = validateOnboardingSubmission({ answers: fullAnswers() })
    expect(result.ok).toBe(true)
  })

  it('accepts a partial submission, keeping only what was answered', () => {
    // Every question is individually skippable, so a partial submission is the
    // normal case. Rejecting it is how answers used to be thrown away: the form
    // posted what was filled in, this returned a 400, and the user was told
    // their answers could not be saved.
    const answered = fullAnswers().slice(0, 2)
    const result = validateOnboardingSubmission({ answers: answered })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.answers.map((a) => a.questionId)).toEqual(
      answered.map((a) => a.questionId),
    )
  })

  it('refuses an entirely empty submission', () => {
    // Saving nothing still marks the questionnaire as dealt with, so it has to
    // be a skip rather than a submission.
    const result = validateOnboardingSubmission({ answers: [] })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.errors).toEqual([
      { questionId: null, message: 'Choose at least one answer.' },
    ])
  })

  it('still rejects a malformed answer among skipped questions', () => {
    // Leniency is about absence only. A present-but-wrong answer is a stale or
    // forged client either way.
    const result = validateOnboardingSubmission({
      answers: [{ questionId: 'role', optionIds: ['ceo_of_mars'] }],
    })
    expect(result.ok).toBe(false)
  })

  it('rejects an unknown option id', () => {
    // Out-of-date client or a forged post. Accepting it would put a value in
    // the analytics that no question can explain.
    const result = validateOnboardingSubmission({
      answers: fullAnswers([{ questionId: 'role', optionIds: ['ceo_of_mars'] }]),
    })
    expect(result.ok).toBe(false)
  })

  it('rejects multiple answers to a single-choice question', () => {
    const result = validateOnboardingSubmission({
      answers: fullAnswers([
        { questionId: 'role', optionIds: ['student', 'founder'] },
      ]),
    })
    expect(result.ok).toBe(false)
  })

  it('rejects an exclusive option combined with others', () => {
    // "No subscriptions" and "Cursor" cannot both be true; a stored
    // contradiction has no honest reading in the tally.
    const result = validateOnboardingSubmission({
      answers: fullAnswers([
        { questionId: 'subscriptions', optionIds: ['none', 'cursor'] },
      ]),
    })
    expect(result.ok).toBe(false)
  })

  it('accepts the exclusive option on its own', () => {
    const result = validateOnboardingSubmission({
      answers: fullAnswers([
        { questionId: 'subscriptions', optionIds: ['none'] },
      ]),
    })
    expect(result.ok).toBe(true)
  })

  it('accepts multiple answers where the question allows it', () => {
    const result = validateOnboardingSubmission({
      answers: fullAnswers([
        {
          questionId: 'intended_use',
          optionIds: ['work', 'learning', 'automation'],
        },
      ]),
    })
    expect(result.ok).toBe(true)
  })
})

describe('the Other option', () => {
  it('requires accompanying text', () => {
    const result = validateOnboardingSubmission({
      answers: fullAnswers([
        { questionId: 'role', optionIds: [OTHER_OPTION_ID] },
      ]),
    })
    expect(result.ok).toBe(false)
  })

  it('keeps the text when Other is chosen', () => {
    const result = validateOnboardingSubmission({
      answers: fullAnswers([
        {
          questionId: 'role',
          optionIds: [OTHER_OPTION_ID],
          otherText: '  technical writer  ',
        },
      ]),
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    const role = result.answers.find((a) => a.questionId === 'role')
    expect(role?.otherText).toBe('technical writer')
  })

  it('drops stray text when Other was NOT chosen', () => {
    // Otherwise text rides along on an answer that has nowhere to display it,
    // and the admin view shows a note against the wrong option.
    const result = validateOnboardingSubmission({
      answers: fullAnswers([
        { questionId: 'role', optionIds: ['student'], otherText: 'ignore me' },
      ]),
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.answers.find((a) => a.questionId === 'role')?.otherText).toBeUndefined()
  })

  it('truncates rather than rejecting a long note', () => {
    const result = validateOnboardingSubmission({
      answers: fullAnswers([
        {
          questionId: 'role',
          optionIds: [OTHER_OPTION_ID],
          otherText: 'x'.repeat(ONBOARDING_OTHER_TEXT_MAX + 500),
        },
      ]),
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.answers.find((a) => a.questionId === 'role')?.otherText).toHaveLength(
      ONBOARDING_OTHER_TEXT_MAX,
    )
  })
})

describe('isOnboardingComplete — the blocking gate reads this', () => {
  it('is true only when every question has an answer', () => {
    expect(isOnboardingComplete(fullAnswers())).toBe(true)
    expect(isOnboardingComplete(fullAnswers().slice(0, 3))).toBe(false)
  })

  it('treats null, undefined and empty as incomplete', () => {
    // A user with no record must be gated, not waved through — this is the
    // difference between the gate working and being decorative.
    expect(isOnboardingComplete(null)).toBe(false)
    expect(isOnboardingComplete(undefined)).toBe(false)
    expect(isOnboardingComplete([])).toBe(false)
  })

  it('does not count an answer with no options chosen', () => {
    const hollow = fullAnswers([{ questionId: 'role', optionIds: [] }])
    expect(isOnboardingComplete(hollow)).toBe(false)
  })
})

describe('applyOnboardingAnswersToTally', () => {
  it('folds retired ids into their successor and drops ids nothing defines', () => {
    const tally = emptyOnboardingTally()
    applyOnboardingAnswersToTally(tally, [
      { questionId: 'referral_source', optionIds: ['reddit'] },
      { questionId: 'role', optionIds: ['pm'] },
      { questionId: 'subscriptions', optionIds: ['copilot', 'cursor'] },
      { questionId: 'intended_use', optionIds: ['prototyping', 'never_existed'] },
      { questionId: 'retired_question', optionIds: ['x'] },
    ])
    expect(tally.referral_source[OTHER_OPTION_ID]).toBe(1)
    expect(tally.referral_source.reddit).toBeUndefined()
    expect(tally.role[OTHER_OPTION_ID]).toBe(1)
    expect(tally.subscriptions[OTHER_OPTION_ID]).toBe(1)
    expect(tally.subscriptions.cursor).toBe(1)
    expect(tally.intended_use.website).toBe(1)
    expect(tally.retired_question).toBeUndefined()
  })

  it('counts a write-in that names an option as that option, and lists the rest', () => {
    const tally = emptyOnboardingTally()
    const others = applyOnboardingAnswersToTally(tally, [
      {
        questionId: 'referral_source',
        optionIds: [OTHER_OPTION_ID],
        otherText: 'instagram reels',
      },
      {
        questionId: 'role',
        optionIds: [OTHER_OPTION_ID],
        otherText: 'lighthouse keeper',
      },
    ])
    expect(tally.referral_source.instagram).toBe(1)
    expect(tally.referral_source[OTHER_OPTION_ID]).toBe(0)
    expect(tally.role[OTHER_OPTION_ID]).toBe(1)
    expect(others).toEqual({ role: ['lighthouse keeper'] })
  })

  it('removes a resubmitted answer with sign -1 so a replace is not a double count', () => {
    const tally = emptyOnboardingTally()
    const first = [{ questionId: 'role', optionIds: ['student'] }]
    const second = [{ questionId: 'role', optionIds: ['founder'] }]
    applyOnboardingAnswersToTally(tally, first, 1)
    applyOnboardingAnswersToTally(tally, first, -1)
    applyOnboardingAnswersToTally(tally, second, 1)
    expect(tally.role.student).toBe(0)
    expect(tally.role.founder).toBe(1)
  })

  it('offers every current option at zero, so an unanswered question still has bars', () => {
    const tally = emptyOnboardingTally()
    for (const q of FREEBUFF_ONBOARDING_QUESTIONS) {
      expect(Object.keys(tally[q.id]).sort()).toEqual(
        [...q.options, ...(q.retiredOptions ?? [])].map((o) => o.id).sort(),
      )
    }
  })

  it('still counts the combined social chip from before the split', () => {
    const tally = emptyOnboardingTally()
    applyOnboardingAnswersToTally(tally, [
      { questionId: 'referral_source', optionIds: ['tiktok'] },
    ])
    expect(tally.referral_source.tiktok).toBe(1)
    expect(tally.referral_source.tiktok_only).toBe(0)
  })
})

describe('question set (2026-09-16 edit)', () => {
  const byId = Object.fromEntries(FREEBUFF_ONBOARDING_QUESTIONS.map((q) => [q.id, q]))
  it('no longer offers Reddit, GitHub, Designer/PM, Non-technical or Copilot', () => {
    const ids = (q: string) => byId[q].options.map((o) => o.id)
    expect(ids('referral_source')).not.toContain('reddit')
    expect(ids('referral_source')).not.toContain('github')
    expect(ids('role')).not.toContain('pm')
    expect(ids('role')).not.toContain('non_technical')
    expect(ids('subscriptions')).not.toContain('copilot')
  })
  it('keeps the build and subscriptions questions multi-select', () => {
    expect(byId.intended_use.multi).toBe(true)
    expect(byId.subscriptions.multi).toBe(true)
  })
  it('offers Instagram, TikTok and Facebook separately (2026-09-28 split)', () => {
    const ids = byId.referral_source.options.map((o) => o.id)
    expect(ids).toEqual(expect.arrayContaining(['instagram', 'tiktok_only', 'facebook']))
    // The combined chip's id is retired, not reused: its answers mean all three.
    expect(ids).not.toContain('tiktok')
    expect(byId.referral_source.retiredOptions?.map((o) => o.id)).toEqual(['tiktok'])
    const result = validateOnboardingSubmission({
      answers: [{ questionId: 'referral_source', optionIds: ['tiktok'] }],
    })
    expect(result.ok).toBe(false)
  })
  it('shuffles every choice question while preserving the proficiency scale', () => {
    expect(
      FREEBUFF_ONBOARDING_QUESTIONS.filter((q) => q.shuffleOptions).map((q) => q.id),
    ).toEqual(['referral_source', 'role', 'intended_use', 'subscriptions'])
  })
  it('still validates a retired id as unknown rather than silently storing it', () => {
    const result = validateOnboardingSubmission({
      answers: [{ questionId: 'role', optionIds: ['pm'] }],
    })
    expect(result.ok).toBe(false)
  })
})

describe('parseOnboardingSurface', () => {
  it('accepts a known surface and falls back to web for anything else', () => {
    expect(parseOnboardingSurface('cli_login')).toBe('cli_login')
    expect(parseOnboardingSurface('web')).toBe('web')
    expect(parseOnboardingSurface('desktop')).toBe('desktop')
    expect(parseOnboardingSurface(undefined)).toBe('web')
    expect(parseOnboardingSurface('desktop; drop table')).toBe('web')
  })
})

describe('onboardingSourceProperties', () => {
  const source = (optionId: string, otherText?: string) =>
    onboardingSourceProperties([
      { questionId: 'referral_source', optionIds: [optionId], otherText },
    ])
  const group = (optionId: string, otherText?: string) =>
    source(optionId, otherText)?.onboarding_source
  const detail = (optionId: string, otherText?: string) =>
    source(optionId, otherText)?.onboarding_source_detail

  it('groups the social platforms and keeps each one as the detail', () => {
    const social = ['instagram', 'tiktok_only', 'facebook', 'youtube', 'x_twitter']
    for (const id of social) expect(group(id)).toBe('Social media')
    expect(detail('instagram')).toBe('Instagram')
    expect(detail('tiktok_only')).toBe('TikTok')
    expect(detail('facebook')).toBe('Facebook')
    expect(detail('youtube')).toBe('YouTube')
    expect(detail('x_twitter')).toBe('X / Twitter')
    expect(source('search')).toEqual({
      onboarding_source: 'Google / AI search',
      onboarding_source_detail: 'Google / AI search',
    })
    expect(group('friend')).toBe('A friend')
  })

  it('keeps the combined chip from before the split as social media', () => {
    expect(source('tiktok')).toEqual({
      onboarding_source: 'Social media',
      onboarding_source_detail: 'Instagram / TikTok / Facebook (before split)',
    })
  })

  it('has a value for every option the form offers or used to', () => {
    const question = FREEBUFF_ONBOARDING_QUESTIONS.find(
      (q) => q.id === 'referral_source',
    )!
    for (const o of [...question.options, ...(question.retiredOptions ?? [])]) {
      expect(source(o.id, 'x')).not.toBeNull()
    }
  })

  it('counts write-ins and retired ids the way the tally does', () => {
    expect(detail(OTHER_OPTION_ID, 'instagram reel')).toBe('Instagram')
    expect(group(OTHER_OPTION_ID, 'asked chatgpt')).toBe('Google / AI search')
    expect(group(OTHER_OPTION_ID, 'my boss')).toBe('Somewhere else')
    expect(group('reddit')).toBe('Somewhere else')
  })

  it('is null when the question was not answered', () => {
    expect(onboardingSourceProperties(null)).toBeNull()
    expect(
      onboardingSourceProperties([
        { questionId: 'role', optionIds: ['student'] },
      ]),
    ).toBeNull()
  })
})

describe('resumableOnboardingAnswers', () => {
  it('drops options the form no longer offers, so the question is asked again', () => {
    const resumed = resumableOnboardingAnswers([
      { questionId: 'referral_source', optionIds: ['tiktok'] },
      { questionId: 'role', optionIds: ['student'] },
      { questionId: 'subscriptions', optionIds: ['copilot', 'cursor'] },
    ])
    expect(resumed).toEqual([
      { questionId: 'role', optionIds: ['student'] },
      { questionId: 'subscriptions', optionIds: ['cursor'] },
    ])
    expect(validateOnboardingSubmission({ answers: resumed }).ok).toBe(true)
  })

  it('keeps write-in text only while "other" is still chosen', () => {
    expect(
      resumableOnboardingAnswers([
        {
          questionId: 'role',
          optionIds: [OTHER_OPTION_ID],
          otherText: 'lighthouse keeper',
        },
      ]),
    ).toEqual([
      {
        questionId: 'role',
        optionIds: [OTHER_OPTION_ID],
        otherText: 'lighthouse keeper',
      },
    ])
  })
})
