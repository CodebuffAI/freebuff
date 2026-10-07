import { describe, expect, it } from 'bun:test'

import {
  PROFILE_SURVEY_QUESTIONS,
  profileSurveyQuestion,
  type ProfileSurveyQuestion,
} from '../freebuff-profile-survey'
import {
  createFakeProfileSurveyClient,
  createFetchProfileSurveyTransport,
  createHttpProfileSurveyClient,
} from '../freebuff-profile-survey-client'
import {
  formatProfileSurveyAnswer,
  isAllNotApplicable,
  isProfileSurveyAnswerReady,
  profileSurveyCompletionCopy,
  profileSurveyDismissCopy,
  profileSurveyHeader,
  profileSurveyHint,
  profileSurveyRewardCopy,
  profileSurveySelections,
  profileSurveyStartIndex,
  toggleProfileSurveyOption,
} from '../freebuff-profile-survey-form'

const q = (id: string) => profileSurveyQuestion(id) as ProfileSurveyQuestion
const shopping = q('shopping')
const database = q('database')
const whoPays = q('who_pays')

describe('toggleProfileSurveyOption', () => {
  it('replaces on a single-choice question', () => {
    expect(toggleProfileSurveyOption(whoPays, ['me'], 'employer')).toEqual([
      'employer',
    ])
  })
  it('adds and removes on a multi question', () => {
    expect(toggleProfileSurveyOption(shopping, ['hosting'], 'auth')).toEqual([
      'hosting',
      'auth',
    ])
    expect(toggleProfileSurveyOption(shopping, ['hosting', 'auth'], 'auth')).toEqual([
      'hosting',
    ])
  })
  it('an exclusive option clears the rest, and the rest clear it', () => {
    expect(toggleProfileSurveyOption(shopping, ['hosting', 'auth'], 'none')).toEqual([
      'none',
    ])
    expect(toggleProfileSurveyOption(shopping, ['none'], 'auth')).toEqual(['auth'])
    expect(toggleProfileSurveyOption(database, ['postgres'], 'na')).toEqual(['na'])
    expect(toggleProfileSurveyOption(database, ['na'], 'sqlite')).toEqual(['sqlite'])
  })
  it('never produces a selection the server would refuse', () => {
    for (const question of PROFILE_SURVEY_QUESTIONS as readonly ProfileSurveyQuestion[]) {
      let chosen: string[] = []
      for (const option of question.options) {
        chosen = toggleProfileSurveyOption(question, chosen, option.id)
        expect(isProfileSurveyAnswerReady(question, chosen)).toBe(true)
      }
    }
  })
})

describe('copy and view helpers', () => {
  it('header, hint and reward line', () => {
    expect(profileSurveyHeader(0, 10)).toBe('Quick question · 1 of 10')
    expect(profileSurveyHint(whoPays)).toBe('Tap one to continue')
    expect(profileSurveyHint(shopping)).toBe('Pick all that apply')
    expect(profileSurveyRewardCopy(25, 10)).toBe('Answer all 10 to get 25 Freebucks')
    expect(profileSurveyRewardCopy(0, 10)).toBeNull()
  })
  it('dismiss copy counts answers and names the stop', () => {
    expect(profileSurveyDismissCopy({ answered: 3, stopped: false })).toBe(
      "Got it. We'll ask again in 7 days. Your 3 answers so far are saved.",
    )
    expect(profileSurveyDismissCopy({ answered: 1, stopped: false })).toContain(
      'Your 1 answer so far is saved.',
    )
    expect(profileSurveyDismissCopy({ answered: 0, stopped: false })).toBe(
      "Got it. We'll ask again in 7 days.",
    )
    expect(profileSurveyDismissCopy({ answered: 4, stopped: true })).toContain(
      'third “Not now”',
    )
  })
  it('completion copy follows what the server credited', () => {
    expect(
      profileSurveyCompletionCopy({ rewardFreebucks: 25, rewardedFreebucks: 25, allNotApplicable: false }),
    ).toEqual({ kind: 'paid', title: '+25 Freebucks', detail: 'Added to your wallet. Thanks!' })
    expect(
      profileSurveyCompletionCopy({ rewardFreebucks: 5, rewardedFreebucks: 0, allNotApplicable: true }).detail,
    ).toContain("didn't earn the 5 Freebucks")
    expect(
      profileSurveyCompletionCopy({ rewardFreebucks: 0, rewardedFreebucks: 0, allNotApplicable: true }),
    ).toEqual({ kind: 'unpaid', title: "Thanks, that's everything.", detail: null })
  })
  it('start index is clamped', () => {
    expect(profileSurveyStartIndex(3, 10)).toBe(3)
    expect(profileSurveyStartIndex(10, 10)).toBe(9)
    expect(profileSurveyStartIndex(-1, 10)).toBe(0)
    expect(profileSurveyStartIndex(Number.NaN, 10)).toBe(0)
  })
  it('formats answers in option order and detects all-notApplicable', () => {
    expect(formatProfileSurveyAnswer(q('deploy'), ['aws', 'vercel'])).toBe('Vercel, AWS')
    expect(formatProfileSurveyAnswer(q('deploy'), [])).toBe('Not answered')
    expect(isAllNotApplicable([whoPays, database], { who_pays: ['na'], database: ['na'] })).toBe(true)
    expect(isAllNotApplicable([whoPays, database], { who_pays: ['me'], database: ['na'] })).toBe(false)
    expect(profileSurveySelections([{ questionId: 'who_pays', optionIds: ['me'] }])).toEqual({
      who_pays: ['me'],
    })
  })
})

