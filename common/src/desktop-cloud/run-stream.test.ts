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

/** An SSE response that stays open until its fetch is aborted, as a held connection would. */
function heldStream(signal: AbortSignal, frames: string[], every?: { ms: number; chunk: string }) {
  let timer: ReturnType<typeof setInterval> | undefined
  return new Response(
    new ReadableStream({
      start(c) {
        for (const frame of frames) c.enqueue(new TextEncoder().encode(frame))
        if (every) timer = setInterval(() => c.enqueue(new TextEncoder().encode(every.chunk)), every.ms)
        signal.addEventListener('abort', () => {
          clearInterval(timer)
          c.error(new DOMException('aborted', 'AbortError'))
        }, { once: true })
      },
      cancel() { clearInterval(timer) },
    }),
    { headers: { 'content-type': 'text/event-stream', 'x-freebuff-stream-id': 'stream-1' } },
  )
}
const later = { ...page, events: [{ id: '9007199254740994', kind: 'chunk', payload: 'later' }] }

test('a stream that goes silent after its headers is abandoned for a poll, and reported', async () => {
  const stalls: unknown[] = []
  let polls = 0
  const reader = new CloudRunReader({
    signal: new AbortController().signal,
    idleMs: 300,
    onStall: (stall) => stalls.push(stall),
    open: async (_after, signal) => heldStream(signal, [`data: ${JSON.stringify(page)}\n\n`]),
    poll: async () => { polls++; return later },
  })
  expect(await reader.next('0')).toEqual(page)
  const started = Date.now()
  // Held: without the watchdog this waited for the 150 s request timeout.
  expect(await reader.next('9007199254740993')).toEqual(later)
  expect(Date.now() - started).toBeLessThan(2000)
  expect(polls).toBe(1)
  expect(stalls).toEqual([expect.objectContaining({ phase: 'stream', frames: 1, streamId: 'stream-1' })])
  expect(reader.streaming).toBe(false)
  await reader.close()
})

test('a stream whose headers never arrive is abandoned for a poll', async () => {
  const stalls: { phase: string }[] = []
  const reader = new CloudRunReader({
    signal: new AbortController().signal,
    idleMs: 300,
    onStall: (stall) => stalls.push(stall),
    open: (_after, signal) => new Promise<Response>((_, reject) =>
      signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })),
    poll: async () => page,
  })
  expect(await reader.next('0')).toEqual(page)
  expect(stalls.map((stall) => stall.phase)).toEqual(['open'])
  await reader.close()
})

test('keepalives keep a quiet stream attached', async () => {
  const stalls: unknown[] = []
  const reader = new CloudRunReader({
    signal: new AbortController().signal,
    idleMs: 300,
    onStall: (stall) => stalls.push(stall),
    open: async (_after, signal) => heldStream(signal, [], { ms: 100, chunk: ': keepalive\n\n' }),
    poll: async () => { throw new Error('unexpected poll') },
  })
  const next = reader.next('0')
  const outcome = await Promise.race([next.then(() => 'frame'), Bun.sleep(1200).then(() => 'still attached')])
  expect(outcome).toBe('still attached')
  expect(stalls).toEqual([])
  await reader.close()
  await next.catch(() => {})
})
