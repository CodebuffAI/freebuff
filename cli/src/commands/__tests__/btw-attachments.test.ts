import { afterEach, describe, expect, mock, test } from 'bun:test'

import { COMMAND_REGISTRY } from '../command-registry'
import { useChatStore } from '../../state/chat-store'

import type { RouterParams } from '../command-registry'

function createMockParams(
  overrides: Partial<RouterParams> = {},
): RouterParams {
  return {
    agentMode: 'DEFAULT',
    inputRef: { current: null },
    inputValue: '/btw check the parser',
    isChainInProgressRef: { current: false },
    isStreaming: false,
    logoutMutation: {} as RouterParams['logoutMutation'],
    streamMessageIdRef: { current: null },
    addToQueue: mock(() => {}),
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
  }
}

describe('/btw attachment routing', () => {
  afterEach(() => {
    useChatStore.getState().clearPendingAttachments()
  })

  test('leaves idle attachments staged for sendMessage to consume', () => {
    const btwCmd = COMMAND_REGISTRY.find((command) => command.name === 'btw')
    expect(btwCmd).toBeDefined()

    const attachment = {
      kind: 'text' as const,
      id: 'note.txt',
      content: 'remember the edge case',
      preview: 'remember the edge case',
      charCount: 22,
    }
    useChatStore.getState().addPendingAttachment(attachment)

    const sendMessage = mock(async () => {})
    btwCmd!.handler(createMockParams({ sendMessage }), 'check the parser')

    expect(sendMessage).toHaveBeenCalledTimes(1)
    // sendMessage intentionally receives no explicit `attachments` value here:
    // prepareUserMessage falls back to useChatStore.pendingAttachments and clears
    // that store only after it has captured the attachments for the direct send.
    expect(sendMessage).toHaveBeenCalledWith({
      content: expect.stringContaining('check the parser'),
      agentMode: 'DEFAULT',
    })
    expect(useChatStore.getState().pendingAttachments).toEqual([attachment])
  })
})
