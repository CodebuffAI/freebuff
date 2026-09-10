import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test'
import { FREEBUFF_PROVIDER_USAGE_MESSAGE } from '@codebuff/common/constants/freebuff-errors'

import type { ChatMessage } from '../../../types/chat'
import type { SendMessageTimerController } from '../../../utils/send-message-timer'
import type { StreamStatus } from '../../use-message-queue'

// Ensure required env vars exist so logger/env parsing succeeds in tests
const ensureEnv = () => {
  process.env.NEXT_PUBLIC_CB_ENVIRONMENT =
    process.env.NEXT_PUBLIC_CB_ENVIRONMENT || 'test'
  process.env.NEXT_PUBLIC_CODEBUFF_APP_URL =
    process.env.NEXT_PUBLIC_CODEBUFF_APP_URL || 'https://app.codebuff.test'
  process.env.NEXT_PUBLIC_SUPPORT_EMAIL =
    process.env.NEXT_PUBLIC_SUPPORT_EMAIL || 'support@codebuff.test'
  process.env.NEXT_PUBLIC_POSTHOG_API_KEY =
    process.env.NEXT_PUBLIC_POSTHOG_API_KEY || 'phc_test_key'
  process.env.NEXT_PUBLIC_POSTHOG_HOST_URL =
    process.env.NEXT_PUBLIC_POSTHOG_HOST_URL || 'https://posthog.codebuff.test'
  process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY =
    process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY || 'pk_test_123'
  process.env.NEXT_PUBLIC_STRIPE_CUSTOMER_PORTAL =
    process.env.NEXT_PUBLIC_STRIPE_CUSTOMER_PORTAL ||
    'https://stripe.codebuff.test'
  process.env.NEXT_PUBLIC_WEB_PORT = process.env.NEXT_PUBLIC_WEB_PORT || '3000'
}

ensureEnv()

const { useChatStore } = await import('../../../state/chat-store')
const { IS_FREEBUFF } = await import('../../../utils/constants')
const { createStreamController } = await import('../../stream-state')
const {
  setupStreamingContext,
  handleRunCompletion,
  handleRunError,
  finalizeQueueState,
  resetEarlyReturnState,
} = await import('../send-message')
const { createBatchedMessageUpdater } =
  await import('../../../utils/message-updater')
import { createPaymentRequiredError } from '@codebuff/sdk'
import type { RunState } from '@codebuff/sdk'

const createMockTimerController = (): SendMessageTimerController & {
  startCalls: string[]
  stopCalls: Array<'success' | 'error' | 'aborted'>
} => {
  const startCalls: string[] = []
  const stopCalls: Array<'success' | 'error' | 'aborted'> = []

  return {
    startCalls,
    stopCalls,
    start: (messageId: string) => {
      startCalls.push(messageId)
    },
    stop: (outcome: 'success' | 'error' | 'aborted') => {
      stopCalls.push(outcome)
      return { finishedAt: Date.now(), elapsedMs: 100 }
    },
    pause: () => {},
    resume: () => {},
    isActive: () => startCalls.length > stopCalls.length,
  }
}

const createBaseMessages = (): ChatMessage[] => [
  {
    id: 'ai-1',
    variant: 'ai',
    content: 'Partial streamed content',
    blocks: [{ type: 'text', content: 'Some text' }],
    timestamp: 'now',
  },
]

describe('setupStreamingContext', () => {
  describe('abort flow', () => {
    test('abort handler appends interruption notice, marks complete, and releases chain lock', () => {
      let messages = createBaseMessages()
      const streamRefs = createStreamController()
      const timerController = createMockTimerController()
      let streamStatus: StreamStatus = 'idle'
      let canProcessQueue = false
      let chainInProgress = true
      let isRetrying = true

      const { updater, abortController } = setupStreamingContext({
        aiMessageId: 'ai-1',
        timerController,
        setMessages: (fn: any) => {
          messages = fn(messages)
        },
        streamRefs,
        setStreamStatus: (status: StreamStatus) => {
          streamStatus = status
        },
        setCanProcessQueue: (can: boolean) => {
          canProcessQueue = can
        },
        updateChainInProgress: (value: boolean) => {
          chainInProgress = value
        },
        setIsRetrying: (value: boolean) => {
          isRetrying = value
        },
        setStreamingAgents: () => {},
      })

      // Trigger abort
      abortController.abort()

      // Verify wasAbortedByUser is set
      expect(streamRefs.state.wasAbortedByUser).toBe(true)

      // Verify stream status reset for UI feedback
      expect(streamStatus).toBe('idle')

      // Chain lock is released immediately so new messages can be sent directly
      expect(chainInProgress).toBe(false)
      expect(canProcessQueue).toBe(true)

      // Verify retrying reset
      expect(isRetrying).toBe(false)

      // Verify timer stopped with 'aborted' outcome
      expect(timerController.stopCalls).toContain('aborted')

      // Flush any pending updates to check interruption notice
      updater.flush()

      // Verify interruption notice appended (the message should have been updated)
      const aiMessage = messages.find((m: ChatMessage) => m.id === 'ai-1')
      expect(aiMessage).toBeDefined()

      // The interruption notice should be added to blocks
      const lastBlock = aiMessage!.blocks?.[aiMessage!.blocks.length - 1]
      expect(lastBlock?.type).toBe('text')
      const textBlock = lastBlock as { type: 'text'; content: string }
      expect(textBlock?.content).toContain('[response interrupted]')

      // Verify message marked complete
      expect(aiMessage!.isComplete).toBe(true)
    })

    test('abort sets canProcessQueue based on queue pause state', () => {
      let messages = createBaseMessages()
      const streamRefs = createStreamController()
      const timerController = createMockTimerController()
      const isQueuePausedRef = { current: true }
      let canProcessQueue = false
      let canProcessQueueCallCount = 0

      const { abortController } = setupStreamingContext({
        aiMessageId: 'ai-1',
        timerController,
        setMessages: (fn: any) => {
          messages = fn(messages)
        },
        streamRefs,
        setStreamStatus: () => {},
        setCanProcessQueue: (can: boolean) => {
          canProcessQueue = can
          canProcessQueueCallCount++
        },
        isQueuePausedRef,
        updateChainInProgress: () => {},
        setIsRetrying: () => {},
        setStreamingAgents: () => {},
      })

      // Trigger abort
      abortController.abort()

      // Abort handler sets canProcessQueue respecting queue pause state
      expect(canProcessQueueCallCount).toBe(1)
      // Queue was paused, so canProcessQueue stays false
      expect(canProcessQueue).toBe(false)
    })

    test('abort resets isProcessingQueueRef', () => {
      let messages = createBaseMessages()
      const streamRefs = createStreamController()
      const timerController = createMockTimerController()
      const isProcessingQueueRef = { current: true }

      const { abortController } = setupStreamingContext({
        aiMessageId: 'ai-1',
        timerController,
        setMessages: (fn: any) => {
          messages = fn(messages)
        },
        streamRefs,
        setStreamStatus: () => {},
        setCanProcessQueue: () => {},
        isProcessingQueueRef,
        updateChainInProgress: () => {},
        setIsRetrying: () => {},
        setStreamingAgents: () => {},
      })

      // Verify ref starts as true
      expect(isProcessingQueueRef.current).toBe(true)

      // Trigger abort
      abortController.abort()

      // isProcessingQueueRef is reset by abort handler so new messages can be sent
      expect(isProcessingQueueRef.current).toBe(false)
    })

    test('abort releases chain lock and processing state, respects queue pause', () => {
      let messages = createBaseMessages()
      const streamRefs = createStreamController()
      const timerController = createMockTimerController()
      const isProcessingQueueRef = { current: true }
      const isQueuePausedRef = { current: true }
      let streamStatus = 'streaming' as StreamStatus
      let canProcessQueue = true
      let chainInProgress = true
      let isRetrying = true

      const { abortController } = setupStreamingContext({
        aiMessageId: 'ai-1',
        timerController,
        setMessages: (fn: any) => {
          messages = fn(messages)
        },
        streamRefs,
        setStreamStatus: (status) => {
          streamStatus = status
        },
        setCanProcessQueue: (can) => {
          canProcessQueue = can
        },
        isQueuePausedRef,
        isProcessingQueueRef,
        updateChainInProgress: (value) => {
          chainInProgress = value
        },
        setIsRetrying: (value) => {
          isRetrying = value
        },
        setStreamingAgents: () => {},
      })

      // Sanity check initial state
      expect(isProcessingQueueRef.current).toBe(true)
      expect(isQueuePausedRef.current).toBe(true)
      expect(streamStatus).toBe('streaming')
      expect(canProcessQueue).toBe(true)
      expect(chainInProgress).toBe(true)
      expect(isRetrying).toBe(true)

      // Trigger abort
      abortController.abort()

      // After abort, chain lock and processing lock are released immediately
      // so new messages can be sent directly instead of being queued.
      expect(isProcessingQueueRef.current).toBe(false)
      expect(canProcessQueue).toBe(false) // Respects isQueuePausedRef (true)
      expect(chainInProgress).toBe(false) // Released immediately
      expect(isRetrying).toBe(false)
      expect(streamStatus).toBe('idle')
    })

    test('uses the run controller supplied by the owner', () => {
      let messages = createBaseMessages()
      const streamRefs = createStreamController()
      const timerController = createMockTimerController()
      const ownedAbortController = new AbortController()

      const { abortController } = setupStreamingContext({
        aiMessageId: 'ai-1',
        timerController,
        setMessages: (fn: any) => {
          messages = fn(messages)
        },
        streamRefs,
        abortController: ownedAbortController,
        setStreamStatus: () => {},
        setCanProcessQueue: () => {},
        updateChainInProgress: () => {},
        setIsRetrying: () => {},
        setStreamingAgents: () => {},
      })

      expect(abortController).toBe(ownedAbortController)
    })

    test('setupStreamingContext resets streamRefs and starts timer', () => {
      let messages = createBaseMessages()
      const streamRefs = createStreamController()
      // Pre-populate some state
      streamRefs.state.rootStreamBuffer = 'some old content'
      streamRefs.state.rootStreamSeen = true

      const timerController = createMockTimerController()

      setupStreamingContext({
        aiMessageId: 'ai-1',
        timerController,
        setMessages: (fn: any) => {
          messages = fn(messages)
        },
        streamRefs,
        setStreamStatus: () => {},
        setCanProcessQueue: () => {},
        updateChainInProgress: () => {},
        setIsRetrying: () => {},
        setStreamingAgents: () => {},
      })

      // Verify streamRefs was reset
      expect(streamRefs.state.rootStreamBuffer).toBe('')
      expect(streamRefs.state.rootStreamSeen).toBe(false)

      // Verify timer was started with correct message ID
      expect(timerController.startCalls).toContain('ai-1')
    })
  })
})

