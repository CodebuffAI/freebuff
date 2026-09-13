import { TEST_USER_ID } from '@codebuff/common/old-constants'
import { createTestAgentRuntimeParams } from '@codebuff/common/testing/fixtures/agent-runtime'
import { getInitialSessionState } from '@codebuff/common/types/session-state'
import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'

import { callMainPrompt } from '../main-prompt'
import * as agentRegistry from '../templates/agent-registry'

import type { ProjectFileContext } from '@codebuff/common/util/file'

describe('callMainPrompt', () => {
  afterEach(() => {
    mock.restore()
  })

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
    agentTemplates: {},
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
  }

  it('returns early without calling mainPrompt when agent config validation fails', async () => {
    const sentActions: Array<{ type: string }> = []
    const sendAction = ({ action }: { action: { type: string } }) => {
      sentActions.push(action)
    }

    spyOn(agentRegistry, 'assembleLocalAgentTemplates').mockReturnValue({
      agentTemplates: {},
      validationErrors: [
        { message: 'bad agent config', agentId: 'test-agent' },
      ] as any,
    })

    const sessionState = getInitialSessionState(mockFileContext)
    const baseParams = createTestAgentRuntimeParams()

    const result = await callMainPrompt({
      ...baseParams,
      promptId: 'test-prompt',
      sendAction,
      logger: baseParams.logger,
      signal: new AbortController().signal,
      action: {
        type: 'prompt' as const,
        prompt: 'Hello',
        sessionState,
        fingerprintId: 'test',
        costMode: 'normal' as const,
        promptId: 'test-prompt',
        toolResults: [],
      },
      repoUrl: undefined,
      repoId: undefined,
      clientSessionId: 'test-session',
      userId: TEST_USER_ID,
    } as any)

    const actionTypes = sentActions.map((a) => a.type)
    expect(actionTypes).toContain('prompt-error')
    expect(actionTypes).toContain('prompt-response')
    expect(actionTypes).not.toContain('response-chunk')
    expect(result.output.type).toBe('error')
  })
})
