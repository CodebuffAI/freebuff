import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'

import { getCurrentChatId } from '../../project-files'
import { useChatStore } from '../../state/chat-store'
import { useFreebuffSessionStore } from '../../state/freebuff-session-store'
import * as auth from '../../utils/auth'
import { IS_FREEBUFF } from '../../utils/constants'
import { getUserMessage } from '../../utils/message-history'
import { returnToFreebuffLanding } from '../use-freebuff-session'

// Exercise the command's real transition in Freebuff mode:
// FREEBUFF_MODE=true bun test src/hooks/__tests__/end-freebuff-session.test.ts
// The React poll controller is absent; the transition still owns release/reset.
describe.skipIf(!IS_FREEBUFF)('end-session transition', () => {
  let authSpy: ReturnType<typeof spyOn>
  let fetchSpy: ReturnType<typeof spyOn>
  const session = {
    status: 'active' as const,
    accessTier: 'full' as const,
    instanceId: 'held-cli',
    model: 'mimo/mimo-v2.5',
    admittedAt: '2099-09-07T12:00:00Z',
    expiresAt: '2099-09-07T13:00:00Z',
    remainingMs: 300000,
  }
  beforeEach(() => {
    authSpy = spyOn(auth, 'getAuthTokenDetails').mockReturnValue({
      token: 'test-token',
      source: 'environment',
    })
    fetchSpy = spyOn(globalThis, 'fetch').mockRejectedValue(
      new Error('offline'),
    )
    useFreebuffSessionStore.getState().setSession(session)
    useChatStore.getState().setMessages([getUserMessage('Keep my work')])
  })
  afterEach(() => {
    authSpy.mockRestore()
    fetchSpy.mockRestore()
    useFreebuffSessionStore.getState().setSession(null)
    useFreebuffSessionStore.getState().setFailure(null)
    useChatStore.getState().reset()
  })

  test('failed end preserves history and identity, explains retry, then resets on confirmation', async () => {
    const original = useChatStore.getState().messages[0]
    const originalChatId = getCurrentChatId()
    await expect(returnToFreebuffLanding({ resetChat: true })).rejects.toThrow(
      'offline',
    )
    expect(useChatStore.getState().messages[0]).toEqual(original)
    expect(getCurrentChatId()).toBe(originalChatId)
    expect(JSON.stringify(useChatStore.getState().messages)).toContain(
      'Retry /end-session',
    )
    expect(useFreebuffSessionStore.getState().session).toEqual(session)
    fetchSpy.mockResolvedValue(
      Response.json({ status: 'ended', freebucksRefund: 4 }),
    )
    // Keep the ids from colliding: they are millisecond timestamps.
    await new Promise((resolve) => setTimeout(resolve, 2))
    await returnToFreebuffLanding({ resetChat: true })
    expect(useChatStore.getState().messages).toHaveLength(0)
    // The next session saves to a new chat, so the ended one stays in /history.
    expect(getCurrentChatId()).not.toBe(originalChatId)
    expect(useFreebuffSessionStore.getState().lastRefund).toBe(4)
    for (const [, init] of fetchSpy.mock.calls) {
      expect(new Headers(init.headers).get('x-freebuff-instance-id')).toBe(
        'held-cli',
      )
    }
  })

  test('an old end cannot reset a replacement chat', async () => {
    let respond!: (response: Response) => void
    fetchSpy.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          respond = resolve
        }),
    )
    const replacementChatId = getCurrentChatId()
    const ending = returnToFreebuffLanding({ resetChat: true })
    useFreebuffSessionStore
      .getState()
      .setSession({ ...session, instanceId: 'new-cli' })
    const replacement = getUserMessage('New work')
    useChatStore.getState().setMessages([replacement])
    respond(Response.json({ status: 'ended', freebucksRefund: 4 }))
    await ending
    expect(useChatStore.getState().messages).toEqual([replacement])
    expect(getCurrentChatId()).toBe(replacementChatId)
    expect(useFreebuffSessionStore.getState().lastRefund).toBeNull()
  })
})
