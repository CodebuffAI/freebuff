import { describe, expect, test } from 'bun:test'

import {
  createHttpSponsoredSurveyClient,
  isSponsoredAnswerReady,
  sponsoredRewardLine,
  toggleSponsoredOption,
} from '../freebuff-sponsored-survey-client'

const MULTI = {
  id: 'q',
  position: 0,
  prompt: 'p',
  kind: 'multi',
  options: [
    { id: 'a', label: 'A' },
    { id: 'b', label: 'B' },
    { id: 'none', label: 'None', exclusive: true },
  ],
}
const SINGLE = { ...MULTI, kind: 'single' }

describe('sponsored survey client helpers', () => {
  test('toggle: exclusive clears the rest and vice versa', () => {
    expect(toggleSponsoredOption(MULTI, [], 'a')).toEqual(['a'])
    expect(toggleSponsoredOption(MULTI, ['a'], 'b')).toEqual(['a', 'b'])
    expect(toggleSponsoredOption(MULTI, ['a', 'b'], 'none')).toEqual(['none'])
    expect(toggleSponsoredOption(MULTI, ['none'], 'a')).toEqual(['a'])
    expect(toggleSponsoredOption(MULTI, ['a'], 'a')).toEqual([])
    expect(toggleSponsoredOption(SINGLE, ['a'], 'b')).toEqual(['b'])
  })

  test('ready', () => {
    expect(isSponsoredAnswerReady(SINGLE, [])).toBe(false)
    expect(isSponsoredAnswerReady(SINGLE, ['a'])).toBe(true)
    expect(isSponsoredAnswerReady(SINGLE, ['a', 'b'])).toBe(false)
    expect(isSponsoredAnswerReady(MULTI, ['a', 'b'])).toBe(true)
    expect(isSponsoredAnswerReady(MULTI, ['a', 'none'])).toBe(false)
  })

  test('reward line only when there is a reward', () => {
    expect(sponsoredRewardLine(25)).toBe('Earn 25 Freebucks')
    expect(sponsoredRewardLine(0)).toBeNull()
  })

  test('the HTTP client never rejects', async () => {
    const paths: string[] = []
    const client = createHttpSponsoredSurveyClient({
      get: async (path) => {
        paths.push(path)
        throw new Error('down')
      },
      post: async () => {
        throw new Error('down')
      },
    })
    expect(await client.getState('cli')).toEqual({ show: false })
    expect(paths).toEqual(['/api/sponsored-survey?surface=cli'])
    expect(
      await client.answer({ action: 'answer', campaignId: 'c', questionId: 'q', optionIds: ['a'] }),
    ).toEqual({ ok: false, error: 'down' })
    expect(await client.dismiss({ action: 'dismiss', campaignId: 'c' })).toEqual({
      ok: false,
      error: 'down',
    })
  })
})
