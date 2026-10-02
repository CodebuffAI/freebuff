import { TEST_USER_ID } from '@codebuff/common/old-constants'
import { TEST_AGENT_RUNTIME_IMPL } from '@codebuff/common/testing/impl/agent-runtime'
import { getInitialSessionState } from '@codebuff/common/types/session-state'
import { promptSuccess } from '@codebuff/common/util/error'
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from 'bun:test'

import { createToolCallChunk, mockFileContext } from './test-utils'
import * as webApi from '../llm-api/codebuff-web-api'
import { runAgentStep } from '../run-agent-step'
import { assembleLocalAgentTemplates } from '../templates/agent-registry'

import type {
  AgentRuntimeDeps,
  AgentRuntimeScopedDeps,
} from '@codebuff/common/types/contracts/agent-runtime'
import type { ParamsExcluding } from '@codebuff/common/types/function-params'
import type { StreamChunk } from '@codebuff/common/types/contracts/llm'
import type { PrintModeEvent } from '@codebuff/common/types/print-mode'

let agentRuntimeImpl: AgentRuntimeDeps & AgentRuntimeScopedDeps
let runAgentStepBaseParams: ParamsExcluding<
  typeof runAgentStep,
  'localAgentTemplates' | 'agentState' | 'prompt' | 'agentTemplate'
>

function mockAgentStream(chunks: StreamChunk[]) {
  runAgentStepBaseParams.promptAiSdkStream = async function* ({}) {
    for (const chunk of chunks) {
      yield chunk
    }
    return promptSuccess('mock-message-id')
  }
}

const gravityTestAgent = {
  id: 'gravity-test-agent',
  displayName: 'Gravity Test Agent',
  model: 'openai/gpt-4o-mini',
  toolNames: ['gravity_index', 'render_ui', 'end_turn'],
  systemPrompt: 'Use Gravity Index when choosing developer services.',
}

