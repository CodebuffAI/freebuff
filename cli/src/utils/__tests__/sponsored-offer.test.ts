/**
 * What the per-turn agentic offer request sends, and what it makes of the
 * answer. The body is asserted directly because it is exactly what leaves the
 * machine, and the route admits a CLI caller only with the in-place flag.
 */
import { describe, expect, test } from 'bun:test'

import { agenticOfferRequestSchema } from '@codebuff/common/ads/agentic-offer'

import { ensureCliTestEnv } from '../../__tests__/test-utils'

ensureCliTestEnv()

const {
  AGENTIC_OFFER_MESSAGE_WINDOW,
  agenticOfferMessages,
  askAgenticOffer,
  buildAgenticOfferRequest,
  localCapabilityFromSponsored,
} = await import('../sponsored-offer')

import type { AgenticOfferDeps } from '../sponsored-offer'
import type { SponsoredCliCapabilityResult } from '../sponsored-cli-capability'
import type { ChatMessage } from '../../types/chat'

const CAPABILITY: SponsoredCliCapabilityResult = {
  sponsoredCapability: {
    schemaVersion: 2,
    target: { kind: 'repo', repoFullName: 'acme/app' },
    framework: 'nextjs',
    packageManager: 'bun',
    hasSupabaseBoundary: false,
    hasCommittedDatabaseBoundary: false,
    hasGitRepository: true,
    hasCommittedHead: true,
    execution: { surface: 'cli_macos', status: 'available' },
  },
  capabilityInspection: { status: 'available' },
}

const message = (
  id: string,
  variant: ChatMessage['variant'],
  content: string,
): ChatMessage => ({ id, variant, content, timestamp: '00:00' })

const CONVERSATION: ChatMessage[] = [
  message('u-1', 'user', 'Build a small web game with a leaderboard.'),
  message('ai-1', 'ai', 'Done — the game is in src/game.ts.'),
  message('sys-1', 'ai', 'Ads enabled.'),
  message('u-2', 'user', 'What database should I set up for this game?'),
]

describe('the request body', () => {
  test('is a valid offer request that says this client runs in place', () => {
    const body = buildAgenticOfferRequest({
      conversationId: 'chat-1',
      messages: CONVERSATION,
      capability: CAPABILITY,
      device: { os: 'macos', timezone: 'UTC', locale: 'en-US' },
    })
    expect(body).not.toBeNull()
    expect(agenticOfferRequestSchema.safeParse(body).success).toBe(true)
    expect(body!.inPlaceExecutionVersion).toBe(1)
    expect(body!.conversationId).toBe('chat-1')
  })

  test('carries the trace pointers when given, and nothing when not', () => {
    const traceContext = {
      traceSessionId: '11111111-2222-4333-8444-555555555555',
      previousRunId: '66666666-7777-4888-9999-aaaaaaaaaaaa',
    }
    const base = {
      conversationId: 'chat-1',
      messages: CONVERSATION,
      capability: CAPABILITY,
      device: { os: 'macos' as const, timezone: 'UTC', locale: 'en-US' },
    }
    const body = buildAgenticOfferRequest({ ...base, traceContext })!
    expect(agenticOfferRequestSchema.safeParse(body).success).toBe(true)
    expect(body.traceContext).toEqual(traceContext)
    for (const none of [undefined, null]) {
      expect(
        buildAgenticOfferRequest({ ...base, traceContext: none }),
      ).not.toHaveProperty('traceContext')
    }
  })

  test('never asks for a setup invitation: the terminal cannot draw one', () => {
    const body = buildAgenticOfferRequest({
      conversationId: 'chat-1',
      messages: CONVERSATION,
      capability: CAPABILITY,
      device: { os: 'macos', timezone: 'UTC', locale: 'en-US' },
    })!
    expect(body.invitationCapability).toBeUndefined()
    expect(body.invitationReadyDiscoveryVersion).toBeUndefined()
  })

  test('the CLI’s own notices are not the conversation', () => {
    const turns = agenticOfferMessages(CONVERSATION)
    expect(turns).toEqual([
      { role: 'user', content: 'Build a small web game with a leaderboard.' },
      { role: 'assistant', content: 'Done — the game is in src/game.ts.' },
      {
        role: 'user',
        content: 'What database should I set up for this game?',
      },
    ])
  })

  test('only the last six turns are sent', () => {
    const many = Array.from({ length: 20 }, (_, index) =>
      message(`u-${index}`, 'user', `message ${index}`),
    )
    const turns = agenticOfferMessages(many)
    expect(turns).toHaveLength(AGENTIC_OFFER_MESSAGE_WINDOW)
    expect(turns.at(-1)!.content).toBe('message 19')
  })

  test('no capability, no request: the route would refuse it anyway', () => {
    expect(
      buildAgenticOfferRequest({
        conversationId: 'chat-1',
        messages: CONVERSATION,
        capability: {
          sponsoredCapability: null,
          capabilityInspection: {
            status: 'unavailable',
            reason: 'windows_no_containment',
          },
        },
        device: { os: 'windows', timezone: 'UTC', locale: 'en-US' },
      }),
    ).toBeNull()
  })

  test('the folder id rides even when the repository has a GitHub remote', () => {
    // The route keys an IN-PLACE offer to the folder and refuses one without
    // its id, whatever `owner/repo` says.
    const body = buildAgenticOfferRequest({
      conversationId: 'chat-1',
      messages: CONVERSATION,
      capability: CAPABILITY,
      device: { os: 'macos', timezone: 'UTC', locale: 'en-US' },
      workspaceId: '0f8fad5b-d9cb-469f-a165-70867728950e',
    })!
    expect(body.localCapability).toMatchObject({
      repoFullName: 'acme/app',
      workspaceId: '0f8fad5b-d9cb-469f-a165-70867728950e',
    })
  })

  test('the v1 projection keys a workspace-only folder by its id', () => {
    const local = localCapabilityFromSponsored({
      ...CAPABILITY.sponsoredCapability!,
      target: {
        kind: 'workspace',
        workspaceId: '0f8fad5b-d9cb-469f-a165-70867728950e',
      },
      framework: 'react-vite',
    })
    expect(local).toMatchObject({
      repoFullName: '',
      workspaceId: '0f8fad5b-d9cb-469f-a165-70867728950e',
      framework: 'unsupported',
    })
  })
})

