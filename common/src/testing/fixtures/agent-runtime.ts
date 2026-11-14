/**
 * Test fixtures for agent runtime testing.
 *
 * Provides pre-built test fixtures and factory functions for
 * testing agent runtime components without needing to set up
 * all the dependencies manually.
 *
 * @example
 * ```typescript
 * import {
 *   createTestAgentRuntimeParams,
 *   createTestAgentRuntimeDeps,
 *   mockFileContext,
 * } from '@codebuff/common/testing/fixtures/agent-runtime'
 *
 * const params = createTestAgentRuntimeParams()
 * const { agentTemplate, localAgentTemplates } = params
 * ```
 */

import { mock } from 'bun:test'

import { promptSuccess } from '../../util/error'

import type { ProjectFileContext } from '../../util/file'

export const mockFileContext: ProjectFileContext = {
  projectRoot: '/test',
  cwd: '/test',
  fileTree: [],
  fileTokenScores: {},
  knowledgeFiles: {},
  userKnowledgeFiles: {},
  agentTemplates: {},
  customToolDefinitions: {},
  gitChanges: {
    status: '',
    diff: '',
    diffCached: '',
    lastCommitMessages: '',
  },
  changesSinceLastChat: {},
  shellConfigFiles: {},
  systemInfo: {
    platform: 'test',
    shell: 'test',
    nodeVersion: 'test',
    arch: 'test',
    homedir: '/home/test',
    cpus: 1,
    chromeAvailable: false,
  },
}

/** @deprecated Use mockFileContext */
export const testFileContext: ProjectFileContext = mockFileContext

export const testLogger = {
  debug: () => {},
  error: () => {},
  info: () => {},
  warn: () => {},
}

export const testFetch = Object.assign(
  async () => {
    throw new Error('fetch not implemented in test runtime')
  },
  {
    preconnect: async () => {
      throw new Error('fetch.preconnect not implemented in test runtime')
    },
  },
)

export const testClientEnv = {
  NEXT_PUBLIC_CB_ENVIRONMENT: 'test' as const,
  NEXT_PUBLIC_CODEBUFF_APP_URL: 'https://test.codebuff.com',
  NEXT_PUBLIC_SUPPORT_EMAIL: 'support@codebuff.test',
  NEXT_PUBLIC_POSTHOG_API_KEY: 'test-posthog-key',
  NEXT_PUBLIC_POSTHOG_HOST_URL: 'https://test.posthog.com',
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: 'pk_test_123',
  NEXT_PUBLIC_STRIPE_CUSTOMER_PORTAL: 'https://test.stripe.com/portal',
  NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION_ID: undefined,
  NEXT_PUBLIC_WEB_PORT: 3000,
}

export const testCiEnv = {
  CI: undefined,
  GITHUB_ACTIONS: undefined,
  RENDER: undefined,
  IS_PULL_REQUEST: undefined,
  CODEBUFF_GITHUB_TOKEN: undefined,
  CODEBUFF_API_KEY: 'test-api-key',
}

