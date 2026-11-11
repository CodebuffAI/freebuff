import * as analytics from '@codebuff/common/analytics'
import {
  parseTurnReview,
  TURN_REVIEW_PROMPT,
} from '@codebuff/common/constants/turn-review'
import { TEST_USER_ID } from '@codebuff/common/old-constants'
import { createTestAgentRuntimeParams } from '@codebuff/common/testing/fixtures/agent-runtime'
import {
  createMockDbOperations,
  setupDbSpies,
} from '@codebuff/common/testing/mocks/database'
import { getInitialSessionState } from '@codebuff/common/types/session-state'
import { promptSuccess } from '@codebuff/common/util/error'
import { userMessage } from '@codebuff/common/util/messages'
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'

import { loopAgentSteps } from '../run-agent-step'
import { clearAgentGeneratorCache } from '../run-programmatic-step'
import { createToolCallChunk, mockFileContext } from './test-utils'

import type { AgentTemplate } from '../templates/types'
import type { TurnReview } from '@codebuff/common/constants/turn-review'
import type { DbSpies } from '@codebuff/common/testing/mocks/database'

const REVIEW = {
  verdict: 'needs_changes',
  reason: "The retry wrapper isn't needed.",
  actions: [
    { kind: 'fix', label: 'Cut the retry wrapper', prompt: 'Inline the one-use retry wrapper.' },
    { kind: 'next', label: 'Add a test', prompt: 'Add a test for the stall.' },
  ],
  nextPrompt: 'Cut the retry wrapper, then add a test for the stall.',
}

const template = {
  id: 'test-agent',
  displayName: 'Test Agent',
  spawnerPrompt: 'Testing',
  model: 'claude-3-5-sonnet-20241022',
  inputSchema: {},
  outputMode: 'last_message',
  includeMessageHistory: true,
  inheritParentSystemPrompt: false,
  mcpServers: {},
  toolNames: ['end_turn'],
  spawnableAgents: [],
  systemPrompt: 'Test system prompt',
  instructionsPrompt: '',
  stepPrompt: '',
  handleSteps: undefined,
} satisfies AgentTemplate as AgentTemplate

const textOf = (message: { content: unknown }): string =>
  Array.isArray(message.content)
    ? message.content.map((part: any) => part.text ?? '').join('\n')
    : String(message.content ?? '')

