import * as mainPromptModule from '@codebuff/agent-runtime/main-prompt'
import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'

import { CodebuffClient } from '../client'
import * as databaseModule from '../impl/database'

// The run's user as the runtime receives it; the turn then ends, which is all these need.
function captureUserId() {
  const seen: { userId?: string } = {}
  spyOn(mainPromptModule, 'callMainPrompt').mockImplementation(
    async (params: Parameters<typeof mainPromptModule.callMainPrompt>[0]) => {
      seen.userId = params.userId
      throw new Error('stop here')
    },
  )
  return seen
}

describe('the API key’s own user', () => {
  afterEach(() => {
    mock.restore()
  })

  it('known to the host, skips the identity lookup and runs as that same user', async () => {
    const lookup = spyOn(databaseModule, 'getUserInfoFromApiKey')
    const seen = captureUserId()
    await new CodebuffClient({ apiKey: 'run-key' }).run({
      agent: 'base2',
      prompt: 'Hi',
      apiKeyUserId: 'owner-1',
    })
    expect(lookup).not.toHaveBeenCalled()
    expect(seen.userId).toBe('owner-1')
  })

  it('unknown, is looked up as before', async () => {
    const lookup = spyOn(databaseModule, 'getUserInfoFromApiKey').mockResolvedValue({
      id: 'looked-up',
    } as never)
    const seen = captureUserId()
    await new CodebuffClient({ apiKey: 'run-key' }).run({ agent: 'base2', prompt: 'Hi' })
    expect(lookup).toHaveBeenCalledTimes(1)
    expect(seen.userId).toBe('looked-up')
  })
})
