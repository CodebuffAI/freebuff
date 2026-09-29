import * as mainPromptModule from '@codebuff/agent-runtime/main-prompt'
import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'

import { CodebuffClient } from '../client'
import * as databaseModule from '../impl/database'

import type { SessionState } from '@codebuff/common/types/session-state'

describe('run() on prompt-error', () => {
  afterEach(() => {
    mock.restore()
  })

  it('resolves with a snapshot, not the state object handed to the runtime', async () => {
    spyOn(databaseModule, 'getUserInfoFromApiKey').mockResolvedValue({
      id: 'user-123',
      email: 'test@example.com',
      discord_id: null,
      stripe_customer_id: null,
      banned: false,
      created_at: new Date('2024-01-01T00:00:00Z'),
    })
    spyOn(databaseModule, 'fetchAgentFromDatabase').mockResolvedValue(null)

    let runtimeState: SessionState | undefined
    spyOn(mainPromptModule, 'callMainPrompt').mockImplementation(
      async (params: Parameters<typeof mainPromptModule.callMainPrompt>[0]) => {
        runtimeState = params.action.sessionState
        params.sendAction({
          action: {
            type: 'prompt-error',
            userInputId: params.promptId,
            message: 'Invalid agent config: broken-agent',
          },
        })
        // Anything that still touches the runtime's object after the error
        // must not reach the state the host keeps.
        runtimeState.mainAgentState.messageHistory.push({
          role: 'user',
          content: [{ type: 'text', text: 'late write' }],
        })
        return {
          sessionState: runtimeState,
          output: { type: 'error', message: 'Invalid agent config' },
        }
      },
    )

    const client = new CodebuffClient({ apiKey: 'test-key' })
    const errors: string[] = []
    const result = await client.run({
      agent: 'base2',
      prompt: 'hello',
      handleEvent: (event) => {
        if (event.type === 'error') errors.push(event.message)
      },
    })

    expect(errors).toEqual(['Invalid agent config: broken-agent'])
    expect(result.output.type).toBe('error')
    expect(runtimeState).toBeDefined()
    expect(result.sessionState!.mainAgentState).not.toBe(
      runtimeState!.mainAgentState,
    )
    expect(
      JSON.stringify(result.sessionState!.mainAgentState.messageHistory),
    ).not.toContain('late write')
  })
})