describe('asking', () => {
  const deps = (over: Partial<AgenticOfferDeps> = {}): AgenticOfferDeps => ({
    getToken: () => 'token',
    capability: async () => CAPABILITY,
    workspaceId: () => '0f8fad5b-d9cb-469f-a165-70867728950e',
    request: async () => ({
      v: 1,
      decision: 'offer',
      kind: 'proposal',
      proposalId: 'proposal-1',
      campaignId: 'campaign-1',
    }),
    device: () => ({ os: 'macos', timezone: 'UTC', locale: 'en-US' }),
    userAgent: () => 'Freebuff-CLI/1.2.3',
    ...over,
  })
  const input = {
    projectRoot: '/repo',
    conversationId: 'chat-1',
    messages: CONVERSATION,
  }

  test('a proposal is an offer, sent with the product user agent', async () => {
    let userAgent = ''
    const offered = await askAgenticOffer(
      input,
      deps({
        request: async (_body, _token, ua) => {
          userAgent = ua
          return {
            v: 1,
            decision: 'offer',
            kind: 'proposal',
            proposalId: 'p',
            campaignId: 'c',
          }
        },
      }),
    )
    expect(offered).toBe(true)
    expect(userAgent).toBe('Freebuff-CLI/1.2.3')
  })

  test('none, an invitation, a failure and no session are all "no offer"', async () => {
    expect(
      await askAgenticOffer(
        input,
        deps({
          request: async () => ({ v: 1, decision: 'none', reason: 'no_match' }),
        }),
      ),
    ).toBe(false)
    expect(
      await askAgenticOffer(
        input,
        deps({
          request: async () =>
            ({
              v: 1,
              decision: 'offer',
              kind: 'invitation',
              invitation: {},
            }) as never,
        }),
      ),
    ).toBe(false)
    expect(
      await askAgenticOffer(
        input,
        deps({
          request: async () => {
            throw new Error('offline')
          },
        }),
      ),
    ).toBe(false)
    let asked = false
    expect(
      await askAgenticOffer(
        input,
        deps({
          getToken: () => null,
          request: async () => {
            asked = true
            return null
          },
        }),
      ),
    ).toBe(false)
    expect(asked).toBe(false)
  })
})
