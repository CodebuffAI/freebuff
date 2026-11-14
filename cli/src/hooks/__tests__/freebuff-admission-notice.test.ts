import { describe, expect, test } from 'bun:test'

import { freebuffAdmissionNotice } from '../use-freebuff-chat-admission'

import type { FreebuffSessionResponse } from '../../types/freebuff-session'

describe('freebuffAdmissionNotice', () => {
  test('a suspended account is pointed at the appeal page', () => {
    const notice = freebuffAdmissionNotice({
      status: 'banned',
    } as FreebuffSessionResponse)
    expect(notice).toContain('https://freebuff.com/account?tab=standing')
    expect(notice).toContain('support@freebuff.com')
  })

  test('a Freebucks shortfall is told in hours, with a cheaper model as the way on', () => {
    const notice = freebuffAdmissionNotice({
      status: 'rate_limited',
      model: 'deepseek/deepseek-v4-flash',
      freebucksShortfall: { price: 15, balance: 10 },
    } as FreebuffSessionResponse)
    expect(notice).toContain('uses 3 hours, and you have 2 hours left.')
    expect(notice).toContain('lower multiplier')
    // Shown in the box that hides the input, where Enter opens the picker.
    expect(notice).toContain('Choose another model')
    expect(notice).not.toContain('Freebucks')
    expect(notice).not.toMatch(/session limit|daily sessions/i)
  })
})
