import * as analytics from '@codebuff/common/analytics'
import {
  MAX_AGENT_STEP_ROWS,
  MAX_AGENT_STEPS_DEFAULT,
  MAX_SUBAGENT_STEPS_DEFAULT,
} from '@codebuff/common/constants/agents'
import { TEST_USER_ID } from '@codebuff/common/old-constants'
import { createTestAgentRuntimeParams } from '@codebuff/common/testing/fixtures/agent-runtime'
import {
  createMockDbOperations,
  setupDbSpies,
} from '@codebuff/common/testing/mocks/database'
import { getInitialSessionState } from '@codebuff/common/types/session-state'
import { promptSuccess } from '@codebuff/common/util/error'
import { userMessage } from '@codebuff/common/util/messages'
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from 'bun:test'

import { loopAgentSteps } from '../run-agent-step'
import { createAgentState } from '../tools/handlers/tool/spawn-agent-utils'
import {
  NO_PROGRESS_STOP_MESSAGE,
  NO_PROGRESS_STOP_THRESHOLD,
} from '../util/turn-progress'
import { createToolCallChunk, mockFileContext } from './test-utils'

import type { AgentTemplate } from '../templates/types'
import type { DbSpies } from '@codebuff/common/testing/mocks/database'
import type { StepGenerator } from '@codebuff/common/types/agent-template'
import type { AgentState } from '@codebuff/common/types/session-state'

const OLD_CEILING = 200
const CEILING_MESSAGE = "I've made quite a few responses in a row."

