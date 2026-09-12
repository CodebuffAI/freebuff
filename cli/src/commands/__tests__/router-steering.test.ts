import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

import { useChatStore } from '../../state/chat-store'
import {
  __resetSteeringForTests,
  activateSteering,
  drainSteeringMessages,
} from '../../utils/steering-buffer'
import { dispatchSkillPrompt, findCommand } from '../command-registry'
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
  useChatStore.getState().clearPendingAttachments()
})

afterEach(() => {
  __resetSteeringForTests()
  useChatStore.getState().clearPendingBashMessages()
  useChatStore.getState().clearPendingAttachments()
})

describe('mid-turn routing', () => {
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

  describe('plan/interview/review input modes queue instead of interrupting', () => {
    afterEach(() => {
      useChatStore.getState().setInputMode('default')
    })

    test('plan mode queues a mid-turn submit instead of sending it', async () => {
      useChatStore.getState().setInputMode('plan')
      const params = createMockParams({
        inputValue: 'add dark mode',
        isStreaming: true,
      })
      await routeUserPrompt(params)

      // Must never fire a second run against the busy owner: that would
      // register a new active-run owner and interrupt the in-flight one.
      expect(params.sendMessage).not.toHaveBeenCalled()
      expect(params.addToQueue).toHaveBeenCalledTimes(1)
      const [queued] = (params.addToQueue as ReturnType<typeof mock>).mock
        .calls[0] as [string]
      expect(queued).toContain('add dark mode')
    })

    test('interview mode queues a mid-turn submit instead of sending it', async () => {
      useChatStore.getState().setInputMode('interview')
      const params = createMockParams({
        inputValue: 'what should the API look like',
        isStreaming: true,
      })
      await routeUserPrompt(params)

      expect(params.sendMessage).not.toHaveBeenCalled()
      expect(params.addToQueue).toHaveBeenCalledTimes(1)
    })

    test('review mode queues a mid-turn submit instead of sending it', async () => {
      useChatStore.getState().setInputMode('review')
      const params = createMockParams({
        inputValue: 'check for null handling',
        isStreaming: true,
      })
      await routeUserPrompt(params)

      expect(params.sendMessage).not.toHaveBeenCalled()
      expect(params.addToQueue).toHaveBeenCalledTimes(1)
    })

    test('plan mode still sends immediately when idle', async () => {
      useChatStore.getState().setInputMode('plan')
      const params = createMockParams({ inputValue: 'add dark mode' })
      await routeUserPrompt(params)

      expect(params.sendMessage).toHaveBeenCalledTimes(1)
      expect(params.addToQueue).not.toHaveBeenCalled()
    })
  })

  describe('/interview and /review with inline args queue instead of interrupting', () => {
    test('/interview <text> queues mid-turn instead of sending', () => {
      const params = createMockParams({
        inputValue: '/interview what should the API look like',
        isStreaming: true,
      })
      findCommand('interview')!.handler(params, 'what should the API look like')

      expect(params.sendMessage).not.toHaveBeenCalled()
      expect(params.addToQueue).toHaveBeenCalledTimes(1)
    })

    test('/review <text> queues mid-turn instead of sending', () => {
      const params = createMockParams({
        inputValue: '/review check for null handling',
        isStreaming: true,
      })
      findCommand('review')!.handler(params, 'check for null handling')

      expect(params.sendMessage).not.toHaveBeenCalled()
      expect(params.addToQueue).toHaveBeenCalledTimes(1)
    })

    test('/interview <text> still sends immediately when idle', () => {
      const params = createMockParams({
        inputValue: '/interview what should the API look like',
      })
      findCommand('interview')!.handler(params, 'what should the API look like')

      expect(params.sendMessage).toHaveBeenCalledTimes(1)
      expect(params.addToQueue).not.toHaveBeenCalled()
    })
  })

  describe('staged attachments follow the prompt they were staged for', () => {
    const stageAttachment = () =>
      useChatStore.getState().addPendingAttachment({
        kind: 'text',
        id: 'pasted-1',
        content: 'a long pasted block',
        preview: 'a long pasted block',
        charCount: 19,
      })

    test('a queued /interview carries the staged attachments with it', () => {
      stageAttachment()
      const params = createMockParams({
        inputValue: '/interview what should the API look like',
        isStreaming: true,
      })
      findCommand('interview')!.handler(params, 'what should the API look like')

      const [, attachments] = (params.addToQueue as ReturnType<typeof mock>)
        .mock.calls[0] as [string, unknown[]]
      // Queued sends pass their attachments explicitly, which suppresses the
      // pendingAttachments fallback in prepareUserMessage. Anything left in
      // the store here would land on some later, unrelated message.
      expect(attachments).toHaveLength(1)
      expect(useChatStore.getState().pendingAttachments).toHaveLength(0)
    })

    test('an idle skill dispatch leaves the staged attachments for the send path', () => {
      stageAttachment()
      const params = createMockParams({ inputValue: '/skill:tidy' })
      dispatchSkillPrompt(params, { name: 'tidy', content: 'Tidy up.' }, '')

      expect(params.sendMessage).toHaveBeenCalledTimes(1)
      // sendMessage is called without an attachments key on purpose: it falls
      // back to the store. Capturing here would clear them into a value the
      // idle branch never passes on.
      expect(useChatStore.getState().pendingAttachments).toHaveLength(1)
    })
  })
})