/** @deprecated Use createTestAgentRuntimeParams() */
export const TEST_AGENT_RUNTIME_IMPL = Object.freeze({
  clientEnv: testClientEnv,
  ciEnv: testCiEnv,
  trackEvent: () => {},
  logger: testLogger,
  fetch: testFetch,
  getUserInfoFromApiKey: async <T extends string>({
    fields,
  }: {
    apiKey: string
    fields: readonly T[]
  }) => {
    const user = {
      id: 'test-user-id',
      email: 'test@example.com',
      name: null,
      discord_id: 'test-discord-id',
      stripe_customer_id: null,
      banned: false,
      created_at: new Date('2024-01-01T00:00:00Z'),
    } as const
    return Object.fromEntries(
      fields.map((field) => [field, user[field as keyof typeof user]]),
    ) as {
      [K in T]: (typeof user)[K & keyof typeof user]
    }
  },
  fetchAgentFromDatabase: async () => null,
  startAgentRun: async () => 'test-agent-run-id',
  finishAgentRun: async () => {},
  addAgentStep: async () => 'test-agent-step-id',
  consumeCreditsWithFallback: async () => {
    throw new Error(
      'consumeCreditsWithFallback not implemented in test runtime',
    )
  },
  promptAiSdkStream: async function* () {
    throw new Error('promptAiSdkStream not implemented in test runtime')
  },
  promptAiSdk: async function () {
    throw new Error('promptAiSdk not implemented in test runtime')
  },
  promptAiSdkStructured: async function () {
    throw new Error('promptAiSdkStructured not implemented in test runtime')
  },
  databaseAgentCache: new Map(),
  handleStepsLogChunk: () => {
    throw new Error('handleStepsLogChunk not implemented in test runtime')
  },
  requestToolCall: () => {
    throw new Error('requestToolCall not implemented in test runtime')
  },
  requestMcpToolData: () => {
    throw new Error('requestMcpToolData not implemented in test runtime')
  },
  requestFiles: () => {
    throw new Error('requestFiles not implemented in test runtime')
  },
  requestOptionalFile: () => {
    throw new Error('requestOptionalFile not implemented in test runtime')
  },
  sendSubagentChunk: () => {
    throw new Error('sendSubagentChunk not implemented in test runtime')
  },
  sendAction: () => {
    throw new Error('sendAction not implemented in test runtime')
  },
  apiKey: 'test-api-key',
})

export interface TestAgentRuntimeParams {
  agentTemplate: {
    id: string
    displayName: string
    model: string
    inputSchema: Record<string, unknown>
    outputMode: string
    includeMessageHistory: boolean
    inheritParentSystemPrompt: boolean
    mcpServers: Record<string, unknown>
    toolNames: string[]
    spawnableAgents: string[]
    systemPrompt: string
    instructionsPrompt: string
    stepPrompt: string
  }
  localAgentTemplates: Record<string, TestAgentRuntimeParams['agentTemplate']>
  sendAction: ReturnType<typeof mock>
  requestFiles: ReturnType<typeof mock>
  requestToolCall: ReturnType<typeof mock>
  onResponseChunk: ReturnType<typeof mock>
  fileContext: ProjectFileContext
  promptAiSdkStream: ReturnType<typeof mock>
  promptAiSdk: ReturnType<typeof mock>
  promptAiSdkStructured: ReturnType<typeof mock>
  requestMcpToolData: ReturnType<typeof mock>
  startAgentRun: ReturnType<typeof mock>
  finishAgentRun: ReturnType<typeof mock>
  addAgentStep: ReturnType<typeof mock>
  logger: typeof testLogger
  trackEvent: ReturnType<typeof mock>
  clientEnv: typeof testClientEnv
  ciEnv: typeof testCiEnv
  apiKey: string
  fetch: typeof testFetch
  fetchAgentFromDatabase: ReturnType<typeof mock>
  databaseAgentCache: Map<string, null>
  consumeCreditsWithFallback: ReturnType<typeof mock>
  getUserInfoFromApiKey: ReturnType<typeof mock>
  handleStepsLogChunk: ReturnType<typeof mock>
  requestOptionalFile: ReturnType<typeof mock>
  sendSubagentChunk: ReturnType<typeof mock>
}

