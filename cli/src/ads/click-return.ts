import { WEBSITE_URL } from '@codebuff/sdk'
import {
  createClickAckGate,
  createClickReturnWatcher,
} from '@codebuff/common/ads/click-return'

import { getAuthToken } from '../utils/auth'
import { logger } from '../utils/logger'

import type {
  ClickReturnBody,
  ClickReturnWatcher,
} from '@codebuff/common/ads/click-return'

/**
 * The CLI's half of the post-click return label (COD-694).
 *
 * A terminal cannot see focus, so the return is the user's NEXT SUBMITTED
 * PROMPT after an ad click: `away_ms` is click → next prompt, an upper bound
 * on time away (the user may have come back and read for a while before
 * typing). Queued messages the runtime sends on its own are not a return;
 * only `routeUserPrompt` -- one call per prompt the user submits -- counts.
 * A second ad click also proves the user was back, and resolves the first.
 */

export type CliClickReturnDeps = {
  send: (impUrl: string, body: ClickReturnBody) => void
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

export function createCliClickReturn(
  deps: CliClickReturnDeps,
): ClickReturnWatcher<string> {
  return createClickReturnWatcher<string>({
    client: 'cli',
    now: deps.now ?? (() => Date.now()),
    setTimer:
      deps.setTimer ??
      ((fn, ms) => {
        const handle = setTimeout(fn, ms)
        // A 30-minute watch must never hold the process open on exit.
        handle.unref?.()
        return handle
      }),
    clearTimer:
      deps.clearTimer ??
      ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)),
    report: deps.send,
  })
}

/** Fire-and-forget POST to the Codebuff API. Never retried, never thrown. */
export function postCliClickReturn(
  impUrl: string,
  body: ClickReturnBody,
): void {
  const authToken = getAuthToken()
  if (!authToken) return
  void fetch(`${WEBSITE_URL}/api/v1/ads/click-return`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${authToken}`,
    },
    body: JSON.stringify({ impUrl, ...body }),
  })
    .then((res) => {
      if (!res.ok) {
        logger.debug(
          { status: res.status },
          '[ads] Failed to record ad click return',
        )
      }
    })
    .catch((err) => {
      logger.debug({ err }, '[ads] Failed to record ad click return')
    })
}

let shared: ClickReturnWatcher<string> | null = null
const clickAcks = createClickAckGate<string>()
function watcher(): ClickReturnWatcher<string> {
  // After the click itself is recorded, or the server 409s the return.
  shared ??= createCliClickReturn({
    send: (impUrl, body) =>
      clickAcks.after(impUrl, () => postCliClickReturn(impUrl, body)),
  })
  return shared
}

/** The click POST for `impUrl`; its return report waits for it to settle. */
export function trackAdClickAck(impUrl: string, ack: Promise<unknown>): void {
  clickAcks.track(impUrl, ack)
}

/** An ad was clicked: start watching for the user's next prompt. */
export function watchAdClickReturn(impUrl: string): void {
  try {
    watcher().click(impUrl)
  } catch {
    // A label must never break the click that produced it.
  }
}

/** The user submitted a prompt: resolves any pending click as a return. */
export function noteUserTurnForAdClickReturn(): void {
  if (!shared) return
  try {
    shared.back('next_turn')
  } catch {
    // Never let a label interfere with sending a prompt.
  }
}
