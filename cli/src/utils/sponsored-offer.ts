/**
 * The per-turn agentic offer request (#3989's flow, ported to the terminal).
 *
 * Desktop asks `POST /api/v1/ads/agentic/offer` once per user turn and draws
 * whatever proposal that mints; the CLI used to wait for its 60-second proposal
 * poll to stumble on one. This module is the CLI's half of that route: build
 * the request from the conversation and this folder's capability, send it, and
 * say whether a proposal now exists so the caller can read it straight away
 * rather than a minute later.
 *
 * ## What it sends, and what it never does
 *
 * - the last six turns as `{ role, content }` -- the same window Desktop sends
 *   and the display auction already receives, so no new text leaves the
 *   machine;
 * - the closed capability facts `sponsored-cli-capability.ts` already sends to
 *   `/api/ads`, plus their v1 projection (`localCapability`);
 * - `inPlaceExecutionVersion: 1`, because this build runs an accepted offer in
 *   place. The route refuses a CLI request without it: the old worktree flow is
 *   never served again.
 *
 * NO INVITATION FIELDS. A setup invitation is a card this surface cannot draw,
 * so `invitationCapability` and `invitationReadyDiscoveryVersion` are never
 * sent, and an invitation that arrives anyway is treated as `none`.
 *
 * It never writes to the checkout: the capability probe reads, and a folder
 * whose identity would have to be minted is simply not offered anything.
 */
import {
  AGENTIC_OFFER_ROUTE_VERSION,
  type AgenticOfferRequest,
} from '@codebuff/common/ads/agentic-offer'
import { localAgenticTestCampaign } from '@codebuff/common/ads/local-agentic-test'
import { SPONSORED_IN_PLACE_VERSION } from '@codebuff/common/ads/sponsored-in-place'
import { env } from '@codebuff/common/env'

import { FREEBUFF_WEB_URL } from '../login/constants'
import { getAdDeviceInfo, getCliAdRequestUserAgent } from './ad-client-identity'
import { getCliEnv } from './env'
import { getAuthToken } from './auth'
import { logger } from './logger'
import { sponsoredCliCapability } from './sponsored-cli-capability'
import { requestAgenticOffer } from './sponsored-proposal-api'
import { sponsoredWorkspaceId } from './sponsored-proposal-target'

import type { SponsoredCliCapabilityResult } from './sponsored-cli-capability'
import type { AdDeviceInfo } from './ad-client-identity'
import type { SponsoredCapability } from '@codebuff/common/ads/sponsored-capability'
import type { AdTraceContext } from '@codebuff/common/ads/trace-context'
import type { ChatMessage } from '../types/chat'

/** The turns the route is shown. Desktop's figure, and the route's cap is 20. */
export const AGENTIC_OFFER_MESSAGE_WINDOW = 6

/**
 * The v1 projection of the capability the auction already receives.
 *
 * `localCapability` is the offer route's shape and predates the v2
 * `sponsoredCapability`; both are sent, as Desktop sends both. The framework
 * enum is narrower here -- v1 knows only Next.js -- so everything v2 can run
 * that is not Next.js reads as `unsupported`, which is what v1 always said
 * about it.
 */
export function localCapabilityFromSponsored(
  capability: SponsoredCapability,
  /**
   * The folder's id, sent even when the repository also has a GitHub remote:
   * the route keys an IN-PLACE offer to the folder and refuses one without it.
   */
  workspaceId: string | null = null,
): NonNullable<AgenticOfferRequest['localCapability']> {
  const target = capability.target
  const folder =
    workspaceId ?? (target.kind === 'workspace' ? target.workspaceId : null)
  return {
    schemaVersion: 1,
    repoFullName: target.kind === 'repo' ? target.repoFullName : '',
    framework:
      capability.framework === 'nextjs'
        ? 'nextjs'
        : capability.framework === 'unknown'
          ? 'unknown'
          : 'unsupported',
    packageManager: capability.packageManager,
    hasSupabaseBoundary: capability.hasSupabaseBoundary,
    hasCommittedDatabaseBoundary: capability.hasCommittedDatabaseBoundary,
    hasGitRepository: capability.hasGitRepository,
    ...(folder ? { workspaceId: folder } : {}),
  }
}

/**
 * The conversation as the route reads it: user and assistant text only, oldest
 * first, the last six turns.
 *
 * System rows are left out on purpose. They are the CLI talking to the user
 * about itself -- command output, a sponsored card, an error -- and an offer
 * decided on "Ads enabled." is an offer decided on nothing the user said.
 */
export function agenticOfferMessages(
  messages: readonly ChatMessage[],
): { role: string; content: string }[] {
  const turns: { role: string; content: string }[] = []
  for (const message of messages) {
    if (message.variant !== 'user' && message.variant !== 'ai') continue
    // `getSystemMessage` rows are `ai`-variant with a `sys-` id: the CLI's own
    // notices, never the assistant's words.
    if (message.id.startsWith('sys-')) continue
    const content =
      message.variant === 'user'
        ? message.content.trim()
        : aiText(message).trim()
    if (!content) continue
    turns.push({
      role: message.variant === 'user' ? 'user' : 'assistant',
      content,
    })
  }
  return turns.slice(-AGENTIC_OFFER_MESSAGE_WINDOW)
}

