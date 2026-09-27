/**
 * The one place an ad auction request is built.
 *
 * The rotating dock, the lazy inline slots and the partner rows all ask the
 * same route for an ad and differ only in which placement they name. They
 * used to differ in more than that by accident: every field the server reads
 * to target, price and bot-filter a request -- the browser-like user agent,
 * the device info, the message history, the dock arm -- lived inside
 * `useGravityAd`'s closure, so a second caller was a second body, free to
 * omit one of them and be quietly mistargeted or quietly filtered.
 */
import { WEBSITE_URL } from '@codebuff/sdk'
import { getAdUserAgent } from '@codebuff/common/util/ad-user-agent'

import { getSessionDockArm } from '../hooks/use-dock-panel'
import { FREEBUFF_WEB_URL } from '../login/constants'
import { tryGetProjectRoot } from '../project-files'
import { useChatStore } from '../state/chat-store'
import {
  getAdDeviceInfo,
  getCliAdRequestUserAgent,
} from '../utils/ad-client-identity'
import { getAuthToken } from '../utils/auth'
import { logger } from '../utils/logger'
import { sponsoredCliCapability } from '../utils/sponsored-cli-capability'

import type { Message } from '@codebuff/sdk'
import type { AdProvider, AdSurface } from '../hooks/use-gravity-ad'

type AdMessage = { role: 'user' | 'assistant'; content: string }

/**
 * Convert LLM message history to ad API format.
 * Includes only user and assistant messages.
 */
const convertToAdMessages = (messages: Message[]): AdMessage[] => {
  const adMessages: AdMessage[] = messages
    .filter(
      (message) => message.role === 'assistant' || message.role === 'user',
    )
    .filter(
      (message) =>
        !message.tags || !message.tags.includes('INSTRUCTIONS_PROMPT'),
    )
    .map((message) => ({
      role: message.role,
      content: message.content
        .filter((c) => c.type === 'text')
        .map((c) => c.text.trim())
        .filter((c) => c !== '')
        .join('\n\n')
        .trim(),
    }))
    .filter((message) => message.content !== '')

  return adMessages
}

/**
 * The conversation as the auction sees it: the run state's history, plus the
 * latest user message from the UI when the run has not caught up to it yet.
 *
 * `runState.messageHistory` only gains a turn once the LLM has answered, and
 * the most valuable targeting signal is exactly the message that has just
 * been typed -- so the UI's copy is appended when the history does not
 * already contain it.
 */
function adMessagesForRequest(): AdMessage[] {
  const { runState, messages: uiMessages } = useChatStore.getState()
  const adMessages = convertToAdMessages(
    runState?.sessionState?.mainAgentState?.messageHistory ?? [],
  )
  const lastUIMessage = [...uiMessages]
    .reverse()
    .find((msg) => msg.variant === 'user')
  if (lastUIMessage?.content) {
    const lastAdUserMessage = [...adMessages]
      .reverse()
      .find((m) => m.role === 'user')
    if (
      !lastAdUserMessage ||
      !lastAdUserMessage.content.includes(lastUIMessage.content)
    ) {
      adMessages.push({
        role: 'user',
        content: `<user_message>${lastUIMessage.content}</user_message>`,
      })
    }
  }
  return adMessages
}

export interface AdAuctionRequest {
  url: string
  init: RequestInit
}

/**
 * Build one auction request, or `null` when this session cannot make one.
 *
 * `null` for a missing auth token only. Everything else on the request is
 * best-effort: a missing project root, an unresolved dock arm and an absent
 * trace context each simply omit their field, because the server's fallback
 * for each is better than no ad at all.
 */
export async function buildAdAuctionRequest(params: {
  /**
   * Omitted for a partner slot. `/api/v1/ads` accepts only the paid networks
   * here and answers anything else with a 400, and a partner request runs no
   * provider chain for it to choose between.
   */
  provider?: AdProvider
  surface?: AdSurface
  placementId?: string
  placementIds?: string[]
  /**
   * Whether this request may be routed to Freebuff Web's sponsored-capable
   * `/api/ads` when the project supports a sponsored run.
   *
   * FALSE FOR A PARTNER SLOT. That route resolves a placement against the
   * operator `ad_placement` table rather than the static registry, so a
   * partner id it has not been seeded with is refused -- and a partner slot
   * has no sponsored proposal to offer in the first place.
   */
  allowSponsoredRoute?: boolean
}): Promise<AdAuctionRequest | null> {
  const authToken = getAuthToken()
  if (!authToken) {
    logger.warn('[ads] No auth token available')
    return null
  }

  const { adTraceContext, chatSessionId } = useChatStore.getState()
  const projectRoot = params.allowSponsoredRoute ? tryGetProjectRoot() : null
  const capability = projectRoot
    ? await sponsoredCliCapability(projectRoot)
    : null
  const capabilityRoute = capability !== null
  const dockArm = getSessionDockArm()

  return {
    url: `${capabilityRoute ? FREEBUFF_WEB_URL : WEBSITE_URL}${capabilityRoute ? '/api/ads' : '/api/v1/ads'}`,
    init: {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`,
        'User-Agent': getCliAdRequestUserAgent(),
      },
      body: JSON.stringify({
        ...(params.provider ? { provider: params.provider } : {}),
        messages: adMessagesForRequest(),
        sessionId: chatSessionId,
        device: getAdDeviceInfo(),
        // Pointer ids to the last finished run's trace, never its text,
        // so a served ad can later be joined to the prompt behind it.
        ...(adTraceContext ? { traceContext: adTraceContext } : {}),
        ...(capability?.sponsoredCapability
          ? { sponsoredCapability: capability.sponsoredCapability }
          : {}),
        ...(capability
          ? { capabilityInspection: capability.capabilityInspection }
          : {}),
        ...(params.surface ? { surface: params.surface } : {}),
        ...(params.placementId ? { placementId: params.placementId } : {}),
        ...(params.placementIds?.length
          ? { placementIds: params.placementIds }
          : {}),
        // Native runtime UAs look bot-like to ad networks. Send the shared
        // browser-like UA so every provider sees a usable targeting signal.
        userAgent: getAdUserAgent(),
        // The dock arm THIS session cached (COD-457). Omitted until the
        // policy resolves, so the server falls back to its own assignment
        // rather than being handed a guess.
        ...(dockArm ? { cliDockArm: dockArm } : {}),
      }),
    },
  }
}