describe('handleRunCompletion', () => {
  describe('abort path', () => {
    test('skips finalizeQueueState when wasAbortedByUser is true (abort handler already released locks)', () => {
      const timerController = createMockTimerController()
      let messages = createBaseMessages()
      const updater = createBatchedMessageUpdater('ai-1', (fn: any) => {
        messages = fn(messages)
      })

      // These simulate state that was already cleaned up by the abort handler
      let streamStatus: StreamStatus = 'idle'
      let canProcessQueue = true
      let chainInProgress = false
      const isProcessingQueueRef = { current: false }
      const isQueuePausedRef = { current: false }
      let hasReceivedPlanResponse = false

      // Track if setters are called (they shouldn't be)
      let setStreamStatusCalled = false
      let setCanProcessQueueCalled = false
      let updateChainInProgressCalled = false

      const runState = {
        traceSessionId: 'trace-test',
        sessionState: undefined,
        output: { type: 'lastMessage' as const, value: [] },
      }

      handleRunCompletion({
        runState,
        actualCredits: undefined,
        agentMode: 'DEFAULT' as any,
        timerController,
        updater,
        aiMessageId: 'ai-1',
        wasAbortedByUser: true,
        setStreamStatus: (status: StreamStatus) => {
          setStreamStatusCalled = true
          streamStatus = status
        },
        setCanProcessQueue: (can: boolean) => {
          setCanProcessQueueCalled = true
          canProcessQueue = can
        },
        updateChainInProgress: (value: boolean) => {
          updateChainInProgressCalled = true
          chainInProgress = value
        },
        setHasReceivedPlanResponse: (value: boolean) => {
          hasReceivedPlanResponse = value
        },
        isProcessingQueueRef,
        isQueuePausedRef,
      })

      // handleRunCompletion should NOT call finalizeQueueState for aborted runs
      // (the abort handler already released the locks)
      expect(setStreamStatusCalled).toBe(false)
      expect(setCanProcessQueueCalled).toBe(false)
      expect(updateChainInProgressCalled).toBe(false)
    })

    test('does not process server response when wasAbortedByUser is true', () => {
      const timerController = createMockTimerController()
      let messages = createBaseMessages()
      const updater = createBatchedMessageUpdater('ai-1', (fn: any) => {
        messages = fn(messages)
      })

      let hasReceivedPlanResponse = false

      const runState = {
        traceSessionId: 'trace-test',
        sessionState: undefined,
        output: {
          type: 'lastMessage' as const,
          value: [
            {
              type: 'text' as const,
              text: 'Server response that should be ignored',
            },
          ],
        },
      }

      handleRunCompletion({
        runState,
        actualCredits: 42,
        agentMode: 'PLAN' as any,
        timerController,
        updater,
        aiMessageId: 'ai-1',
        wasAbortedByUser: true,
        setStreamStatus: () => {},
        setCanProcessQueue: () => {},
        updateChainInProgress: () => {},
        setHasReceivedPlanResponse: (value: boolean) => {
          hasReceivedPlanResponse = value
        },
      })

      // Should NOT set plan response (abort path returns early before processing output)
      expect(hasReceivedPlanResponse).toBe(false)

      // Timer should NOT be stopped by handleRunCompletion (abort handler already stopped it)
      expect(timerController.stopCalls).not.toContain('success')
      expect(timerController.stopCalls).not.toContain('error')
    })

    test('does not call resumeQueue in abort path (abort handler already released locks)', () => {
      const timerController = createMockTimerController()
      let messages = createBaseMessages()
      const updater = createBatchedMessageUpdater('ai-1', (fn: any) => {
        messages = fn(messages)
      })

      let resumeQueueCalled = false
      let canProcessQueueCalled = false

      const runState = {
        traceSessionId: 'trace-test',
        sessionState: undefined,
        output: { type: 'lastMessage' as const, value: [] },
      }

      handleRunCompletion({
        runState,
        actualCredits: undefined,
        agentMode: 'DEFAULT' as any,
        timerController,
        updater,
        aiMessageId: 'ai-1',
        wasAbortedByUser: true,
        setStreamStatus: () => {},
        setCanProcessQueue: () => {
          canProcessQueueCalled = true
        },
        updateChainInProgress: () => {},
        setHasReceivedPlanResponse: () => {},
        resumeQueue: () => {
          resumeQueueCalled = true
        },
      })

      // Neither should be called - abort handler already handled cleanup
      expect(resumeQueueCalled).toBe(false)
      expect(canProcessQueueCalled).toBe(false)
    })
  })

  test('provider credit wording follows the Freebuff client policy', () => {
    let messages = createBaseMessages()
    const timerController = createMockTimerController()
    const updater = createBatchedMessageUpdater('ai-1', (fn: any) => {
      messages = fn(messages)
    })

    handleRunCompletion({
      runState: {
        traceSessionId: 'trace-test',
        sessionState: undefined,
        output: {
          type: 'error',
          statusCode: 401,
          message: 'Not Enough Credits',
        },
      },
      actualCredits: undefined,
      agentMode: 'DEFAULT' as any,
      timerController,
      updater,
      aiMessageId: 'ai-1',
      wasAbortedByUser: false,
      setStreamStatus: () => {},
      setCanProcessQueue: () => {},
      updateChainInProgress: () => {},
      setHasReceivedPlanResponse: () => {},
    })

    expect(messages[0]?.userError).toBe(
      IS_FREEBUFF ? FREEBUFF_PROVIDER_USAGE_MESSAGE : 'Not Enough Credits',
    )
  })
})

