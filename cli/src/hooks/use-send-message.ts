import { randomUUID } from 'node:crypto'

import { useCallback, useEffect, useRef } from 'react'

import { setCurrentChatId } from '../project-files'
import { createStreamController } from './stream-state'
import { useChatStore } from '../state/chat-store'
import {
  getFreebuffInstanceId,
  markFreebuffSessionEnded,
} from './use-freebuff-session'
import { getSelectedFreebuffReasoningEffort } from '../state/freebuff-model-store'
import { getCodebuffClient } from '../utils/codebuff-client'
import { AGENT_MODE_TO_COST_MODE, IS_FREEBUFF } from '../utils/constants'
import { createEventHandlerState } from '../utils/create-event-handler-state'
import { createRunConfig } from '../utils/create-run-config'
import { getAgentIdForMode } from '../utils/freebuff-agent-selection'
import { loadAgentDefinitions } from '../utils/local-agent-registry'
import { logger } from '../utils/logger'
import { clearActiveRun, registerActiveRun } from '../utils/active-run'
import {
  clearLiveChatStateProvider,
  loadMostRecentChatState,
  resolveCurrentChatDir,
  saveChatState,
  scheduleCheckpointSave,
  setLiveChatStateProvider,
  settleCheckpointSave,
} from '../utils/run-state-storage'
import {
  autoCollapsePreviousMessages,
  createAiMessageShell,
  createErrorMessage as createErrorChatMessage,
  generateAiMessageId,
  sanitizeRestoredMessages,
} from '../utils/send-message-helpers'
import { createSendMessageTimerController } from '../utils/send-message-timer'
import {
  activateSteering,
  deactivateSteering,
  drainSteeringMessages as drainSteeringBuffer,
} from '../utils/steering-buffer'
import {
  handleRunCompletion,
  handleRunError,
  prepareUserMessage as prepareUserMessageHelper,
  resetEarlyReturnState,
  setupStreamingContext,
} from './helpers/send-message'
import { NETWORK_ERROR_ID } from '../utils/validation-error-helpers'
import { yieldToEventLoop } from '../utils/yield-to-event-loop'

import type { ElapsedTimeTracker } from './use-elapsed-time'
import type { StreamStatus } from './use-message-queue'
import type { PendingAttachment } from '../types/store'
import type { ChatMessage } from '../types/chat'
import type { SendMessageFn } from '../types/contracts/send-message'
import type { AgentMode } from '../utils/constants'
import type { SendMessageTimerEvent } from '../utils/send-message-timer'
import { STATE_SNAPSHOT_INTERRUPTION_MESSAGE } from '@codebuff/sdk'

import type { AgentDefinition, MessageContent, RunState } from '@codebuff/sdk'
import { isCoveredBySubscription } from '../utils/subscription'

import type { SubscriptionResponse } from './use-subscription-query'

interface UseSendMessageOptions {
  inputRef: React.MutableRefObject<any>
  activeSubagentsRef: React.MutableRefObject<Set<string>>
  isChainInProgressRef: React.MutableRefObject<boolean>
  setStreamStatus: (status: StreamStatus) => void
  setCanProcessQueue: (can: boolean) => void
  agentId?: string
  onBeforeMessageSend: () => Promise<{
    success: boolean
    errors: Array<{ id: string; message: string }>
  }>
  mainAgentTimer: ElapsedTimeTracker
  scrollToLatest: () => void
  onTimerEvent?: (event: SendMessageTimerEvent) => void
  isQueuePausedRef?: React.MutableRefObject<boolean>
  isProcessingQueueRef?: React.MutableRefObject<boolean>
  resumeQueue?: () => void
  /** Put a message back at the head of the queue. Used by the freebuff
   *  run-start guard so a message that can't be sent (session fully over)
   *  is held for the next session instead of consumed. */
  requeueMessageAtFront?: (message: {
    content: string
    attachments: PendingAttachment[]
  }) => void
  /** Pause the queue. Used when requeueing an undelivered steering message
   *  after a user interrupt, so the held text doesn't auto-start a new turn
   *  the user just stopped. */
  pauseQueue?: () => void
  continueChat: boolean
  continueChatId?: string
  subscriptionData?: SubscriptionResponse | null
  /** Dependency injection seam for component-level run lifecycle tests. */
  getClient?: typeof getCodebuffClient
}

