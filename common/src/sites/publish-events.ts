/**
 * The Publish button's progress stream, shared by Desktop, Cloud and Web. Kept
 * apart from `publish.ts` (Node only) so renderers can import it.
 */
export type SitePublishStage = 'building' | 'deploying' | 'publishing'
/**
 * Why a publish failed, for analytics only (`failure_code` on `publish:failed`):
 * stable and closed, never the message. Older servers send none (`unknown`).
 */
export const SITE_PUBLISH_FAILURE_CODES = [
  /** The project is not one Publish supports, or its configuration is refused before deploying. */
  'precheck_failed',
  /** Installing dependencies or the build script failed, or produced no deployment. */
  'build_failed',
  /** The build hit its 15-minute limit, or the deployment did not settle in time. */
  'timeout',
  /** A Sites request was refused (create, inspect, storage, publication). */
  'deploy_rejected',
  /** Cloudflare rejected the uploaded deployment. */
  'cloudflare_rejected',
  /** Cloudflare could not start the built Worker (startup validation, 10021). */
  'cloudflare_startup_failed',
  /** Cloudflare rate limited the deployment (429). */
  'cloudflare_rate_limited',
  /** Cloudflare's outcome was not confirmed, or the request was interrupted. */
  'cloudflare_unconfirmed',
  /** Another chat of the project deployed there: the user is asked to replace it. */
  'other_chat_deploy',
  /** The Cloud chat's workspace could not be opened or used. */
  'workspace_unavailable',
  /** The browser could not reach Freebuff. */
  'network',
  /** The publish request was refused before it started (already publishing, invalid). */
  'refused',
  /** The stream ended without a result. */
  'stopped',
  /** The chat has no workspace yet (no first message). */
  'not_started',
  /** A Desktop too old to publish chats running on this computer. */
  'desktop_outdated',
  'unknown',
] as const
export type SitePublishFailureCode = (typeof SITE_PUBLISH_FAILURE_CODES)[number]
const FAILURE_CODES = new Set<string>(SITE_PUBLISH_FAILURE_CODES)
export type SitePublishResult =
  | {
      type: 'done'
      siteId: string
      environment: 'preview' | 'production'
      url: string
    }
  | {
      type: 'error'
      message: string
      /** Analytics only; absent from older servers and Desktops. */
      code?: SitePublishFailureCode
      /**
       * The environment was last deployed from another chat of the project:
       * publishing again with `replaceChatId: chatId` replaces it.
       */
      replace?: SitePublishReplace
    }
export type SitePublishReplace = { chatId: string; chatTitle: string; url: string }
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
  code: 'stopped',
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
          write({
            type: 'error',
            code: 'unknown',
            message: 'Publishing failed. Try again.',
          }),
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
    if (value.type === 'error' && typeof value.message === 'string') {
      const replace = value.replace
      return {
        type: 'error',
        message: value.message.slice(0, 4096),
        ...(typeof value.code === 'string' && FAILURE_CODES.has(value.code)
          ? { code: value.code }
          : {}),
        ...(replace &&
        typeof replace.chatId === 'string' &&
        typeof replace.chatTitle === 'string' &&
        typeof replace.url === 'string'
          ? {
              replace: {
                chatId: replace.chatId.slice(0, 160),
                chatTitle: replace.chatTitle.slice(0, 200),
                url: replace.url.slice(0, 2048),
              },
            }
          : {}),
      }
    }
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
    return { type: 'error', code: 'refused', message }
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
