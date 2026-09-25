import { castDraft, enableMapSet } from 'immer'
import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'

import { AGENT_MODES, IS_FREEBUFF } from '../utils/constants'
import { clamp } from '../utils/math'
import { loadModePreference, saveModePreference } from '../utils/settings'

import type { ChatMessage, ContentBlock } from '../types/chat'
import type { AgentMode } from '../utils/constants'
import type { InputMode } from '../utils/input-modes'
import type { RunState } from '@codebuff/sdk'
import type { AdTraceContext } from '@codebuff/common/ads/trace-context'
import { adTraceContextFromRunState } from '@codebuff/common/ads/trace-context'

// Import types from the types/store module to avoid circular dependencies
import type {
  TopBannerType,
  InputValue,
  AskUserQuestion,
  AnswerState,
  AskUserState,
  PendingImageStatus,
  PendingImageAttachment,
  PendingTextAttachment,
  PendingFileAttachment,
  PendingAttachment,
  PendingImage,
  PendingBashMessage,
  SuggestedFollowup,
  SuggestedFollowupsState,
  ClickedFollowupsMap,
} from '../types/store'

// Re-export types from the types/store module to maintain backwards compatibility
export type {
  TopBannerType,
  InputValue,
  AskUserQuestion,
  AnswerState,
  AskUserState,
  PendingImageStatus,
  PendingImageAttachment,
  PendingTextAttachment,
  PendingFileAttachment,
  PendingAttachment,
  PendingImage,
  PendingBashMessage,
  SuggestedFollowup,
  SuggestedFollowupsState,
  ClickedFollowupsMap,
}

// Drafts Sets (streamingAgents, activeSubagents) through immer; see
// message-block-store for why the store enables the plugin itself.
enableMapSet()

export type ChatStoreState = {
  /** Unique ID for this chat session, regenerated on /new */
  chatSessionId: string
  messages: ChatMessage[]
  streamingAgents: Set<string>
  focusedAgentId: string | null
  inputValue: string
  cursorPosition: number
  lastEditDueToNav: boolean
  inputFocused: boolean
  isFocusSupported: boolean
  activeSubagents: Set<string>
  isChainInProgress: boolean
  slashSelectedIndex: number
  agentSelectedIndex: number
  agentMode: AgentMode
  hasReceivedPlanResponse: boolean
  lastMessageMode: AgentMode | null
  sessionCreditsUsed: number
  runState: RunState | null
  /**
   * The ad trace pointer (ids only) for the conversation's LAST FINISHED run,
   * completed or interrupted. Kept apart from `runState` because an
   * interrupted run is never adopted there, yet it did create a root run on
   * the server: pointing past it is what keeps the next prompt's lookup from
   * selecting the interrupted run instead.
   */
  adTraceContext: AdTraceContext | null
  /** The currently active top banner, or null if none */
  activeTopBanner: TopBannerType
  inputMode: InputMode
  /** Skill awaiting user text while inputMode === 'skill'. Cleared by
   *  setInputMode whenever the mode moves off 'skill', so Escape and every
   *  other mode exit reset it without extra bookkeeping. */
  pendingSkillName: string | null
  isRetrying: boolean
  /** True while the current retry wait is a server capacity deferral (free
   *  mode shed under high demand) rather than a stream recovery — the status
   *  bar says "high demand" instead of a generic "retrying". Cleared with
   *  isRetrying. */
  isCapacityWait: boolean
  askUserState: AskUserState
  pendingAttachments: PendingAttachment[]
  pendingBashMessages: PendingBashMessage[]
  suggestedFollowups: SuggestedFollowupsState | null
  /** Persisted clicked indices per toolCallId */
  clickedFollowupsMap: ClickedFollowupsMap
}

const findLatestFollowupInBlocks = (
  blocks: ContentBlock[] | undefined,
): string | null => {
  if (!blocks) return null

  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i]
    if (block.type === 'tool' && block.toolName === 'suggest_followups') {
      return block.toolCallId
    }
    if (block.type === 'agent') {
      const nested = findLatestFollowupInBlocks(block.blocks)
      if (nested) return nested
    }
  }

  return null
}