describe('finalizeQueueState', () => {
  test('sets stream status to idle and resets queue state', () => {
    let streamStatus = 'streaming' as StreamStatus
    let canProcessQueue = false
    let chainInProgress = true
    const isProcessingQueueRef = { current: true }

    finalizeQueueState({
      setStreamStatus: (status) => {
        streamStatus = status
      },
      setCanProcessQueue: (can) => {
        canProcessQueue = can
      },
      updateChainInProgress: (value) => {
        chainInProgress = value
      },
      isProcessingQueueRef,
    })

    expect(streamStatus).toBe('idle')
    expect(canProcessQueue).toBe(true)
    expect(chainInProgress).toBe(false)
    expect(isProcessingQueueRef.current).toBe(false)
  })

  test('calls resumeQueue instead of setCanProcessQueue when provided', () => {
    let streamStatus = 'streaming' as StreamStatus
    let canProcessQueueCalled = false
    let resumeQueueCalled = false
    let chainInProgress = true

    finalizeQueueState({
      setStreamStatus: (status) => {
        streamStatus = status
      },
      setCanProcessQueue: () => {
        canProcessQueueCalled = true
      },
      updateChainInProgress: (value) => {
        chainInProgress = value
      },
      resumeQueue: () => {
        resumeQueueCalled = true
      },
    })

    expect(streamStatus).toBe('idle')
    expect(resumeQueueCalled).toBe(true)
    expect(canProcessQueueCalled).toBe(false)
    expect(chainInProgress).toBe(false)
  })

  test('respects isQueuePausedRef when no resumeQueue provided', () => {
    let canProcessQueue = true
    const isQueuePausedRef = { current: true }

    finalizeQueueState({
      setStreamStatus: () => {},
      setCanProcessQueue: (can) => {
        canProcessQueue = can
      },
      updateChainInProgress: () => {},
      isQueuePausedRef,
    })

    // When queue was paused before streaming, canProcessQueue should be false
    expect(canProcessQueue).toBe(false)
  })
})

describe('handleRunError', () => {
  let originalGetState: typeof useChatStore.getState

  beforeEach(() => {
    originalGetState = useChatStore.getState
  })

  afterEach(() => {
    useChatStore.getState = originalGetState
  })

  test('stores error in userError field for regular errors', () => {
    let messages: ChatMessage[] = [
      {
        id: 'ai-1',
        variant: 'ai',
        content: 'Partial streamed content',
        blocks: [],
        timestamp: 'now',
      },
    ]

    const timerController = createMockTimerController()
    const updater = createBatchedMessageUpdater('ai-1', (fn: any) => {
      messages = fn(messages)
    })

    let streamStatus: StreamStatus = 'idle'
    let canProcessQueue = false
    let chainInProgress = true
    let isRetrying = true

    handleRunError({
      error: new Error('Network timeout'),
      timerController,
      updater,
      setIsRetrying: (value: boolean) => {
        isRetrying = value
      },
      setStreamStatus: (status: StreamStatus) => {
        streamStatus = status
      },
      setCanProcessQueue: (can: boolean) => {
        canProcessQueue = can
      },
      updateChainInProgress: (value: boolean) => {
        chainInProgress = value
      },
    })

    const aiMessage = messages.find((m) => m.id === 'ai-1')
    expect(aiMessage).toBeDefined()

    // Content should be preserved, error stored in userError
    expect(aiMessage!.content).toBe('Partial streamed content')
    expect(aiMessage!.userError).toBe('Network timeout')

    // Verify state resets
    expect(streamStatus).toBe('idle')
    expect(canProcessQueue).toBe(true)
    expect(chainInProgress).toBe(false)
    expect(isRetrying).toBe(false)

    // Verify timer stopped with error
    expect(timerController.stopCalls).toContain('error')

    // Verify message marked complete
    expect(aiMessage!.isComplete).toBe(true)
  })

  test('handles empty existing content gracefully', () => {
    let messages: ChatMessage[] = [
      {
        id: 'ai-1',
        variant: 'ai',
        content: '',
        blocks: [],
        timestamp: 'now',
      },
    ]

    const timerController = createMockTimerController()
    const updater = createBatchedMessageUpdater('ai-1', (fn: any) => {
      messages = fn(messages)
    })

    handleRunError({
      error: new Error('Something failed'),
      timerController,
      updater,
      setIsRetrying: () => {},
      setStreamStatus: () => {},
      setCanProcessQueue: () => {},
      updateChainInProgress: () => {},
    })

    const aiMessage = messages.find((m) => m.id === 'ai-1')
    // Error should be in userError field
    expect(aiMessage!.userError).toBe('Something failed')
    expect(aiMessage!.isComplete).toBe(true)
  })

  test('handles regular errors without switching input mode', () => {
    let messages: ChatMessage[] = [
      {
        id: 'ai-1',
        variant: 'ai',
        content: '',
        blocks: [],
        timestamp: 'now',
      },
    ]

    const timerController = createMockTimerController()
    const updater = createBatchedMessageUpdater('ai-1', (fn: any) => {
      messages = fn(messages)
    })

    const setInputModeMock = mock(() => {})
    useChatStore.getState = () => ({
      ...originalGetState(),
      setInputMode: setInputModeMock,
    })

    handleRunError({
      error: new Error('Regular error'),
      timerController,
      updater,
      setIsRetrying: () => {},
      setStreamStatus: () => {},
      setCanProcessQueue: () => {},
      updateChainInProgress: () => {},
    })

    // Should NOT switch input mode for regular errors
    expect(setInputModeMock).not.toHaveBeenCalled()
  })

  test('resets isProcessingQueueRef to false on error', () => {
    let messages: ChatMessage[] = [
      {
        id: 'ai-1',
        variant: 'ai',
        content: '',
        blocks: [],
        timestamp: 'now',
      },
    ]

    const timerController = createMockTimerController()
    const updater = createBatchedMessageUpdater('ai-1', (fn: any) => {
      messages = fn(messages)
    })
    const isProcessingQueueRef = { current: true }

    // Verify ref starts as true
    expect(isProcessingQueueRef.current).toBe(true)

    handleRunError({
      error: new Error('Some error'),
      timerController,
      updater,
      setIsRetrying: () => {},
      setStreamStatus: () => {},
      setCanProcessQueue: () => {},
      updateChainInProgress: () => {},
      isProcessingQueueRef,
    })

    // Verify isProcessingQueueRef is reset to false
    expect(isProcessingQueueRef.current).toBe(false)
  })

  test('respects isQueuePausedRef when setting canProcessQueue on error', () => {
    let messages: ChatMessage[] = [
      {
        id: 'ai-1',
        variant: 'ai',
        content: '',
        blocks: [],
        timestamp: 'now',
      },
    ]

    const timerController = createMockTimerController()
    const updater = createBatchedMessageUpdater('ai-1', (fn: any) => {
      messages = fn(messages)
    })
    const isQueuePausedRef = { current: true }
    let canProcessQueue = true

    handleRunError({
      error: new Error('Some error'),
      timerController,
      updater,
      setIsRetrying: () => {},
      setStreamStatus: () => {},
      setCanProcessQueue: (can: boolean) => {
        canProcessQueue = can
      },
      updateChainInProgress: () => {},
      isQueuePausedRef,
    })

    // When queue was paused before streaming, canProcessQueue should be false
    expect(canProcessQueue).toBe(false)
  })

  test('context length exceeded error (AI_APICallError) stores error in userError and preserves content', () => {
    let messages: ChatMessage[] = [
      {
        id: 'ai-1',
        variant: 'ai',
        content: 'Partial streamed content before error',
        blocks: [{ type: 'text', content: 'some block content' }],
        timestamp: 'now',
      },
    ]

    const timerController = createMockTimerController()
    const updater = createBatchedMessageUpdater('ai-1', (fn: any) => {
      messages = fn(messages)
    })

    // Create an error that matches the real AI_APICallError structure
    const contextLengthError = Object.assign(
      new Error(
        'This endpoint\'s maximum context length is 200000 tokens. However, you requested about 201209 tokens (158536 of text input, 10673 of tool input, 32000 in the output). Please reduce the length of either one, or use the "middle-out" transform to compress your prompt automatically.',
      ),
      {
        name: 'AI_APICallError',
        statusCode: 400,
      },
    )

    let streamStatus = 'streaming' as StreamStatus
    let canProcessQueue = false
    let chainInProgress = true
    let isRetrying = true

    handleRunError({
      error: contextLengthError,
      timerController,
      updater,
      setIsRetrying: (value: boolean) => {
        isRetrying = value
      },
      setStreamStatus: (status: StreamStatus) => {
        streamStatus = status
      },
      setCanProcessQueue: (can: boolean) => {
        canProcessQueue = can
      },
      updateChainInProgress: (value: boolean) => {
        chainInProgress = value
      },
    })

    const aiMessage = messages.find((m) => m.id === 'ai-1')
    expect(aiMessage).toBeDefined()

    // Content should be preserved
    expect(aiMessage!.content).toBe('Partial streamed content before error')

    // Blocks should be preserved
    expect(aiMessage!.blocks).toEqual([
      { type: 'text', content: 'some block content' },
    ])

    // Error should be stored in userError (displayed in UserErrorBanner)
    expect(aiMessage!.userError).toContain(
      'maximum context length is 200000 tokens',
    )
    expect(aiMessage!.userError).toContain('201209 tokens')

    // Message should be marked complete
    expect(aiMessage!.isComplete).toBe(true)

    // State should be reset
    expect(streamStatus).toBe('idle')
    expect(canProcessQueue).toBe(true)
    expect(chainInProgress).toBe(false)
    expect(isRetrying).toBe(false)

    // Timer should be stopped with error
    expect(timerController.stopCalls).toContain('error')
  })

  test('Payment required error (402) uses the billing policy for this client', () => {
    let messages: ChatMessage[] = [
      {
        id: 'ai-1',
        variant: 'ai',
        content: 'Partial streamed content',
        blocks: [{ type: 'text', content: 'some block' }],
        timestamp: 'now',
      },
    ]

    const timerController = createMockTimerController()
    const updater = createBatchedMessageUpdater('ai-1', (fn: any) => {
      messages = fn(messages)
    })

    const setInputModeMock = mock(() => {})
    useChatStore.getState = () => ({
      ...originalGetState(),
      setInputMode: setInputModeMock,
    })

    const paymentError = createPaymentRequiredError('Out of credits')

    handleRunError({
      error: paymentError,
      timerController,
      updater,
      setIsRetrying: () => {},
      setStreamStatus: () => {},
      setCanProcessQueue: () => {},
      updateChainInProgress: () => {},
    })

    const aiMessage = messages.find((m) => m.id === 'ai-1')
    expect(aiMessage).toBeDefined()

    // For PaymentRequiredError, setError sets userError (not content)
    // Content is preserved, error is stored in userError field
    expect(aiMessage!.content).toBe('Partial streamed content')
    expect(aiMessage!.userError).toContain(
      IS_FREEBUFF ? FREEBUFF_PROVIDER_USAGE_MESSAGE : 'Out of credits',
    )

    // Blocks should be preserved for debugging context
    expect(aiMessage!.blocks).toEqual([{ type: 'text', content: 'some block' }])

    // Message should be marked complete
    expect(aiMessage!.isComplete).toBe(true)

    if (IS_FREEBUFF) {
      expect(setInputModeMock).not.toHaveBeenCalled()
    } else {
      expect(setInputModeMock).toHaveBeenCalledWith('outOfCredits')
    }

    // Timer should still be stopped with error
    expect(timerController.stopCalls).toContain('error')
  })
})

