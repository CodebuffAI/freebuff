import { IS_FREEBUFF } from '../../utils/constants'
import { useByokSelectionStore } from '../../utils/byok'
import { afterEach, beforeAll, expect, test } from 'bun:test'
import { createTestRenderer } from '@opentui/core/testing'
import { createRoot, flushSync } from '@opentui/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import { useFreebuffChatAdmission } from '../../hooks/use-freebuff-chat-admission'
import { FreebuffChatControls } from '../freebuff-chat-controls'
import {
  ChatRuntimeProvider,
  useChatRuntime,
} from '../../contexts/chat-runtime-context'
import {
  openFreebuffReasoningPicker,
  selectFreebuffChatModel,
  useFreebuffChatStore,
} from '../../state/freebuff-chat-store'
import { useFreebuffModelStore } from '../../state/freebuff-model-store'
import { useFreebuffSessionStore } from '../../state/freebuff-session-store'
import { useChatStore } from '../../state/chat-store'
import { initializeThemeStore } from '../../hooks/use-theme'
import {
  DEFAULT_FREEBUFF_MODEL_ID,
  FREEBUFF_MIMO_V25_MODEL_ID,
} from '@codebuff/common/constants/freebuff-models'
import { FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID } from '@codebuff/common/constants/freebuff-model-ids'
import type { PendingAttachment } from '../../types/store'

