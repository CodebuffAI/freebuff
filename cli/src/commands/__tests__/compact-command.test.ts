import { beforeEach, describe, expect, mock, test } from 'bun:test'

import { useChatStore } from '../../state/chat-store'
import { findCommand } from '../command-registry'
import { handleCompactCommand } from '../compact'
import { parseCommandInput } from '../router-utils'
import { getUserMessage } from '../../utils/message-history'

import type { RouterParams } from '../command-registry'
import type { ChatMessage } from '../../types/chat'

const createMockParams = (
  overrides: Partial<RouterParams> = {},
): RouterParams =>
  ({
    agentMode: 'DEFAULT',
    inputRef: { current: { focus: mock(() => {}) } as never },
    inputValue: '/compact',
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

describe('handleCompactCommand', () => {
  beforeEach(() => {
    useChatStore.setState({
      messages: [],
      pendingAttachments: [],
    })
  })

  test('bails out early with system message when conversation is empty', async () => {
    const params = createMockParams({ inputValue: '/compact' })

    await handleCompactCommand(params)

    expect(params.saveToHistory).toHaveBeenCalledWith('/compact')
    expect(params.setInputValue).toHaveBeenCalledWith({
      text: '',
      cursorPosition: 0,
      lastEditDueToNav: false,
    })
    expect(params.setMessages).toHaveBeenCalledTimes(1)

    // Inspect the system message added
    const updater = (params.setMessages as ReturnType<typeof mock>).mock
      .calls[0][0] as (prev: ChatMessage[]) => ChatMessage[]
    const resultingMessages = updater([])
    expect(resultingMessages.length).toBe(1)
    expect(resultingMessages[0].content).toContain('Nothing to compact')
    expect(resultingMessages[0].id).toStartWith('sys-')

    // Must NOT call sendMessage or addToQueue
    expect(params.sendMessage).not.toHaveBeenCalled()
    expect(params.addToQueue).not.toHaveBeenCalled()
  })

  test('dispatches /compact to sendMessage when idle and messages exist', async () => {
    useChatStore.setState({
      messages: [getUserMessage('Hello, world!')],
    })

    const params = createMockParams({
      inputValue: '/compact',
      agentMode: 'DEFAULT',
    })

    await handleCompactCommand(params)

    expect(params.saveToHistory).toHaveBeenCalledWith('/compact')
    expect(params.setInputValue).toHaveBeenCalledWith({
      text: '',
      cursorPosition: 0,
      lastEditDueToNav: false,
    })
    expect(params.addToQueue).not.toHaveBeenCalled()
    expect(params.sendMessage).toHaveBeenCalledWith({
      content: '/compact',
      agentMode: 'DEFAULT',
    })
  })

  test('queues /compact when streaming is in progress', async () => {
    useChatStore.setState({
      messages: [getUserMessage('Running code')],
    })

    const params = createMockParams({
      inputValue: '/compact',
      isStreaming: true,
    })

    await handleCompactCommand(params)

    expect(params.saveToHistory).toHaveBeenCalledWith('/compact')
    expect(params.addToQueue).toHaveBeenCalledWith('/compact', [])
    expect(params.setInputFocused).toHaveBeenCalledWith(true)
    expect(params.sendMessage).not.toHaveBeenCalled()
  })

  test('queues /compact when chain is in progress', async () => {
    useChatStore.setState({
      messages: [getUserMessage('Running chain')],
    })

    const params = createMockParams({
      inputValue: '/compact',
      isChainInProgressRef: { current: true },
    })

    await handleCompactCommand(params)

    expect(params.addToQueue).toHaveBeenCalledWith('/compact', [])
    expect(params.sendMessage).not.toHaveBeenCalled()
  })

  test('queues /compact when streamMessageIdRef is active', async () => {
    useChatStore.setState({
      messages: [getUserMessage('Active stream')],
    })

    const params = createMockParams({
      inputValue: '/compact',
      streamMessageIdRef: { current: 'ai-msg-123' },
    })

    await handleCompactCommand(params)

    expect(params.addToQueue).toHaveBeenCalledWith('/compact', [])
    expect(params.sendMessage).not.toHaveBeenCalled()
  })
})

describe('compact command registry and aliases', () => {
  test('findCommand resolves compact by primary name', () => {
    const cmd = findCommand('compact')
    expect(cmd).toBeDefined()
    expect(cmd?.name).toBe('compact')
    expect(cmd?.aliases).toContain('summarize')
    expect(cmd?.acceptsArgs).toBe(false)
  })

  test('findCommand resolves compact by summarize alias', () => {
    const cmd = findCommand('summarize')
    expect(cmd).toBeDefined()
    expect(cmd?.name).toBe('compact')
  })

  test('parseCommandInput supports /compact and slashless compact', () => {
    expect(parseCommandInput('/compact')).toEqual({
      command: 'compact',
      args: '',
      implicitCommand: false,
    })

    expect(parseCommandInput('compact')).toEqual({
      command: 'compact',
      args: '',
      implicitCommand: true,
    })

    expect(parseCommandInput('/summarize')).toEqual({
      command: 'summarize',
      args: '',
      implicitCommand: false,
    })
  })
})
