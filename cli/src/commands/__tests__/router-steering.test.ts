import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

import { useChatStore } from '../../state/chat-store'
import {
  __resetSteeringForTests,
  activateSteering,
  drainSteeringMessages,
} from '../../utils/steering-buffer'
import { routeUserPrompt } from '../router'

import type { RouterParams } from '../command-registry'

const createMockParams = (
  overrides: Partial<RouterParams> = {},
): RouterParams =>
  ({
    agentMode: 'DEFAULT',
    inputRef: { current: null },
    inputValue: '',
    isChainInProgressRef: { current: false },
    isStreaming: false,
    logoutMutation: {} as RouterParams['logoutMutation'],
    streamMessageIdRef: { current: null },
    addToQueue: mock(() => {}),
    hasQueuedMessages: () => false,
    clearMessages: mock(() => {}),
    saveToHistory: mock(() => {}),
    scrollToLatest: mock(() => {}),
    sendMessage: mock(async () => {}),
    setCanProcessQueue: mock(() => {}),
    setInputFocused: mock(() => {}),
    setInputValue: mock(() => {}),
    setIsAuthenticated: mock(() => {}),
    setMessages: mock(() => {}),
    setUser: mock(() => {}),
    ...overrides,
  }) as RouterParams

beforeEach(() => {
  useChatStore.getState().clearPendingBashMessages()
})

afterEach(() => {
  __resetSteeringForTests()
  useChatStore.getState().clearPendingBashMessages()
})

describe('mid-turn routing', () => {
  test.each(['/todo', '/todos'])(
    '%s opens locally during a run without queuing or steering',
    async (command) => {
      activateSteering('run-1')
      const params = createMockParams({
        inputValue: command,
        isStreaming: true,
        isChainInProgressRef: { current: true },
        streamMessageIdRef: { current: 'running-message' },
      })
      const result = await routeUserPrompt(params)
      expect(result).toEqual({ openTodoPanel: true })
      expect(params.addToQueue).not.toHaveBeenCalled()
      expect(params.sendMessage).not.toHaveBeenCalled()
      expect(params.setMessages).not.toHaveBeenCalled()
      expect(params.scrollToLatest).not.toHaveBeenCalled()
      expect(drainSteeringMessages('run-1')).toEqual([])
      expect(params.setInputValue).toHaveBeenCalledWith({
        text: '',
        cursorPosition: 0,
        lastEditDueToNav: false,
      })
    },
  )

  test('plain text steers the active run and echoes a bubble immediately', async () => {
    activateSteering('run-1')
    const params = createMockParams({
      inputValue: 'actually use zod for validation',
      isStreaming: true,
    })
    await routeUserPrompt(params)

    expect(params.addToQueue).not.toHaveBeenCalled()
    expect(params.sendMessage).not.toHaveBeenCalled()
    // Bubble echoed at push time so the submit is visible right away.
    expect(params.setMessages).toHaveBeenCalledTimes(1)
    const drained = drainSteeringMessages('run-1')
    expect(drained.map((entry) => entry.text)).toEqual([
      'actually use zod for validation',
    ])
    expect(drained[0]!.messageId).toStartWith('user-')
  })

  test('falls back to the queue when no run is accepting steering', async () => {
    const params = createMockParams({
      inputValue: 'between chained runs',
      isStreaming: true,
    })
    await routeUserPrompt(params)

    expect(params.addToQueue).toHaveBeenCalledTimes(1)
    const [queued] = (params.addToQueue as ReturnType<typeof mock>).mock
      .calls[0] as [string]
    expect(queued).toBe('between chained runs')
  })

  test('queues instead of steering when earlier messages are already queued', async () => {
    activateSteering('run-1')
    const params = createMockParams({
      inputValue: 'this must not overtake the queue',
      isStreaming: true,
      hasQueuedMessages: () => true,
    })
    await routeUserPrompt(params)

    expect(drainSteeringMessages('run-1')).toEqual([])
    expect(params.addToQueue).toHaveBeenCalledTimes(1)
  })

  test('queues instead of steering while bash output is pending', async () => {
    activateSteering('run-1')
    useChatStore.getState().addPendingBashMessage({
      command: 'bun test',
      output: '3 fail',
    } as never)
    const params = createMockParams({
      inputValue: 'fix those failures',
      isStreaming: true,
    })
    await routeUserPrompt(params)

    expect(drainSteeringMessages('run-1')).toEqual([])
    expect(params.addToQueue).toHaveBeenCalledTimes(1)
  })

  test('slash commands never steer', async () => {
    activateSteering('run-1')
    const params = createMockParams({
      inputValue: '/definitely-not-a-command',
      isStreaming: true,
    })
    await routeUserPrompt(params)

    expect(drainSteeringMessages('run-1')).toEqual([])
    expect(params.addToQueue).toHaveBeenCalledTimes(1)
  })

  test('idle submits are unaffected and send normally', async () => {
    activateSteering('run-1')
    const params = createMockParams({ inputValue: 'a fresh task' })
    await routeUserPrompt(params)

    expect(params.sendMessage).toHaveBeenCalledTimes(1)
    expect(drainSteeringMessages('run-1')).toEqual([])
  })
})