// Choose the agent definition by explicit selection or mode-based fallback.
const resolveAgent = (
  agentMode: AgentMode,
  agentId: string | undefined,
  agentDefinitions: AgentDefinition[],
): AgentDefinition | string => {
  const selectedAgentDefinition =
    agentId && agentDefinitions.length > 0
      ? agentDefinitions.find((definition) => definition.id === agentId)
      : undefined

  return selectedAgentDefinition ?? agentId ?? getAgentIdForMode(agentMode)
}

// Respect bash context, but avoid sending empty prompts when only images are attached.
const buildPromptWithContext = (
  promptWithBashContext: string,
  messageContent: MessageContent[] | undefined,
) => {
  const trimmedPrompt = promptWithBashContext.trim()
  if (trimmedPrompt.length > 0) {
    return promptWithBashContext
  }

  if (messageContent && messageContent.length > 0) {
    return 'See attached image(s)'
  }

  return ''
}

export const useSendMessage = ({
  inputRef,
  activeSubagentsRef,
  isChainInProgressRef,
  setStreamStatus,
  setCanProcessQueue,
  agentId,
  onBeforeMessageSend,
  mainAgentTimer,
  scrollToLatest,
  onTimerEvent = () => {},
  isQueuePausedRef,
  isProcessingQueueRef,
  resumeQueue,
  requeueMessageAtFront,
  pauseQueue,
  continueChat,
  continueChatId,
  subscriptionData,
  getClient = getCodebuffClient,
}: UseSendMessageOptions): {
  sendMessage: SendMessageFn
  clearMessages: () => void
} => {
  // Pull setters directly from store - these are stable references that don't need
  // to trigger re-renders, so using getState() outside of callbacks is intentional.
  const {
    setMessages,
    setFocusedAgentId,
    setInputFocused,
    setStreamingAgents,
    setActiveSubagents,
    setIsChainInProgress,
    setHasReceivedPlanResponse,
    setLastMessageMode,
    addSessionCredits,
    setRunState,
    setIsRetrying,
  } = useChatStore.getState()
  const previousRunStateRef = useRef<RunState | null>(
    useChatStore.getState().runState,
  )
  // Memoize stream controller to maintain referential stability across renders
  const streamRefsRef = useRef<ReturnType<
    typeof createStreamController
  > | null>(null)
  if (!streamRefsRef.current) {
    streamRefsRef.current = createStreamController()
  }
  const streamRefs = streamRefsRef.current

  useEffect(() => {
    if (continueChat && !previousRunStateRef.current) {
      const loadedState = loadMostRecentChatState(continueChatId ?? undefined)
      if (loadedState) {
        previousRunStateRef.current = loadedState.runState
        setRunState(loadedState.runState)
        const restoredMessages = sanitizeRestoredMessages(loadedState.messages)
        if (loadedState.runStateRestored) {
          setMessages(restoredMessages)
        } else {
          // The agent's context was lost (torn run-state.json, nothing
          // recoverable) while the transcript survived. Surface it: without
          // this the model just answers as if the earlier turns never
          // happened, which reads as the assistant being broken.
          setMessages([
            createErrorChatMessage(
              'The saved agent context could not be restored, so the assistant starts this chat without memory of earlier turns. The transcript below is intact.',
            ),
            ...restoredMessages,
          ])
        }
        if (loadedState.chatId) {
          setCurrentChatId(loadedState.chatId)
        }
      }
    }
  }, [continueChat, continueChatId, setMessages, setRunState])

  const updateChainInProgress = useCallback(
    (value: boolean) => {
      isChainInProgressRef.current = value
      setIsChainInProgress(value)
    },
    [setIsChainInProgress, isChainInProgressRef],
  )

  const updateActiveSubagents = useCallback(
    (mutate: (next: Set<string>) => void) => {
      setActiveSubagents((prev) => {
        const next = new Set(prev)
        mutate(next)
        activeSubagentsRef.current = next
        return next
      })
    },
    [setActiveSubagents, activeSubagentsRef],
  )

  const addActiveSubagent = useCallback(
    (subagentId: string) => {
      updateActiveSubagents((next) => next.add(subagentId))
    },
    [updateActiveSubagents],
  )

  const removeActiveSubagent = useCallback(
    (subagentId: string) => {
      updateActiveSubagents((next) => next.delete(subagentId))
    },
    [updateActiveSubagents],
  )

  function clearMessages() {
    previousRunStateRef.current = null
    setRunState(null)
  }

  const prepareUserMessage = useCallback(
    (params: {
      content: string
      agentMode: AgentMode
      postUserMessage?: (prev: ChatMessage[]) => ChatMessage[]
      attachments?: PendingAttachment[]
      signal?: AbortSignal
    }) => {
      // Access lastMessageMode fresh each call to get current value
      const { lastMessageMode } = useChatStore.getState()
      return prepareUserMessageHelper({
        ...params,
        deps: {
          setMessages,
          lastMessageMode,
          setLastMessageMode,
          scrollToLatest,
          setHasReceivedPlanResponse,
        },
      })
    },
    [
      setMessages,
      setLastMessageMode,
      scrollToLatest,
      setHasReceivedPlanResponse,
    ],
  )

  const sendMessage = useCallback<SendMessageFn>(
    async ({ content, agentMode, postUserMessage, attachments }) => {
      // CRITICAL: Set chain in progress immediately (synchronously) before any async work.
      // This ensures the router can detect that we're busy and queue subsequent messages.
      // Set the ref directly first to guarantee immediate visibility to other code paths,
      // then call updateChainInProgress to also update React state for re-renders.
      isChainInProgressRef.current = true
      updateChainInProgress(true)
      setCanProcessQueue(false)

      // Freebuff run-start guard: without a live session slot the server
      // rejects the request outright, consuming the message. Hold it at the
      // head of the queue instead; it resumes when the user rejoins from the
      // session-ended banner. Catches sends that bypass the queue's
      // sendBlocked hold (direct review-screen answers) and the dequeue race
      // where the slot expires between the queue's check and this call.
      if (IS_FREEBUFF && !getFreebuffInstanceId()) {
        markFreebuffSessionEnded()
        requeueMessageAtFront?.({ content, attachments: attachments ?? [] })
        resetEarlyReturnState({
          setCanProcessQueue,
          updateChainInProgress,
          isProcessingQueueRef,
          isQueuePausedRef,
        })
        return
      }

      if (agentMode !== 'PLAN') {
        setHasReceivedPlanResponse(false)
      }

      // Initialize timer for elapsed time tracking
      const timerController = createSendMessageTimerController({
        mainAgentTimer,
        onTimerEvent,
        agentId,
      })
      setIsRetrying(false)

      // Own cancellation before the first await. Previously an interrupt or
      // context switch during attachment processing, validation, or client
      // creation had no controller to stop.
      const runOwnerId = randomUUID()
      const abortController = new AbortController()
      const runChatDir = resolveCurrentChatDir()
      const runChatIsCurrent = () => resolveCurrentChatDir() === runChatDir
      let latestRunStateSnapshot: RunState = previousRunStateRef.current ?? {
        traceSessionId: randomUUID(),
        output: {
          type: 'error',
          message: STATE_SNAPSHOT_INTERRUPTION_MESSAGE,
        },
      }
      let streamingStarted = false

      setLiveChatStateProvider(runOwnerId, () => ({
        runState: latestRunStateSnapshot,
        messages: useChatStore.getState().messages,
      }))

      const releaseRunOwnership = () => {
        clearLiveChatStateProvider(runOwnerId)
        clearActiveRun(runOwnerId)
      }

      registerActiveRun(runOwnerId, (reason) => {
        if (abortController.signal.aborted) return

        // Once streaming starts, setupStreamingContext's abort listener owns
        // message/timer cleanup. Preflight cancellation still needs to drop
        // the shared busy UI state synchronously.
        abortController.abort(reason)
        if (!streamingStarted) {
          setIsRetrying(false)
          setStreamStatus('idle')
          setStreamingAgents(() => new Set())
          updateChainInProgress(false)
          if (isProcessingQueueRef) isProcessingQueueRef.current = false
        }

        // Capture the old chat's array now. Context-changing callers reset the
        // store immediately after stopActiveRun returns.
        scheduleCheckpointSave(
          latestRunStateSnapshot,
          useChatStore.getState().messages,
          runChatDir,
        )
      })

      const releaseIfStopped = (): boolean => {
        if (!abortController.signal.aborted) return false
        releaseRunOwnership()
        return true
      }

      const finishPreflight = () => {
        resetEarlyReturnState({
          setCanProcessQueue,
          updateChainInProgress,
          isProcessingQueueRef,
          isQueuePausedRef,
        })
        releaseRunOwnership()
      }

      // Prepare user message (bash context, images, text attachments, mode divider)
      let userMessageId: string
      let messageContent: MessageContent[] | undefined
      let bashContextForPrompt: string | undefined
      let finalContent: string

      try {
        const prepared = await prepareUserMessage({
          content,
          agentMode,
          postUserMessage,
          attachments,
          signal: abortController.signal,
        })
        userMessageId = prepared.userMessageId
        messageContent = prepared.messageContent
        bashContextForPrompt = prepared.bashContextForPrompt
        finalContent = prepared.finalContent
      } catch (error) {
        if (releaseIfStopped()) return
        logger.error(
          { error },
          '[send-message] prepareUserMessage failed with exception',
        )
        setMessages((prev) => [
          ...prev,
          createErrorChatMessage(
            '⚠️ Failed to prepare message. Please try again.',
          ),
        ])
        finishPreflight()
        return
      }

      if (releaseIfStopped()) return

      // Validate before sending (e.g., agent config checks)
      try {
        const validationResult = await onBeforeMessageSend()

        if (releaseIfStopped()) return

        if (!validationResult.success) {
          logger.warn(
            { errors: validationResult.errors },
            '[send-message] Validation failed',
          )
          const errorsToAttach =
            validationResult.errors.length === 0
              ? [
                  // Hide this for now, as validate endpoint may be flaky and we don't want to bother users.
                  // {
                  //   id: NETWORK_ERROR_ID,
                  //   message:
                  //     'Agent validation failed. This may be due to a network issue or temporary server problem. Please try again.',
                  // },
                ]
              : validationResult.errors

          setMessages((prev) =>
            prev.map((msg) => {
              if (msg.id !== userMessageId) {
                return msg
              }
              return {
                ...msg,
                validationErrors: errorsToAttach,
              }
            }),
          )
          finishPreflight()
          return
        }
      } catch (error) {
        if (releaseIfStopped()) return
        logger.error(
          { error },
          '[send-message] Validation before message send failed with exception',
        )

        setMessages((prev) => [
          ...prev,
          createErrorChatMessage(
            '⚠️ Agent validation failed unexpectedly. Please try again.',
          ),
        ])
        await yieldToEventLoop()
        if (releaseIfStopped()) return
        setTimeout(() => scrollToLatest(), 0)

        finishPreflight()
        return
      }

      // Reset UI focus state
      setFocusedAgentId(null)
      setInputFocused(true)
      inputRef.current?.focus()

      // Get SDK client
      let client: Awaited<ReturnType<typeof getCodebuffClient>>
      try {
        client = await getClient()
      } catch (error) {
        if (releaseIfStopped()) return
        logger.error(
          { error },
          '[send-message] Failed to create Codebuff client',
        )
        setMessages((prev) => [
          ...prev,
          createErrorChatMessage(
            '⚠️ Unable to create the client. Please check your authentication and try again.',
          ),
        ])
        finishPreflight()
        return
      }

      if (releaseIfStopped()) return

      if (!client) {
        logger.error(
          {},
          '[send-message] No Codebuff client available. Please ensure you are authenticated.',
        )
        // Show error to user instead of silently failing
        const brandName = IS_FREEBUFF ? 'Freebuff' : 'Codebuff'
        setMessages((prev) => [
          ...prev,
          createErrorChatMessage(
            `⚠️ Unable to connect to ${brandName}. Please check your authentication and try again.`,
          ),
        ])
        await yieldToEventLoop()
        if (releaseIfStopped()) return
        setTimeout(() => scrollToLatest(), 0)
        finishPreflight()
        return
      }

      // Create AI message shell and setup streaming context
      const aiMessageId = generateAiMessageId()
      const aiMessage = createAiMessageShell(aiMessageId)

      const { updater, hasReceivedContentRef } = setupStreamingContext({
        aiMessageId,
        timerController,
        setMessages,
        streamRefs,
        abortController,
        setStreamStatus,
        setCanProcessQueue,
        isQueuePausedRef,
        isProcessingQueueRef,
        updateChainInProgress,
        setIsRetrying,
        setStreamingAgents,
      })
      streamingStarted = true
      setStreamStatus('waiting')
      // Combine auto-collapse and AI message addition into single atomic update
      // to prevent flicker from intermediate render states
      setMessages((prev) => [
        ...autoCollapsePreviousMessages(prev, aiMessageId),
        aiMessage,
      ])
      // Note: updateChainInProgress(true) and setCanProcessQueue(false) are already
      // called at the start of sendMessage to ensure they happen synchronously
      // before any async work, so the router can correctly detect busy state.
      let actualCredits: number | undefined

      // Checkpoint the turn to disk immediately so that killing the process
      // (closed terminal, crash) can't lose the user's prompt, then keep the
      // checkpoint fresh from SDK run-state snapshots while the run streams.
      // The completion save below overwrites this with the final state.
      saveChatState(
        latestRunStateSnapshot,
        useChatStore.getState().messages,
        runChatDir,
      )

      // Execute SDK run with streaming handlers
      try {
        const agentDefinitions = loadAgentDefinitions()
        const resolvedAgent = resolveAgent(agentMode, agentId, agentDefinitions)

        const promptWithBashContext = bashContextForPrompt
          ? bashContextForPrompt + finalContent
          : finalContent
        const effectivePrompt = buildPromptWithContext(
          promptWithBashContext,
          messageContent,
        )

        const eventHandlerState = createEventHandlerState({
          isActive: () => !abortController.signal.aborted && runChatIsCurrent(),
          streamRefs,
          setStreamingAgents,
          setStreamStatus,
          aiMessageId,
          updater,
          hasReceivedContentRef,
          addActiveSubagent,
          removeActiveSubagent,
          agentMode,
          setHasReceivedPlanResponse,
          logger,
          setIsRetrying,
          onTotalCost: (cost: number) => {
            actualCredits = cost
            // Only add to session credits if not covered by subscription
            // (subscription credits are shown separately in the UI)
            if (!isCoveredBySubscription(subscriptionData)) {
              addSessionCredits(cost)
            }
          },
        })

        const freebuffInstanceId = getFreebuffInstanceId()
        // The user's `/reasoning` pick, when they made one. Read HERE rather
        // than captured earlier so a mid-session change lands on the very next
        // message without restarting the session. Null means "send nothing",
        // which is what makes the server fall back to the catalog default —
        // sending the default explicitly instead would make every turn look
        // like a deliberate user choice and would override an agent's own
        // declared reasoning (see applyFreebuffReasoningDefaults).
        const freebuffReasoningEffort = IS_FREEBUFF
          ? getSelectedFreebuffReasoningEffort()
          : null
        const runConfig = createRunConfig({
          logger,
          agent: resolvedAgent,
          prompt: effectivePrompt,
          content: messageContent,
          previousRunState: previousRunStateRef.current,
          agentDefinitions,
          eventHandlerState,
          signal: abortController.signal,
          costMode: AGENT_MODE_TO_COST_MODE[agentMode],
          extraCodebuffMetadata:
            IS_FREEBUFF && freebuffInstanceId
              ? {
                  freebuff_instance_id: freebuffInstanceId,
                  ...(freebuffReasoningEffort
                    ? { freebuff_reasoning_effort: freebuffReasoningEffort }
                    : {}),
                }
              : undefined,
          onStateSnapshot: (snapshot) => {
            latestRunStateSnapshot = snapshot
            // Don't persist once the run is aborted or the user has switched
            // chats: the store's messages then belong to a different
            // conversation, and checkpointing them into this run's directory
            // would overwrite that chat's transcript with foreign (possibly
            // empty) state — the chat would then be hidden from /history.
            if (abortController.signal.aborted || !runChatIsCurrent()) {
              return
            }
            previousRunStateRef.current = snapshot
            // Persist asynchronously and coalescing: the periodic snapshot
            // fires ~every 5s at step boundaries, and a synchronous save of the
            // (growing) transcript on the render/input thread is what stalls
            // long sessions. The authoritative synchronous saves below still
            // capture the final state.
            scheduleCheckpointSave(
              snapshot,
              useChatStore.getState().messages,
              runChatDir,
            )
          },
          // Mid-turn steering: the agent loop calls this at each step
          // boundary; texts pushed by the router since the last boundary are
          // injected into the running turn as user prompts. The transcript
          // bubble was already echoed at push time (router), so this only
          // hands over the texts. Returning [] on abort leaves the entries
          // in the buffer for the leftover handling below.
          drainSteeringMessages: () => {
            if (abortController.signal.aborted) return []
            return drainSteeringBuffer(runOwnerId).map((entry) => entry.text)
          },
        })

        // Log a summary only: the full run config contains the entire
        // conversation history and attachments, which bloats log.jsonl.
        logger.info(
          {
            runConfig: {
              agent:
                typeof resolvedAgent === 'string'
                  ? resolvedAgent
                  : resolvedAgent.id,
              promptLength: effectivePrompt.length,
              contentBlockCount: messageContent?.length ?? 0,
              previousMessageCount:
                previousRunStateRef.current?.sessionState?.mainAgentState
                  .messageHistory.length ?? 0,
              agentDefinitionCount: agentDefinitions.length,
              costMode: runConfig.costMode,
              maxAgentSteps: runConfig.maxAgentSteps,
            },
          },
          '[send-message] Sending message with sdk run config',
        )
        // Open the steering mailbox for this run only once we're committed to
        // calling run(); the router falls back to the queue before this point.
        activateSteering(runOwnerId)
        const runState = await client.run(runConfig)

        // Only adopt and persist the result while this run's chat is still
        // the active one. After a mid-run chat switch (/new, resuming from
        // /history) the store's messages and run state belong to the new
        // conversation: saving here would overwrite it with this run's
        // context, and previousRunStateRef/setRunState would leak this run's
        // agent state into the other chat. (A plain Esc interrupt keeps the
        // same chat, so the interrupted turn is still saved as before.)
        if (!abortController.signal.aborted && runChatIsCurrent()) {
          // Finalize: persist state and mark complete
          previousRunStateRef.current = runState
          setRunState(runState)
          setIsRetrying(false)

          // Drop any queued/in-flight async checkpoint first so a stale write
          // can't land after this authoritative final save.
          await settleCheckpointSave()
          // Read committed state rather than saving inside a setMessages
          // updater: the store uses immer, so the updater sees a draft proxy
          // and JSON.stringify of the (unbounded) transcript through proxy
          // traps is several times slower.
          saveChatState(runState, useChatStore.getState().messages, runChatDir)
        }
        handleRunCompletion({
          runState,
          actualCredits,
          agentMode,
          timerController,
          updater,
          aiMessageId,
          wasAbortedByUser: abortController.signal.aborted,
          hasReceivedContent: hasReceivedContentRef.current,
          setStreamStatus,
          setCanProcessQueue,
          updateChainInProgress,
          setHasReceivedPlanResponse,
          resumeQueue,
          isProcessingQueueRef,
          isQueuePausedRef,
        })
      } catch (error) {
        // If this run was aborted, the abort handler already handled cleanup.
        // Don't run error handling to avoid interfering with any new run that
        // may have started. Uses per-run abortController.signal (not shared
        // streamRefs) so a newer run's reset() can't clear this flag.
        if (!abortController.signal.aborted) {
          handleRunError({
            error,
            timerController,
            updater,
            setIsRetrying,
            setStreamStatus,
            setCanProcessQueue,
            updateChainInProgress,
            isProcessingQueueRef,
            isQueuePausedRef,
            hasReceivedContent: hasReceivedContentRef.current,
          })
          // Persist the last checkpoint plus the error banner so a restart
          // after a failed run still shows this turn. Settle async checkpoints
          // first so a stale write can't clobber this one. Skipped after a
          // mid-run chat switch — the store's messages belong to the new chat.
          if (runChatIsCurrent()) {
            await settleCheckpointSave()
            saveChatState(
              latestRunStateSnapshot,
              useChatStore.getState().messages,
              runChatDir,
            )
          }
        } else {
          logger.debug({ error }, '[send-message] Ignoring error after abort')
        }
      } finally {
        // Close the steering mailbox. Anything the run never drained was
        // submitted after its last step boundary; retract its push-time
        // bubble (the requeued send mints its own at dequeue) and requeue it
        // at the front so it isn't lost. On Esc the queue is paused first,
        // matching the 'pause-if-pending' interrupt policy that ran while
        // this text was still in the buffer — without the pause, the
        // unblocked queue would immediately auto-start a new turn the user
        // just tried to stop. Skipped after a mid-run chat switch (the
        // message belongs to the old chat, whose queue was already cleared
        // by the stop policy) and after non-user aborts like logout, where
        // resurrecting input is wrong.
        const steeringLeftovers = deactivateSteering(runOwnerId)
        if (
          steeringLeftovers.length > 0 &&
          runChatIsCurrent() &&
          (!abortController.signal.aborted ||
            abortController.signal.reason === 'user-interrupt')
        ) {
          const leftoverIds = new Set(
            steeringLeftovers.map((entry) => entry.messageId),
          )
          setMessages((prev) => prev.filter((msg) => !leftoverIds.has(msg.id)))
          if (abortController.signal.aborted) {
            pauseQueue?.()
          }
          for (const entry of steeringLeftovers.reverse()) {
            requeueMessageAtFront?.({
              content: entry.text,
              attachments: [],
            })
          }
        }
        // Stop exit-flushing this run's checkpoint; the final state (or last
        // checkpoint, on error) has been saved above. Owner-guarded so an
        // aborted run resolving late can't clear a newer run's provider.
        releaseRunOwnership()
        // If this run was aborted, the abort handler already released the chain lock
        // and queue processing state. Don't touch shared state here to avoid
        // interfering with any new run that may have started after the abort.
        // Uses per-run abortController.signal (not shared streamRefs) so a newer
        // run's reset() can't clear this flag.
        if (!abortController.signal.aborted) {
          if (isChainInProgressRef.current) {
            logger.warn(
              {},
              '[send-message] Chain still in progress after try/catch, forcing reset',
            )
            updateChainInProgress(false)
            setStreamStatus('idle')
            setCanProcessQueue(!isQueuePausedRef?.current)
          }
          // Safety net: ensure lock is always released even if handleRunCompletion/handleRunError
          // didn't run (e.g., due to unexpected early return). Redundant releases are safe (idempotent).
          if (isProcessingQueueRef) {
            isProcessingQueueRef.current = false
          }
        }
        updater.dispose()
      }
    },
    [
      addActiveSubagent,
      addSessionCredits,
      agentId,
      inputRef,
      isChainInProgressRef,
      isProcessingQueueRef,
      isQueuePausedRef,
      mainAgentTimer,
      onBeforeMessageSend,
      onTimerEvent,
      prepareUserMessage,
      removeActiveSubagent,
      requeueMessageAtFront,
      resumeQueue,
      pauseQueue,
      scrollToLatest,
      setCanProcessQueue,
      setFocusedAgentId,
      setHasReceivedPlanResponse,
      setInputFocused,
      setIsRetrying,
      setMessages,
      getClient,
      setRunState,
      setStreamStatus,
      setStreamingAgents,
      streamRefs,
      updateChainInProgress,
    ],
  )

  return {
    sendMessage,
    clearMessages,
  }
}
