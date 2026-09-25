import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
} from 'react'

import { useAgentValidation } from '../hooks/use-agent-validation'
import { useElapsedTime } from '../hooks/use-elapsed-time'
import { holdsLiveFreebuffSlot } from '../utils/freebuff-session-api'
import {
  useMessageQueue,
  type QueuedMessage,
  type StreamStatus,
} from '../hooks/use-message-queue'
import { useSendMessage } from '../hooks/use-send-message'
import {
  useSubscriptionQuery,
  type SubscriptionResponse,
} from '../hooks/use-subscription-query'
import { useChatStore } from '../state/chat-store'
import { useFreebuffSessionStore } from '../state/freebuff-session-store'
import {
  sponsoredTurnHoldsQueue,
  useSponsoredRunStore,
} from '../state/sponsored-run-store'
import { useByokSelectionStore } from '../utils/byok'
import { IS_FREEBUFF } from '../utils/constants'
import { logger } from '../utils/logger'
import { getSystemMessage } from '../utils/message-history'
import { setPendingSponsoredBrief } from '../utils/sponsored-brief'
import {
  currentSponsoredRun,
  sponsoredVerdictNotice,
} from '../utils/sponsored-run'
import {
  applyActiveRunQueuePolicy,
  registerActiveRunStopHandler,
  type ActiveRunQueueControls,
} from '../utils/active-run'

import type { MultilineInputHandle } from '../components/multiline-input'
import type { ElapsedTimeTracker } from '../hooks/use-elapsed-time'
import type { SendMessageFn } from '../types/contracts/send-message'
import type { PendingAttachment } from '../types/store'
import type { MutableRefObject, ReactNode } from 'react'

export interface ChatRuntime {
  mainAgentTimer: ElapsedTimeTracker
  timerStartTime: number | null
  streamStatus: StreamStatus
  isWaitingForResponse: boolean
  isStreaming: boolean
  setStreamStatus: (status: StreamStatus) => void
  queuedMessages: QueuedMessage[]
  queuePaused: boolean
  streamMessageIdRef: MutableRefObject<string | null>
  addToQueue: (message: string, attachments?: PendingAttachment[]) => void
  addToQueueFront: (message: Omit<QueuedMessage, 'id'>) => void
  editQueuedMessage: (id: string, content: string) => boolean
  removeQueuedMessage: (id: string) => boolean
  moveQueuedMessage: (id: string, toIndex: number) => boolean
  setCanProcessQueue: (value: boolean | ((prev: boolean) => boolean)) => void
  resumeQueue: () => void
  clearQueue: () => QueuedMessage[]
  isQueuePausedRef: MutableRefObject<boolean>
  isProcessingQueueRef: MutableRefObject<boolean>
  activeAgentStreamsRef: MutableRefObject<number>
  isChainInProgressRef: MutableRefObject<boolean>
  activeSubagentsRef: MutableRefObject<Set<string>>
  registerScrollToLatest: (callback: () => void) => () => void
  sendMessage: SendMessageFn
  clearMessages: () => void
  subscriptionData: SubscriptionResponse | null | undefined
}

const ChatRuntimeContext = createContext<ChatRuntime | null>(null)

/**
 * Owns everything tied to the active chat run. It remains mounted while
 * history and Freebuff session-gate views replace the Chat surface.
 */
