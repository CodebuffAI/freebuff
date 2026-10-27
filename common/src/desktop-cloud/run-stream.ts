import { validCloudPreview, type CloudPreview } from './live-preview'
/** Wire contract shared by the server, native Desktop and hybrid Web UI. */
export type CloudStreamEvent = { id: string; kind: string; payload: unknown }
export type CloudStreamPage = {
  status: string
  error: string | null
  events: CloudStreamEvent[]
  questions?: unknown[]
  preview?: CloudPreview
}
export const CLOUD_RUN_STREAM_VERSION = 1
export const CLOUD_STREAM_MAX_FRAME_BYTES = 8 * 1024 * 1024

/** Incremental SSE decoder: caps a frame, handles split UTF-8 and cancels on detach. */
export async function* readCloudRunStream(
  response: Response,
): AsyncGenerator<CloudStreamPage> {
  if (
    !response.ok ||
    !response.body ||
    !response.headers.get('content-type')?.includes('text/event-stream')
  )
    throw new Error('Cloud stream unavailable')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer = (buffer + decoder.decode(value, { stream: true })).replace(
        /\r\n/g,
        '\n',
      )
      let boundary: number
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        if (frame.length > CLOUD_STREAM_MAX_FRAME_BYTES)
          throw new Error('Cloud stream frame too large')
        const data = frame
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n')
        if (!data) continue
        const item = JSON.parse(data)
        if (
          item.v !== CLOUD_RUN_STREAM_VERSION ||
          !Array.isArray(item.events) ||
          typeof item.status !== 'string'
        )
          throw new Error('Invalid Cloud stream frame')
        if (item.preview !== undefined && !validCloudPreview(item.preview))
          throw new Error('Invalid Cloud preview')
        for (const event of item.events) {
          if (
            !event ||
            typeof event.id !== 'string' ||
            !/^(0|[1-9][0-9]{0,18})$/.test(event.id) ||
            typeof event.kind !== 'string'
          )
            throw new Error('Invalid Cloud event')
        }
        yield item as CloudStreamPage
      }
      if (buffer.length > CLOUD_STREAM_MAX_FRAME_BYTES)
        throw new Error('Cloud stream frame too large')
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

export class CloudStreamHttpError extends Error {
  constructor(readonly status: number) {
    super(`Cloud stream request failed (${status})`)
  }
}

/** A single transport per viewer: SSE first, bounded fallback, then a jittered probe. */
export class CloudRunReader {
  private iterator?: AsyncGenerator<CloudStreamPage>
  private connection?: AbortController
  private retryAt = 0
  private emptyPolls = 0
  streaming = false
  constructor(
    private options: {
      open: (after: string, signal: AbortSignal) => Promise<Response>
      poll: (after: string) => Promise<CloudStreamPage>
      signal: AbortSignal
      onDisconnect?: () => void
    },
  ) {}

  async next(after: string): Promise<CloudStreamPage> {
    this.options.signal.throwIfAborted()
    if (!this.iterator && Date.now() >= this.retryAt) {
      this.connection = new AbortController()
      try {
        const response = await this.options.open(
          after,
          AbortSignal.any([
            this.options.signal,
            this.connection.signal,
            AbortSignal.timeout(150_000),
          ]),
        )
        if ([401, 403].includes(response.status)) {
          await response.body?.cancel()
          throw new CloudStreamHttpError(response.status)
        }
        if (
          response.ok &&
          response.headers.get('content-type')?.includes('text/event-stream')
        ) {
          this.iterator = readCloudRunStream(response)
          this.streaming = true
        } else {
          await response.body?.cancel()
          this.cooldown()
        }
      } catch (error) {
        if (error instanceof CloudStreamHttpError) throw error
        this.options.signal.throwIfAborted()
        this.cooldown()
      }
    }
    if (this.iterator) {
      try {
        const result = await this.iterator.next()
        if (!result.done) return result.value
      } catch {
        this.options.signal.throwIfAborted()
      }
      await this.close()
      this.cooldown()
    }
    const page = await this.options.poll(after)
    this.emptyPolls = page.events.length ? 0 : Math.min(3, this.emptyPolls + 1)
    return page
  }
  get delayMs() {
    if (this.streaming) return 0
    return (
      Math.min(5000, 1000 * 2 ** this.emptyPolls) * (1 + Math.random() * 0.2)
    )
  }
  private cooldown() {
    this.options.onDisconnect?.()
    this.streaming = false
    this.retryAt = Date.now() + 30_000 * (1 + Math.random() * 0.2)
  }
  async close() {
    this.connection?.abort()
    await this.iterator?.return(undefined).catch(() => {})
    this.iterator = undefined
    this.streaming = false
  }
}