/**
 * CLI-level async race test: reproduces the exact bug scenario where aborting
 * run A and attempting run B before A resolves would lose message history.
 *
 * This test simulates the full lifecycle at the helper level:
 * 1. Start run A (setupStreamingContext)
 * 2. Abort run A mid-stream
 * 3. Attempt run B — verify it's blocked (chain lock held)
 * 4. Resolve run A (handleRunCompletion with updated state)
 * 5. Verify run B is now unblocked and can use state from A
 */
describe('CLI-level race condition: abort run A, attempt run B before A resolves', () => {
  /**
   * Simulates the queue-processing gate checks from useMessageQueue.processNextMessage.
   * Returns true if a queued message would be allowed to proceed.
   */
  const canQueueProcessNextMessage = (opts: {
    isChainInProgress: boolean
    canProcessQueue: boolean
    streamStatus: StreamStatus
    isProcessingQueue: boolean
    isQueuePaused: boolean
  }): boolean => {
    if (opts.isQueuePaused) return false
    if (!opts.canProcessQueue) return false
    if (opts.streamStatus !== 'idle') return false
    if (opts.isChainInProgress) return false
    if (opts.isProcessingQueue) return false
    return true
  }

  test('run B can proceed immediately after abort (chain lock released by abort handler)', () => {
    // --- Shared mutable state (simulates React refs and state in the CLI) ---
    let streamStatus: StreamStatus = 'idle'
    let canProcessQueue = false
    let chainInProgress = true // Set true at start of sendMessage
    const isProcessingQueueRef = { current: false }
    const isQueuePausedRef = { current: false }

    const setStreamStatus = (status: StreamStatus) => {
      streamStatus = status
    }
    const setCanProcessQueue = (can: boolean) => {
      canProcessQueue = can
    }
    const updateChainInProgress = (value: boolean) => {
      chainInProgress = value
    }

    // --- PHASE 1: Start run A (setupStreamingContext) ---
    let messagesA = createBaseMessages()
    const streamRefsA = createStreamController()
    const timerControllerA = createMockTimerController()

    const { updater: updaterA, abortController: abortControllerA } =
      setupStreamingContext({
        aiMessageId: 'ai-1',
        timerController: timerControllerA,
        setMessages: (fn: any) => {
          messagesA = fn(messagesA)
        },
        streamRefs: streamRefsA,
        setStreamStatus,
        setCanProcessQueue,
        isQueuePausedRef,
        isProcessingQueueRef,
        updateChainInProgress,
        setIsRetrying: () => {},
        setStreamingAgents: () => {},
      })

    // Simulate streaming has started
    streamStatus = 'streaming'

    // Verify run A is actively streaming
    expect(streamStatus).toBe('streaming')
    expect(chainInProgress).toBe(true)

    // --- PHASE 2: User aborts run A ---
    abortControllerA.abort()

    // Abort handler fires synchronously: UI is updated AND chain lock is released
    expect(streamRefsA.state.wasAbortedByUser).toBe(true)
    expect(streamStatus as StreamStatus).toBe('idle')
    expect(chainInProgress).toBe(false) // Chain lock released immediately!
    expect(canProcessQueue).toBe(true)

    // --- PHASE 3: User types run B — verify it's UNBLOCKED ---
    const canProcessRunB = canQueueProcessNextMessage({
      isChainInProgress: chainInProgress,
      canProcessQueue,
      streamStatus,
      isProcessingQueue: isProcessingQueueRef.current,
      isQueuePaused: isQueuePausedRef.current,
    })

    // Run B can proceed immediately — this is the core fix.
    // New messages are sent directly instead of being queued.
    expect(canProcessRunB).toBe(true)
  })

  test('handleRunCompletion does not interfere after abort (no-op for aborted runs)', () => {
    // After abort releases the chain lock, handleRunCompletion should be a no-op
    // to avoid interfering with any new run that may have started.

    let streamStatus: StreamStatus = 'idle'
    let canProcessQueue = true
    let chainInProgress = false // Already released by abort handler
    const isProcessingQueueRef = { current: false }
    const isQueuePausedRef = { current: false }

    const timerController = createMockTimerController()
    let messages = createBaseMessages()
    const updater = createBatchedMessageUpdater('ai-1', (fn: any) => {
      messages = fn(messages)
    })

    // Track calls
    let setStreamStatusCallCount = 0
    let updateChainInProgressCallCount = 0

    const runState: RunState = {
      traceSessionId: 'trace-test',
      sessionState: {} as any,
      output: { type: 'lastMessage' as const, value: [] },
    }

    handleRunCompletion({
      runState,
      actualCredits: undefined,
      agentMode: 'DEFAULT' as any,
      timerController,
      updater,
      aiMessageId: 'ai-1',
      wasAbortedByUser: true,
      setStreamStatus: () => {
        setStreamStatusCallCount++
      },
      setCanProcessQueue: (can: boolean) => {
        canProcessQueue = can
      },
      updateChainInProgress: () => {
        updateChainInProgressCallCount++
      },
      setHasReceivedPlanResponse: () => {},
      isProcessingQueueRef,
      isQueuePausedRef,
    })

    // handleRunCompletion should be a no-op for aborted runs
    expect(setStreamStatusCallCount).toBe(0)
    expect(updateChainInProgressCallCount).toBe(0)
    // State should be unchanged (still in the "released" state from abort handler)
    expect(chainInProgress).toBe(false)
    expect(canProcessQueue).toBe(true)
  })

  test('aborted run A finally block must not clear isProcessingQueueRef owned by run B', () => {
    // Regression test for overlap hazard: after abort releases the chain lock,
    // run B can start from the queue and set isProcessingQueueRef = true.
    // Run A's late-executing finally block must NOT clear it.
    //
    // This tests the pattern used in use-send-message.ts where the finally block
    // guards isProcessingQueueRef cleanup with !abortController.signal.aborted.

    const isProcessingQueueRef = { current: false }
    const isQueuePausedRef = { current: false }
    let chainInProgress = true
    let canProcessQueue = false
    let streamStatus: StreamStatus = 'idle'

    // --- Run A setup and abort ---
    let messagesA = createBaseMessages()
    const sharedStreamRefs = createStreamController()
    const timerA = createMockTimerController()

    const { abortController: abortA } = setupStreamingContext({
      aiMessageId: 'ai-run-a',
      timerController: timerA,
      setMessages: (fn: any) => {
        messagesA = fn(messagesA)
      },
      streamRefs: sharedStreamRefs,
      setStreamStatus: (status: StreamStatus) => {
        streamStatus = status
      },
      setCanProcessQueue: (can: boolean) => {
        canProcessQueue = can
      },
      isQueuePausedRef,
      isProcessingQueueRef,
      updateChainInProgress: (value: boolean) => {
        chainInProgress = value
      },
      setIsRetrying: () => {},
      setStreamingAgents: () => {},
    })

    // Abort run A
    abortA.abort()
    expect(chainInProgress).toBe(false)
    expect(isProcessingQueueRef.current).toBe(false)

    // --- Run B starts from queue, takes ownership of isProcessingQueueRef ---
    isProcessingQueueRef.current = true // Queue's processNextMessage sets this
    chainInProgress = true
    canProcessQueue = false

    // --- Simulate run A's finally block (late execution) ---
    // In use-send-message.ts, the finally block guards with !abortController.signal.aborted.
    // Verify abortA.signal.aborted is true so the guard would skip cleanup.
    expect(abortA.signal.aborted).toBe(true)

    // The finally block pattern: only clean up if NOT aborted
    if (!abortA.signal.aborted) {
      // This should NOT execute
      isProcessingQueueRef.current = false
    }

    // isProcessingQueueRef must still be true (owned by run B)
    expect(isProcessingQueueRef.current).toBe(true)
    // chainInProgress must still be true (owned by run B)
    expect(chainInProgress).toBe(true)
  })

  test('reject-after-abort must not run handleRunError cleanup that could clobber run B', () => {
    // Regression test: if client.run() rejects after abort (e.g., network teardown),
    // handleRunError should NOT run because it would reset shared queue/stream state
    // that run B may have already claimed.
    //
    // This tests the pattern used in use-send-message.ts where the catch block
    // guards handleRunError with !abortController.signal.aborted.

    let streamStatus: StreamStatus = 'idle'
    let canProcessQueue = true
    let chainInProgress = false // Released by abort handler
    const isProcessingQueueRef = { current: false }
    const isQueuePausedRef = { current: false }

    // --- Simulate run A was aborted ---
    const abortController = new AbortController()
    abortController.abort()
    expect(abortController.signal.aborted).toBe(true)

    // --- Run B has started and claimed shared state ---
    chainInProgress = true
    canProcessQueue = false
    isProcessingQueueRef.current = true
    streamStatus = 'streaming'

    // --- Simulate what happens if client.run() rejects after abort ---
    // The catch block pattern: only handle error if NOT aborted
    const error = new Error('AbortError: The operation was aborted')

    if (!abortController.signal.aborted) {
      // This should NOT execute — handleRunError would clobber run B's state
      handleRunError({
        error,
        timerController: createMockTimerController(),
        updater: createBatchedMessageUpdater('ai-1', () => {}),
        setIsRetrying: () => {},
        setStreamStatus: (status: StreamStatus) => {
          streamStatus = status
        },
        setCanProcessQueue: (can: boolean) => {
          canProcessQueue = can
        },
        updateChainInProgress: (value: boolean) => {
          chainInProgress = value
        },
        isProcessingQueueRef,
        isQueuePausedRef,
      })
    }

    // Run B's state must be untouched
    expect(chainInProgress).toBe(true) // Still owned by run B
    expect(canProcessQueue).toBe(false) // Still owned by run B
    expect(isProcessingQueueRef.current).toBe(true) // Still owned by run B
    expect(streamStatus).toBe('streaming') // Still owned by run B
  })

  test('handleRunError WOULD clobber run B state if called without abort guard (documents why guard is needed)', () => {
    // This test proves that handleRunError resets shared state, which is why
    // the catch block in use-send-message.ts MUST guard it with abort check.

    let streamStatus: StreamStatus = 'streaming'
    let canProcessQueue = false
    let chainInProgress = true
    const isProcessingQueueRef = { current: true }
    const isQueuePausedRef = { current: false }

    // Call handleRunError without guard (simulates the bug scenario)
    handleRunError({
      error: new Error('AbortError'),
      timerController: createMockTimerController(),
      updater: createBatchedMessageUpdater('ai-1', (fn: any) => {}),
      setIsRetrying: () => {},
      setStreamStatus: (status: StreamStatus) => {
        streamStatus = status
      },
      setCanProcessQueue: (can: boolean) => {
        canProcessQueue = can
      },
      updateChainInProgress: (value: boolean) => {
        chainInProgress = value
      },
      isProcessingQueueRef,
      isQueuePausedRef,
    })

    // handleRunError resets ALL shared state — this would clobber run B
    expect(chainInProgress).toBe(false) // Clobbered!
    expect(canProcessQueue).toBe(true) // Clobbered!
    expect(isProcessingQueueRef.current).toBe(false) // Clobbered!
    expect(streamStatus as StreamStatus).toBe('idle') // Clobbered!
  })

  test('full two-run lifecycle with shared streamRefs: run A abort → run B starts immediately', () => {
    // End-to-end test: two complete runs sharing the SAME streamRefs instance
    // (matching production behavior where streamRefs is reused across sends).
    // Verifies that run B can start immediately after abort, and that run A's
    // late-resolving handleRunCompletion does NOT interfere with run B.

    let streamStatus: StreamStatus = 'idle'
    let canProcessQueue = false
    let chainInProgress = true
    const isProcessingQueueRef = { current: false }
    const isQueuePausedRef = { current: false }
    let previousRunState: RunState | null = null

    const setStreamStatus = (status: StreamStatus) => {
      streamStatus = status
    }
    const setCanProcessQueue = (can: boolean) => {
      canProcessQueue = can
    }
    const updateChainInProgress = (value: boolean) => {
      chainInProgress = value
    }

    // CRITICAL: Use a single shared streamRefs instance, just like production.
    // In production, streamRefsRef is created once via useRef and reused.
    const sharedStreamRefs = createStreamController()

    // === RUN A ===
    let messagesA = createBaseMessages()
    const timerA = createMockTimerController()

    const { updater: updaterA, abortController: abortA } =
      setupStreamingContext({
        aiMessageId: 'ai-run-a',
        timerController: timerA,
        setMessages: (fn: any) => {
          messagesA = fn(messagesA)
        },
        streamRefs: sharedStreamRefs,
        setStreamStatus,
        setCanProcessQueue,
        isQueuePausedRef,
        isProcessingQueueRef,
        updateChainInProgress,
        setIsRetrying: () => {},
        setStreamingAgents: () => {},
      })

    streamStatus = 'streaming'

    // Abort run A
    abortA.abort()
    expect(chainInProgress).toBe(false) // Lock released immediately!
    expect(canProcessQueue).toBe(true)
    expect(sharedStreamRefs.state.wasAbortedByUser).toBe(true)

    // === RUN B starts immediately (before A's client.run() resolves) ===
    chainInProgress = true
    canProcessQueue = false

    let messagesB: ChatMessage[] = [
      {
        id: 'ai-run-b',
        variant: 'ai',
        content: '',
        blocks: [],
        timestamp: 'now',
      },
    ]
    const timerB = createMockTimerController()

    // Run B's setupStreamingContext calls sharedStreamRefs.reset(),
    // which clears wasAbortedByUser. This is the key race condition.
    const { updater: updaterB, abortController: abortB } =
      setupStreamingContext({
        aiMessageId: 'ai-run-b',
        timerController: timerB,
        setMessages: (fn: any) => {
          messagesB = fn(messagesB)
        },
        streamRefs: sharedStreamRefs,
        setStreamStatus,
        setCanProcessQueue,
        isQueuePausedRef,
        isProcessingQueueRef,
        updateChainInProgress,
        setIsRetrying: () => {},
        setStreamingAgents: () => {},
      })

    // After B starts, shared streamRefs.wasAbortedByUser is reset to false.
    // This is why we use per-run abortController.signal.aborted instead.
    expect(sharedStreamRefs.state.wasAbortedByUser).toBe(false)

    // Now run A's client.run() resolves (after B has already started and reset shared state).
    // handleRunCompletion uses the per-run wasAbortedByUser boolean (from abortA.signal.aborted),
    // NOT the shared streamRefs, so it correctly knows A was aborted.
    const runStateA: RunState = {
      traceSessionId: 'trace-test-a',
      sessionState: {
        id: 'session-abc',
        messages: [
          { role: 'user', content: 'first message' },
          { role: 'assistant', content: 'partial response before cancel' },
        ],
      } as any,
      output: { type: 'lastMessage' as const, value: [] },
    }
    previousRunState = runStateA

    handleRunCompletion({
      runState: runStateA,
      actualCredits: undefined,
      agentMode: 'DEFAULT' as any,
      timerController: timerA,
      updater: updaterA,
      aiMessageId: 'ai-run-a',
      wasAbortedByUser: abortA.signal.aborted, // per-run flag, not shared state
      setStreamStatus,
      setCanProcessQueue,
      updateChainInProgress,
      setHasReceivedPlanResponse: () => {},
      isProcessingQueueRef,
      isQueuePausedRef,
    })

    // handleRunCompletion for aborted run A should be a no-op
    // (it should NOT interfere with run B's chain lock)
    expect(chainInProgress).toBe(true) // Still true from run B!

    // Simulate run B completing normally
    const runStateB: RunState = {
      traceSessionId: 'trace-test-b',
      sessionState: {
        id: 'session-abc',
        messages: [
          { role: 'user', content: 'first message' },
          { role: 'assistant', content: 'partial response before cancel' },
          { role: 'user', content: 'second message' },
          { role: 'assistant', content: 'full response to second message' },
        ],
      } as any,
      output: {
        type: 'lastMessage' as const,
        value: [{ type: 'text' as const, text: 'full response' }],
      },
    }
    previousRunState = runStateB

    handleRunCompletion({
      runState: runStateB,
      actualCredits: 5,
      agentMode: 'DEFAULT' as any,
      timerController: timerB,
      updater: updaterB,
      aiMessageId: 'ai-run-b',
      wasAbortedByUser: abortB.signal.aborted, // per-run flag: false (B was not aborted)
      setStreamStatus,
      setCanProcessQueue,
      updateChainInProgress,
      setHasReceivedPlanResponse: () => {},
      isProcessingQueueRef,
      isQueuePausedRef,
    })

    // Final state: run B completed normally
    expect(previousRunState!.sessionState as any).toEqual({
      id: 'session-abc',
      messages: [
        { role: 'user', content: 'first message' },
        { role: 'assistant', content: 'partial response before cancel' },
        { role: 'user', content: 'second message' },
        { role: 'assistant', content: 'full response to second message' },
      ],
    })
    expect(chainInProgress).toBe(false)
    expect(canProcessQueue).toBe(true)
  })
})