export const ChatRuntimeProvider = ({
  agentId,
  inputRef,
  continueChat,
  continueChatId,
  children,
}: {
  agentId?: string
  inputRef: MutableRefObject<MultilineInputHandle | null>
  continueChat: boolean
  continueChatId?: string
  children: ReactNode
}) => {
  const agentMode = useChatStore((state) => state.agentMode)
  const askUserState = useChatStore((state) => state.askUserState)
  const isChainInProgress = useChatStore((state) => state.isChainInProgress)
  const activeSubagents = useChatStore((state) => state.activeSubagents)

  const activeAgentStreamsRef = useRef(0)
  const isChainInProgressRef = useRef(isChainInProgress)
  const activeSubagentsRef = useRef(activeSubagents)
  const sendMessageRef = useRef<SendMessageFn | undefined>(undefined)
  const scrollToLatestRef = useRef<() => void>(() => {})

  useEffect(() => {
    isChainInProgressRef.current = isChainInProgress
  }, [isChainInProgress])

  useEffect(() => {
    activeSubagentsRef.current = activeSubagents
  }, [activeSubagents])

  const mainAgentTimer = useElapsedTime()

  useEffect(() => {
    if (askUserState !== null) {
      mainAgentTimer.pause()
    } else if (mainAgentTimer.isPaused) {
      mainAgentTimer.resume()
    }
  }, [askUserState, mainAgentTimer])

  const freebuffSession = useFreebuffSessionStore((state) => state.session)
  const hasSelectedByokConnection = useByokSelectionStore(
    (state) => state.selected !== undefined,
  )
  const freebuffSessionOver =
    IS_FREEBUFF &&
    !hasSelectedByokConnection &&
    !holdsLiveFreebuffSlot(freebuffSession)
  // An accepted sponsored task runs NEXT, ahead of anything the user queued
  // after approving it, and nothing they type steers it: it has no steering
  // mailbox, so their messages land in this queue and wait for its verdict.
  const sponsoredSnapshot = useSponsoredRunStore((state) => state.snapshot)
  const sponsoredHold = sponsoredTurnHoldsQueue(sponsoredSnapshot)
  const sendBlocked = freebuffSessionOver || sponsoredHold

  useEffect(() => {
    if (freebuffSessionOver) {
      logger.info(
        {},
        '[chat-runtime] Freebuff session over; holding queued messages until rejoin',
      )
    }
  }, [freebuffSessionOver])

  const queue = useMessageQueue(
    (message) =>
      sendMessageRef.current?.({
        content: message.content,
        agentMode,
        attachments: message.attachments,
      }) ?? Promise.resolve(),
    isChainInProgressRef,
    activeAgentStreamsRef,
    { sendBlocked },
  )

  // The module-level stop entry point keeps this callback for the runtime's
  // lifetime. Read controls through a ref so cancellation always uses the
  // latest queue rather than the render that installed the handler.
  const queueControls: ActiveRunQueueControls = {
    pauseQueueIfPending: queue.pauseQueueIfPending,
    discardQueue: queue.discardQueue,
    setCanProcessQueue: queue.setCanProcessQueue,
  }
  const queueControlRef = useRef(queueControls)
  queueControlRef.current = queueControls

  useLayoutEffect(
    () =>
      registerActiveRunStopHandler((reason) => {
        applyActiveRunQueuePolicy(reason, queueControlRef.current)
      }),
    [],
  )

  const scrollToLatest = useCallback(() => {
    scrollToLatestRef.current()
  }, [])

  const registerScrollToLatest = useCallback((callback: () => void) => {
    scrollToLatestRef.current = callback
    return () => {
      if (scrollToLatestRef.current === callback) {
        scrollToLatestRef.current = () => {}
      }
    }
  }, [])

  const { validate: validateAgents } = useAgentValidation()
  const { data: subscriptionData } = useSubscriptionQuery({
    refetchInterval: 60 * 1000,
  })
  const { sendMessage, clearMessages } = useSendMessage({
    inputRef,
    activeSubagentsRef,
    isChainInProgressRef,
    setStreamStatus: queue.setStreamStatus,
    setCanProcessQueue: queue.setCanProcessQueue,
    agentId,
    onBeforeMessageSend: validateAgents,
    mainAgentTimer,
    scrollToLatest,
    onTimerEvent: () => {},
    isQueuePausedRef: queue.isQueuePausedRef,
    isProcessingQueueRef: queue.isProcessingQueueRef,
    resumeQueue: queue.resumeQueue,
    requeueMessageAtFront: queue.addToQueueFront,
    pauseQueue: queue.pauseQueue,
    continueChat,
    continueChatId,
    subscriptionData,
  })

  sendMessageRef.current = sendMessage

  // START THE ACCEPTED SPONSORED TURN once the conversation is free. It is a
  // turn IN this conversation (#3989): it streams into the transcript through
  // the ordinary send path, which is what holds the chain -- and so the queue
  // -- until it has a verdict. `starting` guards the await between reading the
  // plan and the send taking the chain, which a re-render could otherwise
  // enter twice.
  const sponsoredStarting = useRef(false)
  useEffect(() => {
    if (sponsoredSnapshot?.phase !== 'queued') return
    if (isChainInProgress || queue.streamStatus !== 'idle') return
    if (sponsoredStarting.current) return
    const run = currentSponsoredRun()
    if (!run) return
    sponsoredStarting.current = true
    void (async () => {
      try {
        const plan = await run.startTurn()
        if (!plan) return
        await sendMessageRef.current?.({
          content: '',
          agentMode,
          sponsored: {
            plan,
            anchor: getSystemMessage(
              `SPONSORED · ${plan.advertiserName} is working in this folder. Messages you send now will wait until it finishes.`,
            ),
            onSettled: (result) => {
              void run.settleTurn(result).then((brief) => {
                setPendingSponsoredBrief(brief)
                const snapshot = run.state
                useChatStore
                  .getState()
                  .setMessages((prev) => [
                    ...prev,
                    getSystemMessage(sponsoredVerdictNotice(snapshot)),
                  ])
              })
            },
          },
        })
      } finally {
        sponsoredStarting.current = false
      }
    })()
  }, [sponsoredSnapshot, isChainInProgress, queue.streamStatus, agentMode])

  const value: ChatRuntime = {
    mainAgentTimer,
    timerStartTime: mainAgentTimer.startTime,
    streamStatus: queue.streamStatus,
    isWaitingForResponse: queue.streamStatus === 'waiting',
    isStreaming: queue.streamStatus !== 'idle',
    setStreamStatus: queue.setStreamStatus,
    queuedMessages: queue.queuedMessages,
    queuePaused: queue.queuePaused,
    streamMessageIdRef: queue.streamMessageIdRef,
    addToQueue: queue.addToQueue,
    addToQueueFront: queue.addToQueueFront,
    editQueuedMessage: queue.editQueuedMessage,
    removeQueuedMessage: queue.removeQueuedMessage,
    moveQueuedMessage: queue.moveQueuedMessage,
    setCanProcessQueue: queue.setCanProcessQueue,
    resumeQueue: queue.resumeQueue,
    clearQueue: queue.clearQueue,
    isQueuePausedRef: queue.isQueuePausedRef,
    isProcessingQueueRef: queue.isProcessingQueueRef,
    activeAgentStreamsRef,
    isChainInProgressRef,
    activeSubagentsRef,
    registerScrollToLatest,
    sendMessage,
    clearMessages,
    subscriptionData,
  }

  return (
    <ChatRuntimeContext.Provider value={value}>
      {children}
    </ChatRuntimeContext.Provider>
  )
}

export const useChatRuntime = (): ChatRuntime => {
  const runtime = useContext(ChatRuntimeContext)
  if (!runtime) {
    throw new Error('useChatRuntime must be used inside ChatRuntimeProvider')
  }
  return runtime
}
