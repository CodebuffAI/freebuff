import { describe, test, expect, mock } from 'bun:test'

import { useFeedbackStore } from '../../state/feedback-store'
import {
  registerActiveRun,
  stopActiveRun,
  type ActiveRunStopReason,
} from '../../utils/active-run'
import {
  COMMAND_REGISTRY,
  defineCommand,
  defineCommandWithArgs,
} from '../command-registry'

import type { RouterParams } from '../command-registry'

/**
 * Tests for the command factory pattern.
 *
 * The factory pattern ensures commands handle arguments correctly:
 * - defineCommand: creates commands that gracefully ignore arguments
 * - defineCommandWithArgs: creates commands that receive and handle arguments
 */
describe('command factory pattern', () => {
  const createMockParams = (
    overrides: Partial<RouterParams> = {},
  ): RouterParams =>
    ({
      agentMode: 'DEFAULT',
      inputRef: { current: null },
      inputValue: '/test',
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
    }) as RouterParams

  describe('defineCommand (gracefully ignores args)', () => {
    test('calls handler when no args provided', () => {
      const handler = mock(() => {})
      const cmd = defineCommand({
        name: 'test',
        handler,
      })

      const params = createMockParams()
      cmd.handler(params, '')

      expect(handler).toHaveBeenCalledWith(params)
    })

    test('calls handler even when args are provided (gracefully ignores)', () => {
      const handler = mock(() => {})
      const cmd = defineCommand({
        name: 'test',
        handler,
      })

      const params = createMockParams()
      cmd.handler(params, 'some unexpected args')

      // Handler should still be called - args are ignored
      expect(handler).toHaveBeenCalledWith(params)
    })

    test('sets aliases correctly', () => {
      const cmd = defineCommand({
        name: 'test',
        aliases: ['t', 'tst'],
        handler: () => {},
      })

      expect(cmd.aliases).toEqual(['t', 'tst'])
    })

    test('defaults to empty aliases when not provided', () => {
      const cmd = defineCommand({
        name: 'test',
        handler: () => {},
      })

      expect(cmd.aliases).toEqual([])
    })

    test('sets acceptsArgs to false', () => {
      const cmd = defineCommand({
        name: 'test',
        handler: () => {},
      })

      expect(cmd.acceptsArgs).toBe(false)
    })
  })

  describe('defineCommandWithArgs', () => {
    test('passes args to handler', () => {
      const handler = mock(() => {})
      const cmd = defineCommandWithArgs({
        name: 'test',
        handler,
      })

      const params = createMockParams()
      cmd.handler(params, 'some args')

      expect(handler).toHaveBeenCalledWith(params, 'some args')
    })

    test('passes empty args to handler', () => {
      const handler = mock(() => {})
      const cmd = defineCommandWithArgs({
        name: 'test',
        handler,
      })

      const params = createMockParams()
      cmd.handler(params, '')

      expect(handler).toHaveBeenCalledWith(params, '')
    })

    test('sets aliases correctly', () => {
      const cmd = defineCommandWithArgs({
        name: 'test',
        aliases: ['t', 'tst'],
        handler: () => {},
      })

      expect(cmd.aliases).toEqual(['t', 'tst'])
    })

    test('sets acceptsArgs to true', () => {
      const cmd = defineCommandWithArgs({
        name: 'test',
        handler: () => {},
      })

      expect(cmd.acceptsArgs).toBe(true)
    })
  })

  describe('COMMAND_REGISTRY commands', () => {
    const noArgsCommands = COMMAND_REGISTRY.filter((cmd) => !cmd.acceptsArgs)
    const withArgsCommands = COMMAND_REGISTRY.filter((cmd) => cmd.acceptsArgs)

    test('there are commands that ignore args', () => {
      expect(noArgsCommands.length).toBeGreaterThan(0)
    })

    test('there are commands that accept args', () => {
      expect(withArgsCommands.length).toBeGreaterThan(0)
    })

    test('expected commands ignore args', () => {
      const expectedNoArgs = ['login', 'logout', 'exit', 'usage', 'init', 'compact']
      for (const name of expectedNoArgs) {
        const cmd = COMMAND_REGISTRY.find((c) => c.name === name)
        expect(cmd, `Command ${name} should exist`).toBeDefined()
        expect(cmd?.acceptsArgs, `Command ${name} should not accept args`).toBe(
          false,
        )
      }
    })

    test('expected commands accept args', () => {
      // mode:* commands also accept args now
      const expectedWithArgs = [
        'feedback',
        'bash',
        'image',
        'publish',
        'new',
        'mode:default',
        'mode:max',
        'mode:plan',
      ]
      for (const name of expectedWithArgs) {
        const cmd = COMMAND_REGISTRY.find((c) => c.name === name)
        expect(cmd, `Command ${name} should exist`).toBeDefined()
        expect(cmd?.acceptsArgs, `Command ${name} should accept args`).toBe(
          true,
        )
      }
    })

    test('mode commands accept args to send as first message', () => {
      const modeCommands = COMMAND_REGISTRY.filter((cmd) =>
        cmd.name.startsWith('mode:'),
      )
      expect(modeCommands.length).toBeGreaterThan(0)
      for (const cmd of modeCommands) {
        expect(
          cmd.acceptsArgs,
          `Mode command ${cmd.name} should accept args`,
        ).toBe(true)
      }
    })
  })

  describe('cancellation reasons', () => {
    test('/logout stops the owned run before starting logout', () => {
      const reasons: ActiveRunStopReason[] = []
      registerActiveRun('logout-run', (reason) => reasons.push(reason))
      const mutate = mock(() => {})
      const logoutCmd = COMMAND_REGISTRY.find((command) =>
        command.aliases.includes('signout'),
      )

      try {
        logoutCmd?.handler(
          createMockParams({
            logoutMutation: {
              mutate,
            } as unknown as RouterParams['logoutMutation'],
          }),
          '',
        )

        expect(reasons).toEqual(['logout'])
        expect(mutate).toHaveBeenCalledTimes(1)
      } finally {
        stopActiveRun('process-exit')
      }
    })
  })

  describe('new command arg handling', () => {
    test('clears messages and sends arg as first message when args provided', () => {
      const newCmd = COMMAND_REGISTRY.find((c) => c.name === 'new')
      expect(newCmd).toBeDefined()

      const sendMessage = mock(async () => {})
      const setMessages = mock(() => {})
      const clearMessages = mock(() => {})
      const setCanProcessQueue = mock(() => {})

      const params = createMockParams({
        inputValue: '/new hello world',
        sendMessage,
        setMessages,
        clearMessages,
        setCanProcessQueue,
      })

      newCmd!.handler(params, 'hello world')

      // Should clear messages
      expect(setMessages).toHaveBeenCalled()
      expect(clearMessages).toHaveBeenCalled()

      // Should re-enable queue and send message
      expect(setCanProcessQueue).toHaveBeenCalledWith(true)
      expect(sendMessage).toHaveBeenCalledWith({
        content: 'hello world',
        agentMode: 'DEFAULT',
      })
    })

    test('clears messages without sending when no args provided', () => {
      const newCmd = COMMAND_REGISTRY.find((c) => c.name === 'new')
      expect(newCmd).toBeDefined()

      const sendMessage = mock(async () => {})
      const setMessages = mock(() => {})
      const clearMessages = mock(() => {})
      const setCanProcessQueue = mock(() => {})

      const params = createMockParams({
        inputValue: '/new',
        sendMessage,
        setMessages,
        clearMessages,
        setCanProcessQueue,
      })

      newCmd!.handler(params, '')

      // Should clear messages
      expect(setMessages).toHaveBeenCalled()
      expect(clearMessages).toHaveBeenCalled()

      // Should disable queue and NOT send message
      expect(setCanProcessQueue).toHaveBeenCalledWith(false)
      expect(sendMessage).not.toHaveBeenCalled()
    })
  })

  describe('feedback command arg handling', () => {
    test('pre-populates feedback text when args are provided', () => {
      const feedbackCmd = COMMAND_REGISTRY.find((c) => c.name === 'feedback')
      expect(feedbackCmd).toBeDefined()

      // Reset the feedback store
      useFeedbackStore.getState().reset()

      const params = createMockParams({ inputValue: '/feedback my bug report' })
      feedbackCmd!.handler(params, 'my bug report')

      // Check that feedback text was pre-populated
      const state = useFeedbackStore.getState()
      expect(state.feedbackText).toBe('my bug report')
      expect(state.feedbackCursor).toBe('my bug report'.length)
    })

    test('opens feedback mode without pre-populating when no args', () => {
      const feedbackCmd = COMMAND_REGISTRY.find((c) => c.name === 'feedback')
      expect(feedbackCmd).toBeDefined()

      // Reset the feedback store
      useFeedbackStore.getState().reset()

      const params = createMockParams({ inputValue: '/feedback' })
      const result = feedbackCmd!.handler(params, '')

      // Should return openFeedbackMode
      expect(result).toEqual({ openFeedbackMode: true })

      // Feedback text should remain empty
      const state = useFeedbackStore.getState()
      expect(state.feedbackText).toBe('')
    })

    test('returns openFeedbackMode even with args', () => {
      const feedbackCmd = COMMAND_REGISTRY.find((c) => c.name === 'feedback')
      expect(feedbackCmd).toBeDefined()

      // Reset the feedback store
      useFeedbackStore.getState().reset()

      const params = createMockParams({ inputValue: '/feedback test' })
      const result = feedbackCmd!.handler(params, 'test')

      // Should still return openFeedbackMode
      expect(result).toEqual({ openFeedbackMode: true })
    })
  })
})
