import { describe, expect, test } from 'bun:test'

import { askSideQuestion } from '../btw'

import type { RunState } from '@codebuff/sdk'

const previousRun = {
  output: { type: 'lastMessage', value: [] },
  traceSessionId: 'trace',
} as unknown as RunState

function clientReturning(output: RunState['output']) {
  const calls: Record<string, unknown>[] = []
  const getClient = (async () => ({
    run: async (options: Record<string, unknown>) => {
      calls.push(options)
      return { output, traceSessionId: 'trace' }
    },
  })) as unknown as Parameters<typeof askSideQuestion>[0]['getClient']
  return { calls, getClient }
}

describe('askSideQuestion', () => {
  test('asks once, with no tools, off the current run', async () => {
    const { calls, getClient } = clientReturning({
      type: 'lastMessage',
      value: [
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'Because the flag defaults to off.' }],
        },
      ],
    })

    const answer = await askSideQuestion({
      question: 'Why is X off?',
      previousRun,
      getClient,
    })

    expect(answer).toBe('Because the flag defaults to off.')
    expect(calls).toHaveLength(1)
    expect(calls[0]?.prompt).toBe('Why is X off?')
    expect(calls[0]?.previousRun).toBe(previousRun)
    expect(calls[0]?.maxAgentSteps).toBe(1)
    expect((calls[0]?.agent as { toolNames: string[] }).toolNames).toEqual([])
  })

  test('surfaces a run error', async () => {
    const { getClient } = clientReturning({
      type: 'error',
      message: 'Out of credits',
    })

    await expect(
      askSideQuestion({ question: 'Anything?', previousRun, getClient }),
    ).rejects.toThrow('Out of credits')
  })

  test('fails when the run returns no text', async () => {
    const { getClient } = clientReturning({ type: 'lastMessage', value: [] })

    await expect(
      askSideQuestion({ question: 'Anything?', previousRun, getClient }),
    ).rejects.toThrow('No answer came back.')
  })

  test('asks the user to log in when there is no client', async () => {
    const getClient = (async () =>
      null) as unknown as Parameters<typeof askSideQuestion>[0]['getClient']

    await expect(
      askSideQuestion({ question: 'Anything?', previousRun, getClient }),
    ).rejects.toThrow('/login')
  })
})
