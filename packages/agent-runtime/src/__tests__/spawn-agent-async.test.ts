import * as analytics from '@codebuff/common/analytics'
import { TEST_USER_ID } from '@codebuff/common/old-constants'
import { createTestAgentRuntimeParams } from '@codebuff/common/testing/fixtures/agent-runtime'
import {
  createMockDbOperations,
  setupDbSpies,
} from '@codebuff/common/testing/mocks/database'
import { getInitialSessionState } from '@codebuff/common/types/session-state'
import { AbortError, promptSuccess } from '@codebuff/common/util/error'
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

import {
  ASYNC_SUBAGENT_REPORT_TAG,
  beginAsyncSubagentGroup,
  endAsyncSubagentGroup,
  nextAsyncSpawnId,
  renderAsyncSubagentTranscript,
  trackAsyncSubagent,
} from '../async-subagents'
import { loopAgentSteps } from '../run-agent-step'
import { createToolCallChunk, mockFileContext } from './test-utils'

import type { AgentTemplate } from '../templates/types'
import type { DbSpies } from '@codebuff/common/testing/mocks/database'
import type { Message } from '@codebuff/common/types/messages/codebuff-message'
import type { AgentState } from '@codebuff/common/types/session-state'

const PARENT: AgentTemplate = {
  id: 'parent',
  displayName: 'Parent',
  spawnerPrompt: '',
  model: 'deepseek/deepseek-v4-flash',
  inputSchema: {},
  outputMode: 'last_message',
  includeMessageHistory: true,
  inheritParentSystemPrompt: false,
  mcpServers: {},
  toolNames: [
    'spawn_agent_async',
    'wait_for_subagents',
    'task_completed',
    'read_files',
  ],
  spawnableAgents: ['worker'],
  systemPrompt: 'Team system prompt',
  instructionsPrompt: '',
  stepPrompt: 'Role for this step: ORCHESTRATOR',
}

const WORKER: AgentTemplate = {
  id: 'worker',
  displayName: 'Worker',
  spawnerPrompt: '',
  model: 'deepseek/deepseek-v4-flash',
  inputSchema: {},
  outputMode: 'last_message',
  includeMessageHistory: true,
  inheritParentSystemPrompt: true,
  mcpServers: {},
  toolNames: ['read_files', 'task_completed'],
  spawnableAgents: [],
  systemPrompt: '',
  instructionsPrompt: 'Do only your task.',
  stepPrompt: 'Role for this step: SUBAGENT',
}

const textOf = (message: Message): string =>
  message.content
    .map((part) =>
      typeof part === 'object' && 'text' in part ? (part.text as string) : '',
    )
    .join('')

/** A child's request carries its framed task; the parent's never does. */
const isChildRequest = (messages: Message[]): boolean =>
  messages.some(
    (m) => m.role === 'user' && textOf(m).startsWith('<subagent_task'),
  )

const reportsIn = (history: Message[]): Message[] =>
  history.filter((m) => m.tags?.includes(ASYNC_SUBAGENT_REPORT_TAG))

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !condition(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  expect(condition()).toBe(true)
}

