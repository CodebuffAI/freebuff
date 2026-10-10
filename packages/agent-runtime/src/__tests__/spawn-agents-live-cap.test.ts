import {
  FREEBUFF_PROJECTS_MAX_LIVE_SUBAGENTS,
  FREEBUFF_PROJECTS_SUBAGENT_ID,
} from '@codebuff/common/constants/free-agents'
import { TEST_USER_ID } from '@codebuff/common/old-constants'
import { TEST_AGENT_RUNTIME_IMPL } from '@codebuff/common/testing/impl/agent-runtime'
import { getInitialSessionState } from '@codebuff/common/types/session-state'
import { assistantMessage } from '@codebuff/common/util/messages'
import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'

import { mockFileContext } from './test-utils'
import * as runAgentStep from '../run-agent-step'
import {
  handleSpawnAgents,
  liveCappedAgentCountForTests,
} from '../tools/handlers/tool/spawn-agents'

import type { AgentTemplate } from '@codebuff/common/types/agent-template'

const template = (
  id: string,
  spawnableAgents: string[] = [],
): AgentTemplate => ({
  id,
  displayName: id,
  outputMode: 'last_message' as const,
  inputSchema: {
    prompt: {
      safeParse: () => ({ success: true }),
    } as unknown as AgentTemplate['inputSchema']['prompt'],
  },
  spawnerPrompt: '',
  model: '',
  includeMessageHistory: false,
  inheritParentSystemPrompt: false,
  mcpServers: {},
  toolNames: [],
  spawnableAgents,
  systemPrompt: '',
  instructionsPrompt: '',
  stepPrompt: '',
})

describe('the live Projects subagent cap', () => {
  afterEach(() => mock.restore())

  it(`runs at most ${FREEBUFF_PROJECTS_MAX_LIVE_SUBAGENTS} at once under one root, across concurrent batches`, async () => {
    const gate = Promise.withResolvers<void>()
    let started = 0
    spyOn(runAgentStep, 'loopAgentSteps').mockImplementation(
      async (options) => {
        started++
        await gate.promise
        return {
          agentState: options.agentState,
          output: { type: 'lastMessage', value: [assistantMessage('done')] },
        }
      },
    )
    const root = template('root', [FREEBUFF_PROJECTS_SUBAGENT_ID])
    const subagent = template(FREEBUFF_PROJECTS_SUBAGENT_ID)
    const spawn = (runId: string, count: number) => {
      const state = getInitialSessionState(mockFileContext).mainAgentState
      state.runId = runId
      return handleSpawnAgents({
        ...TEST_AGENT_RUNTIME_IMPL,
        ancestorRunIds: [],
        clientSessionId: 'session',
        fileContext: mockFileContext,
        fingerprintId: 'fp',
        previousToolCallFinished: Promise.resolve(),
        repoId: undefined,
        repoUrl: undefined,
        sendSubagentChunk: () => {},
        signal: new AbortController().signal,
        system: 'system',
        userId: TEST_USER_ID,
        userInputId: 'input',
        writeToClient: () => {},
        agentState: state,
        agentTemplate: root,
        localAgentTemplates: { [FREEBUFF_PROJECTS_SUBAGENT_ID]: subagent },
        toolCall: {
          toolName: 'spawn_agents',
          toolCallId: `call-${runId}-${count}`,
          input: {
            agents: Array.from({ length: count }, () => ({
              agent_type: FREEBUFF_PROJECTS_SUBAGENT_ID,
              prompt: 'work',
            })),
          },
        },
      })
    }

    // Parallel calls of six until past the cap: more asked than may run.
    const calls = Math.ceil(FREEBUFF_PROJECTS_MAX_LIVE_SUBAGENTS / 6) + 1
    const asked = calls * 6
    const batches = Array.from({ length: calls }, () => spawn('root-a', 6))
    // Another session is not held to root-a's count.
    const other = spawn('root-b', 6)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(started).toBe(FREEBUFF_PROJECTS_MAX_LIVE_SUBAGENTS + 6)
    gate.resolve()
    const outputs = (await Promise.all(batches)).map((b) =>
      JSON.stringify(b.output),
    )
    const refused =
      outputs.join('').split(`at most ${FREEBUFF_PROJECTS_MAX_LIVE_SUBAGENTS}`)
        .length - 1
    expect(refused).toBe(asked - FREEBUFF_PROJECTS_MAX_LIVE_SUBAGENTS)
    expect(JSON.stringify((await other).output)).not.toContain('at most')
    // Every slot is released once its agent reports.
    expect(liveCappedAgentCountForTests()).toBe(0)
    const again = await spawn('root-a', 6)
    expect(JSON.stringify(again.output)).not.toContain('at most')
  })
})
