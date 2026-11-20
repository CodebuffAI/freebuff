/**
 * Headless Freebuff session admission for `--acp`.
 *
 * Free mode is gated server-side: a chat completion that carries no admitted
 * session (no `freebuff_instance_id`) is refused before it runs. The TUI gets
 * that id from `useFreebuffSession`, which only exists inside the React tree.
 * An ACP process has no renderer, so it has to claim the hour itself and
 * release it when the process ends.
 *
 * This module deliberately reuses `callFreebuffSession`, so the ACP path gets
 * the same headers, catalog protocol, device signature and admission rules as
 * the TUI — nothing here re-implements the wire format.
 *
 * Lifetime is the caller's: `serveAcp` releases on the way out. This module
 * installs no signal handlers, because two owners for one process's shutdown
 * is how a SIGINT ends up swallowed instead of ending the process.
 */
import {
  FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID,
  FREEBUFF_MIMO_V25_MODEL_ID,
} from '@codebuff/common/constants/freebuff-models'

import {
  callFreebuffSession,
  FreebuffSessionRequestError,
} from '../utils/freebuff-session-api'
import { newFreebuffCliInstanceId } from '../utils/freebuff-session-identity'
import {
  getSelectedFreebuffModel,
  useFreebuffModelStore,
} from '../state/freebuff-model-store'
import { getAuthTokenDetails } from '../utils/auth'
import { IS_FREEBUFF } from '../utils/constants'
import { logger } from '../utils/logger'

import type { FreebuffSessionServerResponse } from '@codebuff/common/types/freebuff-session'

/** An hour this process is holding, as the chat metadata needs it. */
export type AcpAdmission = {
  instanceId: string
  model: string
  /** Epoch ms. Past this the server no longer accepts the instance. */
  expiresAtMs: number
}

/** Admission was refused for a reason the user can act on. */
export class AcpSessionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AcpSessionError'
  }
}

/** Assume an hour when the server does not send an expiry. */
const FALLBACK_SESSION_MS = 60 * 60 * 1_000

/** Give up waiting for an active hour after this many ms. */
export const ACP_SESSION_ADMIT_DEADLINE_MS = 90_000

const TRANSIENT_STATUS_CODES = new Set([408, 429, 503])