export const getLatestFollowupToolCallId = (
  messages: ChatMessage[],
): string | null => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const latest = findLatestFollowupInBlocks(messages[i]?.blocks)
    if (latest) return latest
  }
  return null
}

type ChatStoreActions = {
  setMessages: (
    value: ChatMessage[] | ((prev: ChatMessage[]) => ChatMessage[]),
  ) => void
  setStreamingAgents: (
    value: Set<string> | ((prev: Set<string>) => Set<string>),
  ) => void
  setFocusedAgentId: (
    value: string | null | ((prev: string | null) => string | null),
  ) => void
  setInputValue: (
    value: InputValue | ((prev: InputValue) => InputValue),
  ) => void
  setInputFocused: (focused: boolean) => void
  setIsFocusSupported: (supported: boolean) => void
  setActiveSubagents: (
    value: Set<string> | ((prev: Set<string>) => Set<string>),
  ) => void
  setIsChainInProgress: (active: boolean) => void
  setSlashSelectedIndex: (value: number | ((prev: number) => number)) => void
  setAgentSelectedIndex: (value: number | ((prev: number) => number)) => void
  setAgentMode: (mode: AgentMode) => void
  toggleAgentMode: () => void
  setHasReceivedPlanResponse: (value: boolean) => void
  setLastMessageMode: (mode: AgentMode | null) => void
  addSessionCredits: (credits: number) => void
  setRunState: (runState: RunState | null) => void
  /** Advance `adTraceContext` past a run that finished without being adopted. */
  noteFinishedRunForAdTrace: (runState: RunState) => void
  setActiveTopBanner: (banner: TopBannerType) => void
  closeTopBanner: () => void
  setInputMode: (mode: InputMode) => void
  setPendingSkillName: (name: string | null) => void
  /** Atomic skill-mode entry: mode and pending skill set together, so
   *  'skill' mode with a null skill is never representable via this path. */
  enterSkillMode: (skillName: string) => void
  setIsRetrying: (retrying: boolean) => void
  /** Mark the current wait as a free-mode capacity deferral (implies
   *  isRetrying). Cleared by setIsRetrying(false). */
  noteCapacityDeferral: () => void
  setAskUserState: (state: AskUserState) => void
  updateAskUserAnswer: (questionIndex: number, optionIndex: number) => void
  updateAskUserOtherText: (questionIndex: number, text: string) => void
  addPendingAttachment: (attachment: PendingAttachment) => void
  removePendingAttachment: (id: string) => void
  clearPendingAttachments: () => void
  // Convenience aliases for backwards compatibility
  addPendingImage: (image: Omit<PendingImageAttachment, 'kind'>) => void
  removePendingImage: (path: string) => void
  clearPendingImages: () => void
  addPendingTextAttachment: (attachment: Omit<PendingTextAttachment, 'kind'>) => void
  removePendingTextAttachment: (id: string) => void
  clearPendingTextAttachments: () => void
  addPendingFileAttachment: (attachment: Omit<PendingFileAttachment, 'kind'>) => void
  addPendingBashMessage: (message: PendingBashMessage) => void
  updatePendingBashMessage: (
    id: string,
    updates: Partial<PendingBashMessage>,
  ) => void
  removePendingBashMessage: (id: string) => void
  clearPendingBashMessages: () => void
  setSuggestedFollowups: (state: SuggestedFollowupsState | null) => void
  markFollowupClicked: (toolCallId: string, index: number) => void
  reset: () => void
}

type ChatStore = ChatStoreState & ChatStoreActions

const generateSessionId = () => crypto.randomUUID()

