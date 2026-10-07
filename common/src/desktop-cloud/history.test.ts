import { expect, test } from 'bun:test'
import { createCloudHistoryClient, CloudHistoryError } from './history'

test('history client supports cookie auth, project filtering and abort signals', async () => {
  const controller = new AbortController()
  const client = createCloudHistoryClient({
    fetch: async (url, init) => {
      expect(url).toBe(
        '/api/v1/cloud/history/chats?cursor=next&limit=5&projectId=p',
      )
      expect(init?.credentials).toBe('same-origin')
      expect(init?.cache).toBe('no-store')
      expect(init?.signal).toBe(controller.signal)
      expect(init?.headers).toBeUndefined()
      return Response.json({ items: [], nextCursor: null })
    },
  })
  expect(
    await client.listChats({
      cursor: 'next',
      limit: 5,
      projectId: 'p',
      signal: controller.signal,
    }),
  ).toEqual({ items: [], nextCursor: null })
})
test('history client targets new Cloud and keeps transcript and trace endpoints separate', async () => {
  const urls: string[] = []
  const client = createCloudHistoryClient({
    baseUrl: 'https://api.example.test/api/v1/cloud/history/',
    getToken: async () => 'session',
    fetch: async (url, init) => {
      urls.push(url)
      expect(init?.headers).toEqual({ Authorization: 'Bearer session' })
      return Response.json({ items: [], nextCursor: null, endCursor: null })
    },
  })
  await client.listProjects()
  await client.getProject('p')
  await client.getChat('c')
  await client.getAttachment('c')
  await client.listRuns('c')
  await client.getRun('r')
  await client.listEvents('r', { cursor: 'opaque' })
  await client.listTraces('r')
  expect(urls.map((url) => url.split('/history/')[1])).toEqual([
    'projects',
    'projects/p',
    'chats/c',
    'chats/c/attachment',
    'chats/c/runs',
    'runs/r',
    'runs/r/events?cursor=opaque',
    'runs/r/traces',
  ])
})
test('history client encodes IDs and surfaces HTTP failures', async () => {
  const client = createCloudHistoryClient({
    fetch: async (url) => {
      expect(url).toBe('/api/v1/cloud/history/chats/a%2Fb')
      return Response.json({ error: 'Cloud chat not found' }, { status: 404 })
    },
  })
  try {
    await client.getChat('a/b')
    throw new Error('expected rejection')
  } catch (error) {
    expect(error).toBeInstanceOf(CloudHistoryError)
    expect((error as CloudHistoryError).status).toBe(404)
  }
})

test('history client updates shared metadata with explicit revision and bearer auth', async () => {
  const update = { expectedRevision: 3, title: 'Shared name', archived: false }
  const client = createCloudHistoryClient({
    getToken: () => 'token',
    fetch: async (url, init) => {
      expect(url).toBe('/api/v1/cloud/history/chats/chat')
      expect(init?.method).toBe('PATCH')
      expect(init?.headers).toEqual({
        'Content-Type': 'application/json',
        Authorization: 'Bearer token',
      })
      expect(JSON.parse(String(init?.body))).toEqual(update)
      return Response.json({
        id: 'chat',
        title: 'Shared name',
        metadataRevision: 4,
      })
    },
  })
  expect(await client.updateChat('chat', update)).toMatchObject({
    metadataRevision: 4,
  })
})
