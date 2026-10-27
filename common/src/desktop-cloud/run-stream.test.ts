import { expect, test } from 'bun:test'
import {
  readCloudRunStream,
  CloudRunReader,
  CloudStreamHttpError,
} from './run-stream'

const page = {
  v: 1,
  status: 'running',
  error: null,
  events: [{ id: '9007199254740993', kind: 'chunk', payload: 'é' }],
}
function response(parts: string[]) {
  return new Response(
    new ReadableStream({
      start(c) {
        const bytes = new TextEncoder().encode(parts.join(''))
        for (const byte of bytes) c.enqueue(new Uint8Array([byte]))
        c.close()
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  )
}
test('SSE preserves split UTF-8 and bigint cursors and ignores keepalives', async () => {
  const items = []
  for await (const item of readCloudRunStream(
    response([': keepalive\r\n\r\n', `data: ${JSON.stringify(page)}\r\n\r\n`]),
  ))
    items.push(item)
  expect(items).toEqual([page])
})
test('transport failure falls back once, then waits before probing SSE again', async () => {
  let opens = 0,
    polls = 0
  const reader = new CloudRunReader({
    signal: new AbortController().signal,
    open: async () => {
      opens++
      return new Response('', { status: 503 })
    },
    poll: async () => {
      polls++
      return page
    },
  })
  await reader.next('0')
  await reader.next('9007199254740993')
  expect(opens).toBe(1)
  expect(polls).toBe(2)
  expect(reader.streaming).toBe(false)
  await reader.close()
})
test('authorization failures do not become polling requests', async () => {
  let polls = 0
  const reader = new CloudRunReader({
    signal: new AbortController().signal,
    open: async () => new Response('', { status: 403 }),
    poll: async () => {
      polls++
      return page
    },
  })
  await expect(reader.next('0')).rejects.toBeInstanceOf(CloudStreamHttpError)
  expect(polls).toBe(0)
})
test('healthy SSE sends no parallel polling request and is cancelled on close', async () => {
  let cancelled = false
  const reader = new CloudRunReader({
    signal: new AbortController().signal,
    open: async () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(
              new TextEncoder().encode(`data: ${JSON.stringify(page)}\n\n`),
            )
          },
          cancel() {
            cancelled = true
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      ),
    poll: async () => {
      throw new Error('unexpected poll')
    },
  })
  expect(await reader.next('0')).toEqual(page)
  expect(reader.delayMs).toBe(0)
  await reader.close()
  expect(cancelled).toBe(true)
})

test('stream loss clears provisional output before a fallback request can block', async () => {
  let cleared = false
  const reader = new CloudRunReader({
    signal: new AbortController().signal,
    open: async () =>
      response([
        `data: ${JSON.stringify({ ...page, events: [], preview: { base: '1', attempt: '1', parts: [{ kind: 'text', text: 'temporary' }] } })}\n\n`,
      ]),
    onDisconnect: () => {
      cleared = true
    },
    poll: async () => {
      expect(cleared).toBe(true)
      return page
    },
  })
  expect((await reader.next('1')).preview?.parts[0].text).toBe('temporary')
  expect(cleared).toBe(false)
  await reader.next('1')
  await reader.close()
})
