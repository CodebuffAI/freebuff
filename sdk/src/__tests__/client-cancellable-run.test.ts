import * as mainPromptModule from '@codebuff/agent-runtime/main-prompt'
import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'

import { CodebuffClient } from '../client'
import { createRunController } from '../run-controller'
import * as databaseModule from '../impl/database'

function mockDatabase() {
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
}

describe('CodebuffClient runCancellable', () => {
  afterEach(() => {
    mock.restore()
  })

  it('aborts the active run signal when cancel is called', async () => {
    mockDatabase()

    let runtimeSignal: AbortSignal | undefined
    let markRuntimeStarted: () => void = () => {}
    const runtimeStarted = new Promise<void>((resolve) => {
      markRuntimeStarted = resolve
    })
    spyOn(mainPromptModule, 'callMainPrompt').mockImplementation(
      async (params: Parameters<typeof mainPromptModule.callMainPrompt>[0]) => {
        runtimeSignal = params.signal
        markRuntimeStarted()
        return await new Promise<never>((_, reject) => {
          params.signal.addEventListener(
            'abort',
            () => reject(params.signal.reason),
            { once: true },
          )
        })
      },
    )

    const client = new CodebuffClient({ apiKey: 'test-key' })
    const activeRun = client.runCancellable({
      agent: 'base2',
      prompt: 'set up preview',
    })

    await runtimeStarted
    activeRun.cancel('Stopped from UI')
    const result = await activeRun.result

    expect(activeRun.controller.cancelled).toBe(true)
    expect(activeRun.signal.aborted).toBe(true)
    expect(runtimeSignal?.aborted).toBe(true)
    expect(result.output.type).toBe('error')
    if (result.output.type === 'error') {
      expect(result.output.message).toBe('Stopped from UI')
    }
  })

  it('combines caller-provided signals with the run controller', async () => {
    mockDatabase()

    let runtimeSignal: AbortSignal | undefined
    let markRuntimeStarted: () => void = () => {}
    const runtimeStarted = new Promise<void>((resolve) => {
      markRuntimeStarted = resolve
    })
    spyOn(mainPromptModule, 'callMainPrompt').mockImplementation(
      async (params: Parameters<typeof mainPromptModule.callMainPrompt>[0]) => {
        runtimeSignal = params.signal
        markRuntimeStarted()
        return await new Promise<never>((_, reject) => {
          params.signal.addEventListener(
            'abort',
            () => reject(params.signal.reason),
            { once: true },
          )
        })
      },
    )

    const externalController = new AbortController()
    const runController = createRunController('cloud-run-1')
    const client = new CodebuffClient({ apiKey: 'test-key' })
    const activeRun = client.runCancellable(
      {
        agent: 'base2',
        prompt: 'build mobile preview',
        signal: externalController.signal,
      },
      runController,
    )

    await runtimeStarted
    externalController.abort(new Error('Request disconnected'))
    const result = await activeRun.result

    expect(activeRun.id).toBe('cloud-run-1')
    expect(runController.cancelled).toBe(false)
    expect(activeRun.signal.aborted).toBe(true)
    expect(runtimeSignal?.aborted).toBe(true)
    expect(result.output.type).toBe('error')
    if (result.output.type === 'error') {
      expect(result.output.message).toBe('Request disconnected')
    }
  })
})