const answerAll = async (
  client: ReturnType<typeof createFakeProfileSurveyClient>,
  pick: (q: ProfileSurveyQuestion) => string,
) => {
  const state = await client.getState()
  if (!state.show) throw new Error('not shown')
  let last
  for (const question of state.questions) {
    last = await client.post({
      action: 'answer',
      version: state.version,
      questionId: question.id as never,
      optionIds: [pick(question)],
    })
  }
  return last
}

describe('the fake client follows the contract', () => {
  it('resumes at the first unanswered question', async () => {
    const client = createFakeProfileSurveyClient({
      answers: [
        { questionId: 'who_pays', optionIds: ['me'] },
        { questionId: 'tool_spend', optionIds: ['zero'] },
      ],
    })
    const state = await client.getState()
    expect(state.show && state.resumeAt).toBe(2)
  })
  it('pays the arm once on completion', async () => {
    const client = createFakeProfileSurveyClient({ rewardFreebucks: 5 })
    const result = await answerAll(client, (q) => q.options[0]!.id)
    expect(result).toEqual({ ok: true, completed: true, rewardedFreebucks: 5 })
    expect(await client.getState()).toEqual({ show: false, reason: 'completed' })
    // an edit after completion is accepted and credits nothing more
    expect(
      await client.post({ action: 'answer', version: 1, questionId: 'who_pays', optionIds: ['both'] }),
    ).toEqual({ ok: true, completed: true, rewardedFreebucks: 0 })
  })
  it('every way out still earns in v1: "Not shopping" is a real answer', async () => {
    const client = createFakeProfileSurveyClient({ rewardFreebucks: 25 })
    const out = (q: ProfileSurveyQuestion) =>
      (q.options.find((o) => o.notApplicable) ?? q.options.find((o) => o.exclusive))!.id
    expect(await answerAll(client, out)).toEqual({ ok: true, completed: true, rewardedFreebucks: 25 })
  })
  it('arm 0 completes with no credit', async () => {
    const client = createFakeProfileSurveyClient({ rewardFreebucks: 0 })
    expect(await answerAll(client, (q) => q.options[0]!.id)).toEqual({
      ok: true,
      completed: true,
      rewardedFreebucks: 0,
    })
  })
  it('snoozes, then stops on the third dismissal', async () => {
    let t = 0
    const client = createFakeProfileSurveyClient({ now: () => t })
    const first = await client.post({ action: 'dismiss', version: 1 })
    expect(first).toMatchObject({ dismissed: true, stopped: false })
    expect(await client.getState()).toEqual({ show: false, reason: 'snoozed' })
    t += 8 * 24 * 60 * 60 * 1000
    expect((await client.getState()).show).toBe(true)
    await client.post({ action: 'dismiss', version: 1 })
    const third = await client.post({ action: 'dismiss', version: 1 })
    expect(third).toMatchObject({ stopped: true, snoozedUntil: null })
    expect(await client.getState()).toEqual({ show: false, reason: 'stopped' })
  })
  it('refuses an invalid answer, lists and clears answers', async () => {
    const client = createFakeProfileSurveyClient()
    expect(
      (await client.post({ action: 'answer', version: 1, questionId: 'shopping', optionIds: ['none', 'auth'] })).ok,
    ).toBe(false)
    await client.post({ action: 'answer', version: 1, questionId: 'shopping', optionIds: ['auth'] })
    const listed = await client.getAnswers()
    expect(listed.answers.map((a) => [a.questionId, a.optionIds])).toEqual([['shopping', ['auth']]])
    expect(await client.post({ action: 'clear' })).toEqual({ ok: true, cleared: true })
    expect((await client.getAnswers()).answers).toEqual([])
    client.reset()
    expect(client.requests).toEqual([])
  })
})

describe('the HTTP client', () => {
  it('GETs and POSTs the contract paths and turns failures into ok:false', async () => {
    const calls: Array<[string, RequestInit | undefined]> = []
    const fetchFn = (async (url: string, init?: RequestInit) => {
      calls.push([url, init])
      if (init?.method === 'POST') return Response.json({ error: 'Nope' }, { status: 400 })
      return Response.json({ show: false, reason: 'signed_out' })
    }) as unknown as typeof fetch
    const client = createHttpProfileSurveyClient(
      createFetchProfileSurveyTransport({ baseUrl: 'https://x.test', fetchFn }),
    )
    expect(await client.getState()).toEqual({ show: false, reason: 'signed_out' })
    expect(await client.post({ action: 'dismiss', version: 1 })).toEqual({ ok: false, error: 'Nope' })
    expect(calls.map(([url, init]) => `${init?.method} ${url}`)).toEqual([
      'GET https://x.test/api/profile-survey',
      'POST https://x.test/api/profile-survey',
    ])
    expect(JSON.parse(String(calls[1]![1]!.body))).toEqual({ action: 'dismiss', version: 1 })
  })
})
