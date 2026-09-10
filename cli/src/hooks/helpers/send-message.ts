import { FREEBUFF_PROVIDER_USAGE_MESSAGE } from '@codebuff/common/constants/freebuff-errors'
import { getErrorObject } from '@codebuff/common/util/error'

import {
  markFreebuffSessionCountryBlocked,
  markFreebuffSessionEnded,
  markFreebuffSessionSuperseded,
  refreshFreebuffSession,
} from '../use-freebuff-session'
import { getProjectRoot } from '../../project-files'
import { useChatStore } from '../../state/chat-store'
import { IS_FREEBUFF } from '../../utils/constants'
import { processBashContext } from '../../utils/bash-context-processor'
import { markRunningAgentsAsCancelled } from '../../utils/block-operations'
import {
  getCountryBlockFromFreeModeError,
  getFreeModeUnavailableErrorMessage,
  getFreebuffGateErrorKind,
  getFreebuffRateLimitErrorMessage,
  isOutOfCreditsError,
  isFreebuffProviderUsageError,
  isFreeModeUnavailableError,
  OUT_OF_CREDITS_MESSAGE,
} from '../../utils/error-handling'
import { formatElapsedTime } from '../../utils/format-elapsed-time'
import { processImagesForMessage } from '../../utils/image-processor'
import { logger } from '../../utils/logger'
import { appendInterruptionNotice } from '../../utils/message-block-helpers'
import { getUserMessage } from '../../utils/message-history'
import {
  createBatchedMessageUpdater,
  type BatchedMessageUpdater,
} from '../../utils/message-updater'
import { createModeDividerMessage } from '../../utils/send-message-helpers'
import { yieldToEventLoop } from '../../utils/yield-to-event-loop'
import { invalidateActivityQuery } from '../use-activity-query'
import { usageQueryKeys } from '../use-usage-query'

import type {
  PendingAttachment,
  PendingFileAttachment,
  PendingImageAttachment,
  PendingTextAttachment,
} from '../../types/store'
import type { ChatMessage } from '../../types/chat'
import type { AgentMode } from '../../utils/constants'
import type { SendMessageTimerController } from '../../utils/send-message-timer'
import type { StreamController } from '../stream-state'
import type { StreamStatus } from '../use-message-queue'
import type { MessageContent, RunState } from '@codebuff/sdk'
import type { MutableRefObject, SetStateAction } from 'react'

/** Resets queue state on early return (before streaming starts). */
export type ResetEarlyReturnStateParams = {
  setCanProcessQueue: (can: boolean) => void
  updateChainInProgress: (value: boolean) => void
  isProcessingQueueRef?: MutableRefObject<boolean>
  isQueuePausedRef?: MutableRefObject<boolean>
}

export const resetEarlyReturnState = (
  params: ResetEarlyReturnStateParams,
): void => {
  const {
    setCanProcessQueue,
    updateChainInProgress,
    isProcessingQueueRef,
    isQueuePausedRef,
  } = params

  updateChainInProgress(false)
  setCanProcessQueue(!isQueuePausedRef?.current)
  if (isProcessingQueueRef) {
    isProcessingQueueRef.current = false
  }
}

/** Resets queue state after streaming completes, aborts, or errors. */
export type FinalizeQueueStateParams = {
  setStreamStatus: (status: StreamStatus) => void
  setCanProcessQueue: (can: boolean) => void
  updateChainInProgress: (value: boolean) => void
  isProcessingQueueRef?: MutableRefObject<boolean>
  isQueuePausedRef?: MutableRefObject<boolean>
  resumeQueue?: () => void
}

export const finalizeQueueState = (params: FinalizeQueueStateParams): void => {
  const {
    setStreamStatus,
    setCanProcessQueue,
    updateChainInProgress,
    isProcessingQueueRef,
    isQueuePausedRef,
    resumeQueue,
  } = params

  setStreamStatus('idle')
  // Release lock here as part of normal completion flow.
  // Also released in finally block and .catch() as safety nets (idempotent).
  if (isProcessingQueueRef) {
    isProcessingQueueRef.current = false
  }
  if (resumeQueue) {
    resumeQueue()
  } else {
    setCanProcessQueue(!isQueuePausedRef?.current)
  }
  updateChainInProgress(false)
}

const DEFAULT_RUN_OUTPUT_ERROR_MESSAGE = 'No output from agent run'