/**
 * Tests for early return queue state reset in sendMessage.
 * These test the resetEarlyReturnState helper used across multiple early return paths:
 * - prepareUserMessage exception
 * - validation failure (success: false)
 * - validation exception
 */
describe('resetEarlyReturnState', () => {
  describe('prepareUserMessage exception path', () => {
    test('resets chain in progress to false', () => {
      let chainInProgress = true

      resetEarlyReturnState({
        updateChainInProgress: (value) => {
          chainInProgress = value
        },
        setCanProcessQueue: () => {},
      })

      expect(chainInProgress).toBe(false)
    })

    test('sets canProcessQueue to true when queue is not paused', () => {
      let canProcessQueue = false
      const isQueuePausedRef = { current: false }

      resetEarlyReturnState({
        updateChainInProgress: () => {},
        setCanProcessQueue: (can) => {
          canProcessQueue = can
        },
        isQueuePausedRef,
      })

      expect(canProcessQueue).toBe(true)
    })

    test('sets canProcessQueue to false when queue is paused', () => {
      let canProcessQueue = true
      const isQueuePausedRef = { current: true }

      resetEarlyReturnState({
        updateChainInProgress: () => {},
        setCanProcessQueue: (can) => {
          canProcessQueue = can
        },
        isQueuePausedRef,
      })

      expect(canProcessQueue).toBe(false)
    })

    test('resets isProcessingQueueRef to false', () => {
      const isProcessingQueueRef = { current: true }

      resetEarlyReturnState({
        updateChainInProgress: () => {},
        setCanProcessQueue: () => {},
        isProcessingQueueRef,
      })

      expect(isProcessingQueueRef.current).toBe(false)
    })

    test('handles missing isProcessingQueueRef gracefully', () => {
      // Should not throw when isProcessingQueueRef is undefined
      expect(() => {
        resetEarlyReturnState({
          updateChainInProgress: () => {},
          setCanProcessQueue: () => {},
        })
      }).not.toThrow()
    })

    test('handles missing isQueuePausedRef gracefully (defaults to canProcessQueue=true)', () => {
      let canProcessQueue = false

      resetEarlyReturnState({
        updateChainInProgress: () => {},
        setCanProcessQueue: (can) => {
          canProcessQueue = can
        },
        // No isQueuePausedRef - should default to !undefined = true
      })

      expect(canProcessQueue).toBe(true)
    })
  })

  describe('validation failure path (success: false)', () => {
    test('resets all queue state correctly when processing queued message', () => {
      let chainInProgress = true
      let canProcessQueue = false
      const isProcessingQueueRef = { current: true }
      const isQueuePausedRef = { current: false }

      resetEarlyReturnState({
        updateChainInProgress: (value) => {
          chainInProgress = value
        },
        setCanProcessQueue: (can) => {
          canProcessQueue = can
        },
        isProcessingQueueRef,
        isQueuePausedRef,
      })

      expect(chainInProgress).toBe(false)
      expect(canProcessQueue).toBe(true)
      expect(isProcessingQueueRef.current).toBe(false)
    })

    test('respects queue paused state after validation failure', () => {
      let chainInProgress = true
      let canProcessQueue = true
      const isProcessingQueueRef = { current: true }
      const isQueuePausedRef = { current: true }

      resetEarlyReturnState({
        updateChainInProgress: (value) => {
          chainInProgress = value
        },
        setCanProcessQueue: (can) => {
          canProcessQueue = can
        },
        isProcessingQueueRef,
        isQueuePausedRef,
      })

      expect(chainInProgress).toBe(false)
      expect(canProcessQueue).toBe(false) // Queue was paused, should stay paused
      expect(isProcessingQueueRef.current).toBe(false)
    })
  })

  describe('validation exception path', () => {
    test('resets all queue state correctly when validation throws', () => {
      let chainInProgress = true
      let canProcessQueue = false
      const isProcessingQueueRef = { current: true }
      const isQueuePausedRef = { current: false }

      // Simulating what happens after catching validation exception
      resetEarlyReturnState({
        updateChainInProgress: (value) => {
          chainInProgress = value
        },
        setCanProcessQueue: (can) => {
          canProcessQueue = can
        },
        isProcessingQueueRef,
        isQueuePausedRef,
      })

      expect(chainInProgress).toBe(false)
      expect(canProcessQueue).toBe(true)
      expect(isProcessingQueueRef.current).toBe(false)
    })

    test('preserves queue pause state when validation throws', () => {
      let canProcessQueue = true
      const isQueuePausedRef = { current: true }
      const isProcessingQueueRef = { current: true }

      resetEarlyReturnState({
        updateChainInProgress: () => {},
        setCanProcessQueue: (can) => {
          canProcessQueue = can
        },
        isProcessingQueueRef,
        isQueuePausedRef,
      })

      // Queue was explicitly paused before, should remain paused after error
      expect(canProcessQueue).toBe(false)
      // But processing lock should be released to allow manual resume
      expect(isProcessingQueueRef.current).toBe(false)
    })
  })

  describe('complete early return scenarios', () => {
    test('queue can process next message after prepareUserMessage exception', () => {
      // Scenario: Message was being processed from queue, prepareUserMessage throws
      let chainInProgress = true
      let canProcessQueue = false
      const isProcessingQueueRef = { current: true }
      const isQueuePausedRef = { current: false }

      // After exception, reset is called
      resetEarlyReturnState({
        updateChainInProgress: (value) => {
          chainInProgress = value
        },
        setCanProcessQueue: (can) => {
          canProcessQueue = can
        },
        isProcessingQueueRef,
        isQueuePausedRef,
      })

      // Queue should be able to process next message
      expect(chainInProgress).toBe(false)
      expect(canProcessQueue).toBe(true)
      expect(isProcessingQueueRef.current).toBe(false)
    })

    test('queue can process next message after validation returns success=false', () => {
      // Scenario: Message was being processed, validation returns failure
      let chainInProgress = true
      let canProcessQueue = false
      const isProcessingQueueRef = { current: true }
      const isQueuePausedRef = { current: false }

      resetEarlyReturnState({
        updateChainInProgress: (value) => {
          chainInProgress = value
        },
        setCanProcessQueue: (can) => {
          canProcessQueue = can
        },
        isProcessingQueueRef,
        isQueuePausedRef,
      })

      // All locks released, queue can continue
      expect(chainInProgress).toBe(false)
      expect(canProcessQueue).toBe(true)
      expect(isProcessingQueueRef.current).toBe(false)
    })

    test('queue can process next message after validation throws exception', () => {
      // Scenario: Message was being processed, validation throws
      let chainInProgress = true
      let canProcessQueue = false
      const isProcessingQueueRef = { current: true }
      const isQueuePausedRef = { current: false }

      resetEarlyReturnState({
        updateChainInProgress: (value) => {
          chainInProgress = value
        },
        setCanProcessQueue: (can) => {
          canProcessQueue = can
        },
        isProcessingQueueRef,
        isQueuePausedRef,
      })

      // All locks released, queue can continue
      expect(chainInProgress).toBe(false)
      expect(canProcessQueue).toBe(true)
      expect(isProcessingQueueRef.current).toBe(false)
    })

    test('queue remains blocked after error if user had paused it', () => {
      // Scenario: User paused queue, then an error occurred
      // Queue should remain paused after error recovery
      let chainInProgress = true
      let canProcessQueue = true
      const isProcessingQueueRef = { current: true }
      const isQueuePausedRef = { current: true } // User explicitly paused

      resetEarlyReturnState({
        updateChainInProgress: (value) => {
          chainInProgress = value
        },
        setCanProcessQueue: (can) => {
          canProcessQueue = can
        },
        isProcessingQueueRef,
        isQueuePausedRef,
      })

      // Chain is no longer in progress
      expect(chainInProgress).toBe(false)
      // But queue should remain blocked because user paused it
      expect(canProcessQueue).toBe(false)
      // Processing lock is released though
      expect(isProcessingQueueRef.current).toBe(false)
    })
  })
})

