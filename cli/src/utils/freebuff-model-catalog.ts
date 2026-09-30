/**
 * Fetching and keeping the server model catalog (docs/freebuff-model-catalog.md).
 *
 * The CLI asks `GET /api/v1/freebuff/models` for its rows on start, again at
 * the catalog's `refreshAt`, whenever the session reports a different access
 * tier or plan, and once after the server answers `freebuff_catalog_stale`.
 * A valid answer puts the process in catalog mode; anything else keeps (or
 * returns) it in fallback mode, the compiled catalog with plain ids, silently.
 *
 * Two kinds of failure, deliberately treated differently:
 *
 * - `unsupported`: the server answered and it is not a catalog (404 on an
 *   older server, an unparseable body). That is the server's answer, so a held
 *   catalog is dropped and fallback mode resumes.
 * - `error`: no usable answer (network, timeout, 5xx, 429). Says nothing about
 *   the catalog, so a held one is KEPT — its handles outlive `refreshAt` by a
 *   grace period precisely so a failed refresh is not a race — and the fetch
 *   is retried with backoff.
 *
 * Nothing here is persisted: the catalog carries per-account handles.
 */
import { FREEBUFF_CLIENT_HEADER } from '@codebuff/common/constants/freebuff-desktop-sessions'
import {
  DEFAULT_FREEBUFF_MODEL_ID,
  resolveAvailableFreebuffModel,
} from '@codebuff/common/constants/freebuff-models'
import {
  FREEBUFF_CATALOG_PROTOCOL_HEADER,
  FREEBUFF_CATALOG_PROTOCOL_VERSION,
  FREEBUFF_CATALOG_STALE_ERROR,
  FREEBUFF_MODEL_CATALOG_PATH,
  parseFreebuffModelCatalog,
} from '@codebuff/common/types/freebuff-model-catalog'
import {
  getFreebuffServerAccessTier,
  getSubscriptionInfo,
} from '@codebuff/common/types/freebuff-session'
import { sanitizeTerminalStrings } from '@codebuff/common/util/terminal-safe-text'

import {
  getFreebuffCatalog,
  getFreebuffModelDirectory,
  setFreebuffCatalog,
  useFreebuffCatalogStore,
} from '../state/freebuff-catalog-store'
import { useFreebuffChatStore } from '../state/freebuff-chat-store'
import { useFreebuffModelStore } from '../state/freebuff-model-store'
import { freebuffApiBaseUrl } from './freebuff-session-api'
import { logger } from './logger'
import {
  loadFreebuffModelKeyPreference,
  loadFreebuffModelPreference,
} from './settings'

import type { FreebuffModelCatalog } from '@codebuff/common/types/freebuff-model-catalog'

/** Sent as `x-freebuff-client` so the server lists the CLI's rows. */
export const FREEBUFF_CATALOG_CLIENT_CLI = 'cli'

const CATALOG_FETCH_TIMEOUT_MS = 10_000
/** How long the first session request waits for the first catalog. Past it,
 *  the session starts in fallback mode and a late catalog switches over. */
export const FREEBUFF_CATALOG_INITIAL_WAIT_MS = 4_000
/** Floor and ceiling on the `refreshAt` schedule: a catalog asking to be
 *  refetched in 2s (clock skew) must not become a tight loop, and one asking
 *  for next week must not outlive a timer. */
const MIN_REFRESH_DELAY_MS = 30_000
const MAX_REFRESH_DELAY_MS = 6 * 60 * 60_000
const RETRY_BASE_DELAY_MS = 60_000
const RETRY_MAX_DELAY_MS = 30 * 60_000
/** A second stale answer this soon after a refetch means the fresh handle is
 *  stale too; refetching again would only loop. */
const STALE_REFRESH_COOLDOWN_MS = 5_000

export type FreebuffCatalogFetchResult =
  | { kind: 'ok'; catalog: FreebuffModelCatalog }
  | { kind: 'unsupported'; status?: number }
  | { kind: 'error'; status?: number; message?: string }