export type PrepareUserMessageDeps = {
  setMessages: (update: SetStateAction<ChatMessage[]>) => void
  lastMessageMode: AgentMode | null
  setLastMessageMode: (mode: AgentMode | null) => void
  scrollToLatest: () => void
  setHasReceivedPlanResponse: (value: boolean) => void
}

export const prepareUserMessage = async (params: {
  content: string
  agentMode: AgentMode
  postUserMessage?: (prev: ChatMessage[]) => ChatMessage[]
  attachments?: PendingAttachment[]
  signal?: AbortSignal
  deps: PrepareUserMessageDeps
}): Promise<{
  userMessageId: string
  messageContent: MessageContent[] | undefined
  bashContextForPrompt: string
  finalContent: string
}> => {
  const { content, agentMode, postUserMessage, attachments, signal, deps } =
    params
  const { setMessages, lastMessageMode, setLastMessageMode, scrollToLatest } =
    deps

  const { pendingBashMessages, clearPendingBashMessages } =
    useChatStore.getState()
  const { bashMessages, bashContextForPrompt } =
    processBashContext(pendingBashMessages)

  if (bashMessages.length > 0) {
    setMessages((prev) => [...prev, ...bashMessages])
  }
  clearPendingBashMessages()

  // Split attachments by kind
  const allAttachments =
    attachments ?? useChatStore.getState().pendingAttachments
  if (!attachments && allAttachments.length > 0) {
    useChatStore.getState().clearPendingAttachments()
  }

  const pendingImages = allAttachments.filter(
    (a): a is PendingImageAttachment => a.kind === 'image',
  )
  const pendingTextAttachments = allAttachments.filter(
    (a): a is PendingTextAttachment => a.kind === 'text',
  )

  const pendingFileAttachments = allAttachments.filter(
    (a): a is PendingFileAttachment => a.kind === 'file',
  )

  // Append text attachments to the content
  let finalContent = content
  if (pendingTextAttachments.length > 0) {
    const textAttachmentContent = pendingTextAttachments
      .map((att) => `[Pasted Text]\n${att.content}`)
      .join('\n\n')
    finalContent = content
      ? `${content}\n\n${textAttachmentContent}`
      : textAttachmentContent
  }

  // Append file/folder attachments to the content
  if (pendingFileAttachments.length > 0) {
    const fileAttachmentContent = pendingFileAttachments
      .filter((att) => att.status === 'ready')
      .map((att) =>
        att.isDirectory
          ? `[Directory: ${att.path}]\n${att.content}`
          : `[File: ${att.path}]\n${att.content}`,
      )
      .join('\n\n')
    if (fileAttachmentContent) {
      finalContent = finalContent
        ? `${finalContent}\n\n${fileAttachmentContent}`
        : fileAttachmentContent
    }
  }

  const { attachments: imageAttachments, messageContent } =
    await processImagesForMessage({
      content: finalContent,
      pendingImages,
      projectRoot: getProjectRoot(),
    })

  // A chat switch can happen while image processing is awaiting filesystem
  // work. Do not append the old prompt after the destination chat has reset.
  if (signal?.aborted) {
    throw new Error('Message preparation aborted')
  }

  const shouldInsertDivider =
    lastMessageMode === null || lastMessageMode !== agentMode

  // Convert pending text attachments to stored text attachments for display
  const textAttachmentsForMessage = pendingTextAttachments.map((att) => ({
    id: att.id,
    content: att.content,
    preview: att.preview,
    charCount: att.charCount,
  }))

  // Convert pending file attachments to stored file attachments for display
  const fileAttachmentsForMessage = pendingFileAttachments
    .filter((att) => att.status === 'ready')
    .map((att) => ({
      path: att.path,
      filename: att.filename,
      isDirectory: att.isDirectory,
      note: att.note,
    }))

  // Pass original content (not finalContent) for display, but finalContent goes to agent
  const userMessage = getUserMessage(
    content,
    imageAttachments,
    textAttachmentsForMessage,
    fileAttachmentsForMessage,
  )
  const userMessageId = userMessage.id
  if (imageAttachments.length > 0) {
    userMessage.attachments = imageAttachments
  }

  setMessages((prev) => {
    let next = [...prev]
    if (shouldInsertDivider) {
      next.push(createModeDividerMessage(agentMode))
    }
    next.push(userMessage)
    if (postUserMessage) {
      next = postUserMessage(next)
    }
    // Keep the full transcript: this array is what saveChatState persists to
    // chat-messages.json, so trimming here would permanently lose history.
    // Rendering stays cheap because useChatMessages paginates what's shown.
    return next
  })

  setLastMessageMode(agentMode)
  await yieldToEventLoop()
  setTimeout(() => scrollToLatest(), 0)

  return {
    userMessageId,
    messageContent,
    bashContextForPrompt,
    finalContent,
  }
}

