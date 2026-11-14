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

/** Incremental SSE decoder: caps a frame, handles split UTF-8 and cancels on detach.
 * `onBytes` sees every chunk, keepalive comments included, so a reader can tell a quiet
 * stream from a dead one. */
export async function* readCloudRunStream(
  response: Response,
  onBytes?: (bytes: number) => void,
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
      onBytes?.(value.byteLength)
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

/** Response header naming one stream connection, logged by both the server and its reader. */
export const CLOUD_STREAM_ID_HEADER = 'x-freebuff-stream-id'
/**
 * A healthy stream sends bytes at least every 15 s: a frame, or a keepalive while the server
 * waits for its next Postgres reconcile (web/src/server/desktop-cloud/run-stream.ts). Silence for
 * twice that means something between the server and this reader holds or dropped the bytes.
 */
export const CLOUD_STREAM_IDLE_MS = 30_000

/** A connection the reader abandoned because it went silent. */
export type CloudStreamStall = {
  /** `open`: no response headers yet; `stream`: headers arrived, then the bytes stopped. */
  phase: 'open' | 'stream'
  silentMs: number
  connectedMs: number
  frames: number
  bytes: number
  streamId: string | null
}

/** A single transport per viewer: SSE first, bounded fallback, then a jittered probe. */
export class CloudRunReader {
  private iterator?: AsyncGenerator<CloudStreamPage>
  private connection?: AbortController
  private retryAt = 0
  private emptyPolls = 0
  private watchdog?: ReturnType<typeof setInterval>
  private openedAt = 0
  private lastByteAt = 0
  private frames = 0
  private bytes = 0
  private streamId: string | null = null
  streaming = false
  constructor(
    private options: {
      open: (after: string, signal: AbortSignal) => Promise<Response>
      poll: (after: string) => Promise<CloudStreamPage>
      signal: AbortSignal
      onDisconnect?: () => void
      /** Silence after which a connection is abandoned for polling (default CLOUD_STREAM_IDLE_MS). */
      idleMs?: number
      onStall?: (stall: CloudStreamStall) => void
    },
  ) {}

  /** Without this, a silent stream hid a running turn's output until the server's 120 s
   * connection cap or the 150 s request timeout, since its viewer stops polling meanwhile. */
  private watch() {
    this.unwatch()
    const idleMs = this.options.idleMs ?? CLOUD_STREAM_IDLE_MS
    this.openedAt = this.lastByteAt = Date.now()
    this.frames = this.bytes = 0
    this.streamId = null
    this.watchdog = setInterval(() => {
      const now = Date.now()
      if (!this.connection || now - this.lastByteAt < idleMs) return
      const stall: CloudStreamStall = {
        phase: this.iterator ? 'stream' : 'open',
        silentMs: now - this.lastByteAt,
        connectedMs: now - this.openedAt,
        frames: this.frames,
        bytes: this.bytes,
        streamId: this.streamId,
      }
      this.unwatch()
      this.connection.abort()
      try { this.options.onStall?.(stall) } catch { /* Diagnostics cannot alter the transport. */ }
    }, Math.max(250, Math.min(5000, idleMs / 6)))
    ;(this.watchdog as { unref?: () => void }).unref?.()
  }
  private unwatch() {
    clearInterval(this.watchdog)
    this.watchdog = undefined
  }

  async next(after: string): Promise<CloudStreamPage> {
    this.options.signal.throwIfAborted()
    if (!this.iterator && Date.now() >= this.retryAt) {
      this.connection = new AbortController()
      this.watch()
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
          this.unwatch()
          await response.body?.cancel()
          throw new CloudStreamHttpError(response.status)
        }
        if (
          response.ok &&
          response.headers.get('content-type')?.includes('text/event-stream')
        ) {
          this.lastByteAt = Date.now()
          this.streamId = response.headers.get(CLOUD_STREAM_ID_HEADER)
          this.iterator = readCloudRunStream(response, (bytes) => {
            this.lastByteAt = Date.now()
            this.bytes += bytes
          })
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
        if (!result.done) {
          this.frames++
          return result.value
        }
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
    this.unwatch()
    this.options.onDisconnect?.()
    this.streaming = false
    this.retryAt = Date.now() + 30_000 * (1 + Math.random() * 0.2)
  }
  async close() {
    this.unwatch()
    this.connection?.abort()
    await this.iterator?.return(undefined).catch(() => {})
    this.iterator = undefined
    this.streaming = false
  }
}
