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
})
