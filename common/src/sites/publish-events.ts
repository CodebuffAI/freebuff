/**
 * The Publish button's progress stream, shared by Desktop, Cloud and Web. Kept
 * apart from `publish.ts` (Node only) so renderers can import it.
 */
export type SitePublishStage = 'building' | 'deploying' | 'publishing'
export type SitePublishResult =
  | {
      type: 'done'
      siteId: string
      environment: 'preview' | 'production'
      url: string
    }
  | { type: 'error'; message: string }
export type SitePublishEvent =
  | { type: 'stage'; stage: SitePublishStage }
  | SitePublishResult
  /** Keeps proxies from closing an idle stream during a long build. */
  | { type: 'heartbeat' }

export const SITE_PUBLISH_STAGE_LABELS: Record<SitePublishStage, string> = {
  building: 'Building…',
  deploying: 'Deploying…',
  publishing: 'Publishing…',
}

export const SITE_PUBLISH_HEARTBEAT_MS = 15_000
const STOPPED: SitePublishResult = {
  type: 'error',
  message:
    'Publishing stopped before it finished. Check deployment activity in Manage site, then try again.',
}

/** One NDJSON line per event; the stream ends after `done` or `error`. */
export function sitePublishResponse(
  run: (
    onEvent: (event: SitePublishEvent) => void,
    signal: AbortSignal,
  ) => Promise<unknown>,
  signal: AbortSignal,
): Response {
  const encoder = new TextEncoder()
  const cancelled = new AbortController()
  const stop = AbortSignal.any([signal, cancelled.signal])
  const stream = new ReadableStream<Uint8Array>({
    start(sink) {
      let open = true
      const write = (event: SitePublishEvent) => {
        if (!open) return
        try {
          sink.enqueue(encoder.encode(JSON.stringify(event) + '\n'))
        } catch {
          open = false
        }
      }
      const beat = setInterval(
        () => write({ type: 'heartbeat' }),
        SITE_PUBLISH_HEARTBEAT_MS,
      )
      void run(write, stop)
        .catch(() =>
          write({ type: 'error', message: 'Publishing failed. Try again.' }),
        )
        .finally(() => {
          clearInterval(beat)
          if (!open) return
          open = false
          try {
            sink.close()
          } catch {
            /* Already cancelled. */
          }
        })
    },
    cancel() {
      cancelled.abort()
    },
  })
  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson',
      'Cache-Control': 'private, no-store',
      'X-Accel-Buffering': 'no',
    },
  })
}

function parseEvent(line: string): SitePublishEvent | null {
  try {
    const value = JSON.parse(line) as SitePublishEvent
    if (value.type === 'stage' && value.stage in SITE_PUBLISH_STAGE_LABELS)
      return value
    if (
      value.type === 'done' &&
      typeof value.siteId === 'string' &&
      typeof value.url === 'string' &&
      ['preview', 'production'].includes(value.environment)
    )
      return value
    if (value.type === 'error' && typeof value.message === 'string')
      return { type: 'error', message: value.message.slice(0, 4096) }
    if (value.type === 'heartbeat') return value
  } catch {
    /* A partial or foreign line is not an event. */
  }
  return null
}

/** Reads a publish stream to its result; a refused request is an error result. */
export async function readSitePublishStream(
  response: Response,
  onEvent: (event: SitePublishEvent) => void = () => {},
): Promise<SitePublishResult> {
  if (
    !response.ok ||
    !response.body ||
    !response.headers.get('content-type')?.includes('application/x-ndjson')
  ) {
    const body = (await response.json().catch(() => null)) as {
      error?: unknown
      message?: unknown
    } | null
    const message =
      typeof body?.message === 'string'
        ? body.message
        : typeof body?.error === 'string'
          ? body.error
          : 'Could not start publishing.'
    return { type: 'error', message }
  }
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ''
  let result: SitePublishResult | null = null
  try {
    while (!result) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += value
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const event = line.trim() ? parseEvent(line) : null
        if (!event) continue
        onEvent(event)
        if (event.type === 'done' || event.type === 'error') {
          result = event
          break
        }
      }
    }
  } catch {
    return STOPPED
  } finally {
    reader.cancel().catch(() => {})
  }
  return result ?? STOPPED
}
