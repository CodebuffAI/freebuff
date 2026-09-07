import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'

import * as auth from '../utils/auth'
import { useFreebuffSessionStore } from './freebuff-session-store'

const activeSession = {
  status: 'active' as const,
  accessTier: 'full' as const,
  model: 'mimo/mimo-v2.5',
  instanceId: 'held-cli',
  admittedAt: '2099-09-07T12:00:00Z',
  expiresAt: '2099-09-07T13:00:00Z',
  remainingMs: 300000,
}
let fetchSpy: ReturnType<typeof spyOn>
let authSpy: ReturnType<typeof spyOn>

beforeEach(() => {
  authSpy = spyOn(auth, 'getAuthTokenDetails').mockReturnValue({
    token: 'test-token',
    source: 'environment',
  })
  fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async () =>
    Response.json({
      status: 'ended',
      freebucksRefund: 4,
    })) as unknown as typeof fetch)
  useFreebuffSessionStore.getState().setSession(activeSession)
})
afterEach(() => {
  fetchSpy.mockRestore()
  authSpy.mockRestore()
  useFreebuffSessionStore.getState().setSession(null)
})

test('release owns the refund receipt and sends the held instance', async () => {
  await useFreebuffSessionStore.getState().releaseSlot()
  expect(useFreebuffSessionStore.getState().lastRefund).toBe(4)
  const [, init] = fetchSpy.mock.calls[0]!
  expect(init.method).toBe('DELETE')
  expect(new Headers(init.headers).get('x-freebuff-instance-id')).toBe(
    'held-cli',
  )
  useFreebuffSessionStore.getState().setSession({ status: 'none' })
  expect(useFreebuffSessionStore.getState().lastRefund).toBe(4)
  useFreebuffSessionStore.getState().setSession(activeSession)
  expect(useFreebuffSessionStore.getState().lastRefund).toBeNull()
  await useFreebuffSessionStore.getState().releaseSlot()
  useFreebuffSessionStore.getState().setSession(null)
  expect(useFreebuffSessionStore.getState().lastRefund).toBeNull()
})

test('failed release is retryable and never invents a receipt', async () => {
  fetchSpy.mockRejectedValue(new Error('offline'))
  await expect(
    useFreebuffSessionStore.getState().releaseSlot(),
  ).rejects.toThrow('offline')
  expect(useFreebuffSessionStore.getState().failure?.outcomeUnknown).toBe(true)
  expect(useFreebuffSessionStore.getState().session).toEqual(activeSession)
  expect(useFreebuffSessionStore.getState().lastRefund).toBeNull()
})

test('release does nothing without a held slot or authentication', async () => {
  authSpy.mockReturnValue({ source: null })
  await expect(
    useFreebuffSessionStore.getState().releaseSlot(),
  ).rejects.toThrow('authentication')
  authSpy.mockReturnValue({ token: 'test-token', source: 'environment' })
  useFreebuffSessionStore.getState().setSession({ status: 'none' })
  await useFreebuffSessionStore.getState().releaseSlot()
  expect(fetchSpy).not.toHaveBeenCalled()
})

for (const transition of ['replacement', 'logout', 'auth-change'] as const) {
  test(`late release cannot publish a receipt after ${transition}`, async () => {
    let respond!: (response: Response) => void
    fetchSpy.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          respond = resolve
        }),
    )
    const release = useFreebuffSessionStore.getState().releaseSlot()
    if (transition === 'replacement')
      useFreebuffSessionStore
        .getState()
        .setSession({ ...activeSession, instanceId: 'new-cli' })
    if (transition === 'logout')
      useFreebuffSessionStore.getState().setSession(null)
    if (transition === 'auth-change')
      authSpy.mockReturnValue({
        token: 'different-user',
        source: 'environment',
      })
    respond(Response.json({ status: 'ended', freebucksRefund: 4 }))
    await release
    expect(useFreebuffSessionStore.getState().lastRefund).toBeNull()
  })
}

