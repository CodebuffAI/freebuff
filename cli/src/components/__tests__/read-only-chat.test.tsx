import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from 'bun:test'
import {
  mockModule,
  type MockResult,
} from '@codebuff/common/testing/mock-modules'
import { freebucksFixture } from '@codebuff/common/testing/freebuff'
import { createTestRenderer } from '@opentui/core/testing'
import { createRoot, flushSync } from '@opentui/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'

import { AuthedSurfaceRoutes } from '../../app'
import { initializeThemeStore } from '../../hooks/use-theme'
import { useChatHistoryStore } from '../../state/chat-history-store'
import { useChatStore } from '../../state/chat-store'
import { useMessageBlockStore } from '../../state/message-block-store'
import { useByokSelectionStore } from '../../utils/byok'
import { HistoryShortcut } from '../history-shortcut'
import { ReadOnlyChat } from '../read-only-chat'

import type { FreebuffSessionResponse } from '../../types/freebuff-session'

let constantsMock: MockResult
let cleanup: (() => void) | undefined
const originalByok = useByokSelectionStore.getState()

beforeAll(async () => {
  initializeThemeStore()
  constantsMock = await mockModule(
    new URL('../../utils/constants.ts', import.meta.url).pathname,
    () => ({ IS_FREEBUFF: true }),
  )
})
afterEach(() => {
  cleanup?.()
  cleanup = undefined
  useChatStore.getState().reset()
  useChatHistoryStore.getState().reset()
  useMessageBlockStore.getState().reset()
  useByokSelectionStore.setState(originalByok)
})
afterAll(() => constantsMock.clear())

async function mount(node: React.ReactNode, height = 24) {
  cleanup?.()
  const setup = await createTestRenderer({
    width: 100,
    height,
    kittyKeyboard: true,
  })
  const root = createRoot(setup.renderer)
  const queries = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  cleanup = () => {
    flushSync(() => root.unmount())
    queries.clear()
    setup.renderer.destroy()
  }
  flushSync(() =>
    root.render(
      <QueryClientProvider client={queries}>{node}</QueryClientProvider>,
    ),
  )
  await setup.renderOnce()
  return setup
}

const seedTranscript = () =>
  useChatStore.getState().setMessages([
    {
      id: 'question',
      variant: 'user',
      content: 'Explain this algorithm',
      timestamp: '12:00',
    },
    {
      id: 'answer',
      variant: 'ai',
      content: 'Saved answer available with zero Freebucks',
      timestamp: '12:01',
      isComplete: true,
    },
    {
      id: 'plan',
      variant: 'ai',
      content: '',
      timestamp: '12:02',
      isComplete: true,
      blocks: [{ type: 'plan', content: 'A saved implementation plan' }],
    },
  ])

