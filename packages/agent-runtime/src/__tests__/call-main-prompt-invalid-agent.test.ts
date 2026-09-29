import * as analytics from '@codebuff/common/analytics'
import { TEST_USER_ID } from '@codebuff/common/old-constants'
import { createTestAgentRuntimeParams } from '@codebuff/common/testing/fixtures/agent-runtime'
import { getInitialSessionState } from '@codebuff/common/types/session-state'
import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'

import { callMainPrompt } from '../main-prompt'
import { createToolCallChunk } from './test-utils'

import type { ServerAction } from '@codebuff/common/actions'
import type { ProjectFileContext } from '@codebuff/common/util/file'

const fileContext = (
  agentTemplates: ProjectFileContext['agentTemplates'],
): ProjectFileContext => ({
  projectRoot: '/test',
  cwd: '/test',
  fileTree: [],
  fileTokenScores: {},
  knowledgeFiles: {},
  gitChanges: { status: '', diff: '', diffCached: '', lastCommitMessages: '' },
  changesSinceLastChat: {},
  shellConfigFiles: {},
  agentTemplates,
  customToolDefinitions: {},
  systemInfo: {
    platform: 'test',
    shell: 'test',
    nodeVersion: 'test',
    arch: 'test',
    homedir: '/home/test',
    cpus: 1,
    chromeAvailable: false,
  },
})

// A usable main agent, so a run that ignored the validation error would go on
// to stream from the model and execute its write_file.
const validBase = {
  id: 'base',
  version: '1.0.0',
  displayName: 'Base',
  spawnerPrompt: 'Base agent',
  model: 'anthropic/claude-4-sonnet-20250522',
  systemPrompt: 'system',
  instructionsPrompt: 'instructions',
  stepPrompt: 'step',
  toolNames: ['write_file', 'end_turn'],
  spawnableAgents: [],
  outputMode: 'last_message',
  includeMessageHistory: true,
  inheritParentSystemPrompt: false,
}

const malformed = {
  ...validBase,
  id: 'broken-agent',
  inputSchema: { prompt: {} as Record<string, never> },
}

describe('callMainPrompt with an invalid local agent template', () => {
  afterEach(() => {
    mock.restore()
  })

  it('stops after prompt-error: no model call, no tools, no further chunks', async () => {
    spyOn(analytics, 'trackEvent').mockImplementation(() => {})

    const promptAiSdkStream = mock(async function* () {
      yield createToolCallChunk('write_file', {
        path: 'orphan.txt',
        instructions: 'orphan write',
        content: 'should never be written',
      })
      yield createToolCallChunk('end_turn', {})
      return 'mock-message-id'
    })
    const requestToolCall = mock(async () => ({
      output: [{ type: 'json' as const, value: 'ok' }],
    }))
    const sent: ServerAction[] = []
    const sendAction = mock(({ action }: { action: ServerAction }) => {
      sent.push(action)
    })

    const sessionState = getInitialSessionState(
      fileContext({
        'base.ts': validBase,
        'broken-agent.md': malformed,
      } as unknown as ProjectFileContext['agentTemplates']),
    )

    const result = await callMainPrompt({
      ...createTestAgentRuntimeParams(),
      promptAiSdkStream,
      requestToolCall,
      sendAction,
      repoId: undefined,
      repoUrl: undefined,
      userId: TEST_USER_ID,
      clientSessionId: 'test-session',
      signal: new AbortController().signal,
      promptId: 'prompt-1',
      action: {
        type: 'prompt',
        promptId: 'prompt-1',
        prompt: 'write a file',
        sessionState,
        fingerprintId: 'test',
        costMode: 'normal',
        toolResults: [],
      },
    } as unknown as Parameters<typeof callMainPrompt>[0])

    expect(sent).toHaveLength(1)
    expect(sent[0]!.type).toBe('prompt-error')
    expect((sent[0] as ServerAction<'prompt-error'>).message).toContain(
      'Invalid agent config',
    )
    expect(promptAiSdkStream).not.toHaveBeenCalled()
    expect(requestToolCall).not.toHaveBeenCalled()
    expect(result.output.type).toBe('error')

    // Nothing is still running in the background to send a late chunk or
    // prompt-response after the host has settled the run.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(sent).toHaveLength(1)
    expect(promptAiSdkStream).not.toHaveBeenCalled()
    expect(requestToolCall).not.toHaveBeenCalled()
  })
})
