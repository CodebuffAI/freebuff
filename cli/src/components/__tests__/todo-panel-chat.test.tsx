import { createTestRenderer } from '@opentui/core/testing'
import { createRoot, flushSync } from '@opentui/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { expect, test } from 'bun:test'
import React from 'react'

import { Chat } from '../../chat'
import {
  ChatRuntimeProvider,
  useChatRuntime,
} from '../../contexts/chat-runtime-context'
import { initializeThemeStore } from '../../hooks/use-theme'
import { setProjectRoot, tryGetProjectRoot } from '../../project-files'
import { useChatStore } from '../../state/chat-store'
import { useMessageBlockStore } from '../../state/message-block-store'
import {
  registerActiveRun,
  stopActiveRun,
  clearActiveRun,
} from '../../utils/active-run'

import type { ChatRuntime } from '../../contexts/chat-runtime-context'
import type { MultilineInputHandle } from '../multiline-input'

test('/todo takes over the composer during streaming and Escape restores it without interrupting', async () => {
  initializeThemeStore()
  const projectRoot = tryGetProjectRoot()
  setProjectRoot(process.cwd())
  useChatStore.getState().reset()
  useChatStore.getState().setMessages([
    {
      id: 'running-message',
      variant: 'ai',
      content: '',
      timestamp: '12:00',
      blocks: [
        {
          type: 'tool',
          toolName: 'write_todos',
          toolCallId: 'plan',
          input: {
            todos: [
              { task: 'Investigate', completed: true },
              { task: 'Implement', completed: false },
            ],
          },
        },
      ],
    },
  ])
  const inputRef = { current: null as MultilineInputHandle | null }
  let runtime!: ChatRuntime
  function Host() {
    runtime = useChatRuntime()
    return (
      <Chat
        consumeInitialPrompt={() => null}
        fileTree={[]}
        inputRef={inputRef}
        setIsAuthenticated={() => {}}
        setUser={() => {}}
        logoutMutation={
          {} as React.ComponentProps<typeof Chat>['logoutMutation']
        }
        authStatus="ok"
        freebuffSession={null}
      />
    )
  }
  const setup = await createTestRenderer({
    width: 100,
    height: 42,
    kittyKeyboard: true,
  })
  const root = createRoot(setup.renderer)
  const queries = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  let stops = 0
  registerActiveRun('todo-panel-test', () => {
    stops++
  })
  const settle = async () => {
    await setup.renderOnce()
    await new Promise((resolve) => setTimeout(resolve, 30))
    await setup.renderOnce()
  }

  try {
    flushSync(() =>
      root.render(
        <QueryClientProvider client={queries}>
          <ChatRuntimeProvider inputRef={inputRef} continueChat={false}>
            <Host />
          </ChatRuntimeProvider>
        </QueryClientProvider>,
      ),
    )
    await settle()
    flushSync(() => {
      runtime.isChainInProgressRef.current = true
      runtime.setStreamStatus('streaming')
      useChatStore
        .getState()
        .setInputValue({
          text: '/todo',
          cursorPosition: 5,
          lastEditDueToNav: false,
        })
    })
    await settle()
    setup.mockInput.pressEnter()
    await settle()
    expect(setup.captureCharFrame()).toContain('1/2 completed')
    expect(runtime.queuedMessages).toHaveLength(0)
    expect(inputRef.current).toBeNull()

    setup.mockInput.pressArrow('up')
    await settle()
    expect(useChatStore.getState().inputValue).toBe('')
    setup.mockInput.pressEscape()
    await settle()
    expect(stops).toBe(0)
    expect(runtime.streamStatus).toBe('streaming')
    expect(setup.captureCharFrame()).not.toContain('1/2 completed')
    expect(inputRef.current).not.toBeNull()
    await setup.mockInput.typeText('draft')
    await settle()
    expect(useChatStore.getState().inputValue).toBe('draft')
  } finally {
    clearActiveRun('todo-panel-test')
    stopActiveRun('process-exit')
    flushSync(() => root.unmount())
    queries.clear()
    setup.renderer.destroy()
    useChatStore.getState().reset()
    useMessageBlockStore.getState().reset()
    setProjectRoot(projectRoot ?? process.cwd())
  }
})