if (process.env.FREEBUFF_CHAT_CONTROLS_TEST !== '1') {
  test('chat admission controls (isolated Freebuff build)', async () => {
    const child = Bun.spawn([process.execPath, 'test', import.meta.path], {
      env: {
        ...process.env,
        FREEBUFF_MODE: 'true',
        FREEBUFF_CHAT_CONTROLS_TEST: '1',
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
  }, 15_000)
} else {
  let cleanup: (() => void) | undefined
  beforeAll(initializeThemeStore)
  afterEach(() => {
    cleanup?.()
    cleanup = undefined
    useChatStore.getState().reset()
    useFreebuffChatStore.setState({
      admission: null,
      pickerOpen: false,
      pickerInitialView: 'model',
      nextModel: null,
    })
    useFreebuffSessionStore.getState().setSession(null)
  })

  const attachment: PendingAttachment = {
    id: 'attached-text',
    kind: 'text',
    content: 'Keep this document',
    preview: 'Keep this document',
    charCount: 18,
  }

  /** The hour on Flash is over and 2 Freebucks are left: Flash is out of
   *  reach, MiMo is free. */
  function endedFlashHourWithTwoFreebucks() {
    const now = Date.now()
    const resetAt = new Date(now + 3_600_000).toISOString()
    useFreebuffSessionStore.getState().setSession({
      status: 'ended',
      accessTier: 'full',
      instanceId: 'cli:held',
      admittedAt: new Date(now - 3_700_000).toISOString(),
      expiresAt: new Date(now - 100_000).toISOString(),
      gracePeriodEndsAt: new Date(now + 1_700_000).toISOString(),
      gracePeriodRemainingMs: 1_700_000,
      freebucks: {
        balance: 2,
        daily: { limit: 100, spent: 98, remaining: 2, resetAt },
        wallet: { balance: 0, monthlyBonus: 0 },
        spend: { limitUsd: 1.5, resetAt },
        monthly: { limitUsd: 25, spentUsd: 0, remainingUsd: 25, resetAt },
        planId: null,
        prices: {
          [FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID]: 15,
          [FREEBUFF_MIMO_V25_MODEL_ID]: 0,
        },
      },
    })
    useFreebuffModelStore.setState({
      selectedModel: FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID,
      hasExplicitPick: true,
    })
  }

  /** `turnRunning` leaves pricing to the runtime's own gate, which waits on
   *  the turn. */
  async function mount(opts: { turnRunning?: boolean; height?: number } = {}) {
    expect(IS_FREEBUFF).toBe(true)
    useByokSelectionStore.setState({ selected: undefined, setupOpen: false })
    const setup = await createTestRenderer({
      width: 90,
      height: opts.height ?? 25,
      kittyKeyboard: true,
    })
    const root = createRoot(setup.renderer)
    const queries = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    let runtime: ReturnType<typeof useChatRuntime> | undefined
    function Seed() {
      useFreebuffChatAdmission(!opts.turnRunning)
      runtime = useChatRuntime()
      return <FreebuffChatControls />
    }
    cleanup = () => {
      flushSync(() => root.unmount())
      queries.clear()
      setup.renderer.destroy()
    }
    flushSync(() =>
      root.render(
        <QueryClientProvider client={queries}>
          <ChatRuntimeProvider
            inputRef={{ current: null }}
            continueChat={false}
          >
            <Seed />
          </ChatRuntimeProvider>
        </QueryClientProvider>,
      ),
    )
    if (opts.turnRunning) flushSync(() => runtime!.setStreamStatus('streaming'))
    flushSync(() =>
      runtime!.addToQueueFront({
        content: 'Keep this first message',
        attachments: [attachment],
      }),
    )
    await setup.renderOnce()
    const deadline = performance.now() + 1000
    while (runtime!.queuedMessages.length === 0 && performance.now() < deadline)
      await Bun.sleep(5)
    expect(runtime!.queuedMessages).toHaveLength(1)
    return Object.assign(setup, { runtime: runtime! })
  }

  test('reasoning shortcut opens the next model at its saved effort and cancels without admission', async () => {
    const previous = useFreebuffModelStore.getState()
    const model = 'z-ai/glm-5.3-flash'
    useFreebuffModelStore.setState({
      selectedModel: 'mimo/mimo-v2.5',
      reasoningEffortByModel: { [model]: 'low' },
    })
    useFreebuffChatStore.setState({ nextModel: model })
    openFreebuffReasoningPicker()
    try {
      const setup = await mount()
      expect(setup.captureCharFrame()).toContain('GLM 5.3 Flash • Reasoning')
      expect(setup.captureCharFrame()).toContain('› low')
      flushSync(() => setup.mockInput.pressKey('ESCAPE'))
      await setup.renderOnce()
      expect(setup.captureCharFrame()).not.toContain('Enter save')
      flushSync(() => setup.mockInput.pressKey('ESCAPE'))
      expect(useFreebuffChatStore.getState().pickerOpen).toBe(false)
      expect(useFreebuffChatStore.getState().admission).toBeNull()
      expect(useFreebuffChatStore.getState().nextModel).toBe(model)
      expect(useFreebuffModelStore.getState().selectedModel).toBe('mimo/mimo-v2.5')
      expect(useFreebuffModelStore.getState().reasoningEffortByModel).toEqual({
        [model]: 'low',
      })
      expect(useFreebuffSessionStore.getState().session).toBeNull()
    } finally {
      useFreebuffModelStore.setState(previous)
    }
  })

  test('GLM to Luna asks for 4 hours (20 Freebucks)', async () => {
    const expiresAt = new Date(Date.now() + 3_600_000).toISOString()
    const glm = 'z-ai/glm-5.3-flash'
    const luna = 'openai/gpt-6-luna'
    useFreebuffSessionStore.getState().setSession({
      status: 'active',
      accessTier: 'full',
      model: glm,
      instanceId: 'cli:held',
      admittedAt: new Date().toISOString(),
      expiresAt,
      remainingMs: 3_600_000,
      freebucks: {
        balance: 90,
        daily: { limit: 100, spent: 10, remaining: 90, resetAt: expiresAt },
        wallet: { balance: 0, monthlyBonus: 0 },
        spend: { limitUsd: 1.5, resetAt: expiresAt },
        monthly: {
          limitUsd: 25,
          spentUsd: 0,
          remainingUsd: 25,
          resetAt: expiresAt,
        },
        planId: null,
        prices: { [glm]: 5, [luna]: 20 },
      },
    })
    useFreebuffChatStore.setState({
      admission: { phase: 'requested', model: luna, metadataChecked: true },
    })
    useFreebuffModelStore.setState({ hasExplicitPick: true }) // Luna was picked
    const setup = await mount()
    expect(useFreebuffChatStore.getState().admission?.phase).toBe('confirm')
    expect(setup.captureCharFrame()).toContain('4 hours')
    expect(useFreebuffChatStore.getState().admission?.message).toContain(
      'takes 4 hours from your balance',
    )
    await setup.mockInput.pressKey('ESCAPE')
    expect(useFreebuffSessionStore.getState().session?.status).toBe('active')
    expect(useChatStore.getState().inputValue).toBe('Keep this first message')
  })

  test('cancelling consent restores the first message and attachments to the draft', async () => {
    useFreebuffChatStore.setState({
      admission: {
        phase: 'confirm',
        model: DEFAULT_FREEBUFF_MODEL_ID,
        message: 'Spend 5 from your wallet?',
      },
    })
    const setup = await mount()
    expect(setup.captureCharFrame()).toContain('Spend 5 from your wallet?')
    await setup.mockInput.pressKey('ESCAPE')
    expect(useFreebuffChatStore.getState().admission).toBeNull()
    expect(useChatStore.getState().inputValue).toBe('Keep this first message')
    expect(useChatStore.getState().pendingAttachments).toEqual([attachment])
  })

  test('cancelling a model-switch question leaves the existing paid session intact', async () => {
    const session = {
      status: 'active' as const,
      accessTier: 'full' as const,
      model: DEFAULT_FREEBUFF_MODEL_ID,
      instanceId: 'cli:held',
      admittedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      remainingMs: 3_600_000,
    }
    useFreebuffSessionStore.getState().setSession(session)
    // Successful admissions retain this cancellation identity too.
    useFreebuffSessionStore
      .getState()
      .setPendingAdmission({ instanceId: session.instanceId, token: 'fixture' })
    useFreebuffChatStore.setState({
      admission: {
        phase: 'confirm',
        model: 'mimo/mimo-v2.5',
        previousSession: session,
        message: 'End the current model session?',
      },
    })
    const setup = await mount()
    await setup.mockInput.pressKey('ESCAPE')
    expect(useFreebuffSessionStore.getState().session).toBe(session)
    expect(useChatStore.getState().inputValue).toBe('Keep this first message')
    expect(useFreebuffChatStore.getState().admission).toBeNull()
  })

  test('too few hours for the old model: Enter opens the picker on another row', async () => {
    const previous = useFreebuffModelStore.getState()
    endedFlashHourWithTwoFreebucks()
    useFreebuffChatStore.setState({
      admission: {
        phase: 'requested',
        model: FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID,
        metadataChecked: true,
      },
    })
    try {
      // The one startable row (MiMo v2.6 Flash Fast, 0 here) waits under
      // Optimized's More since 2026-10-30, below Luna. The test renderer never
      // measures layout, so the picker's scroll-to-cursor cannot run here: a
      // taller terminal keeps the row in the frame.
      const setup = await mount({ height: 45 })
      await setup.renderOnce()
      expect(useFreebuffChatStore.getState().admission).toMatchObject({
        phase: 'failed',
        chooseModel: true,
      })
      expect(setup.captureCharFrame()).toContain('Enter: choose another model')

      flushSync(() => setup.mockInput.pressEnter())
      await setup.renderOnce()
      expect(useFreebuffChatStore.getState().pickerOpen).toBe(true)
      // The cursor starts off the row this balance cannot start.
      const cursor = setup
        .captureCharFrame()
        .split('\n')
        .find((line) => line.includes('›'))
      expect(cursor).toBeDefined()
      expect(cursor).not.toContain('DeepSeek')

      // Esc leaves the picker for the refusal, not the draft.
      flushSync(() => setup.mockInput.pressKey('ESCAPE'))
      await setup.renderOnce()
      expect(useFreebuffChatStore.getState().pickerOpen).toBe(false)
      expect(useFreebuffChatStore.getState().admission?.phase).toBe('failed')
    } finally {
      useFreebuffModelStore.setState(previous)
    }
  })

  test('a message queued behind a running turn can change model before it sends', async () => {
    const previous = useFreebuffModelStore.getState()
    endedFlashHourWithTwoFreebucks()
    useFreebuffChatStore.setState({
      admission: { phase: 'requested', model: FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID },
    })
    try {
      const setup = await mount({ turnRunning: true })
      await setup.renderOnce()
      const waiting = setup.captureCharFrame()
      expect(waiting).toContain('will send after the current turn')
      expect(waiting).toContain('Enter: change model')

      flushSync(() => setup.mockInput.pressEnter())
      await setup.renderOnce()
      expect(useFreebuffChatStore.getState().pickerOpen).toBe(true)

      // The turn ends mid-pick: the old model is not priced while choosing.
      flushSync(() => setup.runtime.setStreamStatus('idle'))
      await Bun.sleep(50)
      expect(useFreebuffChatStore.getState().admission?.phase).toBe('requested')

      // What the picker calls when a row is chosen.
      flushSync(() => selectFreebuffChatModel(FREEBUFF_MIMO_V25_MODEL_ID))
      expect(useFreebuffChatStore.getState().pickerOpen).toBe(false)
      const deadline = performance.now() + 1000
      while (
        useFreebuffChatStore.getState().admission?.phase !== 'starting' &&
        performance.now() < deadline
      )
        await Bun.sleep(5)
      expect(useFreebuffChatStore.getState().admission).toMatchObject({
        phase: 'starting',
        model: FREEBUFF_MIMO_V25_MODEL_ID,
      })
      expect(setup.runtime.queuedMessages).toHaveLength(1)
    } finally {
      useFreebuffModelStore.setState(previous)
    }
  })
}
