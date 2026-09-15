import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { createTestRenderer } from '@opentui/core/testing'
import { createRoot, flushSync } from '@opentui/react'
import React, { useEffect, useRef } from 'react'

import { useSendMessage } from '../use-send-message'
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
    onBeforeMessageSend: async () => ({ success: true, errors: [] }),
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
  testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'use-send-message-'))
  originalProjectRoot = tryGetProjectRoot() ?? process.cwd()
  setProjectRoot(process.cwd())
  setChatDirOverrideForTesting(testRoot)
  useChatStore.getState().reset()
})

afterEach(() => {
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

// Regression tests for the syncRunState fix (#1054).
//
// Both scenarios previously caused a follow-up message to lose all conversation
// context because previousRunStateRef was not updated before client.run()
// settled. The tests below drive the real hook and assert that the snapshot
// passed to onStateSnapshot() is the one carried into the next run's
// previousRun, verifying the actual wiring — not a reimplemented proxy.
describe('useSendMessage syncRunState regression (#1054)', () => {
  test('abort path: latestRunStateSnapshot is committed to previousRunStateRef before client.run() settles', async () => {
    // This exercises use-send-message.ts line ~355:
    //   syncRunState(latestRunStateSnapshot)  ← inside registerActiveRun callback
    // Calling stopActiveRun fires the real abort callback synchronously, before
    // client.run()'s promise resolves. The follow-up run must receive the
    // snapshot that was live at abort time, not an empty/null state.
    const { setup, root } = await mountHost()
    const runs: Promise<void>[] = []

    try {
      runs.push(
        sendMessageFromHost!({ content: 'first message', agentMode: 'DEFAULT' }),
      )
      await waitFor('first run registered', () => runCalls.length === 1)

      const liveSnapshot = makeRunState('mid-stream')
      // Simulate a partial streaming state update arriving before Esc.
      runCalls[0].runConfig.onStateSnapshot(liveSnapshot)
      // User presses Esc — fires the real registerActiveRun abort callback.
      stopActiveRun('user-interrupt')

      runs.push(
        sendMessageFromHost!({ content: 'follow-up after abort', agentMode: 'DEFAULT' }),
      )
      await waitFor('second run registered', () => runCalls.length === 2)

      // The real hook must have assigned liveSnapshot into previousRunStateRef
      // via syncRunState before we got here — not the blank sentinel.
      expect(runCalls[1].runConfig.previousRun).toBe(liveSnapshot)
    } finally {
      settlePendingRuns()
      await Promise.all(runs)
      flushSync(() => root.unmount())
      setup.renderer.destroy()
    }
  })

  test('error path: latestRunStateSnapshot is committed to previousRunStateRef when client.run() rejects', async () => {
    // This exercises use-send-message.ts line ~752:
    //   syncRunState(latestRunStateSnapshot)  ← inside catch (error) block
    // When client.run() throws (network error, session expiry, gate error),
    // the catch block must persist the last received snapshot so the user's
    // conversation context survives the failure.
    const { setup, root } = await mountHost()
    const runs: Promise<void>[] = []

    try {
      runs.push(
        sendMessageFromHost!({ content: 'first message', agentMode: 'DEFAULT' }),
      )
      await waitFor('first run registered', () => runCalls.length === 1)

      const lastSnapshot = makeRunState('before-error')
      // Simulate a snapshot arriving mid-stream, then a network / gate error.
      runCalls[0].runConfig.onStateSnapshot(lastSnapshot)
      runCalls[0].reject(new Error('session expired'))
      await runs[0]

      runs.push(
        sendMessageFromHost!({ content: 'continue', agentMode: 'DEFAULT' }),
      )
      await waitFor('second run registered', () => runCalls.length === 2)

      // The catch block must have called syncRunState(latestRunStateSnapshot),
      // making lastSnapshot available to the next run.
      expect(runCalls[1].runConfig.previousRun).toBe(lastSnapshot)
    } finally {
      settlePendingRuns()
      await Promise.all(runs)
      flushSync(() => root.unmount())
      setup.renderer.destroy()
    }
  })
  test('abort path: falls back to prior run state when client.run() is aborted before any snapshot arrives', async () => {
    // latestRunStateSnapshot is initialized from previousRunStateRef.current (line ~313).
    // If the user presses Esc immediately — before the SDK emits any onStateSnapshot —
    // syncRunState is called with that initial value, which is the prior completed run's
    // state. This directly answers the question: "is latestRunStateSnapshot guaranteed
    // to be populated at the abort callsite?" Yes — it is never null.
    const { setup, root } = await mountHost()
    const runs: Promise<void>[] = []

    try {
      // Run 1: complete successfully so there IS a known prior state.
      runs.push(
        sendMessageFromHost!({ content: 'first message', agentMode: 'DEFAULT' }),
      )
      await waitFor('first run registered', () => runCalls.length === 1)
      const priorState = makeRunState('completed')
      runCalls[0].resolve(priorState)
      await runs[0]

      // Run 2: abort immediately, before any onStateSnapshot arrives.
      runs.push(
        sendMessageFromHost!({ content: 'second message', agentMode: 'DEFAULT' }),
      )
      await waitFor('second run registered', () => runCalls.length === 2)
      // Deliberately NO onStateSnapshot call — simulates Esc before any streaming progress.
      stopActiveRun('user-interrupt')

      // Run 3 should carry priorState (from run 1), not a blank/null sentinel.
      runs.push(
        sendMessageFromHost!({ content: 'follow-up', agentMode: 'DEFAULT' }),
      )
      await waitFor('third run registered', () => runCalls.length === 3)

      expect(runCalls[2].runConfig.previousRun).toBe(priorState)
    } finally {
      settlePendingRuns()
      await Promise.all(runs)
      flushSync(() => root.unmount())
      setup.renderer.destroy()
    }
  })
})