export const setupStreamingContext = (params: {
  aiMessageId: string
  timerController: SendMessageTimerController
  setMessages: (updater: (messages: ChatMessage[]) => ChatMessage[]) => void
  streamRefs: StreamController
  abortController?: AbortController
  /** Invoked synchronously at the top of the abort listener, before the
   *  input lock is released. Lets the run owner checkpoint its latest SDK
   *  snapshot so a follow-up message sent immediately after an interrupt
   *  resumes from fresh state instead of stale or null continuation state. */
  onAbort?: () => void
  setStreamStatus: (status: StreamStatus) => void
  setCanProcessQueue: (can: boolean) => void
  isQueuePausedRef?: MutableRefObject<boolean>
  isProcessingQueueRef?: MutableRefObject<boolean>
  updateChainInProgress: (value: boolean) => void
  setIsRetrying: (value: boolean) => void
  setStreamingAgents: (updater: (prev: Set<string>) => Set<string>) => void
}) => {
  const {
    timerController,
    setMessages,
    streamRefs,
    setStreamStatus,
    setCanProcessQueue,
    isQueuePausedRef,
    isProcessingQueueRef,
    updateChainInProgress,
    setIsRetrying,
    setStreamingAgents,
  } = params
  const { aiMessageId } = params

  streamRefs.reset()
  timerController.start(aiMessageId)
  const updater = createBatchedMessageUpdater(aiMessageId, setMessages)
  // Clear any previous UI-only error on this message when starting a new run
  updater.clearUserError()
  const hasReceivedContentRef = { current: false }
  const abortController = params.abortController ?? new AbortController()

  abortController.signal.addEventListener('abort', () => {
    // Let the run owner checkpoint its latest SDK snapshot synchronously
    // BEFORE the input lock below is released, so a follow-up message sent
    // the moment the user hits Esc inherits the latest state instead of
    // stale (or null) continuation state. Best-effort: an onAbort failure
    // must never block interruption cleanup.
    try {
      params.onAbort?.()
    } catch {
      // Checkpoint callbacks are best-effort; never skip abort cleanup.
    }
    // Abort means the user stopped streaming; update UI with an interruption
    // notice. Release the chain lock immediately so new messages can be sent
    // directly instead of being queued.
    streamRefs.setters.setWasAbortedByUser(true)
    setIsRetrying(false)
    timerController.stop('aborted')

    // Update stream status so the UI reflects cancellation visually
    setStreamStatus('idle')

    // Clear streaming agents so cancelled status displays correctly in UI
    setStreamingAgents(() => new Set())

    // Release chain lock and queue state so new messages are sent directly
    updateChainInProgress(false)
    setCanProcessQueue(!isQueuePausedRef?.current)
    if (isProcessingQueueRef) {
      isProcessingQueueRef.current = false
    }

    updater.updateAiMessageBlocks((blocks) => {
      const cancelledBlocks = markRunningAgentsAsCancelled(blocks)
      return appendInterruptionNotice(cancelledBlocks)
    })
    updater.markComplete()
  })

  return { updater, hasReceivedContentRef, abortController }
}