describe('freebuff gate errors', () => {
  const makeUpdater = (messages: ChatMessage[]) => {
    const updater = createBatchedMessageUpdater('ai-1', (fn: any) => {
      const next = fn(messages)
      messages.length = 0
      messages.push(...next)
    })
    return updater
  }

  const baseMessage = (): ChatMessage[] => [
    {
      id: 'ai-1',
      variant: 'ai',
      content: '',
      blocks: [],
      timestamp: 'now',
    },
  ]

  const gateError = (kind: string, statusCode: number) => ({
    error: kind,
    statusCode,
    message: 'server said so',
  })

  test('handleRunError maps 409 session_superseded to the restart-required message', () => {
    const messages = baseMessage()
    const updater = makeUpdater(messages)
    handleRunError({
      error: gateError('session_superseded', 409),
      timerController: createMockTimerController(),
      updater,
      setIsRetrying: () => {},
      setStreamStatus: () => {},
      setCanProcessQueue: () => {},
      updateChainInProgress: () => {},
    })
    updater.flush()
    expect(messages[0].userError).toContain('Another freebuff CLI took over')
  })

  test('handleRunError suppresses the inline error for 410 session_expired (ended banner takes over)', () => {
    const messages = baseMessage()
    const updater = makeUpdater(messages)
    handleRunError({
      error: gateError('session_expired', 410),
      timerController: createMockTimerController(),
      updater,
      setIsRetrying: () => {},
      setStreamStatus: () => {},
      setCanProcessQueue: () => {},
      updateChainInProgress: () => {},
    })
    updater.flush()
    // New contract: the gate handler flips the session store into `ended`
    // and the session-ended banner is the user-facing signal, so we do NOT
    // also surface an inline userError inside the chat transcript.
    expect(messages[0].userError).toBeUndefined()
  })

  test('handleRunError suppresses the inline error for 428 waiting_room_required (ended banner takes over)', () => {
    const messages = baseMessage()
    const updater = makeUpdater(messages)
    handleRunError({
      error: gateError('waiting_room_required', 428),
      timerController: createMockTimerController(),
      updater,
      setIsRetrying: () => {},
      setStreamStatus: () => {},
      setCanProcessQueue: () => {},
      updateChainInProgress: () => {},
    })
    updater.flush()
    expect(messages[0].userError).toBeUndefined()
  })

  test('handleRunError maps 429 waiting_room_queued to the session-pending message', () => {
    const messages = baseMessage()
    const updater = makeUpdater(messages)
    handleRunError({
      error: gateError('waiting_room_queued', 429),
      timerController: createMockTimerController(),
      updater,
      setIsRetrying: () => {},
      setStreamStatus: () => {},
      setCanProcessQueue: () => {},
      updateChainInProgress: () => {},
    })
    updater.flush()
    expect(messages[0].userError).toContain('still being set up')
  })

  test('handleRunError ignores gate-shaped errors with non-matching status code', () => {
    // An error body with error: 'session_superseded' but a 500 status should
    // NOT be classified as a gate error (prevents generic 5xx from mimicking
    // the structured gate responses).
    const messages = baseMessage()
    const updater = makeUpdater(messages)
    const err = Object.assign(new Error('oops'), {
      error: 'session_superseded',
      statusCode: 500,
    })
    handleRunError({
      error: err,
      timerController: createMockTimerController(),
      updater,
      setIsRetrying: () => {},
      setStreamStatus: () => {},
      setCanProcessQueue: () => {},
      updateChainInProgress: () => {},
    })
    updater.flush()
    expect(messages[0].userError).toBe('oops')
    expect(messages[0].userError).not.toContain('took over')
  })

  test('handleRunCompletion with gate error output routes through the gate handler', () => {
    const messages = baseMessage()
    const updater = makeUpdater(messages)
    const runState: RunState = {
      traceSessionId: 'trace-test',
      sessionState: undefined as any,
      output: {
        type: 'error',
        message: 'server said so',
        error: 'session_expired',
        statusCode: 410,
      } as any,
    }
    handleRunCompletion({
      runState,
      actualCredits: undefined,
      agentMode: 'LITE',
      timerController: createMockTimerController(),
      updater,
      aiMessageId: 'ai-1',
      wasAbortedByUser: false,
      setStreamStatus: () => {},
      setCanProcessQueue: () => {},
      updateChainInProgress: () => {},
      setHasReceivedPlanResponse: () => {},
    })
    updater.flush()
    // 410 is now handled by the ended banner, not an inline error. The
    // assertion here just confirms routing happened via the gate handler
    // (which swallows the userError) rather than the generic error path
    // (which would set a userError from the message).
    expect(messages[0].userError).toBeUndefined()
  })
})