describe('the step budget of a turn', () => {
  let template: AgentTemplate
  let agentState: AgentState
  let chunks: string[]
  let dbSpies: DbSpies
  let params: Parameters<typeof loopAgentSteps>[0]

  beforeEach(() => {
    const {
      agentTemplate: _,
      localAgentTemplates: __,
      ...runtime
    } = createTestAgentRuntimeParams()
    dbSpies = setupDbSpies(createMockDbOperations())
    spyOn(analytics, 'trackEvent').mockImplementation(() => {})
    chunks = []

    template = {
      id: 'test-agent',
      displayName: 'Test Agent',
      spawnerPrompt: 'Testing',
      model: 'claude-3-5-sonnet-20241022',
      inputSchema: {},
      outputMode: 'last_message',
      includeMessageHistory: true,
      inheritParentSystemPrompt: false,
      mcpServers: {},
      toolNames: [
        'run_terminal_command',
        'read_files',
        'write_file',
        'end_turn',
      ],
      spawnableAgents: [],
      systemPrompt: 'Test system prompt',
      instructionsPrompt: 'Test user prompt',
      stepPrompt: 'Test agent step prompt',
      handleSteps: undefined,
    } satisfies AgentTemplate as AgentTemplate

    agentState = {
      ...getInitialSessionState(mockFileContext).mainAgentState,
      agentId: 'test-agent-id',
      messageHistory: [userMessage('Initial message')],
      output: undefined,
    }

    params = {
      ...runtime,
      agentType: 'test-agent',
      localAgentTemplates: { 'test-agent': template },
      repoId: undefined,
      repoUrl: undefined,
      userInputId: 'test-user-input',
      agentState,
      prompt: 'Test prompt',
      spawnParams: undefined,
      fingerprintId: 'test-fingerprint',
      fileContext: mockFileContext,
      userId: TEST_USER_ID,
      clientSessionId: 'test-session',
      ancestorRunIds: [],
      onResponseChunk: (chunk) => {
        if (typeof chunk === 'string') chunks.push(chunk)
      },
      signal: new AbortController().signal,
      // Every command answers with one fixed line unless a test says otherwise.
      requestToolCall: async () => ({
        output: [{ type: 'json', value: { stdout: 'waiting' } }],
      }),
      requestOptionalFile: async () => null,
    }
  })

  afterEach(() => {
    dbSpies.restore()
    mock.restore()
  })

  const stuckStream = (onCall: () => void): typeof params.promptAiSdkStream =>
    async function* () {
      onCall()
      yield createToolCallChunk('run_terminal_command', { command: 'ls' })
      return promptSuccess('stuck')
    }

  it('keeps the ceiling inside what a run can persist, and the subagent ceiling at most the root one', () => {
    expect(MAX_AGENT_STEPS_DEFAULT).toBeGreaterThan(OLD_CEILING)
    expect(MAX_AGENT_STEPS_DEFAULT).toBeLessThan(MAX_AGENT_STEP_ROWS)
    expect(MAX_SUBAGENT_STEPS_DEFAULT).toBeLessThanOrEqual(
      MAX_AGENT_STEPS_DEFAULT,
    )
    expect(agentState.stepsRemaining).toBe(MAX_AGENT_STEPS_DEFAULT)
  })

  it('lets a productive turn run past the old cap and finish on its own', async () => {
    const lastStep = OLD_CEILING + 50
    let calls = 0
    const result = await loopAgentSteps({
      ...params,
      promptAiSdkStream: async function* () {
        calls++
        if (calls >= lastStep) {
          yield { type: 'text' as const, text: 'All done.' }
          yield createToolCallChunk('end_turn', {})
        } else {
          yield createToolCallChunk('write_file', {
            path: `src/file-${calls}.ts`,
            instructions: 'Write it',
            content: `export const value = ${calls}\n`,
          })
        }
        return promptSuccess(`step-${calls}`)
      },
    })

    expect(calls).toBe(lastStep)
    expect(result.output.type).not.toBe('error')
    expect(chunks.join('')).not.toContain(NO_PROGRESS_STOP_MESSAGE)
    expect(chunks.join('')).not.toContain(CEILING_MESSAGE)
  })

  it('does not count a long reading stretch against a turn still changing files', async () => {
    let calls = 0
    const stretch = NO_PROGRESS_STOP_THRESHOLD - 1
    const lastStep = (stretch + 1) * 3
    await loopAgentSteps({
      ...params,
      promptAiSdkStream: async function* () {
        calls++
        if (calls >= lastStep) {
          yield createToolCallChunk('end_turn', {})
        } else if (calls % (stretch + 1) === 0) {
          yield createToolCallChunk('write_file', {
            path: 'src/a.ts',
            instructions: 'Update it',
            content: `export const value = ${calls}\n`,
          })
        } else {
          // the same command, the same answer: nothing new between the edits
          yield createToolCallChunk('run_terminal_command', { command: 'ls' })
        }
        return promptSuccess(`step-${calls}`)
      },
    })

    expect(calls).toBe(lastStep)
    expect(chunks.join('')).not.toContain(NO_PROGRESS_STOP_MESSAGE)
  })

  it('ends a stuck turn early, as a finished turn that says why', async () => {
    let calls = 0
    const finishAgentRun = mock(async () => {})
    const result = await loopAgentSteps({
      ...params,
      finishAgentRun,
      promptAiSdkStream: stuckStream(() => calls++),
    })

    // The first call's answer is new; the next 40 are not.
    expect(calls).toBe(NO_PROGRESS_STOP_THRESHOLD + 1)
    expect(chunks.join('')).toContain(NO_PROGRESS_STOP_MESSAGE)
    expect(result.output.type).not.toBe('error')
    expect(result.agentState.messageHistory.at(-1)).toMatchObject({
      role: 'assistant',
      content: [{ type: 'text', text: NO_PROGRESS_STOP_MESSAGE }],
    })
    expect(finishAgentRun).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'completed' }),
    )
    expect(result.agentState.stepsRemaining).toBe(
      MAX_AGENT_STEPS_DEFAULT - calls,
    )
  })

  it('takes a new prompt after a stop, with a fresh count', async () => {
    let calls = 0
    const stopped = await loopAgentSteps({
      ...params,
      promptAiSdkStream: stuckStream(() => calls++),
    })

    let resumed = 0
    await loopAgentSteps({
      ...params,
      agentState: stopped.agentState,
      prompt: 'Try something else',
      promptAiSdkStream: async function* () {
        resumed++
        if (resumed >= 3) yield createToolCallChunk('end_turn', {})
        else
          yield createToolCallChunk('run_terminal_command', { command: 'ls' })
        return promptSuccess(`resumed-${resumed}`)
      },
    })
    expect(resumed).toBe(3)
  })

  it('gives a message sent mid-turn a fresh count', async () => {
    let calls = 0
    const sendAt = NO_PROGRESS_STOP_THRESHOLD - 1
    let sent = false
    await loopAgentSteps({
      ...params,
      drainSteeringMessages: async () => {
        if (calls !== sendAt || sent) return []
        sent = true
        return ['How is it going?']
      },
      promptAiSdkStream: stuckStream(() => calls++),
    })

    expect(calls).toBe(sendAt + NO_PROGRESS_STOP_THRESHOLD)
  })

  it('still enforces the ceiling on a turn that always looks productive', async () => {
    let calls = 0
    const result = await loopAgentSteps({
      ...params,
      requestToolCall: async () => ({
        output: [{ type: 'json', value: { stdout: `line ${calls}` } }],
      }),
      promptAiSdkStream: async function* () {
        calls++
        yield createToolCallChunk('run_terminal_command', { command: 'ls' })
        return promptSuccess(`step-${calls}`)
      },
    })

    expect(calls).toBe(MAX_AGENT_STEPS_DEFAULT)
    expect(chunks.join('')).toContain(CEILING_MESSAGE)
    expect(chunks.join('')).not.toContain(NO_PROGRESS_STOP_MESSAGE)
    expect(result.agentState.stepsRemaining).toBe(0)
  }, 60_000)

  it('leaves a caller-set budget alone', async () => {
    let calls = 0
    await loopAgentSteps({
      ...params,
      agentState: { ...agentState, stepsRemaining: 5 },
      promptAiSdkStream: stuckStream(() => calls++),
    })

    expect(calls).toBe(5)
    expect(chunks.join('')).toContain(CEILING_MESSAGE)
  })

  it('does not apply to a subagent, which keeps its own ceiling', async () => {
    const subagent = createAgentState(
      'test-agent',
      template,
      agentState,
      {},
      { toolCallId: 'spawn-call' },
    )
    expect(subagent.stepsRemaining).toBe(MAX_SUBAGENT_STEPS_DEFAULT)
    expect(subagent.parentId).toBe(agentState.agentId)

    const budget = NO_PROGRESS_STOP_THRESHOLD + 10
    let calls = 0
    await loopAgentSteps({
      ...params,
      agentState: { ...subagent, stepsRemaining: budget },
      promptAiSdkStream: stuckStream(() => calls++),
    })

    expect(calls).toBe(budget)
    expect(chunks.join('')).not.toContain(NO_PROGRESS_STOP_MESSAGE)
    expect(chunks.join('')).toContain(CEILING_MESSAGE)
  })

  it('does not apply to a programmatic root, whose work happens outside these steps', async () => {
    template.handleSteps = function* () {
      for (let i = 0; i < NO_PROGRESS_STOP_THRESHOLD + 5; i++) {
        yield 'STEP'
      }
    } as unknown as () => StepGenerator

    let calls = 0
    await loopAgentSteps({
      ...params,
      agentState: { ...agentState, stepsRemaining: 60 },
      promptAiSdkStream: stuckStream(() => calls++),
    })

    expect(calls).toBe(NO_PROGRESS_STOP_THRESHOLD + 5)
    expect(chunks.join('')).not.toContain(NO_PROGRESS_STOP_MESSAGE)
  })
})
