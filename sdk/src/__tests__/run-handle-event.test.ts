
import * as mainPromptModule from '@codebuff/agent-runtime/main-prompt'
import { getInitialSessionState } from '@codebuff/common/types/session-state'
import { getStubProjectFileContext } from '@codebuff/common/util/file'
import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'

import { CodebuffClient } from '../client'
import * as databaseModule from '../impl/database'

import type { CodebuffClientOptions } from '../run'
import type { PrintModeEvent } from '@codebuff/common/types/print-mode'

describe('CodebuffClient handleEvent / handleStreamChunk', () => {
  afterEach(() => {
    mock.restore()
  })

  it('awaits slow event and subagent chunk delivery before resolving the turn', async () => {
    spyOn(databaseModule, 'getUserInfoFromApiKey').mockResolvedValue({
      id: 'user-123',
      email: 'test@example.com',
      name: null,
      discord_id: null,
      stripe_customer_id: null,
      banned: false,
      created_at: new Date('2024-01-01T00:00:00Z'),
    })
    spyOn(databaseModule, 'fetchAgentFromDatabase').mockResolvedValue(null)
    spyOn(databaseModule, 'startAgentRun').mockResolvedValue('run-1')
    spyOn(databaseModule, 'finishAgentRun').mockResolvedValue(undefined)
    spyOn(databaseModule, 'addAgentStep').mockResolvedValue('step-1')

    spyOn(mainPromptModule, 'callMainPrompt').mockImplementation(
      async (
        params: Parameters<typeof mainPromptModule.callMainPrompt>[0],
      ) => {
        const { sendAction, action: promptAction, promptId } = params
        const sessionState = getInitialSessionState(
          getStubProjectFileContext(),
        )

        await sendAction({
          action: {
            type: 'response-chunk',
            userInputId: promptId,
            chunk: {
              type: 'subagent_start',
              agentId: 'sub-1',
              agentType: 'commander',
              displayName: 'Commander',
              onlyChild: true,
              parentAgentId: 'main-agent',
              prompt: promptAction.prompt,
              params: promptAction.promptParams,
            },
          },
        })

        await sendAction({
          action: {
            type: 'subagent-response-chunk',
            userInputId: promptId,
            agentId: 'sub-1',
            agentType: 'commander',
            chunk: 'hello from subagent',
          },
        })

        await sendAction({
          action: {
            type: 'response-chunk',
            userInputId: promptId,
            chunk: {
              type: 'subagent_finish',
              agentId: 'sub-1',
              agentType: 'commander',
              displayName: 'Commander',
              onlyChild: true,
              parentAgentId: 'main-agent',
              prompt: promptAction.prompt,
              params: promptAction.promptParams,
            },
          },
        })

        await sendAction({
          action: {
            type: 'prompt-response',
            promptId,
            sessionState,
            output: {
              type: 'lastMessage',
              value: [],
            },
          },
        })

        return {
          sessionState,
          output: {
            type: 'lastMessage' as const,
            value: [],
          },
        }
      },
    )

    type StreamChunk = Parameters<
      NonNullable<CodebuffClientOptions['handleStreamChunk']>
    >[0]

    const events: PrintModeEvent[] = []
    const streamChunks: StreamChunk[] = []

    const client = new CodebuffClient({
      apiKey: 'test-key',
    })

    const result = await client.run({
      agent: 'base2',
      prompt: 'hello world',
      handleEvent: async (event) => {
        await new Promise(resolve => setTimeout(resolve, 5))
        events.push(event)
      },
      handleStreamChunk: async (chunk) => {
        await new Promise(resolve => setTimeout(resolve, 5))
        streamChunks.push(chunk)
      },
    })

    expect(
      events.filter((e) => e.type === 'subagent_start').map((e) => e.agentId),
    ).toEqual(['sub-1'])
    expect(
      events.filter((e) => e.type === 'subagent_finish').map((e) => e.agentId),
    ).toEqual(['sub-1'])

    expect(streamChunks).toEqual([
      {
        type: 'subagent_chunk',
        agentId: 'sub-1',
        agentType: 'commander',
        chunk: 'hello from subagent',
      },
    ])

    expect(result.output.type).toBe('lastMessage')
  })
})