export function createTestAgentRuntimeParams(
  overrides: Partial<TestAgentRuntimeParams> = {},
): TestAgentRuntimeParams {
  const defaultTemplate: TestAgentRuntimeParams['agentTemplate'] = {
    id: 'test-agent',
    displayName: 'Test Agent',
    model: 'claude-3-5-sonnet-20241022',
    inputSchema: {},
    outputMode: 'last_message',
    includeMessageHistory: true,
    inheritParentSystemPrompt: false,
    mcpServers: {},
    toolNames: ['read_files', 'write_file', 'end_turn'],
    spawnableAgents: [],
    systemPrompt: 'You are a test agent.',
    instructionsPrompt: 'Help the user with testing.',
    stepPrompt: '',
  }

  const agentTemplate = overrides.agentTemplate ?? defaultTemplate

  return {
    agentTemplate,
    localAgentTemplates: overrides.localAgentTemplates ?? {
      'test-agent': agentTemplate,
    },
    sendAction: overrides.sendAction ?? mock(() => {}),
    requestFiles: overrides.requestFiles ?? mock(async () => ({})),
    requestToolCall:
      overrides.requestToolCall ??
      mock(async () => ({ success: true, result: 'mock result' })),
    onResponseChunk: overrides.onResponseChunk ?? mock(() => {}),
    fileContext: overrides.fileContext ?? mockFileContext,
    promptAiSdkStream:
      overrides.promptAiSdkStream ??
      mock(async function* () {
        yield { type: 'text' as const, text: 'Mock response\n\n' }
        yield {
          type: 'tool-call' as const,
          toolName: 'end_turn',
          toolCallId: 'mock-id',
          input: {},
        }
        return promptSuccess('mock-message-id')
      }),
    promptAiSdk: overrides.promptAiSdk ?? mock(async () => promptSuccess('Mock response')),
    promptAiSdkStructured:
      overrides.promptAiSdkStructured ?? mock(async () => promptSuccess({})),
    requestMcpToolData: overrides.requestMcpToolData ?? mock(async () => ({})),
    startAgentRun: overrides.startAgentRun ?? mock(async () => 'test-run-id'),
    finishAgentRun: overrides.finishAgentRun ?? mock(async () => {}),
    addAgentStep: overrides.addAgentStep ?? mock(async () => 'test-step-id'),
    logger: overrides.logger ?? testLogger,
    trackEvent: overrides.trackEvent ?? mock(() => {}),
    clientEnv: overrides.clientEnv ?? testClientEnv,
    ciEnv: overrides.ciEnv ?? testCiEnv,
    apiKey: overrides.apiKey ?? 'test-api-key',
    fetch: overrides.fetch ?? testFetch,
    fetchAgentFromDatabase:
      overrides.fetchAgentFromDatabase ?? mock(async () => null),
    databaseAgentCache: overrides.databaseAgentCache ?? new Map<string, null>(),
    consumeCreditsWithFallback:
      overrides.consumeCreditsWithFallback ?? mock(async () => {}),
    getUserInfoFromApiKey:
      overrides.getUserInfoFromApiKey ??
      mock(async () => ({
        id: 'test-user-id',
        email: 'test@example.com',
        name: null,
      })),
    handleStepsLogChunk: overrides.handleStepsLogChunk ?? mock(() => {}),
    requestOptionalFile:
      overrides.requestOptionalFile ?? mock(async () => null),
    sendSubagentChunk: overrides.sendSubagentChunk ?? mock(() => {}),
    ...overrides,
  }
}

export function createTestAgentRuntimeDeps(): Omit<
  TestAgentRuntimeParams,
  'agentTemplate' | 'localAgentTemplates'
> {
  return {
    sendAction: mock(() => {}),
    requestFiles: mock(async () => ({})),
    requestToolCall: mock(async () => ({
      success: true,
      result: 'mock result',
    })),
    onResponseChunk: mock(() => {}),
    fileContext: mockFileContext,
    promptAiSdkStream: mock(async function* () {
      yield { type: 'text' as const, text: 'Mock response\n\n' }
      yield {
        type: 'tool-call' as const,
        toolName: 'end_turn',
        toolCallId: 'mock-id',
        input: {},
      }
      return promptSuccess('mock-message-id')
    }),
    promptAiSdk: mock(async () => promptSuccess('Mock response')),
    promptAiSdkStructured: mock(async () => promptSuccess({})),
    requestMcpToolData: mock(async () => ({})),
    startAgentRun: mock(async () => 'test-run-id'),
    finishAgentRun: mock(async () => {}),
    addAgentStep: mock(async () => 'test-step-id'),
    logger: testLogger,
    trackEvent: mock(() => {}),
    clientEnv: testClientEnv,
    ciEnv: testCiEnv,
    apiKey: 'test-api-key',
    fetch: testFetch,
    fetchAgentFromDatabase: mock(async () => null),
    databaseAgentCache: new Map<string, null>(),
    consumeCreditsWithFallback: mock(async () => {}),
    getUserInfoFromApiKey: mock(async () => ({
      id: 'test-user-id',
      email: 'test@example.com',
      name: null,
    })),
    handleStepsLogChunk: mock(() => {}),
    requestOptionalFile: mock(async () => null),
    sendSubagentChunk: mock(() => {}),
  }
}
