/**
 * COD-764 client-compat check: web/src/app/api/v1/chat/completions/
 * sse-compression.ts can gzip/br-compress the SSE body, flushing after every
 * event so a compressed chunk is independently decodable as soon as it's
 * sent. This file proves the OTHER half of that contract — that the client
 * stack users actually run (the AI SDK's OpenAI-compatible provider, backed
 * by the runtime's own `fetch`, exactly as `model-provider.ts` wires it when
 * no custom `fetch` is supplied) decodes a `Content-Encoding: gzip` SSE
 * response INCREMENTALLY, not by buffering the whole body until the
 * connection closes.
 *
 * It serves real gzip bytes over a real loopback TCP connection — through
 * Node's zlib with the same per-chunk `Z_SYNC_FLUSH` the server-side
 * compressor uses — and asserts that text deltas arrive spread out over
 * time, matching the server's artificial per-chunk delay, rather than all
 * at once right after the final chunk. A client that buffered until the end
 * would report every delta within a few ms of the stream closing; this test
 * fails that way if it fails.
 */
import http from 'node:http'
import { constants as zlibConstants, createGzip } from 'node:zlib'

// The vendored fork, which is what model-provider.ts actually builds the
// backend model from — testing against the npm @ai-sdk/openai-compatible
// would prove nothing about the client users are running. No `fetch` option
// is supplied below, so the AI SDK falls back to the runtime's own global
// `fetch` — the same fallback model-provider.ts relies on.
import { OpenAICompatibleChatLanguageModel } from '@codebuff/llm-providers/openai-compatible'
import { streamText } from 'ai'
import { describe, expect, it } from 'bun:test'

const CHUNK_DELAY_MS = 120

const contentChunk = (content: string, first: boolean) =>
  `data: ${JSON.stringify({
    choices: [
      {
        index: 0,
        delta: first ? { role: 'assistant', content } : { content },
        finish_reason: null,
      },
    ],
  })}\n\n`

const finalChunk = () =>
  `data: ${JSON.stringify({
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
  })}\n\n`

/**
 * Serves a gzip-compressed SSE stream, one upstream "provider" chunk at a
 * time, with a real delay and an explicit sync flush between each — the
 * same shape sse-compression.ts produces for a real completions request.
 */
async function serveGzipSse(events: string[], delayMs: number) {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Content-Encoding': 'gzip',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })
    const gzip = createGzip()
    gzip.on('data', (chunk: Buffer) => res.write(chunk))
    gzip.on('end', () => res.end())
    gzip.on('error', () => res.destroy());

    (async () => {
      // The same preamble sse-compression.ts sends: the gzip header plus an
      // empty sync-flush block, before any event. Bun 1.3's fetch withholds
      // what it decodes from the first socket read until a second arrives;
      // without this, the first two deltas land together.
      await new Promise<void>((resolve) =>
        gzip.flush(zlibConstants.Z_SYNC_FLUSH, () => resolve()),
      )
      await new Promise((resolve) => setTimeout(resolve, delayMs))
      for (const event of events) {
        gzip.write(event)
        await new Promise<void>((resolve) =>
          gzip.flush(zlibConstants.Z_SYNC_FLUSH, () => resolve()),
        )
        await new Promise((resolve) => setTimeout(resolve, delayMs))
      }
      gzip.end()
    })()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, port: (server.address() as { port: number }).port }
}

describe('gzip-compressed SSE decodes incrementally through the AI SDK client stack', () => {
  it('delivers text deltas spread out over time, not bunched at stream end', async () => {
    const pieces = ['Hello', ', ', 'streamed ', 'world!']
    const events = [
      ...pieces.map((piece, i) => contentChunk(piece, i === 0)),
      finalChunk(),
      'data: [DONE]\n\n',
    ]

    const { server, port } = await serveGzipSse(events, CHUNK_DELAY_MS)
    try {
      const result = streamText({
        model: new OpenAICompatibleChatLanguageModel('m', {
          provider: 'codebuff',
          url: () => `http://127.0.0.1:${port}/chat/completions`,
          headers: () => ({}),
        }),
        messages: [{ role: 'user', content: 'hi' }],
        maxRetries: 0,
      })

      const start = performance.now()
      const arrivals: { text: string; atMs: number }[] = []
      for await (const part of result.stream) {
        if (part.type === 'error') throw (part as { error: unknown }).error
        if (part.type === 'text-delta') {
          arrivals.push({
            text: (part as { text: string }).text,
            atMs: performance.now() - start,
          })
        }
      }

      // Round-trip correctness: gzip didn't corrupt or merge/drop deltas.
      expect(arrivals.map((a) => a.text).join('')).toBe(pieces.join(''))
      expect(arrivals.length).toBe(pieces.length)

      // Incrementality: if the client (or an intermediate gzip layer) had
      // buffered the whole response, every delta would land within a few ms
      // of each other, right after the connection closed. With a true
      // per-chunk flush all the way through, consecutive deltas are spaced
      // close to the server's artificial delay. Allow generous slack for CI
      // jitter — this only needs to rule out "all at once".
      const gaps = arrivals.slice(1).map((a, i) => a.atMs - arrivals[i]!.atMs)
      const minGap = Math.min(...gaps)
      expect(minGap).toBeGreaterThan(CHUNK_DELAY_MS * 0.4)

      // And the first delta must not already be most of the way through the
      // whole stream's duration — i.e. it arrived near the start, not the end.
      const totalSpan = arrivals[arrivals.length - 1]!.atMs
      expect(arrivals[0]!.atMs).toBeLessThan(totalSpan * 0.5)
    } finally {
      server.close()
    }
  })
})
