/**
 * Chat view adapter for connection status, queue presentation, and exit handling.
 */

import { RECONNECTION_MESSAGE_DURATION_MS } from '@codebuff/sdk'
import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useState, useTransition } from 'react'

import { authQueryKeys } from './use-auth-query'
import { useConnectionStatus } from './use-connection-status'
import { useExitHandler } from './use-exit-handler'
import { useQueueControls } from './use-queue-controls'
import { useQueueUi } from './use-queue-ui'
import { useTimeout } from './use-timeout'
import { useChatRuntime } from '../contexts/chat-runtime-context'
import { useChatStore } from '../state/chat-store'
import {
  sponsoredTurnHoldsQueue,
  useSponsoredRunStore,
} from '../state/sponsored-run-store'

import type { QueuedMessage, StreamStatus } from './use-message-queue'
import type { PendingAttachment } from '../types/store'
import type { MutableRefObject } from 'react'

export interface UseChatStreamingOptions {
  inputValue: string
  setInputValue: (value: {
    text: string
    cursorPosition: number
    lastEditDueToNav: boolean
  }) => void
  terminalWidth: number
  separatorWidth: number
}

export interface UseChatStreamingReturn {
  // Connection state
  isConnected: boolean
  showReconnectionMessage: boolean

  // Timer
  timerStartTime: number | null

  // Stream status
  streamStatus: StreamStatus
  isWaitingForResponse: boolean
  isStreaming: boolean

  // Queue management
  queuedMessages: QueuedMessage[]
  queuePaused: boolean
  streamMessageIdRef: MutableRefObject<string | null>
  addToQueue: (message: string, attachments?: PendingAttachment[]) => void
  setCanProcessQueue: (value: boolean | ((prev: boolean) => boolean)) => void
  clearQueue: () => QueuedMessage[]

  // Queue UI
  queuedCount: number
  shouldShowQueuePreview: boolean
  inputBoxTitle: string | undefined
  inputPlaceholder: string

  // Exit handling
  handleCtrlC: () => true
  ensureQueueActiveBeforeSubmit: () => boolean
  nextCtrlCWillExit: boolean
}

export function useChatStreaming({
  inputValue,
  setInputValue,
  terminalWidth,
  separatorWidth,
}: UseChatStreamingOptions): UseChatStreamingReturn {
  const queryClient = useQueryClient()
  const [, startUiTransition] = useTransition()
  const runtime = useChatRuntime()

  // Reconnection state
  const [showReconnectionMessage, setShowReconnectionMessage] = useState(false)
  const reconnectionTimeout = useTimeout()

  // Reconnection handler
  const handleReconnection = useCallback(
    (isInitialConnection: boolean) => {
      queryClient.invalidateQueries({ queryKey: authQueryKeys.all })

      startUiTransition(() => {
        if (!isInitialConnection) {
          setShowReconnectionMessage(true)
          reconnectionTimeout.setTimeout(
            'reconnection-message',
            () => {
              startUiTransition(() => {
                setShowReconnectionMessage(false)
              })
            },
            RECONNECTION_MESSAGE_DURATION_MS,
          )
        }
      })
    },
    [queryClient, reconnectionTimeout, startUiTransition],
  )

  // Connection status
  const isConnected = useConnectionStatus(handleReconnection)

  const {
    timerStartTime,
    queuedMessages,
    streamStatus,
    isWaitingForResponse,
    isStreaming,
    queuePaused,
    streamMessageIdRef,
    addToQueue,
    setCanProcessQueue,
    resumeQueue,
    clearQueue,
  } = runtime

  // A plain message sent now joins the running task. Not during a sponsored
  // turn: it has no steering mailbox, so messages wait in the queue.
  const isChainInProgress = useChatStore((state) => state.isChainInProgress)
  const sponsoredHoldsQueue = useSponsoredRunStore((state) =>
    sponsoredTurnHoldsQueue(state.snapshot),
  )
  const steersRun =
    (isStreaming || isChainInProgress) && !sponsoredHoldsQueue

  // Queue UI
  const {
    queuedCount,
    shouldShowQueuePreview,
    inputBoxTitle,
    inputPlaceholder,
  } = useQueueUi({
    queuePaused,
    queuedMessages,
    separatorWidth,
    terminalWidth,
    steersRun,
  })

  // Exit handling
  const { handleCtrlC: baseHandleCtrlC, nextCtrlCWillExit } = useExitHandler({
    inputValue,
    setInputValue,
  })

  // Queue controls
  const { handleCtrlC, ensureQueueActiveBeforeSubmit } = useQueueControls({
    queuePaused,
    queuedCount,
    clearQueue,
    resumeQueue,
    inputHasText: Boolean(inputValue),
    baseHandleCtrlC,
  })

  return {
    // Connection state
    isConnected,
    showReconnectionMessage,

    // Timer
    timerStartTime,

    // Stream status
    streamStatus,
    isWaitingForResponse,
    isStreaming,

    // Queue management
    queuedMessages,
    queuePaused,
    streamMessageIdRef,
    addToQueue,
    setCanProcessQueue,
    clearQueue,

    // Queue UI
    queuedCount,
    shouldShowQueuePreview,
    inputBoxTitle,
    inputPlaceholder,

    // Exit handling
    handleCtrlC,
    ensureQueueActiveBeforeSubmit,
    nextCtrlCWillExit,
  }
}