describe('spawn_agent_async', () => {
  let dbSpies: DbSpies
  let agentState: AgentState
  let baseParams: Omit<
    Parameters<typeof loopAgentSteps>[0],
    'promptAiSdkStream'
  >

  beforeEach(() => {
    const {
      agentTemplate: _,
      localAgentTemplates: __,
      ...runtime
    } = createTestAgentRuntimeParams()
    dbSpies = setupDbSpies(createMockDbOperations())
    spyOn(analytics, 'trackEvent').mockImplementation(() => {})

    agentState = {
      ...getInitialSessionState(mockFileContext).mainAgentState,
      agentId: 'parent-agent-id',
      messageHistory: [
        userMessage('Earlier request'),
        assistantMessage('Earlier answer'),
      ],
      stepsRemaining: 20,
    }
    baseParams = {
      ...runtime,
      // Every run of a loop has its own id, as in production; the fixture's
      // constant one would give a parent and its subagent the same group.
      startAgentRun: async () => `run-${crypto.randomUUID()}`,
      agentType: 'parent',
      localAgentTemplates: { parent: PARENT, worker: WORKER },
      repoId: undefined,
      repoUrl: undefined,
      userInputId: 'input',
      agentState,
      prompt: 'Build the feature',
      spawnParams: undefined,
      fingerprintId: 'fp',
      fileContext: mockFileContext,
      userId: TEST_USER_ID,
      clientSessionId: 'session',
      ancestorRunIds: [],
      onResponseChunk: () => {},
      signal: new AbortController().signal,
    }
  })

  afterEach(() => {
    dbSpies.restore()
    mock.restore()
  })

  it('answers at once, then delivers the report between steps without an extra step', async () => {
    let releaseChild!: () => void
    const childGate = new Promise<void>((resolve) => (releaseChild = resolve))
    const parentRequests: { system: Message; messages: Message[] }[] = []
    const childRequests: { system: Message; messages: Message[] }[] = []

    const run = loopAgentSteps({
      ...baseParams,
      promptAiSdkStream: async function* ({ messages }) {
        const [system, ...rest] = messages
        if (isChildRequest(rest)) {
          childRequests.push({ system, messages: rest })
          await childGate
          yield { type: 'text' as const, text: 'Wrote the greeting in a.ts.' }
          yield createToolCallChunk('task_completed', {})
          return promptSuccess('child-message')
        }
        parentRequests.push({ system, messages: rest })
        if (parentRequests.length === 1) {
          yield { type: 'text' as const, text: 'Starting one task.' }
          yield createToolCallChunk('spawn_agent_async', {
            agent_type: 'worker',
            prompt: 'Write the greeting in a.ts',
          })
        } else {
          yield { type: 'text' as const, text: 'All done.' }
        }
        return promptSuccess('parent-message')
      },
    })

    await until(() => childRequests.length === 1)
    // The spawn-only reply waits for the report instead of taking a step.
    expect(parentRequests).toHaveLength(1)
    releaseChild()
    const { agentState: finalState } = await run

    expect(parentRequests).toHaveLength(2)
    expect(childRequests).toHaveLength(1)

    // The child's request is the parent's, plus the parent's text so far and
    // its task: same system prompt, same history prefix, no parent step note.
    const [parentFirst] = parentRequests
    const [child] = childRequests
    expect(child.system).toEqual(parentFirst.system)
    const inherited = parentFirst.messages.filter(
      (m) => !m.tags?.includes('STEP_PROMPT'),
    )
    expect(child.messages.slice(0, inherited.length)).toEqual(inherited)
    expect(
      child.messages.some((m) =>
        textOf(m).includes('Role for this step: ORCHESTRATOR'),
      ),
    ).toBe(false)
    expect(textOf(child.messages.at(-1)!)).toContain(
      'Role for this step: SUBAGENT',
    )

    // The spawn's own result, then the report, which the second step read.
    const history = finalState.messageHistory
    const spawnResult = history.find(
      (m) => m.role === 'tool' && m.toolName === 'spawn_agent_async',
    )
    expect(spawnResult?.role === 'tool' && spawnResult.content).toEqual([
      {
        type: 'json',
        value: { agentType: 'worker', spawnId: 't1', status: 'running' },
      },
    ])
    const [report] = reportsIn(history)
    const reportText = textOf(report)
    expect(reportText).toContain('spawn_id="t1"')
    expect(reportText).toContain('status="completed"')
    expect(reportText).toContain('Write the greeting in a.ts')
    expect(reportText).toContain('Wrote the greeting in a.ts.')
    expect(reportText).toContain('[tool call: task_completed]')
    expect(reportText).toContain('No other subagents are running.')
    expect(history.indexOf(report)).toBeGreaterThan(
      history.indexOf(spawnResult!),
    )
    expect(
      parentRequests[1].messages.some((m) =>
        m.tags?.includes(ASYNC_SUBAGENT_REPORT_TAG),
      ),
    ).toBe(true)
  })

  it('waits on a reply with no tool call while a subagent runs', async () => {
    let releaseChild!: () => void
    const childGate = new Promise<void>((resolve) => (releaseChild = resolve))
    let parentCalls = 0
    let childCalls = 0
    let thirdRequest: Message[] = []

    const run = loopAgentSteps({
      ...baseParams,
      promptAiSdkStream: async function* ({ messages }) {
        if (isChildRequest(messages)) {
          childCalls++
          await childGate
          yield { type: 'text' as const, text: 'Child finished.' }
          return promptSuccess('child-message')
        }
        parentCalls++
        if (parentCalls === 1) {
          yield createToolCallChunk('spawn_agent_async', {
            agent_type: 'worker',
            prompt: 'Slow task',
          })
          // Another tool forces a second step while the child still runs.
          yield createToolCallChunk('read_files', { paths: ['a.ts'] })
        } else if (parentCalls === 2) {
          yield { type: 'text' as const, text: 'Waiting for t1.' }
        } else {
          thirdRequest = messages
          yield { type: 'text' as const, text: 'Final answer.' }
        }
        return promptSuccess('parent-message')
      },
    })

    await until(() => parentCalls === 2 && childCalls === 1)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(parentCalls).toBe(2)
    releaseChild()
    const { agentState: finalState, output } = await run

    expect(parentCalls).toBe(3)
    expect(reportsIn(finalState.messageHistory)).toHaveLength(1)
    expect(
      thirdRequest.some((m) => m.tags?.includes(ASYNC_SUBAGENT_REPORT_TAG)),
    ).toBe(true)
    expect(output.type).toBe('lastMessage')
  })

  it('wait_for_subagents returns when the next report is ready, and at once when none is running', async () => {
    let releaseChild!: () => void
    const childGate = new Promise<void>((resolve) => (releaseChild = resolve))
    let parentCalls = 0
    let childCalls = 0
    const requests: Message[][] = []

    const run = loopAgentSteps({
      ...baseParams,
      promptAiSdkStream: async function* ({ messages }) {
        if (isChildRequest(messages)) {
          childCalls++
          await childGate
          yield { type: 'text' as const, text: 'Child finished.' }
          return promptSuccess('child-message')
        }
        parentCalls++
        requests.push(messages)
        if (parentCalls === 1) {
          yield createToolCallChunk('spawn_agent_async', {
            agent_type: 'worker',
            prompt: 'Slow task',
          })
          yield createToolCallChunk('wait_for_subagents', {})
        } else if (parentCalls === 2) {
          // Nothing is running any more: this wait answers at once.
          yield createToolCallChunk('wait_for_subagents', {})
        } else {
          yield { type: 'text' as const, text: 'Final answer.' }
        }
        return promptSuccess('parent-message')
      },
    })

    await until(() => childCalls === 1)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(parentCalls).toBe(1)
    releaseChild()
    const { agentState: finalState } = await run

    expect(parentCalls).toBe(3)
    const waitResults = finalState.messageHistory.filter(
      (m) => m.role === 'tool' && m.toolName === 'wait_for_subagents',
    )
    expect(waitResults.map((m) => m.role === 'tool' && m.content)).toEqual([
      [
        {
          type: 'json',
          value: { message: 'A subagent finished: its report follows.' },
        },
      ],
      [{ type: 'json', value: { message: 'No subagents are running.' } }],
    ])
    expect(
      requests[1].some((m) => m.tags?.includes(ASYNC_SUBAGENT_REPORT_TAG)),
    ).toBe(true)
  })

  it('gives the parent another step to read a refused spawn', async () => {
    let parentCalls = 0
    let secondRequest: Message[] = []
    await loopAgentSteps({
      ...baseParams,
      promptAiSdkStream: async function* ({ messages }) {
        parentCalls++
        if (parentCalls === 1) {
          yield createToolCallChunk('spawn_agent_async', {
            agent_type: 'not-spawnable',
            prompt: 'Anything',
          })
        } else {
          secondRequest = messages
          yield { type: 'text' as const, text: 'Doing it myself.' }
        }
        return promptSuccess('parent-message')
      },
    })

    expect(parentCalls).toBe(2)
    expect(JSON.stringify(secondRequest)).toContain(
      'not allowed to spawn child agent type not-spawnable',
    )
  })

  it('stops running subagents when the parent loop exits early', async () => {
    let childSignal: AbortSignal | undefined
    let parentCalls = 0
    const { output } = await loopAgentSteps({
      ...baseParams,
      promptAiSdkStream: async function* ({ messages, signal }) {
        if (isChildRequest(messages)) {
          childSignal = signal
          await new Promise((resolve) =>
            signal.addEventListener('abort', resolve, { once: true }),
          )
          throw new AbortError()
        }
        parentCalls++
        if (parentCalls === 1) {
          yield createToolCallChunk('spawn_agent_async', {
            agent_type: 'worker',
            prompt: 'Never finishes',
          })
          yield createToolCallChunk('read_files', { paths: ['a.ts'] })
          return promptSuccess('parent-message')
        }
        throw new Error('provider exploded')
      },
    })

    expect(output.type).toBe('error')
    await until(() => childSignal?.aborted === true)
  })

  it('keeps the subagents of two concurrent turns of one agent id apart', async () => {
    // Every root run's agentId is 'main-agent'; one process runs many roots.
    const rootState = (): AgentState => ({
      ...agentState,
      agentId: 'main-agent',
      messageHistory: [...agentState.messageHistory],
    })
    let releaseChild!: () => void
    const childGate = new Promise<void>((resolve) => (releaseChild = resolve))
    let childSignal: AbortSignal | undefined
    let parentCalls = 0

    const first = loopAgentSteps({
      ...baseParams,
      agentState: rootState(),
      promptAiSdkStream: async function* ({ messages, signal }) {
        if (isChildRequest(messages)) {
          childSignal = signal
          await childGate
          yield { type: 'text' as const, text: 'Checked the first.' }
          yield createToolCallChunk('task_completed', {})
          return promptSuccess('child-message')
        }
        parentCalls++
        if (parentCalls === 1) {
          yield createToolCallChunk('spawn_agent_async', {
            agent_type: 'worker',
            prompt: 'Run the checks',
          })
        } else {
          yield { type: 'text' as const, text: 'First done.' }
        }
        return promptSuccess('parent-message')
      },
    })
    await until(() => childSignal !== undefined)

    // A second turn starts and ends while the first one's subagent runs: it
    // neither stops that subagent nor waits for it.
    const second = await loopAgentSteps({
      ...baseParams,
      agentState: rootState(),
      prompt: 'A quick question',
      promptAiSdkStream: async function* () {
        yield { type: 'text' as const, text: 'Second done.' }
        return promptSuccess('parent-message')
      },
    })
    expect(childSignal?.aborted).toBe(false)
    expect(reportsIn(second.agentState.messageHistory)).toHaveLength(0)

    releaseChild()
    const { agentState: finalState } = await first
    const [report] = reportsIn(finalState.messageHistory)
    expect(textOf(report)).toContain('Checked the first.')
    expect(parentCalls).toBe(2)
  })

  it('continues spawn ids from the spawns already in the history', () => {
    const spawnCall = (id: string) =>
      assistantMessage({
        type: 'tool-call',
        toolCallId: id,
        toolName: 'spawn_agent_async',
        input: { agent_type: 'worker', prompt: 'x' },
      })
    const parent = {
      runId: 'fresh-parent-run',
      messageHistory: [spawnCall('a'), spawnCall('b')],
    }
    beginAsyncSubagentGroup(parent.runId)
    expect(nextAsyncSpawnId(parent)).toBe('t3')
    expect(nextAsyncSpawnId(parent)).toBe('t4')
    endAsyncSubagentGroup(parent.runId)
  })

  it('a parent with no running loop gets no spawn id, and a late child is stopped', () => {
    const parent = { runId: 'ended-parent-run', messageHistory: [] }
    expect(nextAsyncSpawnId(parent)).toBeUndefined()
    const abort = new AbortController()
    trackAsyncSubagent(parent.runId, 't1', abort, new Promise(() => {}))
    expect(abort.signal.aborted).toBe(true)
  })

  it('renders text, tool calls and results, never reasoning, and clips huge parts', () => {
    const rendered = renderAsyncSubagentTranscript([
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'secret chain of thought' },
          { type: 'text', text: 'Reading the file.' },
          {
            type: 'tool-call',
            toolCallId: 'c1',
            toolName: 'read_files',
            input: { paths: ['a.ts'] },
          },
        ],
      },
      {
        role: 'tool',
        toolCallId: 'c1',
        toolName: 'read_files',
        content: [{ type: 'json', value: { content: 'x'.repeat(50_000) } }],
      },
      // set_messages may store content as a bare string
      { role: 'user', content: 'Also check b.ts.' } as unknown as Message,
      { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
    ])
    expect(rendered).not.toContain('secret chain of thought')
    expect(rendered).toContain('Reading the file.')
    expect(rendered).toContain('[tool call: read_files] {"paths":["a.ts"]}')
    expect(rendered).toContain('[tool result: read_files]')
    expect(rendered).toContain('characters cut')
    expect(rendered).toContain('[note] Also check b.ts.')
    expect(rendered.length).toBeLessThan(20_000)
    expect(rendered.endsWith('Done.')).toBe(true)
  })
})
