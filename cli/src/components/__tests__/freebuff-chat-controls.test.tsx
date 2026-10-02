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
  useFreebuffChatStore,
} from '../../state/freebuff-chat-store'
import { useFreebuffModelStore } from '../../state/freebuff-model-store'
import { useFreebuffSessionStore } from '../../state/freebuff-session-store'
import { useChatStore } from '../../state/chat-store'
import { initializeThemeStore } from '../../hooks/use-theme'
import { DEFAULT_FREEBUFF_MODEL_ID } from '@codebuff/common/constants/freebuff-models'
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

  async function mount() {
    expect(IS_FREEBUFF).toBe(true)
    useByokSelectionStore.setState({ selected: undefined, setupOpen: false })
    const setup = await createTestRenderer({
      width: 90,
      height: 25,
      kittyKeyboard: true,
    })
    const root = createRoot(setup.renderer)
    const queries = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    let runtime: ReturnType<typeof useChatRuntime> | undefined
    function Seed() {
      useFreebuffChatAdmission(true)
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
    return setup
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

  test('GLM to Luna asks for 10 Freebucks: ending GLM releases its first-tab discount', async () => {
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
        listPrices: { [glm]: 5, [luna]: 20 },
        firstTabDiscount: {
          amount: 10,
          available: false,
          holder: { instanceId: 'cli:held', surface: 'desktop', expiresAt },
        },
      },
    })
    useFreebuffChatStore.setState({
      admission: { phase: 'requested', model: luna, metadataChecked: true },
    })
    const setup = await mount()
    expect(useFreebuffChatStore.getState().admission?.phase).toBe('confirm')
    expect(setup.captureCharFrame()).toContain('10')
    expect(useFreebuffChatStore.getState().admission?.message).toContain(
      'costs 10',
    )
    expect(useFreebuffChatStore.getState().admission?.message).not.toContain(
      'costs 20',
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
}
