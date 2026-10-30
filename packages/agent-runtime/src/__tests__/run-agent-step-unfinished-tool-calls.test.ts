import * as analytics from '@codebuff/common/analytics'
import { TEST_USER_ID } from '@codebuff/common/old-constants'
import { TEST_AGENT_RUNTIME_IMPL } from '@codebuff/common/testing/impl/agent-runtime'
import {
  createMockDbOperations,
  setupDbSpies,
} from '@codebuff/common/testing/mocks/database'
import { getInitialSessionState } from '@codebuff/common/types/session-state'
import { promptSuccess } from '@codebuff/common/util/error'
import { assistantMessage, userMessage } from '@codebuff/common/util/messages'
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from 'bun:test'

import { runAgentStep } from '../run-agent-step'

import type { AgentTemplate } from '../templates/types'
import type { DbSpies } from '@codebuff/common/testing/mocks/database'
import type {
  AgentRuntimeDeps,
  AgentRuntimeScopedDeps,
} from '@codebuff/common/types/contracts/agent-runtime'
import type { Message } from '@codebuff/common/types/messages/codebuff-message'
import type { ParamsExcluding } from '@codebuff/common/types/function-params'
import type { ProjectFileContext } from '@codebuff/common/util/file'

const mockFileContext: ProjectFileContext = {
  projectRoot: '/test',
  cwd: '/test',
  fileTree: [],
  fileTokenScores: {},
  knowledgeFiles: {},
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
  agentTemplates: {},
  customToolDefinitions: {},
}

/**
 * A tool call with no tool result makes strict providers reject the request
 * ("An assistant message with 'tool_calls' must be followed by tool messages
 * responding to each 'tool_call_id'"). Since history is persisted and replayed,
 * one orphan left behind by an interrupted turn would fail every later turn, so
 * the step build must drop it and heal the stored history.
 */
