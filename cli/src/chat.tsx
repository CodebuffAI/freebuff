import { AnalyticsEvent } from '@codebuff/common/constants/analytics-events'
import type { FeedbackCategory } from '@codebuff/common/constants/feedback'
import { setFreeModeCapacityDeferralListener } from '@codebuff/sdk'
import { safeOpen } from './utils/open-url'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useShallow } from 'zustand/react/shallow'

import { getAdsEnabled } from './commands/ads'
import { routeUserPrompt, addBashMessageToHistory } from './commands/router'
import { SingleAdBanner } from './components/ad-banner'
import { ChatInputBar } from './components/chat-input-bar'
import { ChatHeader } from './components/chat-header'
import { FreebuffActiveSessionSummary } from './components/freebuff-active-session-summary'
import { LoadPreviousButton } from './components/load-previous-button'
import { ReviewScreen } from './components/review-screen'
import { MessageWithAgents } from './components/message-with-agents'
import { areCreditsRestored } from './components/out-of-credits-banner'
import { PendingBashMessage } from './components/pending-bash-message'
import { SessionEndedBanner } from './components/session-ended-banner'
import { StatusBar } from './components/status-bar'
import {
  SuggestedPrompts,
  DEFAULT_SUGGESTED_PROMPTS,
  type SuggestedPromptSelection,
} from './components/suggested-prompts'
import { TopBanner } from './components/top-banner'
import { useChatRuntime } from './contexts/chat-runtime-context'
import { getSlashCommandsWithSkills } from './data/slash-commands'
import { useAskUserBridge } from './hooks/use-ask-user-bridge'
import { useChatInput } from './hooks/use-chat-input'
import {
  useChatKeyboard,
  type ChatKeyboardHandlers,
} from './hooks/use-chat-keyboard'
import { useChatMessages } from './hooks/use-chat-messages'
import { useChatState } from './hooks/use-chat-state'
import { useChatStreaming } from './hooks/use-chat-streaming'
import { useChatUI } from './hooks/use-chat-ui'
import { useClipboard } from './hooks/use-clipboard'
import { useEvent } from './hooks/use-event'
import { useGravityAd } from './hooks/use-gravity-ad'
import { useInputHistory } from './hooks/use-input-history'
import { usePublishMutation } from './hooks/use-publish-mutation'
import { useSuggestionEngine } from './hooks/use-suggestion-engine'
import { useUsageMonitor } from './hooks/use-usage-monitor'
import { WEBSITE_URL } from './login/constants'
import { getProjectRoot } from './project-files'
import { useChatHistoryStore } from './state/chat-history-store'
import { useChatStore } from './state/chat-store'
import { useUndoHistoryStore } from './state/undo-history-store'
import { useReviewStore } from './state/review-store'
import { useFeedbackStore } from './state/feedback-store'
import { useMessageBlockStore } from './state/message-block-store'
import { usePublishStore } from './state/publish-store'
import { reportActivity } from './utils/activity-tracker'
import { stopActiveRun } from './utils/active-run'
import { trackEvent } from './utils/analytics'
import { showClipboardMessage } from './utils/clipboard'
import { readClipboardImage } from './utils/clipboard-image'
import { returnToFreebuffLanding } from './hooks/use-freebuff-session'
import { END_SESSION_MESSAGE, IS_FREEBUFF } from './utils/constants'
import { getSystemMessage } from './utils/message-history'
import { getInputModeConfig } from './utils/input-modes'
import {
  hasSubmittedFirstPrompt,
  markFirstPromptSubmitted,
} from './utils/settings'

import {
  type ChatKeyboardState,
  createDefaultChatKeyboardState,
} from './utils/keyboard-actions'
import { loadLocalAgents } from './utils/local-agent-registry'
import { logger } from './utils/logger'
import {
  addClipboardPlaceholder,
  addPendingFileFromPath,
  addPendingImageFromFile,
  validateAndAddImage,
} from './utils/pending-attachments'
import { getLoadedSkills } from './utils/skill-registry'
import {
  getStatusIndicatorState,
  type AuthStatus,
} from './utils/status-indicator-state'
import { createPasteHandler } from './utils/strings'
import { setTerminalTitle } from './utils/terminal-title'
import { computeInputLayoutMetrics } from './utils/text-layout'

import type { CommandResult } from './commands/command-registry'
import type { MultilineInputHandle } from './components/multiline-input'
import type { MatchedSlashCommand } from './hooks/use-suggestion-engine'
import type { FreebuffSessionResponse } from './types/freebuff-session'
import type { User } from './utils/auth'
import type { AgentMode } from './utils/constants'
import type { FileTreeNode } from '@codebuff/common/util/file'
import type { BoxRenderable, ScrollBoxRenderable } from '@opentui/core'
import type { UseMutationResult } from '@tanstack/react-query'
import type { Dispatch, SetStateAction } from 'react'