describe('history without a model session', () => {
  const sessions: Array<FreebuffSessionResponse | null> = [
    null,
    { status: 'none', freebucks: freebucksFixture(0) },
    {
      status: 'rate_limited',
      recentCount: 1,
      limit: 1,
      retryAfterMs: 60_000,
      model: 'test-model',
      resetTimeZone: 'UTC',
      resetAt: new Date(Date.now() + 60_000).toISOString(),
      windowHours: 24,
      period: 'pacific_day',
      freebucksShortfall: { price: 5, balance: 0 },
    },
    { status: 'superseded' },
  ]

  for (const session of sessions) {
    test(`--continue displays the saved transcript with ${session?.status ?? 'loading'} admission`, async () => {
      useByokSelectionStore.setState({ selected: undefined, setupOpen: false })
      seedTranscript()
      const props: React.ComponentProps<typeof AuthedSurfaceRoutes> = {
        runtimeKey: 'history-test',
        consumeInitialPrompt: () => null,
        fileTree: [],
        inputRef: { current: null },
        setIsAuthenticated: () => {},
        setUser: () => {},
        logoutMutation: {} as React.ComponentProps<
          typeof AuthedSurfaceRoutes
        >['logoutMutation'],
        continueChat: true,
        continueChatId: 'saved',
        authStatus: 'ok',
        initialMode: undefined,
        gitRoot: null,
        onSwitchToGitRoot: () => {},
        showChatHistory: false,
        onSelectChat: () => {},
        onCancelChatHistory: () => {},
        onNewChat: () => {},
        session,
        sessionFailure: null,
      }
      const setup = await mount(<AuthedSurfaceRoutes {...props} />)
      const frame = setup.captureCharFrame()
      expect(frame).toContain('Saved answer available with zero Freebucks')
      expect(frame).toContain('M · Choose model')
      expect(frame).not.toContain('Start coding for free')
      expect(frame).toContain('A saved implementation plan')
      expect(frame).not.toContain('Build DEFAULT')
      const history = await mount(
        <AuthedSurfaceRoutes {...props} continueChat={false} showChatHistory />,
      )
      expect(history.captureCharFrame()).toContain('Select a chat to resume')
      expect(history.captureCharFrame()).not.toContain('Start coding for free')
    })
  }

  test('history shortcut opens history', async () => {
    const setup = await mount(<HistoryShortcut />)
    await setup.mockInput.pressKey('h')
    expect(useChatHistoryStore.getState().showChatHistory).toBe(true)
  })

  test('history shortcut waits until the introductory card is dismissed', async () => {
    const setup = await mount(<HistoryShortcut disabled />)
    await setup.mockInput.pressKey('h')
    expect(useChatHistoryStore.getState().showChatHistory).toBe(false)
  })

  test('long transcripts can scroll and load older messages while the navigation stays visible', async () => {
    useChatStore.getState().setMessages(
      Array.from({ length: 20 }, (_, index) => ({
        id: `saved-${index}`,
        variant: 'user' as const,
        content: `Saved message number ${index}`,
        timestamp: '12:00',
      })),
    )
    const setup = await mount(<ReadOnlyChat onChooseModel={() => {}} />, 12)
    setup.mockInput.pressKey('HOME')
    await setup.renderOnce()
    let frame = setup.captureCharFrame()
    expect(frame).toContain('M · Choose model')
    expect(frame).toContain('Load previous messages')
    const lines = frame.split('\n')
    const y = lines.findIndex((line) => line.includes('Load previous messages'))
    const x = lines[y].indexOf('Load previous messages') + 2
    await setup.mockMouse.click(x, y)
    await new Promise((resolve) => setTimeout(resolve, 20))
    setup.mockInput.pressKey('HOME')
    await setup.renderOnce()
    frame = setup.captureCharFrame()
    expect(frame).toContain('Saved message number 0')
    expect(frame).toContain('M · Choose model')
  })

  test('reading removes stale run callbacks, Enter does nothing, and model selection is explicit', async () => {
    seedTranscript()
    let runs = 0
    let modelChoices = 0
    useMessageBlockStore.getState().setCallbacks({
      ...useMessageBlockStore.getState().callbacks,
      onBuildFast: () => {
        runs++
      },
      onSponsoredProposalAccept: () => {
        runs++
      },
    })
    const setup = await mount(
      <ReadOnlyChat
        onChooseModel={() => {
          modelChoices++
        }}
      />,
    )
    useMessageBlockStore.getState().callbacks.onBuildFast()
    useMessageBlockStore
      .getState()
      .callbacks.onSponsoredProposalAccept('test/repo')
    setup.mockInput.pressEnter()
    expect(runs).toBe(0)
    expect(modelChoices).toBe(0)
    expect(useChatStore.getState().messages).toHaveLength(3)
    await setup.mockInput.pressKey('m')
    expect(modelChoices).toBe(1)
    setup.mockInput.pressEscape()
    await setup.renderOnce()
    expect(useChatHistoryStore.getState().showChatHistory).toBe(true)
  })
})