function aiText(message: ChatMessage): string {
  const fromBlocks = (message.blocks ?? [])
    .flatMap((block) =>
      block.type === 'text' && block.textType !== 'reasoning'
        ? [block.content]
        : [],
    )
    .join('\n')
  return fromBlocks || message.content
}

/** The request body. Pure, so what leaves the machine is asserted directly. */
export function buildAgenticOfferRequest(input: {
  conversationId: string
  messages: readonly ChatMessage[]
  capability: SponsoredCliCapabilityResult
  device: AdDeviceInfo
  workspaceId?: string | null
  /** The local harness's forced campaign; never set outside it. */
  localTestCampaignId?: string | null
  /** Pointer ids to this conversation's trace, never its text. */
  traceContext?: AdTraceContext | null
}): AgenticOfferRequest | null {
  const sponsored = input.capability.sponsoredCapability
  // No capability, no offer: the route would refuse an in-place CLI request
  // without a target to key it to, so asking would spend a round trip and a
  // rate-limit slot on a certain `none`.
  if (!sponsored) return null
  const messages = agenticOfferMessages(input.messages)
  if (!messages.some((message) => message.role === 'user')) return null
  return {
    v: AGENTIC_OFFER_ROUTE_VERSION,
    conversationId: input.conversationId,
    messages,
    localCapability: localCapabilityFromSponsored(
      sponsored,
      input.workspaceId ?? null,
    ),
    sponsoredCapability: sponsored,
    capabilityInspection: input.capability.capabilityInspection,
    device: input.device,
    ...(input.localTestCampaignId
      ? { localTestCampaignId: input.localTestCampaignId }
      : {}),
    inPlaceExecutionVersion: SPONSORED_IN_PLACE_VERSION,
    ...(input.traceContext ? { traceContext: input.traceContext } : {}),
  }
}

/**
 * The campaign `bun run dev:agentic-ads cli` forces, or null everywhere else.
 * The same rule Desktop applies (`localAgenticTestCampaign`): development
 * runtime and loopback hosts only, so a released build can never send one.
 */
export function cliLocalTestCampaign(): string | null {
  const cli = getCliEnv()
  if (cli.TEST_AGENTIC_ADS !== 'true') return null
  return localAgenticTestCampaign({
    TEST_AGENTIC_ADS: cli.TEST_AGENTIC_ADS,
    TEST_AGENTIC_ADS_CAMPAIGN: cli.TEST_AGENTIC_ADS_CAMPAIGN,
    NODE_ENV: cli.NODE_ENV,
    NEXT_PUBLIC_CB_ENVIRONMENT: env.NEXT_PUBLIC_CB_ENVIRONMENT,
    NEXT_PUBLIC_CODEBUFF_APP_URL: env.NEXT_PUBLIC_CODEBUFF_APP_URL,
    NEXT_PUBLIC_FREEBUFF_APP_URL: FREEBUFF_WEB_URL,
  })
}

export type AgenticOfferDeps = {
  getToken: () => string | null | undefined
  capability: (root: string) => Promise<SponsoredCliCapabilityResult>
  workspaceId: (root: string) => string | null
  request: typeof requestAgenticOffer
  device: () => AdDeviceInfo
  userAgent: () => string
  localTestCampaign?: () => string | null
}

const defaultDeps: AgenticOfferDeps = {
  getToken: getAuthToken,
  capability: (root) => sponsoredCliCapability(root),
  workspaceId: sponsoredWorkspaceId,
  localTestCampaign: cliLocalTestCampaign,
  request: requestAgenticOffer,
  device: getAdDeviceInfo,
  userAgent: getCliAdRequestUserAgent,
}

/**
 * Ask once for this turn. Resolves `true` when a PROPOSAL was offered, so the
 * caller can read it now; `false` for everything else, including every failure.
 * Never throws: the offer is optional, and the turn it rides beside is not.
 */
export async function askAgenticOffer(
  input: {
    projectRoot: string
    conversationId: string
    messages: readonly ChatMessage[]
    traceContext?: AdTraceContext | null
  },
  deps: AgenticOfferDeps = defaultDeps,
): Promise<boolean> {
  try {
    const authToken = deps.getToken()
    if (!authToken) return false
    const body = buildAgenticOfferRequest({
      conversationId: input.conversationId,
      messages: input.messages,
      capability: await deps.capability(input.projectRoot),
      device: deps.device(),
      workspaceId: deps.workspaceId(input.projectRoot),
      localTestCampaignId: deps.localTestCampaign?.() ?? null,
      traceContext: input.traceContext ?? null,
    })
    if (!body) return false
    const response = await deps.request(body, authToken, deps.userAgent())
    // An invitation is a card this surface cannot draw. The route should never
    // send one to a CLI; if it does, it is not an offer here.
    return response?.decision === 'offer' && response.kind === 'proposal'
  } catch (error) {
    logger.debug({ error }, '[sponsored-offer] offer request failed')
    return false
  }
}
