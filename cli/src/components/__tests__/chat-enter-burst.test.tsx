import { createTestRenderer } from '@opentui/core/testing'
import { createRoot, flushSync } from '@opentui/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, test } from 'bun:test'
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
import { stopActiveRun } from '../../utils/active-run'

import type { ChatRuntime } from '../../contexts/chat-runtime-context'
import type { MultilineInputHandle } from '../multiline-input'

/**
 * End to end through the router: while a turn runs, a submit is queued. On
 * 2026-11-11 one stdin read of Returns queued ~400 copies of one draft, and
 * the queue then sent each to be refused as `scripted`.
 */

let cleanup: (() => Promise<void>) | undefined
afterEach(async () => {
  await cleanup?.()
  cleanup = undefined
})

async function mountChatWithTurnRunning(draft: string) {
  initializeThemeStore()
  const projectRoot = tryGetProjectRoot()
  setProjectRoot(process.cwd())
  useChatStore.getState().reset()
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
  // No kitty keyboard: a legacy terminal sends Return as a bare "\r".
  const setup = await createTestRenderer({ width: 100, height: 30 })
  const root = createRoot(setup.renderer)
  const queries = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const settle = async () => {
    await setup.renderOnce()
    await new Promise((resolve) => setTimeout(resolve, 30))
    await setup.renderOnce()
  }
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
    useChatStore.getState().setInputValue({
      text: draft,
      cursorPosition: draft.length,
      lastEditDueToNav: false,
    })
  })
  await settle()
  cleanup = async () => {
    stopActiveRun('process-exit')
    flushSync(() => root.unmount())
    queries.clear()
    setup.renderer.destroy()
    useChatStore.getState().reset()
    useMessageBlockStore.getState().reset()
    setProjectRoot(projectRoot ?? process.cwd())
  }
  return {
    queued: () => runtime.queuedMessages.map((message) => message.content),
    async read(raw: string) {
      setup.renderer.stdin.emit('data', Buffer.from(raw))
      await settle()
    },
  }
}

test('a burst of Returns in one read queues the draft once', async () => {
  const chat = await mountChatWithTurnRunning('Bitte prüfe die Datei')
  await chat.read('\r'.repeat(30))
  expect(chat.queued()).toEqual(['Bitte prüfe die Datei'])
  expect(useChatStore.getState().inputValue).toBe('')
})

test('a typed-out multi-line paste is queued once, whole, with its line breaks', async () => {
  const chat = await mountChatWithTurnRunning('please check this log:')
  await chat.read('\rerror one\rerror two\r')
  expect(chat.queued()).toEqual([
    'please check this log:\nerror one\nerror two',
  ])
  expect(useChatStore.getState().inputValue).toBe('')
})
