import * as analytics from '@codebuff/common/analytics'
import { TEST_USER_ID } from '@codebuff/common/old-constants'
import { createTestAgentRuntimeParams } from '@codebuff/common/testing/fixtures/agent-runtime'
import { clearMockedModules } from '@codebuff/common/testing/mock-modules'
import {
  createMockDbOperations,
  setupDbSpies,
} from '@codebuff/common/testing/mocks/database'
import { getInitialSessionState } from '@codebuff/common/types/session-state'
import { promptSuccess } from '@codebuff/common/util/error'
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from 'bun:test'

import { loopAgentSteps } from '../run-agent-step'
import { clearAgentGeneratorCache } from '../run-programmatic-step'
import { createToolCallChunk, mockFileContext } from './test-utils'

import type { AgentTemplate } from '../templates/types'
import type { ProjectProfileReport } from '@codebuff/common/constants/project-profile'
import type { DbSpies } from '@codebuff/common/testing/mocks/database'

describe('project profile report in loopAgentSteps', () => {
  let dbSpies: DbSpies
  let runtimeImpl: any
  let requests: any[]
  let reports: ProjectProfileReport[]
  let events: string[]

  const template: AgentTemplate = {
    id: 'free-root',
    displayName: 'Free Root',
    spawnerPrompt: 'Testing',
    model: 'deepseek/deepseek-v4-flash',
    inputSchema: {},
    outputMode: 'last_message',
    includeMessageHistory: true,
    inheritParentSystemPrompt: false,
    mcpServers: {},
    toolNames: ['read_files', 'end_turn'],
    spawnableAgents: [],
    systemPrompt: 'Test system prompt',
    instructionsPrompt: '',
    stepPrompt: '',
    handleSteps: undefined,
  } satisfies AgentTemplate as AgentTemplate

  const runLoop = async (params: { costMode: string; due: boolean }) => {
    const {
      agentTemplate: _,
      localAgentTemplates: __,
      ...baseRuntimeParams
    } = createTestAgentRuntimeParams()
    let finished!: () => void
    const finishedPromise = new Promise<void>((resolve) => {
      finished = resolve
    })
    runtimeImpl = {
      ...baseRuntimeParams,
      finishAgentRun: mock(async () => {
        events.push('finish')
        finished()
      }),
      getProjectProfile: mock(async () => ({
        due: params.due,
        profile: { appKinds: ['Web app'], technologies: ['TypeScript'] },
      })),
      reportProjectProfile: mock(async ({ report }: any) => {
        events.push('report')
        reports.push(report)
        return true
      }),
    }
    runtimeImpl.promptAiSdkStream = mock(async function* (request: any) {
      requests.push(request)
      if (
        JSON.stringify(request.messages.at(-1)).includes(
          'report_project_profile once',
        )
      ) {
        yield {
          ...createToolCallChunk('report_project_profile', {}),
          input: { status: 'unchanged' },
        } as ReturnType<typeof createToolCallChunk>
        return promptSuccess('report-message-id')
      }
      yield { type: 'text' as const, text: 'done' }
      yield createToolCallChunk('end_turn', {})
      return promptSuccess('mock-message-id')
    })

    const sessionState = getInitialSessionState(mockFileContext)
    const result = await loopAgentSteps({
      ...runtimeImpl,
      agentType: template.id,
      localAgentTemplates: { [template.id]: template },
      repoId: undefined,
      repoUrl: undefined,
      userInputId: 'test-user-input',
      agentState: {
        ...sessionState.mainAgentState,
        agentId: 'root-agent-id',
        messageHistory: [],
        output: undefined,
        stepsRemaining: 5,
      },
      prompt: 'build the thing',
      spawnParams: undefined,
      fingerprintId: 'test-fingerprint',
      fileContext: mockFileContext,
      userId: TEST_USER_ID,
      clientSessionId: 'test-session',
      ancestorRunIds: [],
      costMode: params.costMode,
      onResponseChunk: () => {},
      signal: new AbortController().signal,
    } as any)
    await finishedPromise
    return result
  }

  beforeEach(() => {
    requests = []
    reports = []
    events = []
    dbSpies = setupDbSpies(createMockDbOperations())
    spyOn(analytics, 'trackEvent').mockImplementation(() => {})
  })

  afterEach(() => {
    if (runtimeImpl) clearAgentGeneratorCache(runtimeImpl)
    dbSpies.restore()
    mock.restore()
  })

  afterAll(() => {
    clearMockedModules()
  })

  it('offers the tool on every step and reports with the turn prefix before finishing the run', async () => {
    const result = await runLoop({ costMode: 'free', due: true })

    expect(requests).toHaveLength(2)
    const [turn, report] = requests
    expect(Object.keys(turn.tools)).toContain('report_project_profile')
    expect(Object.keys(report.tools)).toEqual(Object.keys(turn.tools))
    expect(report.messages.slice(0, turn.messages.length)).toEqual(
      turn.messages,
    )
    expect(report.toolChoice).toBe('required')
    expect(report.extraCodebuffMetadata.llm_step_number).toBe('2')
    expect(reports).toEqual([{ changed: false }])
    expect(events).toEqual(['report', 'finish'])
    expect(JSON.stringify(result.agentState.messageHistory)).not.toContain(
      'report_project_profile once',
    )
  })

  it('makes no report request when the profile is fresh', async () => {
    await runLoop({ costMode: 'free', due: false })
    expect(requests).toHaveLength(1)
    expect(reports).toEqual([])
    expect(events).toEqual(['finish'])
  })

  it('leaves paid runs untouched', async () => {
    await runLoop({ costMode: 'normal', due: true })
    expect(requests).toHaveLength(1)
    expect(Object.keys(requests[0].tools)).not.toContain(
      'report_project_profile',
    )
    expect(runtimeImpl.getProjectProfile).not.toHaveBeenCalled()
  })
})