describe('runAgentStep - unfinished tool calls', () => {
  let agentRuntimeImpl: AgentRuntimeDeps & AgentRuntimeScopedDeps
  let runAgentStepBaseParams: ParamsExcluding<
    typeof runAgentStep,
    | 'agentType'
    | 'prompt'
    | 'localAgentTemplates'
    | 'agentState'
    | 'agentTemplate'
  >
  let dbSpies: DbSpies
  let capturedMessages: Message[]

  const agent: AgentTemplate = {
    id: 'test-orphan-agent',
    displayName: 'Test Orphan Agent',
    spawnerPrompt: 'Testing unfinished tool call handling',
    model: 'deepseek/deepseek-v4-flash',
    inputSchema: {},
    outputMode: 'last_message' as const,
    includeMessageHistory: true,
    inheritParentSystemPrompt: false,
    mcpServers: {},
    toolNames: [],
    spawnableAgents: [],
    systemPrompt: 'Test system prompt',
    instructionsPrompt: '',
    stepPrompt: '',
  }

  beforeEach(() => {
    agentRuntimeImpl = { ...TEST_AGENT_RUNTIME_IMPL, sendAction: () => {} }
    dbSpies = setupDbSpies(createMockDbOperations())
    spyOn(analytics, 'trackEvent').mockImplementation(() => {})

    capturedMessages = []
    runAgentStepBaseParams = {
      ...agentRuntimeImpl,

      additionalToolDefinitions: () => Promise.resolve({}),
      ancestorRunIds: [],
      clientSessionId: 'test-session',
      fileContext: mockFileContext,
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
      promptAiSdkStream: async function* ({ messages }) {
        capturedMessages = messages
        yield { type: 'text' as const, text: 'response text' }
        return promptSuccess('mock-message-id')
      },
    }
  })

  afterEach(() => {
    dbSpies.restore()
    mock.restore()
  })

  const toolCallMessage = (toolCallId: string) =>
    assistantMessage({
      type: 'tool-call',
      toolCallId,
      toolName: 'read_files',
      input: { paths: ['README.md'] },
    })

  const toolResultMessage = (toolCallId: string): Message => ({
    role: 'tool',
    toolCallId,
    toolName: 'read_files',
    content: [{ type: 'json', value: { files: [] } }],
  })

  const runWithHistory = async (messageHistory: Message[]) => {
    const sessionState = getInitialSessionState(mockFileContext)
    const agentState = sessionState.mainAgentState
    agentState.messageHistory = messageHistory

    await runAgentStep({
      ...runAgentStepBaseParams,
      agentType: agent.id,
      localAgentTemplates: { [agent.id]: agent },
      agentTemplate: agent,
      agentState,
      prompt: undefined,
    })

    return agentState
  }

  const toolCallIds = (messages: Message[]) =>
    messages.flatMap((message) =>
      message.role === 'assistant' && Array.isArray(message.content)
        ? message.content
            .filter((part) => part.type === 'tool-call')
            .map((part) => (part as { toolCallId: string }).toolCallId)
        : [],
    )

  it('drops an orphaned tool call from the request', async () => {
    await runWithHistory([
      userMessage('do the thing'),
      toolCallMessage('answered'),
      toolResultMessage('answered'),
      toolCallMessage('interrupted'),
      userMessage('are you there?'),
    ])

    expect(toolCallIds(capturedMessages)).toEqual(['answered'])
  })

  it('heals the persisted history so later turns stop failing', async () => {
    const agentState = await runWithHistory([
      userMessage('do the thing'),
      toolCallMessage('interrupted'),
      userMessage('are you there?'),
    ])

    expect(toolCallIds(agentState.messageHistory)).toEqual([])
  })

  it('leaves a fully paired history untouched', async () => {
    await runWithHistory([
      userMessage('do the thing'),
      toolCallMessage('a'),
      toolResultMessage('a'),
      toolCallMessage('b'),
      toolResultMessage('b'),
    ])

    expect(toolCallIds(capturedMessages)).toEqual(['a', 'b'])
    expect(
      capturedMessages.filter((message) => message.role === 'tool'),
    ).toHaveLength(2)
  })

  it('stubs stale bulky read results but keeps small and newest ones verbatim', async () => {
    const readResult = (toolCallId: string, content: string): Message => ({
      role: 'tool',
      toolCallId,
      toolName: 'read_files',
      content: [{ type: 'json', value: [{ path: 'src/app.ts', content }] }],
    })
    const bigRead = (marker: string) => `${marker}\n`.repeat(1_000)
    const agentState = await runWithHistory([
      userMessage('do the thing'),
      // Five bulky reads (~17k each) so past-window savings clear the
      // pass's 20k floor; the newest-3 window is r3, r4 and the small
      // read, which rides along despite its size floor being separate.
      ...['first', 'second', 'third', 'fourth', 'fifth'].flatMap((name, i) => [
        toolCallMessage(`r${i}`),
        readResult(`r${i}`, bigRead(`const ${name} = ${i};`)),
      ]),
      toolCallMessage('small'),
      readResult('small', 'export const tiny = 1'),
      userMessage('are you there?'),
    ])

    const request = JSON.stringify(capturedMessages)
    // The three oldest bulky reads (newest-3 window = r3, r4, small) were
    // replaced by the omit stub already understood by getPreviouslyReadFiles
    // and the fitToolResults re-read hints...
    expect(request).not.toContain('const first = 0;')
    expect(request).not.toContain('const second = 1;')
    expect(request).not.toContain('const third = 2;')
    expect(request).toContain('contentOmittedForLength')
    // ...the two newest bulky reads stay verbatim...
    expect(request.split('const fourth = 3;').length).toBeGreaterThan(10)
    expect(request.split('const fifth = 4;').length).toBeGreaterThan(10)
    // ...and the small read rides along inside the window.
    expect(request).toContain('export const tiny = 1')
    // The stored history is healed to the same state.
    const stored = JSON.stringify(agentState.messageHistory)
    expect(stored).not.toContain('const first = 0;')
    expect(stored).toContain('export const tiny = 1')
  })
})