export async function fetchFreebuffModelCatalog(
  token: string,
  opts: {
    fetchImpl?: typeof fetch
    baseUrl?: string
    signal?: AbortSignal
    timeoutMs?: number
  } = {},
): Promise<FreebuffCatalogFetchResult> {
  const {
    fetchImpl = fetch,
    baseUrl = freebuffApiBaseUrl(),
    timeoutMs = CATALOG_FETCH_TIMEOUT_MS,
  } = opts
  const timeout = AbortSignal.timeout(timeoutMs)
  let response: Response
  try {
    response = await fetchImpl(`${baseUrl}${FREEBUFF_MODEL_CATALOG_PATH}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        [FREEBUFF_CATALOG_PROTOCOL_HEADER]: FREEBUFF_CATALOG_PROTOCOL_VERSION,
        [FREEBUFF_CLIENT_HEADER]: FREEBUFF_CATALOG_CLIENT_CLI,
      },
      signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout,
    })
  } catch (error) {
    return {
      kind: 'error',
      message: error instanceof Error ? error.message : String(error),
    }
  }
  if (
    response.status === 408 ||
    response.status === 429 ||
    response.status >= 500
  ) {
    return { kind: 'error', status: response.status }
  }
  if (!response.ok) return { kind: 'unsupported', status: response.status }
  const body = await response.json().catch(() => undefined)
  // Every string in a row is drawn in the terminal, so escape sequences are
  // stripped before anything reads it — the same rule as session responses.
  const catalog = parseFreebuffModelCatalog(sanitizeTerminalStrings(body))
  // A catalog with no rows leaves the picker nothing to draw; the compiled
  // one is the better answer, and the server refuses what it must anyway.
  return catalog && catalog.rows.length > 0
    ? { kind: 'ok', catalog }
    : { kind: 'unsupported', status: response.status }
}

/**
 * Whether an error (a session request failure, a thrown SDK error, or an
 * agent run's error output) is the server saying the handle we sent is stale.
 * The code can sit on several fields depending on which layer surfaced it, so
 * every string field that might carry it is checked.
 */
export function isFreebuffCatalogStaleError(error: unknown): boolean {
  const seen = new Set<unknown>()
  const visit = (value: unknown, depth: number): boolean => {
    if (typeof value === 'string')
      return value.includes(FREEBUFF_CATALOG_STALE_ERROR)
    if (!value || typeof value !== 'object' || depth > 3 || seen.has(value))
      return false
    seen.add(value)
    const record = value as Record<string, unknown>
    return [
      'error',
      'errorCode',
      'code',
      'message',
      'responseBody',
      'body',
      'data',
      'cause',
    ].some((field) => visit(record[field], depth + 1))
  }
  return visit(error, 0)
}

// --- Applying a catalog ------------------------------------------------------

/**
 * Hold `next` (null: back to fallback mode) and move every in-memory model
 * selection onto something that mode understands.
 *
 * Entering catalog mode (or losing the selected row): the saved row key wins,
 * because a compiled pick clears it and so it is only present when it is the
 * newest pick; then the selection's own row (a compiled id mapped through its
 * legacy digest); then the catalog's recommendation. Leaving catalog mode: a
 * key means nothing to the compiled catalog, so the selection reloads from
 * the saved compiled pick, exactly as a fresh launch would.
 *
 * Nothing is persisted here. A migration from a legacy id is recomputed on
 * every catalog, and the session response re-keys itself on the next poll.
 */
export function applyFreebuffCatalog(next: FreebuffModelCatalog | null): void {
  const previous = getFreebuffCatalog()
  if (previous === next) return
  setFreebuffCatalog(next)
  const directory = getFreebuffModelDirectory()
  const modelStore = useFreebuffModelStore.getState()
  const chatStore = useFreebuffChatStore.getState()

  if (next) {
    const selected = modelStore.selectedModel
    if (directory.row(selected)?.key !== selected) {
      const savedKey = loadFreebuffModelKeyPreference()
      modelStore.setSelectedModel(
        savedKey && directory.row(savedKey)?.key === savedKey
          ? savedKey
          : (directory.row(selected)?.key ??
              directory.recommendedModelId('full')),
      )
    }
    if (chatStore.nextModel !== null) {
      const nextKey = directory.row(chatStore.nextModel)?.key ?? null
      if (nextKey !== chatStore.nextModel)
        useFreebuffChatStore.setState({ nextModel: nextKey })
    }
    return
  }

  if (previous) {
    modelStore.setSelectedModel(
      resolveAvailableFreebuffModel(
        loadFreebuffModelPreference() ?? DEFAULT_FREEBUFF_MODEL_ID,
      ),
    )
    // An unsent pick of a catalog row has no compiled meaning.
    if (chatStore.nextModel !== null)
      useFreebuffChatStore.setState({ nextModel: null })
  }
}

// --- The refresh controller --------------------------------------------------

export interface FreebuffCatalogControllerDeps {
  fetchCatalog: (
    token: string,
    signal: AbortSignal,
  ) => Promise<FreebuffCatalogFetchResult>
  applyCatalog: (catalog: FreebuffModelCatalog | null) => void
  getCatalog: () => FreebuffModelCatalog | null
  now: () => number
  setTimer: (callback: () => void, ms: number) => unknown
  clearTimer: (timer: unknown) => void
}

export interface FreebuffCatalogController {
  /** The first fetch. Idempotent: every call returns the same promise. */
  load(): Promise<void>
  /** Fetch now (joining one already in flight) and apply the answer. */
  refresh(): Promise<FreebuffCatalogFetchResult['kind']>
  /** After a `freebuff_catalog_stale`: true when a fresh catalog is held. */
  refreshAfterStale(): Promise<boolean>
  /** Refetch when the viewer the catalog was built for has changed. */
  noteViewer(viewer: FreebuffCatalogViewer): void
  dispose(): void
}

/** What the server builds a catalog from that a session response reveals. */
export interface FreebuffCatalogViewer {
  accessTier?: string
  /** The plan tier; null is "no plan". Undefined means "not in this response". */
  subscriptionTierId?: string | null
}

export function createFreebuffCatalogController(
  token: string,
  deps: FreebuffCatalogControllerDeps,
): FreebuffCatalogController {
  let disposed = false
  const abort = new AbortController()
  let timer: unknown = null
  let inFlight: Promise<FreebuffCatalogFetchResult['kind']> | null = null
  let initial: Promise<void> | null = null
  let consecutiveErrors = 0
  let lastStaleRefreshAt = Number.NEGATIVE_INFINITY
  const viewer: FreebuffCatalogViewer = {}

  const clear = () => {
    if (timer !== null) deps.clearTimer(timer)
    timer = null
  }
  const schedule = (ms: number) => {
    if (disposed) return
    clear()
    timer = deps.setTimer(() => {
      timer = null
      void refresh()
    }, ms)
  }

  const refresh = (): Promise<FreebuffCatalogFetchResult['kind']> => {
    if (disposed) return Promise.resolve('error')
    if (inFlight) return inFlight
    clear()
    inFlight = deps
      .fetchCatalog(token, abort.signal)
      .catch(
        (error): FreebuffCatalogFetchResult => ({
          kind: 'error',
          message: error instanceof Error ? error.message : String(error),
        }),
      )
      .then((result) => {
        inFlight = null
        if (disposed) return result.kind
        if (result.kind === 'ok') {
          consecutiveErrors = 0
          deps.applyCatalog(result.catalog)
          schedule(
            Math.min(
              MAX_REFRESH_DELAY_MS,
              Math.max(
                MIN_REFRESH_DELAY_MS,
                result.catalog.refreshAt - deps.now(),
              ),
            ),
          )
        } else if (result.kind === 'unsupported') {
          consecutiveErrors = 0
          // The server's own answer: this client runs on the compiled
          // catalog. Nothing to poll for; a tier change asks again.
          deps.applyCatalog(null)
        } else {
          consecutiveErrors++
          logger.debug(
            { status: result.status, error: result.message },
            '[freebuff-catalog] fetch failed; keeping the current mode',
          )
          schedule(
            Math.min(
              RETRY_MAX_DELAY_MS,
              RETRY_BASE_DELAY_MS * 2 ** (consecutiveErrors - 1),
            ),
          )
        }
        return result.kind
      })
    return inFlight
  }

  return {
    load: () => {
      initial ??= refresh().then(() => undefined)
      return initial
    },
    refresh,
    refreshAfterStale: async () => {
      if (disposed) return false
      if (!inFlight && deps.now() - lastStaleRefreshAt < STALE_REFRESH_COOLDOWN_MS)
        return false
      lastStaleRefreshAt = deps.now()
      return (await refresh()) === 'ok' && deps.getCatalog() !== null
    },
    noteViewer: (next) => {
      let changed = false
      if (next.accessTier !== undefined) {
        changed ||=
          viewer.accessTier !== undefined &&
          viewer.accessTier !== next.accessTier
        viewer.accessTier = next.accessTier
      }
      if (next.subscriptionTierId !== undefined) {
        changed ||=
          viewer.subscriptionTierId !== undefined &&
          viewer.subscriptionTierId !== next.subscriptionTierId
        viewer.subscriptionTierId = next.subscriptionTierId
      }
      if (changed) void refresh()
    },
    dispose: () => {
      disposed = true
      clear()
      abort.abort()
    },
  }
}

// --- The process's controller ------------------------------------------------

let active: {
  token: string
  controller: FreebuffCatalogController
  settled: boolean
  initial: Promise<void>
} | null = null

/**
 * Start fetching the catalog for this token. Returns the stop function; a
 * second start with the same token reuses the running controller.
 */
export function startFreebuffModelCatalog(
  token: string,
  deps: Partial<FreebuffCatalogControllerDeps> = {},
): () => void {
  if (active?.token === token) return stopFreebuffModelCatalog
  stopFreebuffModelCatalog()
  const controller = createFreebuffCatalogController(token, {
    fetchCatalog: (t, signal) => fetchFreebuffModelCatalog(t, { signal }),
    applyCatalog: applyFreebuffCatalog,
    getCatalog: getFreebuffCatalog,
    now: Date.now,
    setTimer: (callback, ms) => {
      const handle = setTimeout(callback, ms)
      handle.unref?.()
      return handle
    },
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    ...deps,
  })
  const entry = {
    token,
    controller,
    settled: false,
    initial: controller.load(),
  }
  void entry.initial.finally(() => {
    entry.settled = true
  })
  active = entry
  useFreebuffCatalogStore.setState({
    refreshAfterStale: controller.refreshAfterStale,
  })
  return stopFreebuffModelCatalog
}

/** Stop the controller and return to fallback mode. */
export function stopFreebuffModelCatalog(): void {
  if (!active) return
  active.controller.dispose()
  active = null
  useFreebuffCatalogStore.setState({ refreshAfterStale: null })
  applyFreebuffCatalog(null)
}

/**
 * The first catalog fetch, bounded by FREEBUFF_CATALOG_INITIAL_WAIT_MS, or
 * null when there is nothing to wait for (no controller, or it already
 * answered) so callers can stay synchronous in the common case.
 */
export function freebuffModelCatalogInitialLoad(): Promise<void> | null {
  if (!active || active.settled) return null
  const initial = active.initial
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, FREEBUFF_CATALOG_INITIAL_WAIT_MS)
    timer.unref?.()
    void initial.finally(() => {
      clearTimeout(timer)
      resolve()
    })
  })
}

/** Feed a session response in, so a tier or plan change refetches rows. */
export function noteFreebuffCatalogViewer(
  session: { status: string } | null,
): void {
  if (!active || !session) return
  const subscription = getSubscriptionInfo(session)
  active.controller.noteViewer({
    accessTier: getFreebuffServerAccessTier(session),
    subscriptionTierId: subscription ? subscription.tierId : undefined,
  })
}

/**
 * Run a turn, and run it ONCE more if the server refused its model handle as
 * stale (`freebuff_catalog_stale`): refetch the catalog, then `run` again,
 * which rebuilds the root from the fresh catalog, so the same row goes out
 * under its new handle. A second refusal is returned (or thrown) as is.
 *
 * `canRetry` is asked after the refusal: a turn that already streamed content
 * or was stopped is never restarted, because a retry replays the whole prompt.
 * The refusal can arrive thrown or as the run's error output, so both are
 * checked. Outside catalog mode this is exactly `run()`.
 */
export async function runWithFreebuffCatalogStaleRetry<T>(opts: {
  /** 0 for the turn, 1 for its one retry, which must rebuild its agent. */
  run: (attempt: number) => Promise<T>
  canRetry: () => boolean
  refreshAfterStale?: (() => Promise<boolean>) | null
}): Promise<T> {
  if (!getFreebuffCatalog()) return opts.run(0)
  const refresh =
    opts.refreshAfterStale === undefined
      ? useFreebuffCatalogStore.getState().refreshAfterStale
      : opts.refreshAfterStale
  const retryable = async (refusal: unknown) =>
    isFreebuffCatalogStaleError(refusal) &&
    opts.canRetry() &&
    refresh !== null &&
    (await refresh())

  let result: T
  try {
    result = await opts.run(0)
  } catch (error) {
    if (!(await retryable(error))) throw error
    logger.info({}, '[freebuff-catalog] stale handle; retrying the turn once')
    return opts.run(1)
  }
  const output = (result as { output?: { type?: string } } | null)?.output
  if (output?.type === 'error' && (await retryable(output))) {
    logger.info({}, '[freebuff-catalog] stale handle; retrying the turn once')
    return opts.run(1)
  }
  return result
}