export const handleRunCompletion = (params: {
  runState: RunState
  actualCredits: number | undefined
  agentMode: AgentMode
  timerController: SendMessageTimerController
  updater: BatchedMessageUpdater
  aiMessageId: string
  wasAbortedByUser: boolean
  /** Whether the run streamed any content before finishing. A freebuff gate
   *  rejection with no content means the prompt was consumed unprocessed —
   *  surfaced as an inline error instead of silently looking sent. */
  hasReceivedContent?: boolean
  setStreamStatus: (status: StreamStatus) => void
  setCanProcessQueue: (can: boolean) => void
  updateChainInProgress: (value: boolean) => void
  setHasReceivedPlanResponse: (value: boolean) => void
  resumeQueue?: () => void
  isProcessingQueueRef?: MutableRefObject<boolean>
  isQueuePausedRef?: MutableRefObject<boolean>
}) => {
  const {
    runState,
    actualCredits,
    agentMode,
    timerController,
    updater,
    wasAbortedByUser,
    setStreamStatus,
    setCanProcessQueue,
    updateChainInProgress,
    setHasReceivedPlanResponse,
    resumeQueue,
    isProcessingQueueRef,
    isQueuePausedRef,
  } = params

  // If user aborted, the abort handler already handled UI updates and released the
  // chain lock. Don't finalize queue state again to avoid interfering with any new
  // run that may have started after the abort. Uses per-run abort signal (not shared
  // streamRefs) so a newer run's reset() can't clear this flag.
  if (wasAbortedByUser) {
    return
  }

  const output = runState.output
  const finalizeAfterError = () => {
    finalizeQueueState({
      setStreamStatus,
      setCanProcessQueue,
      updateChainInProgress,
      isProcessingQueueRef,
      isQueuePausedRef,
    })
    timerController.stop('error')
  }

  if (!output) {
    if (!wasAbortedByUser) {
      updater.setError(DEFAULT_RUN_OUTPUT_ERROR_MESSAGE)
      finalizeAfterError()
    }
    return
  }

  if (output.type === 'error') {
    if (IS_FREEBUFF && isFreebuffProviderUsageError(output)) {
      updater.setError(FREEBUFF_PROVIDER_USAGE_MESSAGE)
      finalizeAfterError()
      return
    }

    if (isOutOfCreditsError(output)) {
      updater.setError(OUT_OF_CREDITS_MESSAGE)
      useChatStore.getState().setInputMode('outOfCredits')
      invalidateActivityQuery(usageQueryKeys.current())
      finalizeAfterError()
      return
    }

    if (isFreeModeUnavailableError(output)) {
      updater.setError(getFreeModeUnavailableErrorMessage(output))
      if (IS_FREEBUFF) {
        markFreebuffSessionCountryBlocked(
          getCountryBlockFromFreeModeError(output) ?? {
            countryCode: 'UNKNOWN',
          },
        )
      }
      finalizeAfterError()
      return
    }

    const gateKind = getFreebuffGateErrorKind(output)
    if (gateKind) {
      handleFreebuffGateError(gateKind, updater, {
        messageWasDropped: params.hasReceivedContent === false,
      })
      finalizeAfterError()
      return
    }

    const freebuffRateLimitMessage = IS_FREEBUFF
      ? getFreebuffRateLimitErrorMessage(output)
      : null
    if (freebuffRateLimitMessage) {
      updater.setError(freebuffRateLimitMessage)
      finalizeAfterError()
      return
    }

    // Pass the raw error message to setError (displayed in UserErrorBanner without additional wrapper formatting)
    updater.setError(output.message ?? DEFAULT_RUN_OUTPUT_ERROR_MESSAGE)

    finalizeAfterError()
    return
  }

  invalidateActivityQuery(usageQueryKeys.current())

  finalizeQueueState({
    setStreamStatus,
    setCanProcessQueue,
    updateChainInProgress,
    isProcessingQueueRef,
    isQueuePausedRef,
    resumeQueue,
  })
  const timerResult = timerController.stop('success')

  if (agentMode === 'PLAN') {
    setHasReceivedPlanResponse(true)
  }

  const elapsedMs = timerResult?.elapsedMs ?? 0
  const elapsedSeconds = Math.floor(elapsedMs / 1000)
  let completionTime: string | undefined
  if (elapsedSeconds > 0) {
    completionTime = formatElapsedTime(elapsedSeconds)
  }

  updater.markComplete({
    ...(completionTime && { completionTime }),
    ...(actualCredits !== undefined && { credits: actualCredits }),
    metadata: {
      runState,
    },
  })
}

