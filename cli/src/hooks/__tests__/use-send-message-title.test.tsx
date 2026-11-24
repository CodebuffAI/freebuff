import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { DEFAULT_FREEBUFF_MODEL_ID } from '@codebuff/common/constants/freebuff-models'
import { createTestRenderer } from '@opentui/core/testing'
import { createRoot, flushSync } from '@opentui/react'
import React, { useEffect, useRef } from 'react'

import { useSendMessage } from '../use-send-message'
import { setProjectRoot, tryGetProjectRoot } from '../../project-files'
import { useChatStore } from '../../state/chat-store'
import { useFreebuffChatStore } from '../../state/freebuff-chat-store'
import { useFreebuffModelStore } from '../../state/freebuff-model-store'
import { useFreebuffSessionStore } from '../../state/freebuff-session-store'
import { stopActiveRun } from '../../utils/active-run'
import * as auth from '../../utils/auth'
import { useByokSelectionStore } from '../../utils/byok'
import { IS_FREEBUFF } from '../../utils/constants'
import { setChatDirOverrideForTesting } from '../../utils/run-state-storage'

import type { RunState } from '@codebuff/sdk'
import type { SendMessageFn } from '../../types/contracts/send-message'

// An own-key chat's prompts go to the user's provider. Titling it would send
// its first message to ours, so the title request must never happen for one.
// The BYOK branch exists only in the Freebuff build, so this re-runs itself
// with FREEBUFF_MODE set, as freebuff-chat-controls.test.tsx does.
if (process.env.SEND_MESSAGE_TITLE_TEST !== '1') {
  test('chat titles (isolated Freebuff build)', async () => {
    const child = Bun.spawn([process.execPath, 'test', import.meta.path], {
      env: {
        ...process.env,
        FREEBUFF_MODE: 'true',
        SEND_MESSAGE_TITLE_TEST: '1',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect({ code, output: code ? stdout + stderr : '' }).toEqual({
      code: 0,
      output: '',
    })
  }, 20_000)
} else {
  let sendMessage: SendMessageFn | null = null
  let titleRequests: string[] = []
  let testRoot: string
  let originalProjectRoot: string
  const originalFetch = globalThis.fetch
  const pendingRuns: Array<(state: RunState) => void> = []

  const fakeClient = {
    run: () =>
      new Promise<RunState>((resolve) => {
        pendingRuns.push(resolve)
      }),
  }

  const Host = () => {
    const inputRef = useRef<any>(null)
    const activeSubagentsRef = useRef(new Set<string>())
    const isChainInProgressRef = useRef(false)
    const isQueuePausedRef = useRef(false)
    const isProcessingQueueRef = useRef(false)
    const { sendMessage: send } = useSendMessage({
      inputRef,
      activeSubagentsRef,
      isChainInProgressRef,
      setStreamStatus: () => {},
      setCanProcessQueue: () => {},
      onBeforeMessageSend: async () => ({ success: true, errors: [] }),
      mainAgentTimer: {
        start: () => {},
        stop: () => {},
        pause: () => {},
        resume: () => {},
        elapsedSeconds: 0,
        startTime: null,
        isPaused: false,
      },
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
      sendMessage = send
    }, [send])
    return <text>title-test-host</text>
  }

  /** Sends a chat's first message and reports whether its title was asked for. */
  const firstSendRequestsTitle = async (): Promise<boolean> => {
    const setup = await createTestRenderer({ width: 80, height: 3 })
    const root = createRoot(setup.renderer)
    flushSync(() => root.render(<Host />))
    await setup.renderOnce()
    let settled = false
    const sending = sendMessage!({
      content: 'Build a game',
      agentMode: 'DEFAULT',
    }).finally(() => {
      settled = true
    })
    try {
      // The send either reaches the model or stops at the own-key client;
      // the title decision is made before both.
      const deadline = Date.now() + 4_000
      while (!settled && pendingRuns.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      expect(settled || pendingRuns.length > 0).toBe(true)
      // The request is fire-and-forget; give it a turn to leave.
      await new Promise((resolve) => setTimeout(resolve, 50))
      return titleRequests.length > 0
    } finally {
      for (const resolve of pendingRuns.splice(0)) {
        resolve({
          sessionState: undefined,
          output: { type: 'error', message: 'done' },
        } as unknown as RunState)
      }
      await sending
      flushSync(() => root.unmount())
      setup.renderer.destroy()
    }
  }

  beforeEach(() => {
    expect(IS_FREEBUFF).toBe(true)
    titleRequests = []
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'send-message-title-'))
    originalProjectRoot = tryGetProjectRoot() ?? process.cwd()
    setProjectRoot(process.cwd())
    setChatDirOverrideForTesting(testRoot)
    useChatStore.getState().reset()
    spyOn(auth, 'getAuthToken').mockReturnValue('test-token')
    globalThis.fetch = Object.assign(
      async (input: string | URL | Request) => {
        const url = String(input instanceof Request ? input.url : input)
        if (url.endsWith('/api/v1/freebuff/title')) {
          titleRequests.push(url)
          return new Response(JSON.stringify({ title: 'A Game' }))
        }
        return new Response('{}')
      },
      { preconnect: originalFetch.preconnect },
    ) as typeof fetch
    // A live session on the selected model, so a Freebuff send is admitted.
    useFreebuffModelStore.setState({ selectedModel: DEFAULT_FREEBUFF_MODEL_ID })
    useFreebuffChatStore.setState({ nextModel: null, admission: null })
    useFreebuffSessionStore.getState().setSession({
      status: 'active',
      accessTier: 'full',
      model: DEFAULT_FREEBUFF_MODEL_ID,
      instanceId: 'test',
      admittedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      remainingMs: 3_600_000,
    } as any)
    useByokSelectionStore.setState({ selected: undefined, setupOpen: false })
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    stopActiveRun('process-exit')
    setChatDirOverrideForTesting(undefined)
    setProjectRoot(originalProjectRoot)
    useByokSelectionStore.setState({ selected: undefined, setupOpen: false })
    fs.rmSync(testRoot, { recursive: true, force: true })
  })

  test('a Freebuff chat asks for its title on the first send', async () => {
    // The control: without it, a broken request would pass the test below.
    expect(await firstSendRequestsTitle()).toBe(true)
  })

  test('an own-key chat never sends its first message to the title model', async () => {
    useByokSelectionStore.setState({
      selected: { id: 'conn-1', revision: 1, provider: 'openrouter' },
    })
    expect(await firstSendRequestsTitle()).toBe(false)
  })
}
