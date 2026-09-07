import { describe, it, expect, beforeEach } from 'bun:test'

import { useFreebuffSessionStore } from '../freebuff-session-store'

describe('FreebuffSessionStore — session binding', () => {
  beforeEach(() => {
    useFreebuffSessionStore.getState().setSession(null)
    useFreebuffSessionStore.getState().setFailure(null)
    useFreebuffSessionStore.getState().setSessionBoundUserId(null)
  })

  describe('sessionBoundUserId', () => {
    it('should default to null', () => {
      expect(useFreebuffSessionStore.getState().sessionBoundUserId).toBeNull()
    })

    it('should set the bound user id', () => {
      useFreebuffSessionStore.getState().setSessionBoundUserId('user-123')

      expect(useFreebuffSessionStore.getState().sessionBoundUserId).toBe(
        'user-123',
      )
    })

    it('should clear the bound user id', () => {
      useFreebuffSessionStore.getState().setSessionBoundUserId('user-123')
      useFreebuffSessionStore.getState().setSessionBoundUserId(null)

      expect(useFreebuffSessionStore.getState().sessionBoundUserId).toBeNull()
    })

    it('should overwrite previous binding', () => {
      useFreebuffSessionStore.getState().setSessionBoundUserId('user-123')
      useFreebuffSessionStore.getState().setSessionBoundUserId('user-456')

      expect(useFreebuffSessionStore.getState().sessionBoundUserId).toBe(
        'user-456',
      )
    })
  })

  describe('setSession', () => {
    it('should not affect sessionBoundUserId when setting session', () => {
      useFreebuffSessionStore.getState().setSessionBoundUserId('user-123')

      useFreebuffSessionStore.getState().setSession({
        status: 'active',
        instanceId: 'inst-1',
        model: 'test-model',
        expiresAt: Date.now() + 60_000,
        remainingMs: 60_000,
        accessTier: 'full',
      })

      expect(useFreebuffSessionStore.getState().sessionBoundUserId).toBe(
        'user-123',
      )
    })
  })
})
