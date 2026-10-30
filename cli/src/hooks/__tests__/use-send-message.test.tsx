import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { createTestRenderer } from '@opentui/core/testing'
import { createRoot, flushSync } from '@opentui/react'
import React, { useEffect, useRef } from 'react'

import { useSendMessage } from '../use-send-message'
import { useAgentValidation } from '../use-agent-validation'
import { setProjectRoot, tryGetProjectRoot } from '../../project-files'
import { useChatStore } from '../../state/chat-store'
import { stopActiveRun } from '../../utils/active-run'
import { setChatDirOverrideForTesting } from '../../utils/run-state-storage'

import type { RunState } from '@codebuff/sdk'
import type { SendMessageFn } from '../../types/contracts/send-message'
import type { ElapsedTimeTracker } from '../use-elapsed-time'

type RunCall = {
  runConfig: any
  resolve: (state: RunState) => void
  reject: (error: unknown) => void
}

let sendMessageFromHost: SendMessageFn | null = null
let runCalls: RunCall[] = []
let testRoot: string
let originalProjectRoot: string
let useHostedValidation = false
let validateBeforeSend = async () => ({
  success: true,
  errors: [] as Array<{ id: string; message: string }>,
})
const originalFetch = globalThis.fetch

const fakeClient = {
  run: (runConfig: any) =>
    new Promise<RunState>((resolve, reject) => {
      runCalls.push({ runConfig, resolve, reject })
    }),
}

const makeTimer = (): ElapsedTimeTracker => ({
  start: () => {},
  stop: () => {},
  pause: () => {},
  resume: () => {},
  elapsedSeconds: 0,
  startTime: null,
  isPaused: false,
})

const Host = () => {
  const validation = useAgentValidation()
  const inputRef = useRef<any>(null)
  const activeSubagentsRef = useRef(new Set<string>())
  const isChainInProgressRef = useRef(false)
  const isQueuePausedRef = useRef(false)
  const isProcessingQueueRef = useRef(false)
  const mainAgentTimer = useRef(makeTimer()).current

  const { sendMessage } = useSendMessage({
    inputRef,
    activeSubagentsRef,
    isChainInProgressRef,
    setStreamStatus: () => {},
    setCanProcessQueue: () => {},
    onBeforeMessageSend: useHostedValidation
      ? validation.validate
      : validateBeforeSend,
    mainAgentTimer,
    scrollToLatest: () => {},
    isQueuePausedRef,
    isProcessingQueueRef,
    resumeQueue: () => {},
    requeueMessageAtFront: () => {},
    continueChat: false,
    subscriptionData: null,
    getClient: async () => fakeClient as any,
  })

  useEffect(() => {
    sendMessageFromHost = sendMessage
  }, [sendMessage])

  return <text>send-message-test-host</text>
}

const waitFor = async (label: string, predicate: () => boolean) => {
  const deadline = Date.now() + 4_000
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`Timed out waiting for ${label}`)
}

const makeRunState = (marker: string): RunState =>
  ({
    traceSessionId: `trace-${marker}`,
    sessionState: {
      mainAgentState: { messageHistory: [] },
    },
    output: {
      type: 'error',
      message: 'Session ended before this response completed.',
    },
  }) as unknown as RunState

const settlePendingRuns = () => {
  for (const call of runCalls) {
    call.resolve(makeRunState('cleanup'))
  }
}

beforeEach(() => {
  sendMessageFromHost = null
  runCalls = []
  useHostedValidation = false
  validateBeforeSend = async () => ({ success: true, errors: [] })
  testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'use-send-message-'))
  originalProjectRoot = tryGetProjectRoot() ?? process.cwd()
  setProjectRoot(process.cwd())
  setChatDirOverrideForTesting(testRoot)
  useChatStore.getState().reset()
})

afterEach(() => {
  globalThis.fetch = originalFetch
  stopActiveRun('process-exit')
  setChatDirOverrideForTesting(undefined)
  setProjectRoot(originalProjectRoot)
  fs.rmSync(testRoot, { recursive: true, force: true })
})

const mountHost = async () => {
  const setup = await createTestRenderer({ width: 80, height: 3 })
  const root = createRoot(setup.renderer)
  flushSync(() => root.render(<Host />))
  await setup.renderOnce()
  expect(sendMessageFromHost).not.toBeNull()
  return { setup, root }
}

