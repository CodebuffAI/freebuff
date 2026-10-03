import { useCallback, useEffect, useRef, useState } from 'react'

import { noteAdQueuedCount } from '../ads/ad-signals'
import { logger } from '../utils/logger'

import type { PendingAttachment } from '../types/store'

export type StreamStatus = 'idle' | 'waiting' | 'streaming'

export type QueuedMessage = {
  /** Stable across edits and reorders so the queue editor can address a row
   *  by identity rather than by a position that shifts underneath it. */
  id: string
  content: string
  attachments: PendingAttachment[]
}

const newQueueId = () => crypto.randomUUID()

// Watchdog timeout duration: 60 seconds
const QUEUE_WATCHDOG_TIMEOUT_MS = 60 * 1000

export const useMessageQueue = (
  sendMessage: (message: QueuedMessage) => Promise<void>,
  isChainInProgressRef: React.MutableRefObject<boolean>,
  activeAgentStreamsRef: React.MutableRefObject<number>,
  opts: {
    /** External hold on dequeuing (e.g. the freebuff session ended and new
     *  requests would be rejected). Queued messages are kept, not dropped;
     *  processing resumes automatically when this flips back to false. */
    sendBlocked?: boolean
    /** Test seam for the stuck-lock watchdog. */
    watchdogTimeoutMs?: number
  } = {},
) => {
  const sendBlocked = opts.sendBlocked ?? false
  const watchdogTimeoutMs = opts.watchdogTimeoutMs ?? QUEUE_WATCHDOG_TIMEOUT_MS
  const [queuedMessages, setQueuedMessages] = useState<QueuedMessage[]>([])
  const [streamStatus, setStreamStatus] = useState<StreamStatus>('idle')
  const [canProcessQueue, setCanProcessQueue] = useState<boolean>(true)
  // Separate state for user-initiated pause to ensure re-renders when pause status changes
  const [queuePausedState, setQueuePausedState] = useState<boolean>(false)

  // Keep a ref so clearQueue can return the current queue synchronously.
  const queuedMessagesRef = useRef<QueuedMessage[]>([])
  const streamTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const streamIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const streamMessageIdRef = useRef<string | null>(null)
  const isProcessingQueueRef = useRef<boolean>(false)
  const queueProcessingOwnerRef = useRef<symbol | null>(null)
  // User-initiated pause state (separate from system-busy state)
  const isQueuePausedRef = useRef<boolean>(false)
  // Watchdog timer to recover from stuck queue processing lock
  const watchdogTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // queuePaused reflects whether the user has explicitly paused the queue
  // (not whether the system is temporarily busy processing)
  // Use state instead of ref to ensure components re-render when pause status changes
  const queuePaused = queuePausedState

  /** Every queue write goes through here: the ref is updated before React
   *  state so anything reading between renders (cancellation, the next
   *  dequeue) sees the same queue the user just acted on. */
  const writeQueue = useCallback((next: QueuedMessage[]) => {
    queuedMessagesRef.current = next
    // COD-757: the queue length rides the ad client context as a bucket.
    noteAdQueuedCount(next.length)
    setQueuedMessages(next)
  }, [])

  const clearStreaming = useCallback(() => {
    if (streamTimeoutRef.current) {
      clearTimeout(streamTimeoutRef.current)
      streamTimeoutRef.current = null
    }
    if (streamIntervalRef.current) {
      clearInterval(streamIntervalRef.current)
      streamIntervalRef.current = null
    }
    streamMessageIdRef.current = null
    activeAgentStreamsRef.current = 0
    setStreamStatus('idle')
  }, [activeAgentStreamsRef])

  useEffect(() => {
    return () => {
      clearStreaming()
      // Clean up watchdog timer on unmount
      if (watchdogTimeoutRef.current) {
        clearTimeout(watchdogTimeoutRef.current)
        watchdogTimeoutRef.current = null
      }
    }
  }, [clearStreaming])

  const processNextMessage = useCallback(() => {
    const queuedList = queuedMessagesRef.current
    const queueLength = queuedList.length

    if (queueLength === 0) {
      return
    }

    // Check if user has explicitly paused the queue
    if (isQueuePausedRef.current) {
      logger.debug(
        { queueLength },
        '[message-queue] Queue blocked: user paused',
      )
      return
    }

    // External hold: sending is currently pointless (e.g. freebuff session
    // fully ended — requests without a live session are rejected). Leave the
    // messages queued; the effect below re-runs when sendBlocked flips false.
    // No log here: unlike the transient busy branches above, this state can
    // persist for the whole hold, and this path re-runs on every render —
    // the transition is logged once by the caller instead.
    if (sendBlocked) {
      return
    }

    if (!canProcessQueue) {
      return
    }
    if (streamStatus !== 'idle') {
      logger.debug(
        { queueLength, streamStatus },
        '[message-queue] Queue blocked: stream not idle',
      )
      return
    }
    if (streamMessageIdRef.current) {
      logger.debug(
        { queueLength, streamMessageId: streamMessageIdRef.current },
        '[message-queue] Queue blocked: streamMessageId set',
      )
      return
    }
    if (isChainInProgressRef.current) {
      logger.debug(
        { queueLength, isChainInProgress: isChainInProgressRef.current },
        '[message-queue] Queue blocked: chain in progress',
      )
      return
    }
    if (activeAgentStreamsRef.current > 0) {
      logger.debug(
        { queueLength, activeAgentStreams: activeAgentStreamsRef.current },
        '[message-queue] Queue blocked: active agent streams',
      )
      return
    }

    if (isProcessingQueueRef.current) {
      logger.debug(
        { queueLength },
        '[message-queue] Queue blocked: already processing',
      )
      return
    }

    logger.info(
      { queueLength },
      '[message-queue] Processing next message from queue',
    )

    const processingOwner = Symbol('queue-processing-owner')
    queueProcessingOwnerRef.current = processingOwner
    isProcessingQueueRef.current = true

    // Start watchdog timer to recover from stuck processing lock
    if (watchdogTimeoutRef.current) {
      clearTimeout(watchdogTimeoutRef.current)
    }
    const armWatchdog = (stuckDurationMs: number) => {
      watchdogTimeoutRef.current = setTimeout(() => {
        if (queueProcessingOwnerRef.current !== processingOwner) return
        // The lock is held for the whole run it dispatched (released by the
        // run's completion), and a run legitimately outlives the timeout --
        // an agent turn, or one waiting on an ask_user answer. That is not a
        // stuck lock: keep watching instead of resetting the queue under the
        // live run. Since chat-first Freebuff sends every session's first
        // prompt through the queue, this misfired on most long first turns.
        if (
          isProcessingQueueRef.current &&
          (isChainInProgressRef.current || activeAgentStreamsRef.current > 0)
        ) {
          armWatchdog(stuckDurationMs + watchdogTimeoutMs)
          return
        }
        if (isProcessingQueueRef.current) {
          logger.warn(
            { stuckDurationMs },
            '[message-queue] Watchdog: isProcessingQueueRef stuck for too long, forcing reset',
          )
          // Also reset canProcessQueue to allow queue to resume (unless user-paused)
          setCanProcessQueue(!isQueuePausedRef.current)
        }
        queueProcessingOwnerRef.current = null
        isProcessingQueueRef.current = false
        watchdogTimeoutRef.current = null
      }, watchdogTimeoutMs)
    }
    armWatchdog(watchdogTimeoutMs)

    // Read the message to process from the synchronous queue source.
    const messageToProcess = queuedMessagesRef.current[0]

    if (!messageToProcess) {
      queueProcessingOwnerRef.current = null
      isProcessingQueueRef.current = false
      // Clear watchdog timer on early return
      if (watchdogTimeoutRef.current) {
        clearTimeout(watchdogTimeoutRef.current)
        watchdogTimeoutRef.current = null
      }
      return
    }

    // Remove it from both sources synchronously. Cancellation decisions read
    // the ref between renders, so deferring this update inside a React state
    // updater can make an in-flight message look queued.
    writeQueue(queuedMessagesRef.current.slice(1))

    sendMessage(messageToProcess)
      .catch((err: unknown) => {
        logger.warn(
          { error: err },
          '[message-queue] sendMessage promise rejected',
        )
      })
      .finally(() => {
        if (queueProcessingOwnerRef.current !== processingOwner) return
        queueProcessingOwnerRef.current = null
        isProcessingQueueRef.current = false
        // Clear watchdog timer when processing completes normally
        if (watchdogTimeoutRef.current) {
          clearTimeout(watchdogTimeoutRef.current)
          watchdogTimeoutRef.current = null
        }
        logger.debug('[message-queue] Processing lock released')
      })
  }, [
    canProcessQueue,
    streamStatus,
    sendMessage,
    sendBlocked,
    isChainInProgressRef,
    activeAgentStreamsRef,
    writeQueue,
    watchdogTimeoutMs,
  ])

  useEffect(() => {
    processNextMessage()
  }, [
    canProcessQueue,
    streamStatus,
    queuedMessages.length,
    processNextMessage,
    isChainInProgressRef,
  ])

  const addToQueue = useCallback(
    (message: string, attachments: PendingAttachment[] = []) => {
      const queuedMessage = {
        id: newQueueId(),
        content: message,
        attachments,
      }
      writeQueue([...queuedMessagesRef.current, queuedMessage])
    },
    [writeQueue],
  )

  /** Put a message back at the HEAD of the queue. Used when a send was
   *  aborted before it did anything (e.g. the freebuff session ended between
   *  dequeue and run start) so the message keeps its place instead of being
   *  consumed. */
  const addToQueueFront = useCallback(
    (message: Omit<QueuedMessage, 'id'>) => {
      writeQueue([
        { ...message, id: newQueueId() },
        ...queuedMessagesRef.current,
      ])
    },
    [writeQueue],
  )

  /** Replace a queued message's text, keeping its place and attachments.
   *  Returns false when the message is no longer queued — it started running
   *  between the editor's render and this call, and rewriting a prompt the
   *  agent is already working on would be a lie either way. */
  const editQueuedMessage = useCallback(
    (id: string, content: string): boolean => {
      const current = queuedMessagesRef.current
      const index = current.findIndex((message) => message.id === id)
      if (index === -1) return false

      const next = [...current]
      next[index] = { ...next[index]!, content }
      writeQueue(next)
      return true
    },
    [writeQueue],
  )

  /** Drop a single queued message. Returns false if it already left the
   *  queue, which is the caller's cue that it is running, not cancelled. */
  const removeQueuedMessage = useCallback(
    (id: string): boolean => {
      const current = queuedMessagesRef.current
      const next = current.filter((message) => message.id !== id)
      if (next.length === current.length) return false

      writeQueue(next)
      return true
    },
    [writeQueue],
  )

  /** Move a queued message to `toIndex`, clamped to the queue's bounds so
   *  callers can pass index±1 at the edges without a guard. */
  const moveQueuedMessage = useCallback(
    (id: string, toIndex: number): boolean => {
      const current = queuedMessagesRef.current
      const from = current.findIndex((message) => message.id === id)
      if (from === -1) return false

      const to = Math.max(0, Math.min(current.length - 1, toIndex))
      if (to === from) return false

      const next = [...current]
      const [moved] = next.splice(from, 1)
      next.splice(to, 0, moved!)
      writeQueue(next)
      return true
    },
    [writeQueue],
  )

  const pauseQueue = useCallback(() => {
    isQueuePausedRef.current = true
    setQueuePausedState(true)
    setCanProcessQueue(false)
  }, [])

  const pauseQueueIfPending = useCallback(() => {
    if (queuedMessagesRef.current.length === 0) return
    pauseQueue()
  }, [pauseQueue])

  const resumeQueue = useCallback(() => {
    isQueuePausedRef.current = false
    setQueuePausedState(false)
    setCanProcessQueue(true)
  }, [])

  const clearQueue = useCallback(() => {
    const current = queuedMessagesRef.current
    writeQueue([])
    return current
  }, [writeQueue])

  /** Drop queue state when leaving its chat. Unlike clearQueue (the user's
   * Ctrl-C action), this also removes paused/processing bookkeeping so a
   * same-provider /new cannot inherit a phantom paused queue. */
  const discardQueue = useCallback(() => {
    writeQueue([])
    isQueuePausedRef.current = false
    setQueuePausedState(false)
    queueProcessingOwnerRef.current = null
    isProcessingQueueRef.current = false
    if (watchdogTimeoutRef.current) {
      clearTimeout(watchdogTimeoutRef.current)
      watchdogTimeoutRef.current = null
    }
    setCanProcessQueue(false)
  }, [writeQueue])

  const startStreaming = useCallback(() => {
    setStreamStatus('streaming')
    setCanProcessQueue(false)
  }, [])

  return {
    queuedMessages,
    streamStatus,
    canProcessQueue,
    queuePaused,
    streamMessageIdRef,
    addToQueue,
    addToQueueFront,
    editQueuedMessage,
    removeQueuedMessage,
    moveQueuedMessage,
    startStreaming,
    setStreamStatus,
    clearStreaming,
    setCanProcessQueue,
    pauseQueue,
    pauseQueueIfPending,
    resumeQueue,
    clearQueue,
    discardQueue,
    isQueuePausedRef,
    isProcessingQueueRef,
  }
}
