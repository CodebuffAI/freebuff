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
  callFreebuffSession,
  FreebuffSessionRequestError,
} from '../utils/freebuff-session-api'
import { newFreebuffCliInstanceId } from '../utils/freebuff-session-identity'
import { getSelectedFreebuffModel } from '../state/freebuff-model-store'
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

function expiryOf(response: FreebuffSessionServerResponse): number {
  if ('expiresAt' in response && typeof response.expiresAt === 'string') {
    const parsed = Date.parse(response.expiresAt)
    if (Number.isFinite(parsed)) return parsed
  }
  return Date.now() + FALLBACK_SESSION_MS
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

  /** The held hour, when it is still valid and (optionally) for `model`. */
  current(model?: string): AcpAdmission | null {
    const held = this.admission
    if (!held) return null
    if (held.expiresAtMs <= Date.now()) return null
    if (model && held.model !== model) return null
    return held
  }

  /** Admit the selected model, reusing a live hour for the same model. */
  ensure(signal?: AbortSignal): Promise<AcpAdmission | null> {
    if (!IS_FREEBUFF) return Promise.resolve(null)
    const run = this.queue.then(() => this.ensureNow(signal))
    // Keep the chain alive after a refusal: one failed admission must not
    // wedge every later turn.
    this.queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  private async ensureNow(signal?: AbortSignal): Promise<AcpAdmission> {
    const model = getSelectedFreebuffModel()
    const held = this.current(model)
    if (held) return held

    // Reaching here means a live hour on another model, or an expired one.
    // Either way the old instance is finished with: release before claiming,
    // so the account never holds two slots for this process.
    if (this.admission) await this.release('model-switch')

    const { token } = getAuthTokenDetails()
    if (!token) {
      throw new AcpSessionError(
        'Not signed in. Run `freebuff login` on this machine before connecting an editor.',
      )
    }

    const instanceId = newFreebuffCliInstanceId()
    let response: FreebuffSessionServerResponse
    try {
      response = await callFreebuffSession('POST', token, {
        instanceId,
        multiSession: true,
        model,
        signal,
      })
    } catch (error) {
      if (error instanceof FreebuffSessionRequestError) {
        throw new AcpSessionError(
          `Could not start a Freebuff session: ${error.message}`,
        )
      }
      throw error
    }

    if (response.status !== 'active') {
      throw new AcpSessionError(describeRefusal(response))
    }

    const admission: AcpAdmission = {
      instanceId:
        'instanceId' in response && response.instanceId
          ? response.instanceId
          : instanceId,
      model: 'model' in response && response.model ? response.model : model,
      expiresAtMs: expiryOf(response),
    }
    this.admission = admission
    logger.info(
      { model: admission.model },
      '[acp] free session admitted for this process',
    )
    return admission
  }

  /** Best-effort DELETE so the hour is not left charged to the account. */
  async release(reason = 'shutdown'): Promise<void> {
    const admission = this.admission
    if (!admission) return
    this.admission = null
    const { token } = getAuthTokenDetails()
    if (!token) return
    try {
      await callFreebuffSession('DELETE', token, {
        instanceId: admission.instanceId,
        multiSession: true,
      })
      logger.info({ reason }, '[acp] free session released')
    } catch (error) {
      // Losing this costs the tail of an hour; it must never fail a turn.
      logger.warn({ reason, error }, '[acp] could not release the free session')
    }
  }
}

/** One holder for the process, released by the ACP entry point at shutdown. */
export const acpFreebuffSession = new AcpFreebuffSession()