export const handleRunError = (params: {
  error: unknown
  timerController: SendMessageTimerController
  updater: BatchedMessageUpdater
  setIsRetrying: (value: boolean) => void
  setStreamStatus: (status: StreamStatus) => void
  setCanProcessQueue: (can: boolean) => void
  updateChainInProgress: (value: boolean) => void
  isProcessingQueueRef?: MutableRefObject<boolean>
  isQueuePausedRef?: MutableRefObject<boolean>
  /** See handleRunCompletion — flags an unprocessed prompt on gate errors. */
  hasReceivedContent?: boolean
}) => {
  const {
    error,
    timerController,
    updater,
    setIsRetrying,
    setStreamStatus,
    setCanProcessQueue,
    updateChainInProgress,
    isProcessingQueueRef,
    isQueuePausedRef,
    hasReceivedContent,
  } = params

  const errorInfo = getErrorObject(error, { includeRawError: true })

  logger.error({ error: errorInfo }, 'SDK client.run() failed')
  setIsRetrying(false)
  finalizeQueueState({
    setStreamStatus,
    setCanProcessQueue,
    updateChainInProgress,
    isProcessingQueueRef,
    isQueuePausedRef,
  })
  timerController.stop('error')

  if (IS_FREEBUFF && isFreebuffProviderUsageError(error)) {
    updater.setError(FREEBUFF_PROVIDER_USAGE_MESSAGE)
    return
  }

  if (isOutOfCreditsError(error)) {
    updater.setError(OUT_OF_CREDITS_MESSAGE)
    useChatStore.getState().setInputMode('outOfCredits')
    invalidateActivityQuery(usageQueryKeys.current())
    return
  }

  if (isFreeModeUnavailableError(error)) {
    updater.setError(getFreeModeUnavailableErrorMessage(error))
    if (IS_FREEBUFF) {
      markFreebuffSessionCountryBlocked(
        getCountryBlockFromFreeModeError(error) ?? {
          countryCode: 'UNKNOWN',
        },
      )
    }
    return
  }

  const gateKind = getFreebuffGateErrorKind(error)
  if (gateKind) {
    handleFreebuffGateError(gateKind, updater, {
      messageWasDropped: hasReceivedContent === false,
    })
    return
  }

  const freebuffRateLimitMessage = IS_FREEBUFF
    ? getFreebuffRateLimitErrorMessage(error)
    : null
  if (freebuffRateLimitMessage) {
    updater.setError(freebuffRateLimitMessage)
    return
  }

  // Use setError for all errors so they display in UserErrorBanner consistently
  const errorMessage = errorInfo.message || 'An unexpected error occurred'
  updater.setError(errorMessage)
}

/**
 * Surface + recover from a session gate rejection. The server rejected
 * the request because our session is no longer valid; update local state so
 * the UI reflects reality and we stop sending requests until we re-admit.
 */
function handleFreebuffGateError(
  kind: ReturnType<typeof getFreebuffGateErrorKind>,
  updater: BatchedMessageUpdater,
  opts: { messageWasDropped?: boolean } = {},
) {
  switch (kind) {
    case 'session_expired':
    case 'waiting_room_required':
    case 'session_model_mismatch':
      // Our seat is gone mid-chat. Finalize the AI message so its streaming
      // indicator stops — otherwise `isComplete` stays false and the message
      // keeps rendering a blinking cursor forever, making the user think the
      // agent is still working even though the SessionEndedBanner is visible
      // and actionable. Also disposes the batched-updater flush interval.
      updater.markComplete()
      // Rejected before producing anything (the run-start guard missed
      // because only the server knew the slot was gone): the prompt won't be
      // processed and isn't re-queued, so say so instead of leaving it
      // looking sent. Runs that got partway keep the quieter banner-only UX.
      if (opts.messageWasDropped) {
        updater.setError(
          'Your free session ended before this message was processed. Send it again after starting a new session.',
        )
      }
      // Flip to `ended` instead of auto re-queuing: the Chat surface stays
      // mounted so any in-flight agent work can finish under the server-side
      // grace period, and the session-ended banner prompts the user to press
      // Enter when they're ready to rejoin.
      markFreebuffSessionEnded()
      return
    case 'waiting_room_queued':
      // Legacy error code: sessions are admitted immediately now, so this is
      // only reachable in a transient race with a concurrent session request.
      updater.setError(
        'Your free session is still being set up. Try again in a moment.',
      )
      // Re-sync without resetting chat — this is a "we'll wait", not a
      // "let's start fresh".
      refreshFreebuffSession().catch(() => {})
      return
    case 'session_superseded':
      updater.setError(
        'Another freebuff CLI took over this account. Close the other instance, then restart.',
      )
      // Terminal state: stop polling and flip UI to a "please restart" screen
      // so we don't silently fight the other instance for the seat.
      markFreebuffSessionSuperseded()
      return
    default:
      return
  }
}