function expiryOf(response: FreebuffSessionServerResponse): number {
  if ('expiresAt' in response && typeof response.expiresAt === 'string') {
    const parsed = Date.parse(response.expiresAt)
    if (Number.isFinite(parsed)) return parsed
  }
  return Date.now() + FALLBACK_SESSION_MS
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AcpSessionError('Cancelled'))
      return
    }
    const timer = setTimeout(resolve, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new AcpSessionError('Cancelled'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** The picker's refusals, in wording an editor surface can show without the
 *  picker, the queue or the plan panel around it. */
export function describeRefusal(
  response: FreebuffSessionServerResponse,
): string {
  switch (response.status) {
    case 'banned':
      return 'This Freebuff account is suspended. Visit https://freebuff.com/account?tab=standing or contact support@freebuff.com.'
    case 'country_blocked':
      return 'Freebuff is unavailable from this network. Disable any VPN or proxy and try again.'
    case 'rate_limited':
      return 'Freebuff session limit reached for this model. Pick another model, or try again when your daily hours reset.'
    case 'spend_limited':
      return 'message' in response && response.message
        ? response.message
        : 'Your Freebuff balance for this model is spent.'
    case 'ip_capped':
      return 'Too many Freebuff sessions on this network. Try again after another session finishes.'
    case 'model_locked':
      return 'This Freebuff session is locked to another model. End it in Freebuff Desktop or the CLI first.'
    case 'model_unavailable':
      return 'That model is not available for this account right now. Pick another model.'
    case 'premium_slot_taken':
    case 'purchase_in_use':
    case 'purchase_capacity':
      return 'Your concurrent Freebuff session limit is reached. Take over or end the other session first.'
    case 'superseded':
      return 'This session was taken over elsewhere. Send again to start a new one.'
    default:
      return `Freebuff refused the session (${response.status}).`
  }
}

function isHardRefusal(status: FreebuffSessionServerResponse['status']): boolean {
  return (
    status === 'banned' ||
    status === 'country_blocked' ||
    status === 'rate_limited' ||
    status === 'spend_limited' ||
    status === 'ip_capped' ||
    status === 'model_locked' ||
    status === 'premium_slot_taken' ||
    status === 'purchase_in_use' ||
    status === 'purchase_capacity' ||
    status === 'superseded' ||
    status === 'ended'
  )
}

/** The other model to try when `model` is unavailable. Named ids, not
 *  DEFAULT_FREEBUFF_MODEL_ID: the default is DeepSeek V4.1 Flash since
 *  2026-11-08, so using it here made DeepSeek "fall back" to itself. MiMo is
 *  unlisted but still admitted by the server. */
function fallbackModelFor(model: string): string {
  return model === FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID
    ? FREEBUFF_MIMO_V25_MODEL_ID
    : FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID
}

/** Optional seams for unit tests (fake clocks, stubbed session API). */
export type AcpFreebuffSessionOptions = {
  isFreebuff?: boolean
  admitDeadlineMs?: number
  callSession?: typeof callFreebuffSession
  getToken?: () => { token: string | null }
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  now?: () => number
}

/**
 * Holds at most one hour for the process. Turns reuse it; a different selected
 * model releases it and claims again, because the server locks an hour to the
 * model it was bought for.
 *
 * Admission is serialized through `queue` so two sessions starting at once
 * cannot each POST a claim and burn two of the account's concurrent slots.
 */
export class AcpFreebuffSession {
  private admission: AcpAdmission | null = null
  private queue: Promise<unknown> = Promise.resolve()
  private readonly options: AcpFreebuffSessionOptions

  constructor(options: AcpFreebuffSessionOptions = {}) {
    this.options = options
  }

  /** The held hour, when it is still valid and (optionally) for `model`. */
  current(model?: string): AcpAdmission | null {
    const held = this.admission
    if (!held) return null
    const now = this.options.now?.() ?? Date.now()
    if (held.expiresAtMs <= now) return null
    if (model && held.model !== model) return null
    return held
  }

  /** Admit the selected model, reusing a live hour for the same model. */
  ensure(signal?: AbortSignal): Promise<AcpAdmission | null> {
    const isFreebuff = this.options.isFreebuff ?? IS_FREEBUFF
    if (!isFreebuff) return Promise.resolve(null)
    const run = this.queue.then(() => this.ensureNow(signal))
    // Keep the chain alive after a refusal: one failed admission must not
    // wedge every later turn.
    this.queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /**
   * Claim (or reuse) a free hour. POST once, then poll GET until active,
   * falling back once on `model_unavailable`, backing off on 408/429/503,
   * and giving up cleanly at {@link ACP_SESSION_ADMIT_DEADLINE_MS}.
   */
  private async ensureNow(signal?: AbortSignal): Promise<AcpAdmission> {
    const callSession = this.options.callSession ?? callFreebuffSession
    const getToken = this.options.getToken ?? getAuthTokenDetails
    const wait = this.options.sleep ?? sleep
    const now = this.options.now ?? Date.now
    const deadlineMs =
      this.options.admitDeadlineMs ?? ACP_SESSION_ADMIT_DEADLINE_MS

    let model = getSelectedFreebuffModel()
    // Drop a leftover catalog key from a prior TUI session — ACP stays on
    // compiled model ids so completions are not refused as third-party.
    if (model.startsWith('m-')) {
      model = FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID
      useFreebuffModelStore.getState().setSelectedModel(model)
    }

    const held = this.current(model)
    if (held) return held

    // Reaching here means a live hour on another model, or an expired one.
    // Either way the old instance is finished with: release before claiming,
    // so the account never holds two slots for this process.
    if (this.admission) await this.release('model-switch')

    const { token } = getToken()
    if (!token) {
      throw new AcpSessionError(
        'Not signed in. Run `freebuff login` on this machine before connecting an editor.',
      )
    }

    const deadline = now() + deadlineMs
    let claimId = newFreebuffCliInstanceId()
    let method: 'POST' | 'GET' = 'POST'
    let lastStatus = 'none'
    let fellBackOnce = false

    while (now() < deadline) {
      if (signal?.aborted) throw new AcpSessionError('Cancelled')

      try {
        const response = await callSession(method, token, {
          signal,
          instanceId: claimId,
          multiSession: true,
          model: method === 'POST' ? model : undefined,
        })
        lastStatus = response.status

        if (response.status === 'active') {
          const admission: AcpAdmission = {
            instanceId:
              'instanceId' in response && response.instanceId
                ? response.instanceId
                : claimId,
            model:
              'model' in response && response.model ? response.model : model,
            expiresAtMs: expiryOf(response),
          }
          this.admission = admission
          useFreebuffModelStore.getState().setSelectedModel(admission.model)
          logger.info(
            { model: admission.model },
            '[acp] free session admitted for this process',
          )
          return admission
        }

        if (response.status === 'model_unavailable') {
          const unavailable = response as FreebuffSessionServerResponse & {
            updateRequired?: boolean
            purchasesPaused?: boolean
            dailyLimitReached?: boolean
            availableHours?: string
            requestedModel?: string
          }
          if (
            unavailable.updateRequired ||
            unavailable.purchasesPaused ||
            unavailable.dailyLimitReached
          ) {
            throw new AcpSessionError(
              unavailable.availableHours ||
                `Freebuff model unavailable: ${unavailable.requestedModel ?? model}`,
            )
          }
          if (fellBackOnce) {
            throw new AcpSessionError(
              `Freebuff model unavailable after fallback (requested ${unavailable.requestedModel ?? model}).`,
            )
          }
          const fallback = fallbackModelFor(model)
          logger.info(
            { requested: unavailable.requestedModel ?? model, fallback },
            '[acp] model unavailable; retrying with fallback',
          )
          model = fallback
          useFreebuffModelStore.getState().setSelectedModel(fallback)
          claimId = newFreebuffCliInstanceId()
          fellBackOnce = true
          method = 'POST'
          continue
        }

        if (isHardRefusal(response.status)) {
          throw new AcpSessionError(describeRefusal(response))
        }

        // Transient / none: poll GET until active or timeout.
        method = 'GET'
      } catch (error) {
        if (error instanceof AcpSessionError) throw error
        if (error instanceof FreebuffSessionRequestError) {
          if (TRANSIENT_STATUS_CODES.has(error.statusCode)) {
            await wait(error.retryAfterMs ?? 1_000, signal)
            continue
          }
          throw new AcpSessionError(
            `Could not start a Freebuff session: ${error.message}`,
          )
        }
        throw error
      }

      await wait(500, signal)
    }

    throw new AcpSessionError(
      `Timed out waiting for a Freebuff session (last status: ${lastStatus}).`,
    )
  }

  /** Best-effort DELETE so the hour is not left charged to the account. */
  async release(reason = 'shutdown'): Promise<void> {
    const admission = this.admission
    if (!admission) return
    this.admission = null
    const getToken = this.options.getToken ?? getAuthTokenDetails
    const callSession = this.options.callSession ?? callFreebuffSession
    const { token } = getToken()
    if (!token) return
    try {
      await callSession('DELETE', token, {
        instanceId: admission.instanceId,
        multiSession: true,
      })
      logger.info({ reason }, '[acp] free session released')
    } catch (error) {
      // Losing this costs the tail of an hour; it must never fail a turn.
      logger.warn({ reason, error }, '[acp] could not release the free session')
    }
  }

  /** Test helper: seed a held admission without calling the API. */
  seedAdmissionForTests(admission: AcpAdmission): void {
    this.admission = admission
  }
}

/** One holder for the process, released by the ACP entry point at shutdown. */
export const acpFreebuffSession = new AcpFreebuffSession()