test('exit and explicit end share one pending request; failure permits retry', async () => {
  let reject!: (error: Error) => void
  fetchSpy.mockImplementation(
    () =>
      new Promise<Response>((_, fail) => {
        reject = fail
      }),
  )
  const first = useFreebuffSessionStore.getState().releaseSlot()
  const second = useFreebuffSessionStore.getState().releaseSlot()
  expect(first).toBe(second)
  expect(fetchSpy).toHaveBeenCalledTimes(1)
  reject(new Error('response lost'))
  await expect(first).rejects.toThrow('response lost')
  fetchSpy.mockResolvedValue(
    Response.json({ status: 'ended', freebucksRefund: 4 }),
  )
  await useFreebuffSessionStore.getState().releaseSlot()
  expect(fetchSpy).toHaveBeenCalledTimes(2)
  expect(useFreebuffSessionStore.getState().lastRefund).toBe(4)
})

test.each(['none', 'banned', 'country_blocked'])(
  'a %s response does not confirm an end',
  async (status) => {
    fetchSpy.mockResolvedValue(Response.json({ status }))
    await expect(
      useFreebuffSessionStore.getState().releaseSlot(),
    ).rejects.toThrow('did not confirm')
    expect(useFreebuffSessionStore.getState().session).toEqual(activeSession)
    expect(useFreebuffSessionStore.getState().lastRefund).toBeNull()
  },
)

test('a poll refreshing the same instance does not discard its refund receipt', async () => {
  let respond!: (response: Response) => void
  fetchSpy.mockImplementation(
    () =>
      new Promise<Response>((resolve) => {
        respond = resolve
      }),
  )
  const release = useFreebuffSessionStore.getState().releaseSlot()
  useFreebuffSessionStore
    .getState()
    .setSession({ ...activeSession, remainingMs: 299000 })
  respond(Response.json({ status: 'ended', freebucksRefund: 4 }))
  await release
  expect(useFreebuffSessionStore.getState().lastRefund).toBe(4)
})

test('a pending end releases the chat and later recovers its final receipt', async () => {
  fetchSpy.mockResolvedValue(
    Response.json({ status: 'ended', freebucksRefundPending: true }),
  )
  await useFreebuffSessionStore.getState().releaseSlot()
  expect(useFreebuffSessionStore.getState().lastRefund).toBeNull()
  expect(useFreebuffSessionStore.getState().pendingRefund?.instanceId).toBe(
    'held-cli',
  )
  useFreebuffSessionStore.getState().setSession({ status: 'none' })
  fetchSpy.mockResolvedValue(
    Response.json({ status: 'ended', freebucksRefund: 1 }),
  )
  await useFreebuffSessionStore.getState().refreshRefund()
  expect(useFreebuffSessionStore.getState().lastRefund).toBe(1)
  expect(useFreebuffSessionStore.getState().pendingRefund).toBeNull()
  expect(
    new Headers(fetchSpy.mock.calls[1]![1].headers).get(
      'x-freebuff-instance-id',
    ),
  ).toBe('held-cli')
})

test('a receipt poll cannot publish into a replacement session', async () => {
  fetchSpy.mockResolvedValue(
    Response.json({ status: 'ended', freebucksRefundPending: true }),
  )
  await useFreebuffSessionStore.getState().releaseSlot()
  let respond!: (response: Response) => void
  fetchSpy.mockImplementation(
    () =>
      new Promise<Response>((resolve) => {
        respond = resolve
      }),
  )
  const poll = useFreebuffSessionStore.getState().refreshRefund()
  useFreebuffSessionStore
    .getState()
    .setSession({ ...activeSession, instanceId: 'replacement' })
  respond(Response.json({ status: 'ended', freebucksRefund: 1 }))
  await poll
  expect(useFreebuffSessionStore.getState().lastRefund).toBeNull()
})