describe('turn review', () => {
  let dbSpies: DbSpies
  let runtimeImpl: any
  let agentRequests: any[]
  let reviewRequests: any[]
  let reviewReply: string

  const run = async (options: {
    onTurnReview?: (review: TurnReview) => void
    parentId?: string
    logged?: any[]
  }) => {
    const { agentTemplate: _, localAgentTemplates: __, ...base } =
      createTestAgentRuntimeParams()
    runtimeImpl = { ...base }
    if (options.logged) {
      const logged = options.logged
      runtimeImpl.logger = { ...base.logger, info: (data: unknown) => logged.push(data) }
    }
    runtimeImpl.promptAiSdkStream = mock(async function* (params: any) {
      if (params.extraCodebuffMetadata?.turn_review === '1') {
        reviewRequests.push(params)
        yield { type: 'text' as const, text: reviewReply }
        return promptSuccess('review-id')
      }
      agentRequests.push(params)
      yield { type: 'text' as const, text: 'Done: the stall is fixed.' }
      yield createToolCallChunk('end_turn', {}) as any
      return promptSuccess('agent-id')
    })
    const result = await loopAgentSteps({
      ...runtimeImpl,
      agentType: template.id,
      localAgentTemplates: { [template.id]: template },
      repoId: undefined,
      repoUrl: undefined,
      userInputId: 'test-user-input',
      agentState: {
        ...getInitialSessionState(mockFileContext).mainAgentState,
        agentId: 'test-agent-id',
        messageHistory: [userMessage('an earlier request')],
        output: undefined,
        stepsRemaining: 5,
        ...(options.parentId ? { parentId: options.parentId } : {}),
      },
      prompt: 'Fix the stall',
      spawnParams: undefined,
      fingerprintId: 'test-fingerprint',
      fileContext: mockFileContext,
      userId: TEST_USER_ID,
      clientSessionId: 'test-session',
      ancestorRunIds: [],
      extraCodebuffMetadata: { trace_session_id: 'thread-1' },
      onResponseChunk: () => {},
      signal: new AbortController().signal,
      ...(options.onTurnReview ? { onTurnReview: options.onTurnReview } : {}),
    } as any)
    // The review runs in the background, after the loop returned.
    await new Promise((resolve) => setTimeout(resolve, 10))
    return result
  }

  beforeEach(() => {
    agentRequests = []
    reviewRequests = []
    reviewReply = JSON.stringify(REVIEW)
    dbSpies = setupDbSpies(createMockDbOperations())
    spyOn(analytics, 'trackEvent').mockImplementation(() => {})
  })

  afterEach(() => {
    if (runtimeImpl) clearAgentGeneratorCache(runtimeImpl)
    dbSpies.restore()
    mock.restore()
  })

  it("asks the agent's own prefix for a review and never keeps it", async () => {
    const reviews: TurnReview[] = []
    const result = await run({ onTurnReview: (review) => reviews.push(review) })

    expect(reviews).toEqual([REVIEW as TurnReview])
    expect(reviewRequests).toHaveLength(1)
    const review = reviewRequests[0]
    const agent = agentRequests.at(-1)
    // Same system prompt and tools as the agent's own request: the cache hits.
    expect(review.messages[0]).toEqual(agent.messages[0])
    expect(Object.keys(review.tools)).toEqual(Object.keys(agent.tools))
    expect(textOf(review.messages.at(-1))).toContain(TURN_REVIEW_PROMPT)
    expect(review.messages.map(textOf).join('\n')).toContain('Done: the stall is fixed.')
    expect(
      result.agentState.messageHistory.map(textOf).join('\n'),
    ).not.toContain(TURN_REVIEW_PROMPT)
  })

  it('asks nothing without a host callback, or for a subagent', async () => {
    await run({})
    await run({ onTurnReview: () => {}, parentId: 'parent-run' })
    expect(reviewRequests).toHaveLength(0)
  })

  it('reports nothing for a reply that holds no review', async () => {
    reviewReply = 'I think it is fine.'
    const reviews: TurnReview[] = []
    const logged: any[] = []
    await run({ onTurnReview: (review) => reviews.push(review), logged })
    expect(reviews).toHaveLength(0)
    expect(logged.find((row) => row.axiomEvent === 'turn_review')).toMatchObject({
      outcome: 'unrecognized',
      action_count: 0,
    })
  })
})

describe('parseTurnReview', () => {
  it('reads the JSON past thinking and prose', () => {
    expect(
      parseTurnReview(`<think>{"verdict":"x"}</think>Here: ${JSON.stringify(REVIEW)}`),
    ).toEqual(REVIEW as TurnReview)
  })

  it('drops unknown verdicts and their reason, empty actions and extras past the limit', () => {
    const actions = Array.from({ length: 8 }, (_, i) => ({ label: `A${i}`, prompt: `P${i}` }))
    expect(
      parseTurnReview(
        JSON.stringify({ verdict: 'maybe', reason: 'why', actions: [{ label: '', prompt: 'x' }, ...actions] }),
      ),
    ).toEqual({
      verdict: null,
      reason: null,
      // An action with no known kind is a next step.
      actions: actions.slice(0, 5).map((action) => ({ ...action, kind: 'next' })),
      nextPrompt: null,
    })
  })

  it('is null for no review at all', () => {
    expect(parseTurnReview('{"verdict": null, "actions": []}')).toBeNull()
    // A recommended next message alone is still a review.
    expect(parseTurnReview('{"verdict": null, "actions": [], "nextPrompt": "Add a test."}'))
      .toEqual({ verdict: null, reason: null, actions: [], nextPrompt: 'Add a test.' })
    expect(parseTurnReview('not json')).toBeNull()
  })
})
