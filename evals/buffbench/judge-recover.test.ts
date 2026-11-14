import { describe, expect, test } from 'bun:test'

import { recoverFromSetOutput } from './judge'

describe('recoverFromSetOutput', () => {
  test('reads stringified scores and lists', () => {
    expect(
      recoverFromSetOutput({
        analysis: 'ok',
        strengths: '["a", "b"]',
        weaknesses: 'just one',
        completionScore: '9',
        codeQualityScore: '8.5',
        overallScore: '9',
      }),
    ).toEqual({
      analysis: 'ok',
      strengths: ['a', 'b'],
      weaknesses: ['just one'],
      completionScore: 9,
      codeQualityScore: 8.5,
      overallScore: 9,
    })
  })

  test('unwraps a retry wrapped in data, and refuses a non-verdict', () => {
    expect(
      recoverFromSetOutput({
        data: {
          analysis: 'x',
          strengths: [],
          weaknesses: [],
          completionScore: 1,
          codeQualityScore: 2,
          overallScore: 3,
        },
      })?.overallScore,
    ).toBe(3)
    expect(recoverFromSetOutput({ score: '7' })).toBeNull()
  })
})
