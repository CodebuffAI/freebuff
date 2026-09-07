import { describe, it, expect, beforeEach } from 'bun:test'

import { useFreebuffSessionStore } from '../../state/freebuff-session-store'

// Re-implement the helper to test it independently (avoids importing the
// full use-freebuff-session module which has side effects and React deps).
function getSessionBoundUserId(): string | null {
  return useFreebuffSessionStore.getState().sessionBoundUserId
}

describe('getSessionBoundUserId', () => {
  beforeEach(() => {
    useFreebuffSessionStore.getState().setSessionBoundUserId(null)
  })

  it('returns null when no binding exists', () => {
    expect(getSessionBoundUserId()).toBeNull()
  })

  it('returns the bound user id when set', () => {
    useFreebuffSessionStore.getState().setSessionBoundUserId('user-abc')
    expect(getSessionBoundUserId()).toBe('user-abc')
  })

  it('returns null after binding is cleared', () => {
    useFreebuffSessionStore.getState().setSessionBoundUserId('user-abc')
    useFreebuffSessionStore.getState().setSessionBoundUserId(null)
    expect(getSessionBoundUserId()).toBeNull()
  })
})