describe('onAbort checkpoint callback (freebuff #1054)', () => {
  test('runs synchronously at the top of the abort listener, before the input lock is released', () => {
    let messages = createBaseMessages()
    const streamRefs = createStreamController()
    const timerController = createMockTimerController()
    // Cast the initializers: TS narrows `let` vars from literal
    // initializers and the abort listener's closure assignments never
    // reset that narrowing, which would mis-type the assertions below.
    let streamStatus = 'streaming' as StreamStatus
    let statusSeenInOnAbort = null as StreamStatus | null
    let chainInProgress = true
    let onAbortCalls = 0

    const { abortController } = setupStreamingContext({
      aiMessageId: 'ai-1',
      timerController,
      setMessages: (fn: any) => {
        messages = fn(messages)
      },
      streamRefs,
      onAbort: () => {
        onAbortCalls++
        // The listener below swaps this to 'idle'; seeing 'streaming'
        // proves onAbort ran BEFORE the lock release / UI reset.
        statusSeenInOnAbort = streamStatus
      },
      setStreamStatus: (status: StreamStatus) => {
        streamStatus = status
      },
      setCanProcessQueue: () => {
        chainInProgress = false
      },
      updateChainInProgress: () => {},
      setIsRetrying: () => {},
      setStreamingAgents: () => {},
    })

    abortController.abort()

    expect(onAbortCalls).toBe(1)
    expect(statusSeenInOnAbort).toBe('streaming')
    expect(streamStatus).toBe('idle')
  })

  test('a throwing onAbort still runs the interruption cleanup', () => {
    let messages = createBaseMessages()
    const streamRefs = createStreamController()
    const timerController = createMockTimerController()
    let chainInProgress = true

    const { abortController } = setupStreamingContext({
      aiMessageId: 'ai-1',
      timerController,
      setMessages: (fn: any) => {
        messages = fn(messages)
      },
      streamRefs,
      onAbort: () => {
        throw new Error('checkpoint boom')
      },
      setStreamStatus: () => {},
      setCanProcessQueue: () => {
        chainInProgress = false
      },
      updateChainInProgress: () => {},
      setIsRetrying: () => {},
      setStreamingAgents: () => {},
    })

    expect(() => abortController.abort()).not.toThrow()
    expect(chainInProgress).toBe(false)
    expect(streamRefs.state.wasAbortedByUser).toBe(true)
  })

  test('abort leaves the full message history in the continuation snapshot', () => {
    // Mirrors the hook wiring: onAbort stores the latest in-flight snapshot
    // into the continuation ref used by the next sendMessage. This is the
    // exact path that used to hand the SDK an empty previousRun after an
    // interrupt, resetting the conversation to a blank session.
    const previousRunStateRef = { current: null as RunState | null }
    const snapshot = {
      traceSessionId: 'trace-1',
      sessionState: {
        mainAgentState: {
          messageHistory: [
            {
              role: 'user',
              content: [{ type: 'text', text: 'implement authentication' }],
            },
            {
              role: 'assistant',
              content: [{ type: 'text', text: 'reading project files' }],
            },
            {
              role: 'tool',
              toolName: 'read_files',
              content: [{ type: 'text', value: { files: ['src/auth.ts'] } }],
            },
          ],
        },
      } as any,
      output: {
        type: 'error',
        message: 'Session ended before this response completed.',
      },
    } as unknown as RunState

    const { abortController } = setupStreamingContext({
      aiMessageId: 'ai-1',
      timerController: createMockTimerController(),
      setMessages: (fn: any) => {},
      streamRefs: createStreamController(),
      onAbort: () => {
        previousRunStateRef.current = snapshot
      },
      setStreamStatus: () => {},
      setCanProcessQueue: () => {},
      updateChainInProgress: () => {},
      setIsRetrying: () => {},
      setStreamingAgents: () => {},
    })

    abortController.abort()

    // The continuation snapshot now carries the full history instead of
    // null (which would make the SDK build a blank session and re-explore
    // from scratch on the next prompt). The hook-level test in
    // cli/src/hooks/__tests__/use-send-message.test.tsx asserts the same
    // through the real createRunConfig/client.run path.
    expect(previousRunStateRef.current).toBe(snapshot)
    expect(
      (previousRunStateRef.current!.sessionState as any).mainAgentState
        .messageHistory,
    ).toHaveLength(3)
    expect(
      (previousRunStateRef.current!.sessionState as any).mainAgentState
        .messageHistory[2].toolName,
    ).toBe('read_files')
  })
})