describe('useSendMessage continuation state', () => {
  test.each([
    {
      name: 'JSON HTTP rejection',
      respond: async () =>
        new Response(JSON.stringify({ error: 'Too many agent definitions' }), {
          status: 400,
        }),
      detail: 'HTTP 400',
      reason: 'Too many agent definitions',
    },
    {
      name: 'HTML HTTP rejection',
      respond: async () =>
        new Response('<html>Blocked</html>', {
          status: 403,
          statusText: 'Forbidden',
        }),
      detail: 'HTTP 403',
      reason: 'Forbidden',
    },
    {
      name: 'connection failure',
      respond: async (): Promise<Response> => {
        throw new Error('Connection reset')
      },
      detail: 'Connection reset',
      reason: 'Connection reset',
    },
  ])(
    'shows a $name before running the model and allows retry',
    async ({ respond, detail, reason }) => {
      useHostedValidation = true
      globalThis.fetch = Object.assign(respond, {
        preconnect: originalFetch.preconnect,
      }) as typeof fetch
      const { setup, root } = await mountHost()
      let retry: Promise<void> | undefined
      try {
        await sendMessageFromHost!({ content: 'hi', agentMode: 'DEFAULT' })
        expect(runCalls).toHaveLength(0)
        const messages = useChatStore.getState().messages
        expect(
          messages.find((message) => message.variant === 'user')
            ?.validationErrors,
        ).toEqual([
          { id: 'network_error', message: expect.stringContaining(detail) },
        ])
        expect(messages.at(-1)?.variant).toBe('error')
        expect(messages.at(-1)?.content).toContain('Message not sent')
        expect(messages.at(-1)?.content).toContain(detail)
        expect(messages.at(-1)?.content).toContain(reason)

        globalThis.fetch = Object.assign(
          async () => new Response(JSON.stringify({ validationErrors: [] })),
          {
            preconnect: originalFetch.preconnect,
          },
        ) as typeof fetch
        retry = sendMessageFromHost!({
          content: 'hi again',
          agentMode: 'DEFAULT',
        })
        await waitFor('retry SDK run', () => runCalls.length === 1)
      } finally {
        settlePendingRuns()
        await retry
        flushSync(() => root.unmount())
        setup.renderer.destroy()
      }
    },
  )

  test('shows a fallback when validation refuses without error details', async () => {
    validateBeforeSend = async () => ({ success: false, errors: [] })
    const { setup, root } = await mountHost()
    try {
      await sendMessageFromHost!({ content: 'hi', agentMode: 'DEFAULT' })
      expect(runCalls).toHaveLength(0)
      const messages = useChatStore.getState().messages
      expect(messages.at(-1)?.variant).toBe('error')
      expect(messages.at(-1)?.content).toContain('Message not sent')
      expect(messages.at(-1)?.content).toContain('without an explanation')
    } finally {
      flushSync(() => root.unmount())
      setup.renderer.destroy()
    }
  })

  test('persists the final streamed text and completion state before returning', async () => {
    const { setup, root } = await mountHost()
    const run = sendMessageFromHost!({
      content: 'finish',
      agentMode: 'DEFAULT',
    })

    try {
      await waitFor('SDK run', () => runCalls.length === 1)
      const finalText = 'Finished the cache TTL change. All 14 tests pass.'
      const finalState = {
        ...makeRunState('completed'),
        output: { type: 'lastMessage', value: [] },
      } as RunState
      // Return immediately after the last chunk, before the 100ms UI batch
      // flush. The live screen and a resumed chat must retain the same answer.
      runCalls[0].runConfig.handleStreamChunk(finalText)
      runCalls[0].resolve(finalState)
      await run

      const saved = JSON.parse(
        fs.readFileSync(path.join(testRoot, 'chat-messages.json'), 'utf8'),
      ).at(-1)
      expect(saved.blocks).toContainEqual({
        type: 'text',
        textType: 'text',
        content: finalText,
      })
      expect(saved.isComplete).toBe(true)
      expect(saved.metadata.runState).toEqual(finalState)
    } finally {
      settlePendingRuns()
      await run
      flushSync(() => root.unmount())
      setup.renderer.destroy()
    }
  })

  test('follow-ups inherit rejected and aborted run snapshots without stale replacement', async () => {
    const { setup, root } = await mountHost()
    const runs: Promise<void>[] = []

    try {
      runs.push(
        sendMessageFromHost!({ content: 'first', agentMode: 'DEFAULT' }),
      )
      await waitFor('first SDK run', () => runCalls.length === 1)

      const rejectedSnapshot = makeRunState('failed')
      runCalls[0].runConfig.onStateSnapshot(rejectedSnapshot)
      runCalls[0].reject(new Error('network failed'))
      await runs[0]

      runs.push(
        sendMessageFromHost!({ content: 'after error', agentMode: 'DEFAULT' }),
      )
      await waitFor('second SDK run', () => runCalls.length === 2)

      expect(runCalls[1].runConfig.previousRun).toBe(rejectedSnapshot)

      const abortedSnapshot = makeRunState('interrupted')
      runCalls[1].runConfig.onStateSnapshot(abortedSnapshot)
      stopActiveRun('user-interrupt')

      runs.push(
        sendMessageFromHost!({ content: 'after abort', agentMode: 'DEFAULT' }),
      )
      await waitFor('third SDK run', () => runCalls.length === 3)

      expect(runCalls[2].runConfig.previousRun).toBe(abortedSnapshot)

      const finalState = makeRunState('final')
      runCalls[2].resolve(finalState)
      await runs[2]

      runCalls[1].resolve(makeRunState('late'))
      await runs[1]

      runs.push(
        sendMessageFromHost!({ content: 'after late', agentMode: 'DEFAULT' }),
      )
      await waitFor('fourth SDK run', () => runCalls.length === 4)

      expect(runCalls[3].runConfig.previousRun).toBe(finalState)
    } finally {
      settlePendingRuns()
      await Promise.all(runs)
      flushSync(() => root.unmount())
      setup.renderer.destroy()
    }
  })
})
