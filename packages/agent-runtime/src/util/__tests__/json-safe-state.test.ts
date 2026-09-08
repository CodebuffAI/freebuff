import * as analytics from '@codebuff/common/analytics'
import { TEST_USER_ID } from '@codebuff/common/old-constants'
import { TEST_AGENT_RUNTIME_IMPL } from '@codebuff/common/testing/impl/agent-runtime'
import {
  createMockDbOperations,
  setupDbSpies,
} from '@codebuff/common/testing/mocks/database'
import { getInitialSessionState } from '@codebuff/common/types/session-state'
import { promptSuccess } from '@codebuff/common/util/error'
import { afterEach, describe, expect, spyOn, test } from 'bun:test'

import { loopAgentSteps } from '../../run-agent-step'

import type { AgentTemplate } from '../../templates/types'
import type { DbSpies } from '@codebuff/common/testing/mocks/database'
import type { ProjectFileContext } from '@codebuff/common/util/file'

/**
 * Application-tier regression test: toolDefinitions live in agent state
 * (persisted, snapshotted, shipped over the wire), so every stored
 * inputSchema must be plain JSON Schema. A live zod instance in state
 * serializes as {"def":{...}} internals instead of the declared schema.
 */

const CUSTOM_TOOL_NAME = 'declared_tool'

const baseFileContext: ProjectFileContext = {
  projectRoot: '/test',
  cwd: '/test',
  fileTree: [],
  fileTokenScores: {},
  knowledgeFiles: {},
  gitChanges: { status: '', diff: '', diffCached: '', lastCommitMessages: '' },
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
  agentTemplates: {},
  customToolDefinitions: {},
}

const makeAgent = (): AgentTemplate => ({
  id: 'json-safe-state-agent',
  displayName: 'JSON Safe State Agent',
  spawnerPrompt: 'Regression: state toolDefinitions stay JSON-safe',
  model: 'google/gemini-2.5-flash',
  inputSchema: {},
  outputMode: 'last_message' as const,
  includeMessageHistory: true,
  inheritParentSystemPrompt: false,
  mcpServers: {},
  toolNames: [CUSTOM_TOOL_NAME],
  spawnableAgents: [],
  systemPrompt: 'Test system prompt',
  instructionsPrompt: '',
  stepPrompt: '',
})

const makeFileContextWithDeclaredTool = (schema: unknown): ProjectFileContext =>
  ({
    ...baseFileContext,
    customToolDefinitions: {
      [CUSTOM_TOOL_NAME]: {
        description: 'A tool declared with a JSON Schema',
        inputSchema: schema,
      },
    },
  }) as ProjectFileContext

const runStepToPopulation = async (fileContext: ProjectFileContext) => {
  const agent = makeAgent()
  const sessionState = getInitialSessionState(baseFileContext)
  const agentState = sessionState.mainAgentState
  agentState.messageHistory = []

  await loopAgentSteps({
    ...(TEST_AGENT_RUNTIME_IMPL as never),
    sendAction: () => {},
    additionalToolDefinitions: () => Promise.resolve({}),
    ancestorRunIds: [],
    clientSessionId: 'json-safe-state-session',
    fileContext,
    fingerprintId: 'json-safe-state-fingerprint',
    onResponseChunk: () => {},
    repoId: undefined,
    repoUrl: undefined,
    runId: 'json-safe-state-run',
    signal: new AbortController().signal,
    spawnParams: undefined,
    system: 'Test system prompt',
    tools: {},
    userId: TEST_USER_ID,
    userInputId: 'json-safe-state-input',
    promptAiSdkStream: async function* () {
      yield { type: 'text' as const, text: 'response text' }
      return promptSuccess('mock-message-id')
    },
    agentType: agent.id,
    localAgentTemplates: { [agent.id]: agent },
    agentTemplate: agent,
    agentState,
    prompt: 'hello',
  } as never)

  return agentState
}

describe('agent state toolDefinitions serialization', () => {
  let dbSpies: DbSpies
  let analyticsSpy: ReturnType<typeof spyOn>

  afterEach(() => {
    dbSpies.restore()
    analyticsSpy.mockRestore()
  })

  test('stores_declared_json_schema_without_zod_internals', async () => {
    dbSpies = setupDbSpies(createMockDbOperations())
    analyticsSpy = spyOn(analytics, 'trackEvent').mockImplementation(() => {})
    const declaredSchema = {
      type: 'object',
      properties: { path: { type: 'string', description: 'The file path' } },
      required: ['path'],
    }

    const agentState = await runStepToPopulation(
      makeFileContextWithDeclaredTool(declaredSchema),
    )

    const toolDefs = agentState.toolDefinitions as Record<
      string,
      { inputSchema?: unknown }
    >
    expect(Object.keys(toolDefs)).toContain(CUSTOM_TOOL_NAME)

    const serialized = JSON.stringify(toolDefs[CUSTOM_TOOL_NAME].inputSchema)
    const roundTripped = JSON.parse(serialized) as { type?: string }
    expect(roundTripped.type).toBe('object')
    expect(serialized).not.toContain('"def"')
  })
})