export const Chat = ({
  consumeInitialPrompt,
  fileTree,
  inputRef,
  setIsAuthenticated,
  setUser,
  logoutMutation,
  authStatus,
  initialMode,
  gitRoot,
  onSwitchToGitRoot,
  freebuffSession,
}: {
  consumeInitialPrompt: () => string | null
  fileTree: FileTreeNode[]
  inputRef: React.MutableRefObject<MultilineInputHandle | null>
  setIsAuthenticated: Dispatch<SetStateAction<boolean | null>>
  setUser: Dispatch<SetStateAction<User | null>>
  logoutMutation: UseMutationResult<boolean, Error, void, unknown>
  authStatus: AuthStatus
  initialMode?: AgentMode
  gitRoot?: string | null
  onSwitchToGitRoot?: () => void
  freebuffSession: FreebuffSessionResponse | null
}) => {
  const [forceFileOnlyMentions, setForceFileOnlyMentions] = useState(false)
  const headerRef = useRef<BoxRenderable | null>(null)
  const [isHeaderVisible, setIsHeaderVisible] = useState(true)

  // First-time onboarding: show clickable starter prompts until the user
  // submits their first prompt ever (persisted in settings). Freebuff only.
  const [showSuggestedPrompts, setShowSuggestedPrompts] = useState(
    () => IS_FREEBUFF && !hasSubmittedFirstPrompt(),
  )

  // Subscribe to ask_user bridge to trigger form display
  useAskUserBridge()

  // Monitor usage data and auto-show banner when thresholds are crossed
  useUsageMonitor()

  // Get chat state from extracted hook
  const {
    inputValue,
    cursorPosition,
    lastEditDueToNav,
    setInputValue,
    inputFocused,
    setInputFocused,
    slashSelectedIndex,
    setSlashSelectedIndex,
    agentSelectedIndex,
    setAgentSelectedIndex,
    focusedAgentId,
    setFocusedAgentId,
    messages,
    setMessages,
    agentMode,
    setAgentMode,
    toggleAgentMode,
    isRetrying,
    isCapacityWait,
    pendingBashMessages,
  } = useChatState()

  const { statusMessage } = useClipboard()
  const {
    isChainInProgressRef,
    sendMessage,
    clearMessages,
    subscriptionData,
    registerScrollToLatest,
  } = useChatRuntime()
  const hasSubscription = subscriptionData?.hasSubscription ?? false

  const {
    ads,
    responseAds,
    requestResponseAds,
    recordClick,
    recordImpression,
  } = useGravityAd({
    enabled: IS_FREEBUFF || !hasSubscription,
    provider: 'gravity',
    inline: true,
    surface: 'cli_chat',
    // Lazily fill a four-ad pool, then repeat it for later transcript slots.
    inlinePlacementId: 'CLI-Chat-Inline',
    // Keep the rotating above-input slot separate for reporting continuity.
    slotPlacementId: 'Single-Ad-Unit-1',
  })
  const showInlineAds = IS_FREEBUFF || getAdsEnabled()

  // Stable identities so the message-block callbacks (set once) always call
  // the latest recorder from the hook.
  const handleAdClick = useEvent(recordClick)
  const handleAdImpression = useEvent(recordImpression)
  const handleResponseAdsNeeded = useEvent(requestResponseAds)

  // Set initial mode from CLI flag on mount
  useEffect(() => {
    if (initialMode) {
      setAgentMode(initialMode)
    }
  }, [initialMode, setAgentMode])

  // Use extracted chat messages hook for message tree and pagination
  const {
    messageTree,
    visibleTopLevelMessages,
    hiddenMessageCount,
    handleCollapseToggle,
    isUserCollapsing,
    handleLoadPreviousMessages,
    handleToggleAll,
  } = useChatMessages({ messages, setMessages })

  // Use extracted UI hook for scroll, terminal dimensions, and theme
  const {
    scrollRef,
    scrollToLatest,
    scrollUp,
    scrollDown,
    appliedScrollboxProps,
    isAtBottom,
    hasOverflow,
    terminalWidth,
    terminalHeight,
    separatorWidth,
    messageAvailableWidth,
    isCompactHeight,
    isNarrowWidth,
    theme,
    markdownPalette,
  } = useChatUI({ messages, isUserCollapsing })

  useEffect(
    () => registerScrollToLatest(scrollToLatest),
    [registerScrollToLatest, scrollToLatest],
  )

  const updateHeaderVisibility = useCallback(() => {
    const header = headerRef.current
    const viewport = scrollRef.current?.viewport
    if (!header || !viewport) return

    const headerTop = header.screenY
    const headerBottom = headerTop + header.height
    const viewportTop = viewport.screenY
    const viewportBottom = viewportTop + viewport.height
    const visible = headerTop < viewportBottom && headerBottom > viewportTop
    setIsHeaderVisible((current) => (current === visible ? current : visible))
  }, [scrollRef])

  useEffect(() => {
    const scrollbox = scrollRef.current
    if (!scrollbox) return

    const timeoutId = setTimeout(updateHeaderVisibility, 0)
    scrollbox.verticalScrollBar.on('change', updateHeaderVisibility)
    return () => {
      clearTimeout(timeoutId)
      scrollbox.verticalScrollBar.off('change', updateHeaderVisibility)
    }
  }, [scrollRef, updateHeaderVisibility])

  useEffect(() => {
    const timeoutId = setTimeout(updateHeaderVisibility, 0)
    return () => clearTimeout(timeoutId)
  }, [messages, terminalHeight, terminalWidth, updateHeaderVisibility])

  // Surface server capacity deferrals (free-mode tier shedding under peak
  // demand): the SDK's retry loop absorbs the 429s silently, so without this
  // the user just sees a longer unexplained "thinking". The stream-chunk
  // handlers clear the flag (via setIsRetrying(false)) as soon as real
  // output resumes.
  useEffect(() => {
    setFreeModeCapacityDeferralListener(() => {
      useChatStore.getState().noteCapacityDeferral()
    })
    return () => setFreeModeCapacityDeferralListener(null)
  }, [])

  const localAgents = useMemo(() => loadLocalAgents(agentMode), [agentMode])
  const inputMode = useChatStore((state) => state.inputMode)
  const setInputMode = useChatStore((state) => state.setInputMode)
  const askUserState = useChatStore((state) => state.askUserState)

  // Get loaded skills for slash commands
  const loadedSkills = useMemo(() => getLoadedSkills(), [])

  // Filter slash commands based on current ads state - only show the option that changes state
  // Hide both ads commands entirely for subscribers
  // Also merge in skill commands
  const filteredSlashCommands = useMemo(() => {
    const adsEnabled = getAdsEnabled()
    const allCommands = getSlashCommandsWithSkills(loadedSkills)
    return allCommands.filter((cmd) => {
      if (cmd.id === 'ads:enable') return !hasSubscription && !adsEnabled
      if (cmd.id === 'ads:disable') return !hasSubscription && adsEnabled
      return true
    })
  }, [inputValue, loadedSkills, hasSubscription]) // Re-evaluate when input changes (user may have just toggled)

  const {
    slashContext,
    mentionContext,
    slashMatches,
    agentMatches,
    fileMatches,
    slashSuggestionItems,
    agentSuggestionItems,
    fileSuggestionItems,
  } = useSuggestionEngine({
    disableAgentSuggestions: forceFileOnlyMentions || inputMode !== 'default',
    inputValue: inputMode === 'bash' ? '' : inputValue,
    cursorPosition,
    slashCommands: filteredSlashCommands,
    localAgents,
    fileTree,
    currentAgentMode: agentMode,
  })

  useEffect(() => {
    if (!mentionContext.active) {
      setForceFileOnlyMentions(false)
    }
  }, [mentionContext.active])

  // Track when slash menu is activated
  const prevSlashActiveRef = useRef(false)
  useEffect(() => {
    if (slashContext.active && !prevSlashActiveRef.current) {
      trackEvent(AnalyticsEvent.SLASH_MENU_ACTIVATED, {
        queryLength: slashContext.query.length,
        matchCount: slashMatches.length,
        inputLength: inputValue.length,
      })
    }
    prevSlashActiveRef.current = slashContext.active
  }, [
    slashContext.active,
    slashContext.query,
    slashMatches.length,
    inputValue.length,
  ])

  // Reset suggestion menu indexes when context changes
  useEffect(() => {
    if (!slashContext.active) {
      setSlashSelectedIndex(0)
      return
    }
    setSlashSelectedIndex(0)
  }, [slashContext.active, slashContext.query, setSlashSelectedIndex])

  useEffect(() => {
    if (slashMatches.length > 0 && slashSelectedIndex >= slashMatches.length) {
      setSlashSelectedIndex(slashMatches.length - 1)
    }
    if (slashMatches.length === 0 && slashSelectedIndex !== 0) {
      setSlashSelectedIndex(0)
    }
  }, [slashMatches.length, slashSelectedIndex, setSlashSelectedIndex])

  useEffect(() => {
    if (!mentionContext.active) {
      setAgentSelectedIndex(0)
      return
    }
    setAgentSelectedIndex(0)
  }, [mentionContext.active, mentionContext.query, setAgentSelectedIndex])

  useEffect(() => {
    const totalMatches = agentMatches.length + fileMatches.length
    if (totalMatches > 0 && agentSelectedIndex >= totalMatches) {
      setAgentSelectedIndex(totalMatches - 1)
    }
    if (totalMatches === 0 && agentSelectedIndex !== 0) {
      setAgentSelectedIndex(0)
    }
  }, [
    agentMatches.length,
    fileMatches.length,
    agentSelectedIndex,
    setAgentSelectedIndex,
  ])

  const openFileMenuWithTab = useCallback(() => {
    const safeCursor = Math.max(0, Math.min(cursorPosition, inputValue.length))

    let wordStart = safeCursor
    while (wordStart > 0 && !/\s/.test(inputValue[wordStart - 1])) {
      wordStart--
    }

    const before = inputValue.slice(0, wordStart)
    const wordAtCursor = inputValue.slice(wordStart, safeCursor)
    const after = inputValue.slice(safeCursor)
    const mentionWord = wordAtCursor.startsWith('@')
      ? wordAtCursor
      : `@${wordAtCursor}`

    const text = `${before}${mentionWord}${after}`
    const nextCursor = before.length + mentionWord.length

    setInputValue({
      text,
      cursorPosition: nextCursor,
      lastEditDueToNav: false,
    })
    setForceFileOnlyMentions(true)
  }, [cursorPosition, inputValue, setInputValue])

  const { saveToHistory, navigateUp, navigateDown, resetHistoryNavigation } =
    useInputHistory(inputValue, setInputValue, { inputMode, setInputMode })

  // Use extracted streaming hook for connection, timer, queue, and exit handling
  const {
    isConnected,
    showReconnectionMessage,
    timerStartTime,
    streamStatus,
    isWaitingForResponse,
    isStreaming,
    queuePaused,
    streamMessageIdRef,
    addToQueue,
    setCanProcessQueue,
    clearQueue,
    queuedCount,
    shouldShowQueuePreview,
    queuePreviewTitle,
    pausedQueueText,
    inputPlaceholder,
    handleCtrlC,
    ensureQueueActiveBeforeSubmit,
    nextCtrlCWillExit,
  } = useChatStreaming({
    inputValue,
    setInputValue,
    terminalWidth,
    separatorWidth,
  })

  // When streaming completes, flush any pending bash commands into history (ghost mode only)
  // Non-ghost mode commands are already in history and will be cleared when user sends next message
  useEffect(() => {
    if (
      !isStreaming &&
      !streamMessageIdRef.current &&
      !isChainInProgressRef.current &&
      pendingBashMessages.length > 0
    ) {
      // Only flush ghost mode commands (those not already added to history) to UI
      const ghostModeMessages = pendingBashMessages.filter(
        (msg) => !msg.isRunning && !msg.addedToHistory,
      )

      // Add ghost mode messages to UI history
      for (const msg of ghostModeMessages) {
        addBashMessageToHistory({
          command: msg.command,
          stdout: msg.stdout,
          stderr: msg.stderr ?? null,
          exitCode: msg.exitCode,
          cwd: msg.cwd || process.cwd(),
          setMessages,
        })
      }

      // Mark ghost mode messages as added to history (so they don't show as ghost UI)
      // but keep them in pendingBashMessages so they get sent to LLM with next user message
      if (ghostModeMessages.length > 0) {
        const ghostIds = new Set(ghostModeMessages.map((m) => m.id))
        useChatStore.setState((state) => ({
          pendingBashMessages: state.pendingBashMessages.map((m) =>
            ghostIds.has(m.id) ? { ...m, addedToHistory: true } : m,
          ),
        }))
      }
    }
  }, [isStreaming, pendingBashMessages, setMessages])

  const onSubmitPrompt = useEvent(
    async (
      content: string,
      mode: AgentMode,
      options?: { preserveInputValue?: boolean },
    ) => {
      ensureQueueActiveBeforeSubmit()

      const preserveInput = options?.preserveInputValue === true
      const previousInputValue = preserveInput
        ? (() => {
            const {
              inputValue: text,
              cursorPosition,
              lastEditDueToNav,
            } = useChatStore.getState()
            return { text, cursorPosition, lastEditDueToNav }
          })()
        : null

      // Preserve attachments if needed (inline logic to avoid abstraction overhead)
      const preservedAttachments = preserveInput
        ? (() => {
            const items = useChatStore.getState().pendingAttachments
            if (items.length > 0) {
              useChatStore.getState().clearPendingAttachments()
              return [...items]
            }
            return null
          })()
        : null

      try {
        const result = await routeUserPrompt({
          agentMode: mode,
          inputRef,
          inputValue: content,
          isChainInProgressRef,
          isStreaming,
          logoutMutation,
          streamMessageIdRef,
          addToQueue,
          clearMessages,
          saveToHistory,
          scrollToLatest,
          sendMessage,
          setCanProcessQueue,
          setInputFocused,
          setInputValue,
          setIsAuthenticated,
          setMessages,
          setUser,
        })

        return result
      } finally {
        if (previousInputValue) {
          setInputValue({
            text: previousInputValue.text,
            cursorPosition: previousInputValue.cursorPosition,
            lastEditDueToNav: previousInputValue.lastEditDueToNav,
          })
        }

        // Restore attachments if they were preserved and none have been added since
        if (
          preservedAttachments &&
          useChatStore.getState().pendingAttachments.length === 0
        ) {
          useChatStore.setState((state) => {
            state.pendingAttachments = preservedAttachments
          })
        }
      }
    },
  )

  // Retire onboarding suggested prompts once the user submits anything
  // (typed or clicked), persisting so they don't return on future launches.
  useEffect(() => {
    if (showSuggestedPrompts && messages.length > 0) {
      markFirstPromptSubmitted()
      setShowSuggestedPrompts(false)
    }
  }, [showSuggestedPrompts, messages.length])

  // Submit a suggested onboarding prompt as if the user had typed and sent it
  const handleSelectSuggestedPrompt = useEvent(
    (prompt: string, selection: SuggestedPromptSelection) => {
      trackEvent(AnalyticsEvent.SUGGESTED_PROMPT_CLICKED, {
        label: selection.label,
        index: selection.index,
        promptLength: prompt.length,
        agentMode,
      })
      onSubmitPrompt(prompt, agentMode).catch((error) => {
        logger.error({ error }, '[suggested-prompt] Failed to submit prompt')
        showClipboardMessage('Failed to send prompt', { durationMs: 3000 })
      })
    },
  )

  // Handle followup suggestion clicks
  useEffect(() => {
    const handleFollowupClick = (event: Event) => {
      const customEvent = event as CustomEvent<{
        prompt: string
        index: number
        toolCallId: string
      }>
      const { prompt, index, toolCallId } = customEvent.detail

      logger.info(
        { promptLength: prompt.length, index, toolCallId, agentMode },
        '[followup-click] Followup clicked',
      )

      // Track analytics event
      trackEvent(AnalyticsEvent.FOLLOWUP_CLICKED, {
        promptLength: prompt.length,
        index,
        agentMode,
      })

      // Mark this followup as clicked (persisted per toolCallId)
      useChatStore.getState().markFollowupClicked(toolCallId, index)

      // Send the followup prompt directly, preserving the user's current input
      onSubmitPrompt(prompt, agentMode, {
        preserveInputValue: true,
      })
        .then((result) => {
          logger.info(
            { hasResult: !!result },
            '[followup-click] onSubmitPrompt completed',
          )
        })
        .catch((error) => {
          logger.error(
            { error },
            '[followup-click] onSubmitPrompt failed with error',
          )
          showClipboardMessage('Failed to send followup', { durationMs: 3000 })
        })
    }

    globalThis.addEventListener('codebuff:send-followup', handleFollowupClick)
    return () => {
      globalThis.removeEventListener(
        'codebuff:send-followup',
        handleFollowupClick,
      )
    }
  }, [onSubmitPrompt, agentMode])

  // handleSlashItemClick is defined later after feedback/publish stores are available

  const handleMentionItemClick = useCallback(
    (index: number) => {
      if (mentionContext.startIndex < 0) return

      let replacement: string
      if (index < agentMatches.length) {
        const selected = agentMatches[index]
        if (!selected) return
        replacement = `@${selected.id} `
      } else {
        const fileIndex = index - agentMatches.length
        const selectedFile = fileMatches[fileIndex]
        if (!selectedFile) return
        replacement = `@${selectedFile.filePath} `
      }
      const before = inputValue.slice(0, mentionContext.startIndex)
      const after = inputValue.slice(
        mentionContext.startIndex + 1 + mentionContext.query.length,
      )
      setInputValue({
        text: before + replacement + after,
        cursorPosition: before.length + replacement.length,
        lastEditDueToNav: false,
      })
      setAgentSelectedIndex(0)
    },
    [
      mentionContext,
      agentMatches,
      fileMatches,
      inputValue,
      setInputValue,
      setAgentSelectedIndex,
    ],
  )

  const { inputWidth, handleBuildFast, handleBuildMax, handleBuildLite } =
    useChatInput({
      setInputValue,
      agentMode,
      setAgentMode,
      separatorWidth,
      consumeInitialPrompt,
      onSubmitPrompt,
      isCompactHeight,
      isNarrowWidth,
    })

  const {
    feedbackMode,
    feedbackText,
    openFeedbackForMessage,
    closeFeedback,
    saveCurrentInput,
    restoreSavedInput,
    setFeedbackText,
  } = useFeedbackStore(
    useShallow((state) => ({
      feedbackMode: state.feedbackMode,
      feedbackText: state.feedbackText,
      openFeedbackForMessage: state.openFeedbackForMessage,
      closeFeedback: state.closeFeedback,
      saveCurrentInput: state.saveCurrentInput,
      restoreSavedInput: state.restoreSavedInput,
      setFeedbackText: state.setFeedbackText,
    })),
  )

  const { publishMode, openPublishMode, closePublish, preSelectAgents } =
    usePublishStore(
      useShallow((state) => ({
        publishMode: state.publishMode,
        openPublishMode: state.openPublishMode,
        closePublish: state.closePublish,
        preSelectAgents: state.preSelectAgents,
      })),
    )

  const { reviewMode, closeReviewScreen } = useReviewStore(
    useShallow((state) => ({
      reviewMode: state.reviewMode,
      closeReviewScreen: state.closeReviewScreen,
    })),
  )

  const publishMutation = usePublishMutation()

  const handleCommandResult = useCallback(
    (result?: CommandResult) => {
      if (!result) return

      if (result.openFeedbackMode) {
        // Save the feedback text that was set by the command handler before opening feedback mode
        const { feedbackText, feedbackCursor } = useFeedbackStore.getState()
        saveCurrentInput('', 0)
        openFeedbackForMessage(null)
        // Restore the prefilled text after openFeedbackForMessage resets it
        if (feedbackText) {
          useFeedbackStore.getState().setFeedbackText(feedbackText)
          useFeedbackStore.getState().setFeedbackCursor(feedbackCursor)
        }
      }

      if (result.openPublishMode) {
        if (result.preSelectAgents && result.preSelectAgents.length > 0) {
          // preSelectAgents already sets publishMode: true, so don't call openPublishMode
          // which would reset the selectedAgentIds
          preSelectAgents(result.preSelectAgents)
        } else {
          openPublishMode()
        }
      }

      if (result.openChatHistory) {
        useChatHistoryStore.getState().openChatHistory()
      }

      if (result.openUndoHistory) {
        useUndoHistoryStore.getState().openUndoHistory()
      }

      if (result.openRedoHistory) {
        useUndoHistoryStore.getState().openRedoHistory()
      }

      if (result.openReviewScreen) {
        useReviewStore.getState().openReviewScreen()
      }
    },
    [
      saveCurrentInput,
      openFeedbackForMessage,
      openPublishMode,
      preSelectAgents,
    ],
  )

  // Helper to apply insertText for slash commands - returns true if handled
  const applySlashInsertText = useCallback(
    (selected: MatchedSlashCommand): boolean => {
      if (selected.insertText != null && slashContext.startIndex >= 0) {
        const before = inputValue.slice(0, slashContext.startIndex)
        const after = inputValue.slice(
          slashContext.startIndex + 1 + slashContext.query.length,
        )
        setInputValue({
          text: before + selected.insertText + after,
          cursorPosition: before.length + selected.insertText.length,
          lastEditDueToNav: false,
        })
        setSlashSelectedIndex(0)
        return true
      }
      return false
    },
    [slashContext, inputValue, setInputValue, setSlashSelectedIndex],
  )

  // Click handler for slash menu items - executes command or inserts text
  const handleSlashItemClick = useCallback(
    async (index: number) => {
      const selected = slashMatches[index]
      if (!selected) return

      // If the command has insertText, insert it instead of executing
      if (applySlashInsertText(selected)) return

      // Execute the selected slash command immediately
      const commandString = `/${selected.id}`
      setSlashSelectedIndex(0)

      const result = await onSubmitPrompt(commandString, agentMode)
      handleCommandResult(result)
    },
    [
      slashMatches,
      applySlashInsertText,
      setSlashSelectedIndex,
      onSubmitPrompt,
      agentMode,
      handleCommandResult,
    ],
  )

  const inputValueRef = useRef(inputValue)
  const cursorPositionRef = useRef(cursorPosition)
  useEffect(() => {
    inputValueRef.current = inputValue
  }, [inputValue])

  // Report activity on input changes for ad rotation (debounced via separate effect)
  const lastReportedActivityRef = useRef<number>(0)
  useEffect(() => {
    const now = Date.now()
    // Throttle to max once per second to avoid excessive calls
    if (now - lastReportedActivityRef.current > 1000) {
      lastReportedActivityRef.current = now
      reportActivity()
    }
  }, [inputValue])
  useEffect(() => {
    cursorPositionRef.current = cursorPosition
  }, [cursorPosition])

  const handleOpenFeedbackForMessage = useCallback(
    (
      id: string | null,
      options?: {
        category?: FeedbackCategory
        footerMessage?: string
        errors?: Array<{ id: string; message: string }>
      },
    ) => {
      saveCurrentInput(inputValueRef.current, cursorPositionRef.current)
      openFeedbackForMessage(id, options)
    },
    [saveCurrentInput, openFeedbackForMessage],
  )

  const handleMessageFeedback = useCallback(
    (
      id: string,
      options?: {
        category?: FeedbackCategory
        footerMessage?: string
        errors?: Array<{ id: string; message: string }>
      },
    ) => {
      handleOpenFeedbackForMessage(id, options)
    },
    [handleOpenFeedbackForMessage],
  )

  const handleExitFeedback = useCallback(() => {
    const { value, cursor } = restoreSavedInput()
    setInputValue({
      text: value,
      cursorPosition: cursor,
      lastEditDueToNav: false,
    })
    setInputFocused(true)
    resetHistoryNavigation()
  }, [
    restoreSavedInput,
    setInputValue,
    setInputFocused,
    resetHistoryNavigation,
  ])

  const handleCloseFeedback = useCallback(() => {
    closeFeedback()
    handleExitFeedback()
  }, [closeFeedback, handleExitFeedback])

  const handleExitPublish = useCallback(() => {
    closePublish()
    setInputFocused(true)
  }, [closePublish, setInputFocused])

  const handleReviewOptionSelect = useCallback(
    (reviewText: string) => {
      closeReviewScreen()
      setInputFocused(true)
      // Submit the review request
      onSubmitPrompt(reviewText, agentMode)
        .then((result) => handleCommandResult(result))
        .catch((error) => {
          logger.error({ error }, '[review] Failed to submit review prompt')
          showClipboardMessage('Failed to send review request', {
            durationMs: 3000,
          })
        })
    },
    [
      closeReviewScreen,
      setInputFocused,
      onSubmitPrompt,
      agentMode,
      handleCommandResult,
    ],
  )

  const handleCloseReviewScreen = useCallback(() => {
    closeReviewScreen()
    setInputFocused(true)
  }, [closeReviewScreen, setInputFocused])

  const handleReviewCustom = useCallback(() => {
    closeReviewScreen()
    setInputMode('review')
    setInputFocused(true)
  }, [closeReviewScreen, setInputMode, setInputFocused])

  const handlePublish = useCallback(
    async (agentIds: string[]) => {
      await publishMutation.mutateAsync(agentIds)
    },
    [publishMutation],
  )

  // Ensure bracketed paste events target the active chat input
  useEffect(() => {
    if (feedbackMode) {
      inputRef.current?.focus()
      return
    }
    if (!askUserState) {
      inputRef.current?.focus()
    }
  }, [feedbackMode, askUserState, inputRef])

  const handleSubmit = useCallback(async () => {
    // Report activity for ad rotation
    reportActivity()
    // Update terminal title with truncated user input
    if (inputValue.trim()) {
      setTerminalTitle(inputValue)
    }
    const result = await onSubmitPrompt(inputValue, agentMode)
    handleCommandResult(result)
  }, [onSubmitPrompt, inputValue, agentMode, handleCommandResult])

  const totalMentionMatches = agentMatches.length + fileMatches.length
  const historyNavUpEnabled =
    lastEditDueToNav ||
    (cursorPosition === 0 &&
      ((slashContext.active && slashSelectedIndex === 0) ||
        (mentionContext.active && agentSelectedIndex === 0) ||
        (!slashContext.active && !mentionContext.active)))
  const historyNavDownEnabled =
    lastEditDueToNav ||
    (cursorPosition === inputValue.length &&
      ((slashContext.active &&
        slashSelectedIndex === slashMatches.length - 1) ||
        (mentionContext.active &&
          agentSelectedIndex === totalMentionMatches - 1) ||
        (!slashContext.active && !mentionContext.active)))

  // Build keyboard state from store values
  const chatKeyboardState: ChatKeyboardState = useMemo(
    () => ({
      ...createDefaultChatKeyboardState(),
      inputMode,
      inputValue: feedbackMode ? feedbackText : inputValue,
      cursorPosition,
      isStreaming,
      isWaitingForResponse,
      feedbackMode,
      focusedAgentId,
      slashMenuActive: slashContext.active,
      mentionMenuActive: mentionContext.active,
      slashSelectedIndex,
      agentSelectedIndex,
      slashMatchesLength: slashMatches.length,
      totalMentionMatches: agentMatches.length + fileMatches.length,
      disableSlashSuggestions:
        getInputModeConfig(inputMode).disableSlashSuggestions,
      historyNavUpEnabled,
      historyNavDownEnabled,
      nextCtrlCWillExit,
      queuePaused,
      queuedCount,
    }),
    [
      inputMode,
      inputValue,
      feedbackText,
      cursorPosition,
      isStreaming,
      isWaitingForResponse,
      feedbackMode,
      focusedAgentId,
      slashContext.active,
      mentionContext.active,
      slashSelectedIndex,
      agentSelectedIndex,
      slashMatches.length,
      agentMatches.length,
      fileMatches.length,
      historyNavUpEnabled,
      historyNavDownEnabled,
      nextCtrlCWillExit,
      queuePaused,
      queuedCount,
    ],
  )

  // Keyboard handlers
  const chatKeyboardHandlers: ChatKeyboardHandlers = useMemo(
    () => ({
      onExitInputMode: () => setInputMode('default'),
      onExitFeedbackMode: handleCloseFeedback,
      onClearFeedbackInput: () => {
        setFeedbackText('')
        useFeedbackStore.getState().setFeedbackCursor(0)
      },
      onClearInput: () =>
        setInputValue({ text: '', cursorPosition: 0, lastEditDueToNav: false }),
      onBackspaceExitMode: () => setInputMode('default'),
      onInterruptStream: () => {
        stopActiveRun('user-interrupt')
      },
      onSlashMenuDown: () => setSlashSelectedIndex((prev) => prev + 1),
      onSlashMenuUp: () => setSlashSelectedIndex((prev) => prev - 1),
      onSlashMenuSelect: async () => {
        const selected = slashMatches[slashSelectedIndex] || slashMatches[0]
        if (!selected) return

        // If the command has insertText, insert it instead of executing
        if (applySlashInsertText(selected)) return

        // Execute the selected slash command immediately
        const commandString = `/${selected.id}`
        setSlashSelectedIndex(0)

        const result = await onSubmitPrompt(commandString, agentMode)

        handleCommandResult(result)
      },
      onSlashMenuComplete: () => {
        // Complete the word without executing - same as clicking on the item
        const selected = slashMatches[slashSelectedIndex] || slashMatches[0]
        if (!selected || slashContext.startIndex < 0) return

        // If the command has insertText, insert it instead of the command
        if (applySlashInsertText(selected)) return

        const before = inputValue.slice(0, slashContext.startIndex)
        const after = inputValue.slice(
          slashContext.startIndex + 1 + slashContext.query.length,
        )
        const replacement = `/${selected.id} `
        setInputValue({
          text: before + replacement + after,
          cursorPosition: before.length + replacement.length,
          lastEditDueToNav: false,
        })
        setSlashSelectedIndex(0)
      },
      onMentionMenuDown: () => setAgentSelectedIndex((prev) => prev + 1),
      onMentionMenuUp: () => setAgentSelectedIndex((prev) => prev - 1),
      onMentionMenuTab: () => {
        const totalMatches = agentMatches.length + fileMatches.length
        setAgentSelectedIndex((prev) => (prev + 1) % totalMatches)
      },
      onMentionMenuShiftTab: () => {
        const totalMatches = agentMatches.length + fileMatches.length
        setAgentSelectedIndex(
          (prev) => (totalMatches + prev - 1) % totalMatches,
        )
      },
      onMentionMenuSelect: () => {
        if (mentionContext.startIndex < 0) return

        const trySelectAtIndex = (index: number): boolean => {
          let replacement: string
          if (index < agentMatches.length) {
            const selected = agentMatches[index]
            if (!selected) return false
            replacement = `@${selected.id} `
          } else {
            const fileIndex = index - agentMatches.length
            const selectedFile = fileMatches[fileIndex]
            if (!selectedFile) return false
            replacement = `@${selectedFile.filePath} `
          }
          const before = inputValue.slice(0, mentionContext.startIndex)
          const after = inputValue.slice(
            mentionContext.startIndex + 1 + mentionContext.query.length,
          )
          setInputValue({
            text: before + replacement + after,
            cursorPosition: before.length + replacement.length,
            lastEditDueToNav: false,
          })
          setAgentSelectedIndex(0)
          return true
        }

        // Try current selection, fall back to first item
        trySelectAtIndex(agentSelectedIndex) || trySelectAtIndex(0)
      },
      onMentionMenuComplete: () => {
        // Complete the word without executing - same as select for mentions
        if (mentionContext.startIndex < 0) return

        let replacement: string
        const index = agentSelectedIndex
        if (index < agentMatches.length) {
          const selected =
            agentMatches.length > 0
              ? agentMatches[index] || agentMatches[0]
              : undefined
          if (!selected) return
          replacement = `@${selected.id} `
        } else {
          const fileIndex = index - agentMatches.length
          const selectedFile =
            fileMatches.length > 0
              ? fileMatches[fileIndex] || fileMatches[0]
              : undefined
          if (!selectedFile) return
          replacement = `@${selectedFile.filePath} `
        }
        const before = inputValue.slice(0, mentionContext.startIndex)
        const after = inputValue.slice(
          mentionContext.startIndex + 1 + mentionContext.query.length,
        )
        setInputValue({
          text: before + replacement + after,
          cursorPosition: before.length + replacement.length,
          lastEditDueToNav: false,
        })
        setAgentSelectedIndex(0)
      },
      onOpenFileMenuWithTab: () => {
        const safeCursor = Math.max(
          0,
          Math.min(cursorPosition, inputValue.length),
        )
        let wordStart = safeCursor
        while (wordStart > 0 && !/\s/.test(inputValue[wordStart - 1]!)) {
          wordStart--
        }
        if (wordStart < safeCursor) {
          openFileMenuWithTab()
          return true
        }
        return false
      },
      onHistoryUp: navigateUp,
      onHistoryDown: navigateDown,
      onToggleAgentMode: toggleAgentMode,
      onUnfocusAgent: () => {
        setFocusedAgentId(null)
        setInputFocused(true)
        inputRef.current?.focus()
      },
      onClearQueue: clearQueue,
      onExitAppWarning: () => handleCtrlC(),
      onExitApp: () => handleCtrlC(),
      onBashHistoryUp: navigateUp,
      onBashHistoryDown: navigateDown,
      onPasteImage: () => {
        const placeholderPath = addClipboardPlaceholder()

        // Process the image in the background
        setTimeout(() => {
          const result = readClipboardImage()
          if (!result.success || !result.imagePath) {
            useChatStore.getState().removePendingImage(placeholderPath)
            showClipboardMessage(result.error || 'Failed to paste image', {
              durationMs: 3000,
            })
            return
          }

          const cwd = getProjectRoot() ?? process.cwd()
          addPendingImageFromFile(result.imagePath, cwd, placeholderPath).catch(
            (error) => {
              logger.error({ error }, 'Failed to add pending image from file')
              showClipboardMessage('Failed to add image', { durationMs: 3000 })
            },
          )
        }, 0)
      },
      onPasteImagePath: (imagePath: string) => {
        const cwd = getProjectRoot() ?? process.cwd()
        validateAndAddImage(imagePath, cwd).catch((error) => {
          logger.error({ error, imagePath }, 'Failed to validate and add image')
          showClipboardMessage('Failed to add image', { durationMs: 3000 })
        })
      },
      onPasteFilePath: (filePath: string, isDirectory: boolean) => {
        addPendingFileFromPath(filePath, isDirectory)
      },
      onPasteText: (text: string) => {
        setInputValue((prev) => {
          const before = prev.text.slice(0, prev.cursorPosition)
          const after = prev.text.slice(prev.cursorPosition)
          return {
            text: before + text + after,
            cursorPosition: before.length + text.length,
            lastEditDueToNav: false,
          }
        })
      },
      onScrollUp: scrollUp,
      onScrollDown: scrollDown,
      onToggleAll: handleToggleAll,
      onOpenBuyCredits: () => {
        // If credits have been restored, just return to default mode
        if (areCreditsRestored()) {
          setInputMode('default')
          return
        }
        // Otherwise open the buy credits page
        safeOpen(WEBSITE_URL + '/usage')
      },
    }),
    [
      setInputMode,
      handleCloseFeedback,
      setFeedbackText,
      setInputValue,
      setSlashSelectedIndex,
      slashMatches,
      slashSelectedIndex,
      slashContext,
      inputValue,
      applySlashInsertText,
      onSubmitPrompt,
      agentMode,
      handleCommandResult,
      setAgentSelectedIndex,
      agentMatches,
      fileMatches,
      agentSelectedIndex,
      mentionContext,
      cursorPosition,
      openFileMenuWithTab,
      navigateUp,
      navigateDown,
      toggleAgentMode,
      setFocusedAgentId,
      setInputFocused,
      inputRef,
      handleCtrlC,
      clearQueue,
      scrollUp,
      scrollDown,
      handleToggleAll,
    ],
  )

  // Use the chat keyboard hook
  useChatKeyboard({
    state: chatKeyboardState,
    handlers: chatKeyboardHandlers,
    disabled: askUserState !== null || reviewMode,
  })

  // Sync message block context to zustand store for child components
  const setMessageBlockContext = useMessageBlockStore(
    (state) => state.setContext,
  )
  const setMessageBlockCallbacks = useMessageBlockStore(
    (state) => state.setCallbacks,
  )

  // Update context when values change - useLayoutEffect ensures synchronous updates
  // to prevent message loss during rapid streaming (race condition fix)
  useLayoutEffect(() => {
    setMessageBlockContext({
      theme,
      markdownPalette,
      messageTree,
      isWaitingForResponse,
      timerStartTime,
      availableWidth: messageAvailableWidth,
      responseAds: showInlineAds ? responseAds : {},
    })
  }, [
    theme,
    markdownPalette,
    messageTree,
    isWaitingForResponse,
    timerStartTime,
    messageAvailableWidth,
    responseAds,
    showInlineAds,
    setMessageBlockContext,
  ])

  // Update callbacks once (they're stable)
  useEffect(() => {
    setMessageBlockCallbacks({
      onToggleCollapsed: handleCollapseToggle,
      onBuildFast: handleBuildFast,
      onBuildMax: handleBuildMax,
      onBuildLite: handleBuildLite,
      onFeedback: handleMessageFeedback,
      onCloseFeedback: handleCloseFeedback,
      onAdClick: handleAdClick,
      onAdImpression: handleAdImpression,
      onResponseAdsNeeded: handleResponseAdsNeeded,
    })
  }, [
    handleCollapseToggle,
    handleBuildFast,
    handleBuildMax,
    handleBuildLite,
    handleMessageFeedback,
    handleCloseFeedback,
    handleAdClick,
    handleAdImpression,
    handleResponseAdsNeeded,
    setMessageBlockCallbacks,
  ])

  const modeConfig = getInputModeConfig(inputMode)
  const hasSlashSuggestions =
    slashContext.active &&
    slashSuggestionItems.length > 0 &&
    !modeConfig.disableSlashSuggestions
  const hasMentionSuggestions =
    !slashContext.active &&
    mentionContext.active &&
    (agentSuggestionItems.length > 0 || fileSuggestionItems.length > 0)
  const hasSuggestionMenu = hasSlashSuggestions || hasMentionSuggestions

  // Show first-time onboarding starter prompts only on a pristine, idle,
  // empty-input default-mode chat — and never while a menu/overlay is up.
  const showOnboardingPrompts =
    showSuggestedPrompts &&
    messages.length === 0 &&
    inputValue.length === 0 &&
    inputMode === 'default' &&
    !hasSuggestionMenu &&
    !isStreaming &&
    !isWaitingForResponse &&
    !feedbackMode &&
    !publishMode &&
    !reviewMode &&
    askUserState === null

  // Fire a one-time impression so we can measure onboarding-prompt usage
  // (click-through = SUGGESTED_PROMPT_CLICKED / SUGGESTED_PROMPT_SHOWN).
  const suggestedPromptsShownRef = useRef(false)
  useEffect(() => {
    if (showOnboardingPrompts && !suggestedPromptsShownRef.current) {
      suggestedPromptsShownRef.current = true
      trackEvent(AnalyticsEvent.SUGGESTED_PROMPT_SHOWN, {
        count: isCompactHeight
          ? Math.min(2, DEFAULT_SUGGESTED_PROMPTS.length)
          : DEFAULT_SUGGESTED_PROMPTS.length,
        isCompactHeight,
      })
    }
  }, [showOnboardingPrompts, isCompactHeight])

  const inputLayoutMetrics = useMemo(() => {
    // In bash mode, layout is based on the actual input (no ! prefix needed)
    const text = inputValue ?? ''
    const layoutContent = text.length > 0 ? text : ' '
    const safeCursor = Math.max(
      0,
      Math.min(cursorPosition, layoutContent.length),
    )
    const cursorProbe =
      safeCursor >= layoutContent.length
        ? layoutContent
        : layoutContent.slice(0, safeCursor)
    const cols = Math.max(1, inputWidth)
    return computeInputLayoutMetrics({
      layoutContent,
      cursorProbe,
      cols,
      maxHeight: Math.floor(terminalHeight / 2),
    })
  }, [inputValue, cursorPosition, inputWidth, terminalHeight])
  const isMultilineInput = inputLayoutMetrics.heightLines > 1
  const shouldCenterInputVertically = !hasSuggestionMenu && !isMultilineInput
  const statusIndicatorState = getStatusIndicatorState({
    statusMessage,
    streamStatus,
    nextCtrlCWillExit,
    isConnected,
    authStatus,
    showReconnectionMessage,
    isRetrying,
    isCapacityWait,
    isAskUserActive: askUserState !== null,
  })
  const hasStatusIndicatorContent = statusIndicatorState.kind !== 'idle'

  // Auto-show subscription limit banner when rate limit becomes active
  const subscriptionLimitShownRef = useRef(false)
  const subscriptionRateLimit = subscriptionData?.hasSubscription
    ? subscriptionData.rateLimit
    : undefined
  const fallbackToALaCarte = subscriptionData?.fallbackToALaCarte ?? false
  useEffect(() => {
    const isLimited = subscriptionRateLimit?.limited === true
    if (isLimited && !subscriptionLimitShownRef.current) {
      subscriptionLimitShownRef.current = true
      // Skip showing the banner if user prefers to always fall back to a-la-carte
      if (!fallbackToALaCarte) {
        useChatStore.getState().setInputMode('subscriptionLimit')
      }
    } else if (!isLimited) {
      subscriptionLimitShownRef.current = false
      if (useChatStore.getState().inputMode === 'subscriptionLimit') {
        useChatStore.getState().setInputMode('default')
      }
    }
  }, [subscriptionRateLimit?.limited, fallbackToALaCarte])

  const inputBoxTitle = useMemo(() => {
    const segments: string[] = []

    if (queuePreviewTitle) {
      segments.push(queuePreviewTitle)
    } else if (pausedQueueText) {
      segments.push(`⏸ ${pausedQueueText}`)
    }

    if (segments.length === 0) {
      return undefined
    }

    return ` ${segments.join('   ')} `
  }, [queuePreviewTitle, pausedQueueText])

  const hasActiveFreebuffSession =
    IS_FREEBUFF && freebuffSession?.status === 'active'
  const isFreebuffSessionOver =
    IS_FREEBUFF && freebuffSession?.status === 'ended'
  const shouldShowStatusLine =
    !feedbackMode &&
    (hasStatusIndicatorContent ||
      shouldShowQueuePreview ||
      !isAtBottom ||
      hasActiveFreebuffSession)

  // Track mouse movement for ad activity (throttled)
  const lastMouseActivityRef = useRef<number>(0)
  const handleMouseActivity = useCallback(() => {
    const now = Date.now()
    // Throttle to max once per second
    if (now - lastMouseActivityRef.current > 1000) {
      lastMouseActivityRef.current = now
      reportActivity()
    }
  }, [])

  return (
    <box
      onMouseMove={handleMouseActivity}
      style={{
        flexDirection: 'column',
        gap: 0,
        flexGrow: 1,
      }}
    >
      <scrollbox
        ref={scrollRef as React.Ref<ScrollBoxRenderable>}
        stickyScroll
        stickyStart="bottom"
        scrollX={false}
        scrollbarOptions={{ visible: false }}
        verticalScrollbarOptions={{
          visible: !isStreaming && !isWaitingForResponse && hasOverflow,
          trackOptions: { width: 1 },
        }}
        {...appliedScrollboxProps}
        style={{
          flexGrow: 1,
          rootOptions: {
            flexGrow: 1,
            padding: 0,
            gap: 0,
            flexDirection: 'row',
            shouldFill: true,
            backgroundColor: 'transparent',
          },
          wrapperOptions: {
            flexGrow: 1,
            border: false,
            shouldFill: true,
            backgroundColor: 'transparent',
            flexDirection: 'column',
          },
          contentOptions: {
            flexDirection: 'column',
            gap: 0,
            shouldFill: true,
            justifyContent: 'flex-end',
            backgroundColor: 'transparent',
            paddingLeft: 1,
            paddingRight: 2,
          },
        }}
      >
        <TopBanner gitRoot={gitRoot} onSwitchToGitRoot={onSwitchToGitRoot} />

        <box
          ref={headerRef as React.Ref<BoxRenderable>}
          style={{ flexDirection: 'column' }}
        >
          <ChatHeader
            projectRoot={getProjectRoot()}
            animationEnabled={isHeaderVisible && inputFocused}
          />
        </box>
        {IS_FREEBUFF && (
          <FreebuffActiveSessionSummary session={freebuffSession} />
        )}
        {hiddenMessageCount > 0 && (
          <LoadPreviousButton
            hiddenCount={hiddenMessageCount}
            onLoadMore={handleLoadPreviousMessages}
          />
        )}
        {visibleTopLevelMessages.map((message, idx) => (
          <MessageWithAgents
            key={message.id}
            message={message}
            depth={0}
            isLastMessage={idx === visibleTopLevelMessages.length - 1}
            availableWidth={messageAvailableWidth}
          />
        ))}
        {/* Pending bash messages as ghost messages (only show those not already in history) */}
        {pendingBashMessages
          .filter((msg) => !msg.addedToHistory)
          .map((msg) => (
            <PendingBashMessage key={`pending-bash-${msg.id}`} message={msg} />
          ))}
      </scrollbox>

      <box
        style={{
          flexShrink: 0,
          backgroundColor: 'transparent',
        }}
      >
        {showOnboardingPrompts && !reviewMode && !isFreebuffSessionOver && (
          <SuggestedPrompts
            onSelect={handleSelectSuggestedPrompt}
            maxItems={isCompactHeight ? 2 : undefined}
          />
        )}

        {shouldShowStatusLine && (
          <StatusBar
            timerStartTime={timerStartTime}
            isAtBottom={isAtBottom}
            scrollToLatest={scrollToLatest}
            statusIndicatorState={statusIndicatorState}
            onStop={chatKeyboardHandlers.onInterruptStream}
            onEndSession={() => {
              setMessages((prev) => [
                ...prev,
                getSystemMessage(END_SESSION_MESSAGE),
              ])
              returnToFreebuffLanding({ resetChat: true }).catch(() => {})
            }}
            freebuffSession={freebuffSession}
          />
        )}

        {ads?.[0] && showInlineAds && (
          <SingleAdBanner
            ad={ads[0]}
            onClick={recordClick}
            onImpression={recordImpression}
          />
        )}

        {reviewMode ? (
          // Review and ask_user take precedence over the session-ended banner:
          // during the grace window the agent may still be asking to run tools
          // or asking the user a question, and those approvals/answers must be
          // reachable for the run to finish — otherwise the agent hangs
          // waiting for input that can never be given.
          <ReviewScreen
            onSelectOption={handleReviewOptionSelect}
            onCustom={handleReviewCustom}
            onCancel={handleCloseReviewScreen}
          />
        ) : isFreebuffSessionOver && !askUserState ? (
          <SessionEndedBanner
            isStreaming={isStreaming || isWaitingForResponse}
          />
        ) : (
          <>
            <ChatInputBar
              inputValue={inputValue}
              cursorPosition={cursorPosition}
              setInputValue={setInputValue}
              inputFocused={inputFocused}
              inputRef={inputRef}
              inputPlaceholder={inputPlaceholder}
              lastEditDueToNav={lastEditDueToNav}
              agentMode={agentMode}
              toggleAgentMode={toggleAgentMode}
              setAgentMode={setAgentMode}
              hasSlashSuggestions={hasSlashSuggestions}
              hasMentionSuggestions={hasMentionSuggestions}
              hasSuggestionMenu={hasSuggestionMenu}
              slashSuggestionItems={slashSuggestionItems}
              agentSuggestionItems={agentSuggestionItems}
              fileSuggestionItems={fileSuggestionItems}
              slashSelectedIndex={slashSelectedIndex}
              agentSelectedIndex={agentSelectedIndex}
              onSlashItemClick={handleSlashItemClick}
              onMentionItemClick={handleMentionItemClick}
              theme={theme}
              terminalHeight={terminalHeight}
              separatorWidth={separatorWidth}
              shouldCenterInputVertically={shouldCenterInputVertically}
              inputBoxTitle={inputBoxTitle}
              isCompactHeight={isCompactHeight}
              isNarrowWidth={isNarrowWidth}
              feedbackMode={feedbackMode}
              handleExitFeedback={handleExitFeedback}
              publishMode={publishMode}
              handleExitPublish={handleExitPublish}
              handlePublish={handlePublish}
              handleSubmit={handleSubmit}
              onPaste={createPasteHandler({
                text: inputValue,
                cursorPosition,
                onChange: setInputValue,
                onPasteImage: chatKeyboardHandlers.onPasteImage,
                onPasteImagePath: chatKeyboardHandlers.onPasteImagePath,
                onPasteFilePath: chatKeyboardHandlers.onPasteFilePath,
                onPasteLongText: (pastedText) => {
                  const id = crypto.randomUUID()
                  const preview = pastedText.slice(0, 100).replace(/\n/g, ' ')
                  useChatStore.getState().addPendingTextAttachment({
                    id,
                    content: pastedText,
                    preview,
                    charCount: pastedText.length,
                  })
                  // Show temporary status message
                  showClipboardMessage(
                    `📋 Pasted text (${pastedText.length.toLocaleString()} chars)`,
                    { durationMs: 5000 },
                  )
                },
                cwd: getProjectRoot() ?? process.cwd(),
              })}
              onInterruptStream={chatKeyboardHandlers.onInterruptStream}
            />
          </>
        )}
      </box>
    </box>
  )
}