const initialState: ChatStoreState = {
  chatSessionId: generateSessionId(),
  messages: [],
  streamingAgents: new Set<string>(),
  focusedAgentId: null,
  inputValue: '',
  cursorPosition: 0,
  lastEditDueToNav: false,
  inputFocused: true, // Cursor visible by default
  isFocusSupported: false, // Don't blink until terminal support is detected
  activeSubagents: new Set<string>(),
  isChainInProgress: false,
  slashSelectedIndex: 0,
  agentSelectedIndex: 0,
  agentMode: IS_FREEBUFF ? ('LITE' as const) : loadModePreference(),
  hasReceivedPlanResponse: false,
  lastMessageMode: null,
  sessionCreditsUsed: 0,
  runState: null,
  adTraceContext: null,
  activeTopBanner: null,
  inputMode: 'default' as InputMode,
  pendingSkillName: null as string | null,
  isRetrying: false,
  isCapacityWait: false,
  askUserState: null,
  pendingAttachments: [],
  pendingBashMessages: [],
  suggestedFollowups: null,
  clickedFollowupsMap: new Map<string, Set<number>>(),
}

export const useChatStore = create<ChatStore>()(
  immer((set) => ({
    ...initialState,

    setMessages: (value) =>
      set((state) => {
        state.messages =
          typeof value === 'function' ? value(state.messages) : value
      }),

    setStreamingAgents: (value) =>
      set((state) => {
        state.streamingAgents =
          typeof value === 'function' ? value(state.streamingAgents) : value
      }),

    setFocusedAgentId: (value) =>
      set((state) => {
        state.focusedAgentId =
          typeof value === 'function' ? value(state.focusedAgentId) : value
      }),

    setInputValue: (value) =>
      set((state) => {
        const { text, cursorPosition, lastEditDueToNav } =
          typeof value === 'function'
            ? value({
                text: state.inputValue,
                cursorPosition: state.cursorPosition,
                lastEditDueToNav: state.lastEditDueToNav,
              })
            : value
        state.inputValue = text
        state.cursorPosition = clamp(cursorPosition, 0, text.length)
        state.lastEditDueToNav = lastEditDueToNav
      }),

    setInputFocused: (focused) =>
      set((state) => {
        state.inputFocused = focused
      }),

    setIsFocusSupported: (supported) =>
      set((state) => {
        state.isFocusSupported = supported
      }),

    setActiveSubagents: (value) =>
      set((state) => {
        state.activeSubagents =
          typeof value === 'function' ? value(state.activeSubagents) : value
      }),

    setIsChainInProgress: (active) =>
      set((state) => {
        state.isChainInProgress = active
      }),

    setSlashSelectedIndex: (value) =>
      set((state) => {
        state.slashSelectedIndex =
          typeof value === 'function' ? value(state.slashSelectedIndex) : value
      }),

    setAgentSelectedIndex: (value) =>
      set((state) => {
        state.agentSelectedIndex =
          typeof value === 'function' ? value(state.agentSelectedIndex) : value
      }),

    setAgentMode: (mode) =>
      set((state) => {
        if (IS_FREEBUFF) return
        state.agentMode = mode
        saveModePreference(mode)
      }),

    toggleAgentMode: () =>
      set((state) => {
        if (IS_FREEBUFF) return
        const currentIndex = AGENT_MODES.indexOf(state.agentMode)
        const nextIndex = (currentIndex + 1) % AGENT_MODES.length
        state.agentMode = AGENT_MODES[nextIndex]
        saveModePreference(state.agentMode)
      }),

    setHasReceivedPlanResponse: (value) =>
      set((state) => {
        state.hasReceivedPlanResponse = value
      }),

    setLastMessageMode: (mode) =>
      set((state) => {
        state.lastMessageMode = mode
      }),

    addSessionCredits: (credits) =>
      set((state) => {
        state.sessionCreditsUsed += credits
      }),

    setRunState: (runState) =>
      set((state) => {
        state.runState = runState ? castDraft(runState) : null
        state.adTraceContext = adTraceContextFromRunState(runState)
      }),

    noteFinishedRunForAdTrace: (runState) =>
      set((state) => {
        state.adTraceContext =
          adTraceContextFromRunState(runState) ?? state.adTraceContext
      }),

    setActiveTopBanner: (banner) =>
      set((state) => {
        state.activeTopBanner = banner
      }),

    closeTopBanner: () =>
      set((state) => {
        state.activeTopBanner = null
      }),

    setInputMode: (mode) =>
      set((state) => {
        state.inputMode = mode
        if (mode !== 'skill') {
          state.pendingSkillName = null
        }
      }),

    setPendingSkillName: (name) =>
      set((state) => {
        state.pendingSkillName = name
      }),

    enterSkillMode: (skillName) =>
      set((state) => {
        state.inputMode = 'skill'
        state.pendingSkillName = skillName
      }),

    setIsRetrying: (retrying) =>
      set((state) => {
        state.isRetrying = retrying
        // Any transition (fresh generic retry, or the wait ending) supersedes
        // a capacity flavor; only noteCapacityDeferral re-establishes it.
        state.isCapacityWait = false
      }),

    noteCapacityDeferral: () =>
      set((state) => {
        state.isRetrying = true
        state.isCapacityWait = true
      }),

    setAskUserState: (askUserState) =>
      set((state) => {
        state.askUserState = askUserState
      }),

    addPendingAttachment: (attachment) =>
      set((state) => {
        // Don't add duplicates — use path for image/file, id for text
        const id = attachment.kind === 'text' ? attachment.id : attachment.path
        const isDuplicate = state.pendingAttachments.some((a) =>
          a.kind === 'text' ? a.id === id : a.path === id,
        )
        if (!isDuplicate) {
          state.pendingAttachments.push(attachment)
        }
      }),

    removePendingAttachment: (id) =>
      set((state) => {
        state.pendingAttachments = state.pendingAttachments.filter((a) =>
          a.kind === 'text' ? a.id !== id : a.path !== id,
        )
      }),

    clearPendingAttachments: () =>
      set((state) => {
        state.pendingAttachments = []
      }),

    // Backwards-compatible convenience methods that delegate to canonical functions
    addPendingImage: (image) => {
      useChatStore.getState().addPendingAttachment({ ...image, kind: 'image' })
    },

    removePendingImage: (path) => {
      // Clear any auto-remove timer to prevent memory leaks
      // Import dynamically to avoid circular dependency
      import('../utils/pending-attachments')
        .then(({ clearErrorImageTimer }) => {
          clearErrorImageTimer(path)
        })
        .catch(() => {
          // Silently ignore import errors - timer cleanup is best-effort
        })
      useChatStore.getState().removePendingAttachment(path)
    },

    clearPendingImages: () =>
      set((state) => {
        state.pendingAttachments = state.pendingAttachments.filter(
          (a) => a.kind !== 'image',
        )
      }),

    addPendingTextAttachment: (attachment) => {
      useChatStore.getState().addPendingAttachment({ ...attachment, kind: 'text' })
    },

    removePendingTextAttachment: (id) => {
      useChatStore.getState().removePendingAttachment(id)
    },

    clearPendingTextAttachments: () =>
      set((state) => {
        state.pendingAttachments = state.pendingAttachments.filter(
          (a) => a.kind !== 'text',
        )
      }),

    addPendingFileAttachment: (attachment) => {
      useChatStore.getState().addPendingAttachment({ ...attachment, kind: 'file' })
    },

    updateAskUserAnswer: (questionIndex, optionIndex) =>
      set((state) => {
        if (!state.askUserState) return

        const question = state.askUserState.questions[questionIndex]
        const currentAnswer = state.askUserState.selectedAnswers[questionIndex]

        if (question?.multiSelect) {
          // Multi-select: toggle option in array
          const selected = Array.isArray(currentAnswer) ? currentAnswer : []
          const newSelected = selected.includes(optionIndex)
            ? selected.filter((i) => i !== optionIndex) // Remove if already selected
            : [...selected, optionIndex] // Add if not selected

          state.askUserState.selectedAnswers[questionIndex] = newSelected
        } else {
          // Single-select: set option index
          state.askUserState.selectedAnswers[questionIndex] = optionIndex
        }

        // Clear other text when any option is selected (mutually exclusive)
        state.askUserState.otherTexts[questionIndex] = ''
      }),

    updateAskUserOtherText: (questionIndex, text) =>
      set((state) => {
        if (!state.askUserState) return

        state.askUserState.otherTexts[questionIndex] = text

        // Clear selected option(s) when text is entered (mutually exclusive)
        if (text) {
          const question = state.askUserState.questions[questionIndex]
          if (question?.multiSelect) {
            state.askUserState.selectedAnswers[questionIndex] = []
          } else {
            state.askUserState.selectedAnswers[questionIndex] = -1
          }
        }
      }),

    addPendingBashMessage: (message) =>
      set((state) => {
        state.pendingBashMessages.push(message)
      }),

    updatePendingBashMessage: (id, updates) =>
      set((state) => {
        const msg = state.pendingBashMessages.find((m) => m.id === id)
        if (msg) {
          Object.assign(msg, updates)
        }
      }),

    removePendingBashMessage: (id) =>
      set((state) => {
        state.pendingBashMessages = state.pendingBashMessages.filter(
          (m) => m.id !== id,
        )
      }),

    clearPendingBashMessages: () =>
      set((state) => {
        state.pendingBashMessages = []
      }),

    setSuggestedFollowups: (suggestedFollowups) =>
      set((state) => {
        state.suggestedFollowups = suggestedFollowups
      }),

    markFollowupClicked: (toolCallId: string, index: number) =>
      set((state) => {
        // Store in the persistent map
        if (!state.clickedFollowupsMap.has(toolCallId)) {
          state.clickedFollowupsMap.set(toolCallId, new Set<number>())
        }
        state.clickedFollowupsMap.get(toolCallId)!.add(index)

        // Also update the current suggestedFollowups if it matches
        if (state.suggestedFollowups?.toolCallId === toolCallId) {
          state.suggestedFollowups.clickedIndices.add(index)
        }
      }),

    reset: () =>
      set((state) => {
        state.chatSessionId = generateSessionId()
        state.messages = initialState.messages.slice()
        state.streamingAgents = new Set(initialState.streamingAgents)
        state.focusedAgentId = initialState.focusedAgentId
        state.inputValue = initialState.inputValue
        state.cursorPosition = initialState.cursorPosition
        state.lastEditDueToNav = initialState.lastEditDueToNav
        // Terminal capabilities and focus outlive a chat. Resetting these can
        // re-enable animation while the app is still unfocused, and focus
        // support would stay false because the mounted detector only reports
        // support once per subscription.
        state.activeSubagents = new Set(initialState.activeSubagents)
        state.isChainInProgress = initialState.isChainInProgress
        state.slashSelectedIndex = initialState.slashSelectedIndex
        state.agentSelectedIndex = initialState.agentSelectedIndex
        state.agentMode = initialState.agentMode
        state.hasReceivedPlanResponse = initialState.hasReceivedPlanResponse
        state.lastMessageMode = initialState.lastMessageMode
        state.sessionCreditsUsed = initialState.sessionCreditsUsed
        state.runState = initialState.runState
          ? castDraft(initialState.runState)
          : null
        state.adTraceContext = initialState.adTraceContext
        state.activeTopBanner = initialState.activeTopBanner
        state.inputMode = initialState.inputMode
        state.pendingSkillName = initialState.pendingSkillName
        state.isRetrying = initialState.isRetrying
        state.isCapacityWait = initialState.isCapacityWait
        state.askUserState = initialState.askUserState
        state.pendingAttachments = []
        state.pendingBashMessages = []
        state.suggestedFollowups = null
        state.clickedFollowupsMap = new Map<string, Set<number>>()
      }),
  })),
)
