import * as mainPromptModule from '@codebuff/agent-runtime/main-prompt'
import { getInitialSessionState } from '@codebuff/common/types/session-state'
import { getStubProjectFileContext } from '@codebuff/common/util/file'
import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'

import { CodebuffClient } from '../client'
import * as databaseModule from '../impl/database'

const SESSION = '11111111-2222-4333-8444-555555555555'

function stubServer(): { metadata: unknown[] } {
  const metadata: unknown[] = []
  spyOn(databaseModule, 'getUserInfoFromApiKey').mockResolvedValue({
    id: 'user-123',
    email: 'test@example.com',
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
    async (params: Parameters<typeof mainPromptModule.callMainPrompt>[0]) => {
      metadata.push(
        (params as { extraCodebuffMetadata?: unknown }).extraCodebuffMetadata,
      )
      const sessionState = getInitialSessionState(getStubProjectFileContext())
      await params.sendAction({
        action: {
          type: 'prompt-response',
          promptId: params.promptId,
          sessionState,
          output: { type: 'lastMessage', value: [] },
        },
      })
      return {
        sessionState,
        output: { type: 'lastMessage' as const, value: [] },
      }
    },
  )
  return { metadata }
}

describe('RunOptions.traceSessionId', () => {
  afterEach(() => {
    mock.restore()
  })

  it('starts a run with no previous state on the given trace session', async () => {
    const server = stubServer()
    const result = await new CodebuffClient({ apiKey: 'test-key' }).run({
      agent: 'base2',
      prompt: 'hi',
      traceSessionId: SESSION,
    })
    expect(result.traceSessionId).toBe(SESSION)
    expect(server.metadata[0]).toMatchObject({ trace_session_id: SESSION })
  })

  it('keeps the previous run’s trace session over the option', async () => {
    stubServer()
    const client = new CodebuffClient({ apiKey: 'test-key' })
    const first = await client.run({ agent: 'base2', prompt: 'hi' })
    const second = await client.run({
      agent: 'base2',
      prompt: 'again',
      previousRun: first,
      traceSessionId: SESSION,
    })
    expect(second.traceSessionId).toBe(first.traceSessionId)
    expect(second.traceSessionId).not.toBe(SESSION)
  })
})
