import { describe, expect, it } from 'bun:test'

import { shouldAnimateChatHeader } from '../chat-header-animation'

describe('shouldAnimateChatHeader', () => {
  it('disables the sheen for the Freebuff chat header', () => {
    expect(shouldAnimateChatHeader(true, true)).toBe(false)
  })

  it('keeps the Codebuff sheen when the header is active', () => {
    expect(shouldAnimateChatHeader(true, false)).toBe(true)
  })

  it('does not animate an inactive header for either product', () => {
    expect(shouldAnimateChatHeader(false, true)).toBe(false)
    expect(shouldAnimateChatHeader(false, false)).toBe(false)
  })
})