describe('gravity_index tool', () => {
  beforeEach(() => {
    agentRuntimeImpl = {
      ...TEST_AGENT_RUNTIME_IMPL,
    }
    runAgentStepBaseParams = {
      ...agentRuntimeImpl,
      additionalToolDefinitions: () => Promise.resolve({}),
      agentType: 'gravity-test-agent',
      ancestorRunIds: [],
      clientSessionId: 'test-session',
      fileContext: {
        ...mockFileContext,
        agentTemplates: { 'gravity-test-agent': gravityTestAgent },
      },
      fingerprintId: 'test-fingerprint',
      onResponseChunk: () => {},
      repoId: undefined,
      repoUrl: undefined,
      runId: 'test-run-id',
      signal: new AbortController().signal,
      spawnParams: undefined,
      system: 'Test system prompt',
      tools: {},
      userId: TEST_USER_ID,
      userInputId: 'test-input',
    }

    runAgentStepBaseParams.requestFiles = async () => ({})
    runAgentStepBaseParams.requestOptionalFile = async () => null
    runAgentStepBaseParams.requestToolCall = async () => ({
      output: [{ type: 'json', value: 'Tool call success' }],
    })
    runAgentStepBaseParams.promptAiSdk = async function () {
      return promptSuccess('Test response')
    }
  })

  afterEach(() => {
    mock.restore()
  })

  test('calls Gravity Index facade with the query', async () => {
    const spy = spyOn(webApi, 'callGravityIndexAPI').mockResolvedValue({
      result: {
        search_id: 'search-1',
        recommendation: { name: 'SendGrid', slug: 'sendgrid' },
        credential_request: {
          setup_url: 'https://index.trygravity.ai/go/test',
          required_env_vars: ['SENDGRID_API_KEY'],
        },
        click_url: 'https://index.trygravity.ai/go/test',
      },
    })

    mockAgentStream([
      createToolCallChunk('gravity_index', {
        action: 'search',
        query: 'transactional email for Next.js',
      }),
      createToolCallChunk('end_turn', {}),
    ])

    const sessionState = getInitialSessionState(
      runAgentStepBaseParams.fileContext,
    )
    const agentState = {
      ...sessionState.mainAgentState,
      agentType: 'gravity-test-agent',
    }
    const { agentTemplates } = assembleLocalAgentTemplates({
      ...agentRuntimeImpl,
      fileContext: runAgentStepBaseParams.fileContext,
    })

    await runAgentStep({
      ...runAgentStepBaseParams,
      localAgentTemplates: agentTemplates,
      agentTemplate: agentTemplates['gravity-test-agent'],
      agentState,
      prompt: 'Find an email provider',
    })

    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          action: 'search',
          query: 'transactional email for Next.js',
          external_session_id: 'test-session',
          metadata: expect.objectContaining({
            surface: 'codebuff_cli',
            tool_call_id: expect.any(String),
            agent_step_id: expect.any(String),
            fingerprint_id: 'test-fingerprint',
            user_input_id: 'test-input',
          }),
        }),
      }),
    )
    // CLI traffic must NOT forward external_user_id; the web API attributes it
    // to the real API-key owner instead.
    expect(spy.mock.calls[0]?.[0]?.input).not.toHaveProperty('external_user_id')
  })

  test('tags base-chat traffic with the freebuff_chat surface', async () => {
    const spy = spyOn(webApi, 'callGravityIndexAPI').mockResolvedValue({
      result: { search_id: 'search-1' },
    })

    mockAgentStream([
      createToolCallChunk('gravity_index', {
        action: 'search',
        query: 'transactional email for Next.js',
      }),
      createToolCallChunk('end_turn', {}),
    ])

    const fileContext = {
      ...mockFileContext,
      agentTemplates: {
        'base-chat': {
          ...gravityTestAgent,
          id: 'base-chat',
          displayName: 'Freebuff Chat',
        },
      },
    }
    const sessionState = getInitialSessionState(fileContext)
    const agentState = {
      ...sessionState.mainAgentState,
      agentType: 'base-chat',
    }
    const { agentTemplates } = assembleLocalAgentTemplates({
      ...agentRuntimeImpl,
      fileContext,
    })

    await runAgentStep({
      ...runAgentStepBaseParams,
      agentType: 'base-chat',
      fileContext,
      localAgentTemplates: agentTemplates,
      agentTemplate: agentTemplates['base-chat'],
      agentState,
      prompt: 'Find an email provider',
    })

    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          external_user_id: 'test-fingerprint',
          metadata: expect.objectContaining({
            surface: 'freebuff_chat',
          }),
        }),
      }),
    )
  })

  // Freebuff Desktop's thread agents run on the user's own key, so they attribute like the CLI (no
  // external_user_id) but under their own label, not as CLI traffic.
  test.each([
    'freebuff-desktop-thread-local-v3',
    'freebuff-desktop-thread-worktree',
  ])(
    'tags %s traffic with the freebuff_desktop surface and no external_user_id',
    async (rootAgentId) => {
      const spy = spyOn(webApi, 'callGravityIndexAPI').mockResolvedValue({
        result: { search_id: 'search-1' },
      })

      mockAgentStream([
        createToolCallChunk('gravity_index', {
          action: 'search',
          query: 'transactional email for Next.js',
        }),
        createToolCallChunk('end_turn', {}),
      ])

      const fileContext = {
        ...mockFileContext,
        agentTemplates: {
          [rootAgentId]: {
            ...gravityTestAgent,
            id: rootAgentId,
            displayName: 'Freebuff',
          },
        },
      }
      const sessionState = getInitialSessionState(fileContext)
      const agentState = {
        ...sessionState.mainAgentState,
        agentType: rootAgentId,
      }
      const { agentTemplates } = assembleLocalAgentTemplates({
        ...agentRuntimeImpl,
        fileContext,
      })

      await runAgentStep({
        ...runAgentStepBaseParams,
        agentType: rootAgentId,
        fileContext,
        localAgentTemplates: agentTemplates,
        agentTemplate: agentTemplates[rootAgentId],
        agentState,
        prompt: 'Find an email provider',
      })

      const input = spy.mock.calls[0]?.[0]?.input
      expect(input).toMatchObject({ metadata: { surface: 'freebuff_desktop' } })
      expect(input).not.toHaveProperty('external_user_id')
    },
  )

  // Both freebuff Web root families, because the harness swap changed the id
  // prefix: a base3 root that fell through to `codebuff_cli` would attribute
  // Web clicks to the CLI and would stop forwarding the per-end-user id that
  // keeps the shared service account from collapsing every user into one.
  test.each(['base2-free-deepseek', 'base3-free-deepseek'])(
    'tags %s traffic with the freebuff_web surface and forwards external_user_id',
    async (rootAgentId) => {
      const spy = spyOn(webApi, 'callGravityIndexAPI').mockResolvedValue({
        result: { search_id: 'search-1' },
      })

      mockAgentStream([
        createToolCallChunk('gravity_index', {
          action: 'search',
          query: 'transactional email for Next.js',
        }),
        createToolCallChunk('end_turn', {}),
      ])

      const fileContext = {
        ...mockFileContext,
        agentTemplates: {
          [rootAgentId]: {
            ...gravityTestAgent,
            id: rootAgentId,
            displayName: 'Buffy on DeepSeek',
          },
        },
      }
      const sessionState = getInitialSessionState(fileContext)
      const agentState = {
        ...sessionState.mainAgentState,
        agentType: rootAgentId,
      }
      const { agentTemplates } = assembleLocalAgentTemplates({
        ...agentRuntimeImpl,
        fileContext,
      })

      await runAgentStep({
        ...runAgentStepBaseParams,
        agentType: rootAgentId,
        fileContext,
        localAgentTemplates: agentTemplates,
        agentTemplate: agentTemplates[rootAgentId],
        agentState,
        prompt: 'Find an email provider',
      })

      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({
          input: expect.objectContaining({
            // Freebuff Web runs under a shared service account, so the handler
            // forwards the stable per-end-user signal (fingerprintId) for
            // attribution instead of letting it collapse onto the service account.
            external_user_id: 'test-fingerprint',
            metadata: expect.objectContaining({
              surface: 'freebuff_web',
            }),
          }),
        }),
      )
    },
  )

  test('stores results without rendering until the agent selects a service', async () => {
    spyOn(webApi, 'callGravityIndexAPI').mockResolvedValue({
      result: {
        search_id: 'search-1',
        recommendation: {
          name: 'SendGrid',
          slug: 'sendgrid',
          category: 'Email',
          click_url: 'https://index.trygravity.ai/go/recommendation-fallback',
        },
        reasoning: 'Good transactional email fit.',
        credential_request: {
          setup_url: 'https://index.trygravity.ai/go/test',
          required_env_vars: ['SENDGRID_API_KEY'],
        },
        click_url: 'https://index.trygravity.ai/go/test',
      },
    })

    mockAgentStream([
      createToolCallChunk('gravity_index', {
        action: 'search',
        query: 'transactional email for Next.js',
      }),
      createToolCallChunk('end_turn', {}),
    ])

    const sessionState = getInitialSessionState(
      runAgentStepBaseParams.fileContext,
    )
    const agentState = {
      ...sessionState.mainAgentState,
      agentType: 'gravity-test-agent',
    }
    const { agentTemplates } = assembleLocalAgentTemplates({
      ...agentRuntimeImpl,
      fileContext: runAgentStepBaseParams.fileContext,
    })

    const { agentState: newAgentState } = await runAgentStep({
      ...runAgentStepBaseParams,
      localAgentTemplates: agentTemplates,
      agentTemplate: agentTemplates['gravity-test-agent'],
      agentState,
      prompt: 'Find an email provider',
    })

    const toolMsgs = newAgentState.messageHistory.filter(
      (m) => m.role === 'tool' && m.toolName === 'gravity_index',
    )
    expect(toolMsgs.length).toBeGreaterThan(0)
    const last = JSON.stringify(toolMsgs[toolMsgs.length - 1].content)
    expect(last).toContain('SendGrid')
    expect(last).toContain('https://index.trygravity.ai/go/test')

    expect(
      newAgentState.messageHistory
        .filter((message) => message.role === 'assistant')
        .flatMap((message) => message.content)
        .some(
          (part) => part.type === 'tool-call' && part.toolName === 'render_ui',
        ),
    ).toBe(false)

    mockAgentStream([
      createToolCallChunk('render_ui', {
        widget: {
          type: 'button',
          text: 'Get your SendGrid API key',
          link: {
            source: 'gravity_index',
            search_id: 'search-1',
            service_slug: 'sendgrid',
          },
          variant: 'primary',
        },
      }),
      createToolCallChunk('end_turn', {}),
    ])
    const responseChunks: (string | PrintModeEvent)[] = []

    const { agentState: renderedAgentState } = await runAgentStep({
      ...runAgentStepBaseParams,
      localAgentTemplates: agentTemplates,
      agentTemplate: agentTemplates['gravity-test-agent'],
      agentState: newAgentState,
      prompt: undefined,
      onResponseChunk: (chunk) => responseChunks.push(chunk),
    })

    const streamedRenderUICall = responseChunks.find(
      (chunk) =>
        typeof chunk !== 'string' &&
        chunk.type === 'tool_call' &&
        chunk.toolName === 'render_ui',
    )
    expect(streamedRenderUICall).toMatchObject({
      input: {
        widget: {
          link: 'https://index.trygravity.ai/go/recommendation-fallback',
        },
      },
    })

    const renderUICall = renderedAgentState.messageHistory
      .filter((message) => message.role === 'assistant')
      .flatMap((message) => message.content)
      .find(
        (part) => part.type === 'tool-call' && part.toolName === 'render_ui',
      )
    expect(renderUICall).toMatchObject({
      type: 'tool-call',
      toolName: 'render_ui',
      input: {
        widget: {
          type: 'button',
          text: 'Get your SendGrid API key',
          link: 'https://index.trygravity.ai/go/recommendation-fallback',
          variant: 'primary',
        },
      },
    })

    const renderUIResult = renderedAgentState.messageHistory.find(
      (message) => message.role === 'tool' && message.toolName === 'render_ui',
    )
    expect(renderUIResult).toMatchObject({
      content: [
        {
          type: 'json',
          value: {
            message: 'UI rendered.',
          },
        },
      ],
    })
  })

  test('fails closed before streaming an invalid Gravity button reference', async () => {
    mockAgentStream([
      createToolCallChunk('render_ui', {
        widget: {
          type: 'button',
          text: 'Open missing service',
          link: {
            source: 'gravity_index',
            search_id: 'missing-search',
            service_slug: 'missing-service',
          },
        },
      }),
      createToolCallChunk('end_turn', {}),
    ])

    const sessionState = getInitialSessionState(
      runAgentStepBaseParams.fileContext,
    )
    const agentState = {
      ...sessionState.mainAgentState,
      agentType: 'gravity-test-agent',
    }
    const { agentTemplates } = assembleLocalAgentTemplates({
      ...agentRuntimeImpl,
      fileContext: runAgentStepBaseParams.fileContext,
    })
    const responseChunks: (string | PrintModeEvent)[] = []

    const result = await runAgentStep({
      ...runAgentStepBaseParams,
      localAgentTemplates: agentTemplates,
      agentTemplate: agentTemplates['gravity-test-agent'],
      agentState,
      prompt: 'Render an invalid service',
      onResponseChunk: (chunk) => responseChunks.push(chunk),
    })

    expect(result.shouldEndTurn).toBe(false)
    expect(
      responseChunks.some(
        (chunk) =>
          typeof chunk !== 'string' &&
          chunk.type === 'error' &&
          chunk.message.includes('Invalid Gravity button reference'),
      ),
    ).toBe(true)
    expect(
      responseChunks.some(
        (chunk) =>
          typeof chunk !== 'string' &&
          (chunk.type === 'tool_call' || chunk.type === 'tool_result') &&
          chunk.toolName === 'render_ui',
      ),
    ).toBe(false)
  })

  test('surfaces API errors in tool output', async () => {
    spyOn(webApi, 'callGravityIndexAPI').mockResolvedValue({
      error: 'Gravity Index is not configured',
    })

    mockAgentStream([
      createToolCallChunk('gravity_index', {
        action: 'search',
        query: 'transactional email for Next.js',
      }),
      createToolCallChunk('end_turn', {}),
    ])

    const sessionState = getInitialSessionState(
      runAgentStepBaseParams.fileContext,
    )
    const agentState = {
      ...sessionState.mainAgentState,
      agentType: 'gravity-test-agent',
    }
    const { agentTemplates } = assembleLocalAgentTemplates({
      ...agentRuntimeImpl,
      fileContext: runAgentStepBaseParams.fileContext,
    })

    const { agentState: newAgentState } = await runAgentStep({
      ...runAgentStepBaseParams,
      localAgentTemplates: agentTemplates,
      agentTemplate: agentTemplates['gravity-test-agent'],
      agentState,
      prompt: 'Find an email provider',
    })

    const toolMsgs = newAgentState.messageHistory.filter(
      (m) => m.role === 'tool' && m.toolName === 'gravity_index',
    )
    const last = JSON.stringify(toolMsgs[toolMsgs.length - 1].content)
    expect(last).toContain('errorMessage')
    expect(last).toContain('Gravity Index is not configured')
  })

  test('passes non-search actions through the unified facade', async () => {
    const spy = spyOn(webApi, 'callGravityIndexAPI').mockResolvedValue({
      result: {
        services: [{ name: 'SendGrid', slug: 'sendgrid' }],
        total: 1,
      },
    })

    mockAgentStream([
      createToolCallChunk('gravity_index', {
        action: 'browse',
        category: 'Email',
        q: 'send',
      }),
      createToolCallChunk('end_turn', {}),
    ])

    const sessionState = getInitialSessionState(
      runAgentStepBaseParams.fileContext,
    )
    const agentState = {
      ...sessionState.mainAgentState,
      agentType: 'gravity-test-agent',
    }
    const { agentTemplates } = assembleLocalAgentTemplates({
      ...agentRuntimeImpl,
      fileContext: runAgentStepBaseParams.fileContext,
    })

    await runAgentStep({
      ...runAgentStepBaseParams,
      localAgentTemplates: agentTemplates,
      agentTemplate: agentTemplates['gravity-test-agent'],
      agentState,
      prompt: 'Browse email providers',
    })

    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          action: 'browse',
          category: 'Email',
          q: 'send',
        }),
      }),
    )
  })
})
