import { AnalyticsEvent } from '@codebuff/common/constants/analytics-events'
import type { FeedbackCategory } from '@codebuff/common/constants/feedback'
import { setFreeModeCapacityDeferralListener } from '@codebuff/sdk'
import { safeOpen } from './utils/open-url'
import { getAuthToken } from './utils/auth'
import { isSponsoredProposalBlock } from './types/chat'
import { runSponsoredProposalControl } from './utils/sponsored-proposal-control'
import {
  replaySponsoredTerminalReports,
  sponsoredRunFor,
  sponsoredTaskEvidence,
} from './utils/sponsored-run'
import type { SponsoredRun } from './utils/sponsored-run'
import {
  refreshSponsoredProposalNow,
  useSponsoredProposal,
} from './hooks/use-sponsored-proposal'
import { askAgenticOffer } from './utils/sponsored-offer'
import { SponsoredProposalBlock } from './components/blocks/sponsored-proposal-block'
import { setPendingSponsoredBrief } from './utils/sponsored-brief'
import { useSponsoredRunStore } from './state/sponsored-run-store'
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
import { SingleAdBanner, dockPanelRowBudget } from './components/ad-banner'
import {
  DOCK_PANEL_MAX_WIDTH,
  getDockPanelLayout,
} from '@codebuff/common/ads/inline-ad-layout'
import { ChatInputBar } from './components/chat-input-bar'
import { ChatHeader } from './components/chat-header'
import { FreebuffActiveSessionSummary } from './components/freebuff-active-session-summary'
import { LoadPreviousButton } from './components/load-previous-button'
import { QueuePanel } from './components/queue-panel'
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
import { useByokSelectionStore } from './utils/byok'
import { DOCK_CHORD_HINT, useDockPanel } from './hooks/use-dock-panel'
import { useInputHistory } from './hooks/use-input-history'
import { usePublishMutation } from './hooks/use-publish-mutation'
import { useSuggestionEngine } from './hooks/use-suggestion-engine'
import { useUsageMonitor } from './hooks/use-usage-monitor'
import { WEBSITE_URL } from './login/constants'
import { getProjectRoot, tryGetProjectRoot } from './project-files'
import { useChatHistoryStore } from './state/chat-history-store'
import { useChatStore } from './state/chat-store'
import { useQueuePanelStore } from './state/queue-panel-store'
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
import type { SponsoredProposalContentBlock } from './types/chat'
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
    queuedMessages,
    editQueuedMessage,
    removeQueuedMessage,
    moveQueuedMessage,
  } = useChatRuntime()
  const hasSubscription = subscriptionData?.hasSubscription ?? false
  const hasSelectedByokConnection = useByokSelectionStore(
    (state) => state.selected !== undefined,
  )

  // THE PROPOSAL THAT HOLDS THE DOCK, if any: an unanswered offer, or the one
  // whose run is in flight or has just finished. It replaces the display ad
  // for as long as it holds the slot -- one slot, one ad -- and gives it back
  // once the user has moved on from a verdict (`dockReleased`).
  const sponsoredRunSnapshot = useSponsoredRunStore((state) => state.snapshot)
  const dockProposal = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      for (const block of messages[i]!.blocks ?? []) {
        if (!isSponsoredProposalBlock(block) || block.dockReleased) continue
        const runs =
          sponsoredRunSnapshot?.proposalId === block.proposal._id &&
          sponsoredRunSnapshot.phase !== 'idle'
        if (runs) return block
        if (!block.answered && block.proposal.state === 'offered') return block
      }
    }
    return null
  }, [messages, sponsoredRunSnapshot])

  const {
    ads,
    responseAds,
    requestResponseAds,
    recordClick,
    recordImpression,
  } = useGravityAd({
    enabled: !hasSelectedByokConnection && (IS_FREEBUFF || !hasSubscription),
    provider: 'gravity',
    inline: true,
    surface: 'cli_chat',
    // Lazily fill a four-ad pool, then repeat it for later transcript slots.
    inlinePlacementId: 'CLI-Chat-Inline',
    // Keep the rotating above-input slot separate for reporting continuity.
    slotPlacementId: 'Single-Ad-Unit-1',
    // The dock holds that slot while a proposal does: an ad fetched for it
    // then would be served and never rendered.
    slotPaused: dockProposal !== null,
  })
  const showInlineAds =
    !hasSelectedByokConnection && (IS_FREEBUFF || getAdsEnabled())

  // Stable identities so the message-block callbacks (set once) always call
  // the latest recorder from the hook.
  const handleAdClick = useEvent(recordClick)
  const handleAdImpression = useEvent(recordImpression)

  const handleResponseAdsNeeded = useEvent(requestResponseAds)

  // ------------------------------------------------- sponsored proposals

  /**
   * Patch the one sponsored-proposal block for a target, wherever it sits.
   *
   * BY TARGET rather than by message id: a repository has one live offer, and
   * if it were ever rendered twice, declining it in one place must not leave it
   * standing in the other.
   */
  // The transcript as of this render. A control has to find its own block
  // synchronously -- `busy` is what makes a double press inert, and reading it
  // out of a `setMessages` updater would be a check inside a state write.
  const messagesRef = useRef(messages)
  messagesRef.current = messages

  const patchProposalBlock = useEvent(
    (target: string, patch: Partial<SponsoredProposalContentBlock>) => {
      setMessages((prev) =>
        prev.map((message) =>
          message.blocks?.some(
            (block) =>
              isSponsoredProposalBlock(block) && block.target === target,
          )
            ? {
                ...message,
                blocks: message.blocks.map((block) =>
                  isSponsoredProposalBlock(block) && block.target === target
                    ? { ...block, ...patch }
                    : block,
                ),
              }
            : message,
        ),
      )
    },
  )

  const findProposalBlock = useEvent((target: string) => {
    for (const message of messagesRef.current) {
      for (const block of message.blocks ?? []) {
        if (isSponsoredProposalBlock(block) && block.target === target) {
          return block
        }
      }
    }
    return null
  })

  // Whether a card is currently holding the keyboard. Derived from the
  // transcript rather than kept as its own flag: the menu is a property of a
  // block, and a second source of truth would go stale the moment a block is
  // answered or replaced while its menu is open.
  //
  // AN OPEN CONSENT COUNTS TOO (COD-339), and it matters more than the menu
  // does: its Enter answers "run an advertiser's procedure on this machine",
  // and an Enter that also reached the composer would send a prompt at the same
  // time as it approved a run.
  const sponsoredProposalMenuOpen = useMemo(
    () =>
      messages.some((message) =>
        message.blocks?.some(
          (block) =>
            isSponsoredProposalBlock(block) &&
            (block.menuOpen === true || block.consent !== undefined) &&
            block.answered !== true,
        ),
      ),
    [messages],
  )

  const dockRun =
    dockProposal &&
    sponsoredRunSnapshot?.proposalId === dockProposal.proposal._id &&
    sponsoredRunSnapshot.phase !== 'idle'
      ? {
          phase: sponsoredRunSnapshot.phase,
          changedFiles: sponsoredRunSnapshot.changedFiles,
          undone: sponsoredRunSnapshot.undone,
        }
      : null

  const handleSponsoredProposalMenu = useEvent(
    (target: string, open: boolean) =>
      patchProposalBlock(target, { menuOpen: open }),
  )
  const handleSponsoredProposalDisclose = useEvent(
    (target: string, open: boolean) =>
      patchProposalBlock(target, { whyOpen: open }),
  )

  const handleSponsoredProposalControl = useEvent(
    (
      target: string,
      control: 'dismiss' | 'report' | 'never-advertiser' | 'opt-out',
    ) => {
      const block = findProposalBlock(target)
      const authToken = getAuthToken()
      // `busy` is checked before the await, not after: the impatient double
      // press is synchronous, and a guard on the far side of a promise arrives
      // too late to stop the second call.
      if (
        !block ||
        block.busy ||
        block.answered ||
        block.refreshUnavailable ||
        !authToken
      )
        return
      patchProposalBlock(target, { busy: true, menuOpen: false })
      const proposalId = block.proposal._id
      const advertiserId = block.proposal.advertiser_id
      void (async () => {
        let succeeded = false
        try {
          // The ordering rules -- preference before dismiss, and the
          // preference's RESULT deciding whether the dismiss happens at all --
          // live in `runSponsoredProposalControl` so they can be tested
          // without a network and without mounting chat.
          succeeded = await runSponsoredProposalControl(
            control,
            { proposalId, advertiserId },
            authToken,
          )
        } finally {
          // ANSWERED ONLY WHEN IT WAS. `answered` stands the card's controls
          // down permanently, so setting it in a `finally` marked a failed
          // control as an answer the user gave: the card stayed on screen
          // looking spent, with no way to retry and nothing saved.
          //
          // ANSWERED, not removed, when it did succeed. The card stays in the
          // transcript with its controls stood down, because a block that
          // vanishes reflows text the user is reading and leaves history
          // claiming the offer never happened.
          patchProposalBlock(
            target,
            succeeded ? { busy: false, answered: true } : { busy: false },
          )
          if (!succeeded) {
            // Said out loud, unlike the transport's own debug log. Everything
            // else in this channel is optional and stays quiet, but this is the
            // one moment the user made a request of us and the card must not
            // silently keep the answer.
            setMessages((prev) => [
              ...prev,
              getSystemMessage("Couldn't save that — try again"),
            ])
          }
        }
      })()
    },
  )

  /**
   * Accept, in two halves (COD-339, COD-336 item 4).
   *
   * The first half OPENS the consent and writes nothing upstream: it reads the
   * exact reviewed procedure through the preview route and mints the run id
   * the Accept will carry. A refusal is therefore free -- there is nothing to
   * undo.
   */
  const handleSponsoredProposalAccept = useEvent((target: string) => {
    const block = findProposalBlock(target)
    if (
      !block ||
      block.busy ||
      block.answered ||
      block.refreshUnavailable ||
      block.consent
    )
      return
    patchProposalBlock(target, { busy: true, menuOpen: false })
    void (async () => {
      // Anything that THROWS (the project folder gone, its identity
      // unreadable) must still hand the card back, or it stays busy with
      // both of its buttons dead until the CLI restarts.
      let consent: Awaited<ReturnType<SponsoredRun['consentFor']>>
      try {
        consent = await sponsoredRunFor(getProjectRoot()).consentFor(
          block.proposal,
          sponsoredTaskEvidence(messagesRef.current),
        )
      } catch (error) {
        logger.debug({ error }, '[sponsored-run] consent failed')
        consent = {
          ok: false,
          message: 'Could not review this sponsored task. Try again.',
        }
      }
      if (!consent.ok) {
        patchProposalBlock(target, { busy: false })
        setMessages((prev) => [...prev, getSystemMessage(consent.message)])
        return
      }
      patchProposalBlock(target, {
        busy: false,
        consent: {
          advertiserName: consent.consent.advertiserName,
          headline: consent.consent.headline,
          body: consent.consent.body,
          folder: consent.consent.folder,
          procedure: consent.consent.procedure,
          runId: consent.runId,
        },
        consentIndex: 0,
        procedureOpen: false,
      })
    })()
  })

  /**
   * The consent's answer.
   *
   * A REFUSAL CLOSES THE SCREEN AND DOES NOTHING ELSE. Not a dismiss, not a
   * decline recorded upstream -- the user said "not now" to running something,
   * which is not the same as saying they never want to see it, and conflating
   * the two would spend a control they did not press.
   */
  const handleSponsoredProposalConsent = useEvent(
    (target: string, approved: boolean) => {
      const block = findProposalBlock(target)
      const consent = block?.consent
      if (!block || !consent) return
      patchProposalBlock(target, { consent: undefined, consentIndex: 0 })
      if (!approved) return
      patchProposalBlock(target, { busy: true })
      void (async () => {
        // As at the consent: a throw must hand the card back, not leave it
        // busy with both answers dead.
        let outcome: Awaited<ReturnType<SponsoredRun['accept']>>
        try {
          outcome = await sponsoredRunFor(getProjectRoot()).accept(
            block.proposal,
            consent.runId,
            sponsoredTaskEvidence(messagesRef.current),
          )
        } catch (error) {
          logger.debug({ error }, '[sponsored-run] accept failed')
          outcome = {
            ok: false,
            message: 'Could not start this sponsored task. Try again.',
          }
        }
        // `runStarted` is what makes the poller watch: the row upstream still
        // reads `offered` until the first poll after the accept, and keying the
        // cadence on the state alone would slow it down at exactly the moment
        // watching starts to matter.
        patchProposalBlock(target, {
          busy: false,
          ...(outcome.ok ? { runStarted: true } : {}),
        })
        // THE TURN IS NOT STARTED HERE. The chat runtime starts it once the
        // conversation is free, and holds the user's queue behind it.
        if (outcome.ok) return
        setMessages((prev) => [
          ...prev,
          getSystemMessage(
            'message' in outcome
              ? outcome.message
              : 'The sponsored task was not started.',
          ),
        ])
        // The procedure changed after review: show the new one rather than
        // leaving a refusal on a card whose Accept would meet it again.
        if ('reviewAgain' in outcome && outcome.reviewAgain) {
          handleSponsoredProposalAccept(target)
        }
      })()
    },
  )

  const handleSponsoredProposalProcedure = useEvent(
    (target: string, open: boolean) =>
      patchProposalBlock(target, { procedureOpen: open }),
  )

  /**
   * Undo, from the dock or `/ads:undo`. The run service reads its receipts
   * from disk and restores what it can without clobbering later work; the
   * conversation's agent is told on its next turn that the files moved back.
   */
  const handleSponsoredProposalUndo = useEvent(() => {
    const outcome = sponsoredRunFor(getProjectRoot()).undo()
    if (outcome.brief) setPendingSponsoredBrief(outcome.brief)
    setMessages((prev) => [...prev, getSystemMessage(outcome.message)])
  })

  // ONE OFFER QUESTION PER USER TURN (#3989's flow). Keyed on the user's own
  // newest message, so it fires once when they send one and never for the
  // CLI's notices or a sponsored turn's rows. A proposal it mints is read at
  // once rather than a poll interval later.
  const newestUserMessageId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]!.variant === 'user') return messages[i]!.id
    }
    return null
  }, [messages])
  // A TURN IS A USER MESSAGE WRITTEN SINCE THIS CHAT MOUNTED. Everything else
  // in the transcript is history: a resume from /history or `--continue`
  // loads it all at once -- after this component mounted with an empty
  // transcript -- and must not ask for an offer on its own. A user message's
  // id is its creation time (`getUserMessage`), so that is the test, and each
  // message is asked about once.
  const chatMountedAt = useRef(Date.now())
  const askedForMessage = useRef<string | null>(null)
  useEffect(() => {
    if (!newestUserMessageId || newestUserMessageId === askedForMessage.current)
      return
    askedForMessage.current = newestUserMessageId
    const createdAt = Number(/^user-(\d+)$/.exec(newestUserMessageId)?.[1])
    if (!Number.isFinite(createdAt) || createdAt < chatMountedAt.current) return
    // The user has moved on from a finished sponsored run: its card gives the
    // dock back to display ads. It stays in history, and `/ads:undo` still
    // works from any later turn.
    const finished = useSponsoredRunStore.getState().snapshot
    if (
      finished?.proposalId &&
      (finished.phase === 'delivered' || finished.phase === 'failed')
    ) {
      for (const message of messagesRef.current) {
        for (const block of message.blocks ?? []) {
          if (
            isSponsoredProposalBlock(block) &&
            block.proposal._id === finished.proposalId &&
            !block.dockReleased
          ) {
            patchProposalBlock(block.target, { dockReleased: true })
          }
        }
      }
    }
    if (hasSelectedByokConnection || !getAdsEnabled()) return
    const projectRoot = tryGetProjectRoot()
    if (!projectRoot) return
    void askAgenticOffer({
      projectRoot,
      conversationId: useChatStore.getState().chatSessionId,
      messages: messagesRef.current,
    }).then((offered) => {
      if (offered) refreshSponsoredProposalNow()
    })
  }, [newestUserMessageId, hasSelectedByokConnection])

  // Mounted here rather than inside the card, because the card does not exist
  // until this hook puts it there (COD-339: nothing polled before it).
  useSponsoredProposal({ enabled: !hasSelectedByokConnection })

  // A terminal report an earlier process could not deliver is still owed:
  // until it lands the row sits on `running` and its compute grant stays live.
  // Replayed on every signed-in mount -- chat only mounts with a session, so
  // this covers both a launch and a sign-in -- rather than waiting for the
  // next Accept in this folder to construct the run. Keyed on the project root
  // too: switching to the git root re-renders chat without remounting it, and
  // the new folder's outbox is owed the same replay.
  const currentProjectRoot = tryGetProjectRoot()
  useEffect(() => {
    if (!currentProjectRoot) return
    if (hasSelectedByokConnection || !getAuthToken()) return
    try {
      replaySponsoredTerminalReports(currentProjectRoot)
    } catch (error) {
      logger.debug({ error }, '[sponsored-run] outbox replay failed')
    }
  }, [hasSelectedByokConnection, currentProjectRoot])

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

  // The sponsor dock's detail panel (COD-457). `enabled` is the surface gate,
  // not the experiment: the arm itself comes from the policy route, and every
  // failure there lands on control.
  //
  // `canExpand` is computed HERE rather than inside the hook because only this
  // component knows the terminal height. Passing it in is what stops a toggle
  // parking the dock in an open state that renders nothing on a short
  // terminal: below roughly 22 rows the budget leaves fewer rows than the
  // smallest panel needs, and accepting the toggle there hid the chord hint
  // and required Escape to clear a state the user could not see.
  const dockPanelFits = useMemo(() => {
    const ad = ads?.[0]
    if (!ad) return false
    return getDockPanelLayout(ad, {
      width: Math.min(DOCK_PANEL_MAX_WIDTH, terminalWidth - 2),
      availableRows: dockPanelRowBudget(terminalHeight),
    }).fits
  }, [ads, terminalWidth, terminalHeight])

  const dockPanel = useDockPanel({
    ad: ads?.[0],
    enabled: showInlineAds,
    canExpand: dockPanelFits,
  })

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
    inputBoxTitle,
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
          hasQueuedMessages: () => queuedCount > 0,
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

  const { queuePanelOpen, openQueuePanel, closeQueuePanel } =
    useQueuePanelStore(
      useShallow((state) => ({
        queuePanelOpen: state.queuePanelOpen,
        openQueuePanel: state.openQueuePanel,
        closeQueuePanel: state.closeQueuePanel,
      })),
    )

  // Review and ask_user take the composer's place too. Leaving the panel
  // flagged open behind them would keep chat's keyboard disabled with nothing
  // rendered to handle keys, so hand the surface back for real.
  useEffect(() => {
    if (queuePanelOpen && (reviewMode || askUserState !== null)) {
      closeQueuePanel()
    }
  }, [queuePanelOpen, reviewMode, askUserState, closeQueuePanel])

  // The panel store outlives this component and a Freebuff session can end on
  // its own, unmounting chat mid-edit. Without this, the next session would
  // open onto a panel for a queue that no longer exists.
  useEffect(() => () => useQueuePanelStore.getState().closeQueuePanel(), [])

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

      if (result.openReviewScreen) {
        useReviewStore.getState().openReviewScreen()
      }

      if (result.openQueuePanel) {
        // The panel closes itself once the queue drains, so opening an empty
        // one would just flash. Say so instead.
        if (queuedCount > 0) useQueuePanelStore.getState().openQueuePanel()
        else
          setMessages((prev) => [...prev, getSystemMessage('Nothing queued.')])
      }
    },
    [
      saveCurrentInput,
      openFeedbackForMessage,
      openPublishMode,
      preSelectAgents,
      queuedCount,
      setMessages,
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

  // The panel took the composer's place, so give the keyboard back to it the
  // same way the review screen does.
  const handleCloseQueuePanel = useCallback(() => {
    closeQueuePanel()
    setInputFocused(true)
    inputRef.current?.focus()
  }, [closeQueuePanel, setInputFocused, inputRef])

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
    // A new send collapses the panel: the user has moved on from the ad.
    dockPanel.collapse('send')
    // Update terminal title with truncated user input
    if (inputValue.trim()) {
      setTerminalTitle(inputValue)
    }
    const result = await onSubmitPrompt(inputValue, agentMode)
    handleCommandResult(result)
  }, [onSubmitPrompt, inputValue, agentMode, handleCommandResult, dockPanel])

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
      dockExpandable: dockPanel.expandable,
      dockPanelOpen: dockPanel.expanded,
      sponsoredDockActive: dockProposal !== null,
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
      dockPanel.expandable,
      dockPanel.expanded,
      dockProposal,
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
      onOpenQueuePanel: openQueuePanel,
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
      onToggleDockPanel: () => dockPanel.toggle('key'),
      onCloseDockPanel: () => dockPanel.collapse('esc'),
      onToggleSponsoredDock: () => {
        if (!dockProposal) return
        handleSponsoredProposalMenu(dockProposal.target, !dockProposal.menuOpen)
      },
    }),
    [
      dockPanel,
      dockProposal,
      handleSponsoredProposalMenu,
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
      openQueuePanel,
      scrollUp,
      scrollDown,
      handleToggleAll,
    ],
  )

  // Use the chat keyboard hook
  useChatKeyboard({
    state: chatKeyboardState,
    handlers: chatKeyboardHandlers,
    // `sponsoredProposalMenuOpen` joins askUser for exactly the same reason
    // askUser is here (COD-376): both take over the keyboard, and `useKeyboard`
    // is a GLOBAL listener rather than a focus-scoped one -- so without this,
    // the menu's arrows, Enter and Esc would reach the card AND the composer,
    // and the user would move a selection while also navigating history. The
    // card claims no keys at all outside this span; that is what makes turning
    // chat's off for the span safe rather than a second overlap.
    disabled:
      askUserState !== null ||
      reviewMode ||
      queuePanelOpen ||
      sponsoredProposalMenuOpen,
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
      readOnly: false,
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
      onSponsoredProposalMenu: handleSponsoredProposalMenu,
      onSponsoredProposalDisclose: handleSponsoredProposalDisclose,
      onSponsoredProposalAccept: handleSponsoredProposalAccept,
      onSponsoredProposalConsent: handleSponsoredProposalConsent,
      onSponsoredProposalProcedure: handleSponsoredProposalProcedure,
      onSponsoredProposalUndo: handleSponsoredProposalUndo,
      onSponsoredProposalControl: handleSponsoredProposalControl,
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

  const hasActiveFreebuffSession =
    !hasSelectedByokConnection &&
    IS_FREEBUFF &&
    freebuffSession?.status === 'active'
  const isFreebuffSessionOver =
    !hasSelectedByokConnection &&
    IS_FREEBUFF &&
    freebuffSession?.status === 'ended'

  // A takeover screen owns both the keyboard and the rows above the composer.
  // Rather than teach the panel to arbitrate with four other Escape handlers,
  // it simply closes for the duration -- and `collapse` is a no-op when it was
  // already shut, so this fires exactly one `dock_collapsed`.
  const dockTakeoverActive =
    askUserState !== null ||
    reviewMode ||
    queuePanelOpen ||
    sponsoredProposalMenuOpen ||
    isFreebuffSessionOver
  useEffect(() => {
    if (dockTakeoverActive) dockPanel.collapse('outside')
  }, [dockTakeoverActive, dockPanel])

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

        {/* ONE SLOT, ONE AD: a sponsored proposal replaces the display ad for
            as long as it holds the dock (`dockProposal`). */}
        {dockProposal && (
          <SponsoredProposalBlock
            key={`sponsored-dock-${dockProposal.target}`}
            block={dockProposal}
            availableWidth={separatorWidth}
            run={dockRun}
          />
        )}

        {!dockProposal && ads?.[0] && showInlineAds && (
          <SingleAdBanner
            ad={ads[0]}
            onClick={recordClick}
            onImpression={recordImpression}
            arm={dockPanel.arm}
            // A takeover screen owns the keyboard and the space above the
            // composer, so the panel is force-closed for its duration rather
            // than fighting it for Escape.
            expanded={dockPanel.expanded && !dockTakeoverActive}
            chordHint={DOCK_CHORD_HINT}
            panelRows={dockPanelRowBudget(terminalHeight)}
            onToggle={() => dockPanel.toggle('click')}
            onClose={() => dockPanel.collapse('close')}
            // One click, one event: the dock's metadata rides the click
            // acknowledgement so the canonical server-side `ads.clicked`
            // carries it, rather than a second client-side event beside it.
            onDockClick={(clickedAd, from) =>
              recordClick(clickedAd, dockPanel.clickContext(from))
            }
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
        ) : queuePanelOpen && !askUserState ? (
          <QueuePanel
            queuedMessages={queuedMessages}
            onEdit={editQueuedMessage}
            onDelete={removeQueuedMessage}
            onMove={moveQueuedMessage}
            onClose={handleCloseQueuePanel}
            width={separatorWidth}
            maxVisibleRows={isCompactHeight ? 4 : 8}
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
              onQueuePreviewClick={openQueuePanel}
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
