import { getInputModeConfig, type InputMode } from './input-modes'
import { isPlainEnterKey } from './terminal-enter-detection'
import type { KeyEvent } from '@opentui/core'


/**
 * State needed to determine keyboard actions in chat input contexts.
 * This is a focused subset of app state relevant to keyboard handling.
 */
export type ChatKeyboardState = {
  // Input state
  inputMode: InputMode
  inputValue: string
  cursorPosition: number

  // Stream state
  isStreaming: boolean
  isWaitingForResponse: boolean

  // Feedback mode
  feedbackMode: boolean

  // Focus state
  focusedAgentId: string | null

  // Menu state
  slashMenuActive: boolean
  mentionMenuActive: boolean
  slashSelectedIndex: number
  agentSelectedIndex: number
  slashMatchesLength: number
  totalMentionMatches: number
  disableSlashSuggestions: boolean

  // Queue state
  queuePaused: boolean
  queuedCount: number

  // History navigation state
  historyNavUpEnabled: boolean
  historyNavDownEnabled: boolean

  // Exit handler state
  nextCtrlCWillExit: boolean

  /**
   * The sponsor dock's detail panel (COD-457).
   *
   * `dockExpandable` is the sticky experiment arm: false in control, and then
   * the chord resolves to `none` exactly as it did before this issue.
   * `dockPanelOpen` is what makes Escape mean "close the panel" — and ONLY
   * while it is true. `useKeyboard` is a global listener, so a panel that
   * listened for Escape on its own would close AND interrupt the stream on one
   * keypress; routing it through this resolver is what keeps Escape's six
   * existing meanings intact the moment the panel is shut.
   */
  dockExpandable: boolean
  dockPanelOpen: boolean
  /**
   * A sponsored PROPOSAL holds the dock (#3989's flow on the CLI). Ctrl+O then
   * opens the proposal's details instead of the display ad's panel -- the
   * dock holds one ad at a time, so the chord has one meaning at a time -- and
   * it does so in both COD-457 arms, because a proposal is not part of that
   * experiment. Escape is not claimed here: an open proposal disables chat's
   * keyboard outright and owns its own Escape.
   */
  sponsoredDockActive?: boolean
}

/**
 * All possible keyboard actions for chat input.
 * Each action represents a distinct behavior to be handled.
 */
export type ChatKeyboardAction =
  // Mode actions
  | { type: 'exit-input-mode' }
  | { type: 'exit-feedback-mode' }
  | { type: 'clear-feedback-input' }

  // Input actions
  | { type: 'clear-input' }
  | { type: 'backspace-exit-mode' }

  // Stream actions
  | { type: 'interrupt-stream' }

  // Menu navigation
  | { type: 'slash-menu-down' }
  | { type: 'slash-menu-up' }
  | { type: 'slash-menu-select' }
  | { type: 'slash-menu-complete' }
  | { type: 'mention-menu-down' }
  | { type: 'mention-menu-up' }
  | { type: 'mention-menu-tab' }
  | { type: 'mention-menu-shift-tab' }
  | { type: 'mention-menu-select' }
  | { type: 'mention-menu-complete' }
  | { type: 'open-file-menu-with-tab' }

  // History navigation
  | { type: 'history-up' }
  | { type: 'history-down' }

  // Agent mode
  | { type: 'toggle-agent-mode' }
  | { type: 'unfocus-agent' }

  // Toggle all collapsed/expanded
  | { type: 'toggle-all' }

  // Queue actions
  | { type: 'clear-queue' }
  | { type: 'open-queue-panel' }

  // Exit actions
  | { type: 'exit-app-warning' }
  | { type: 'exit-app' }

  // Bash history navigation
  | { type: 'bash-history-up' }
  | { type: 'bash-history-down' }

  // Scroll actions
  | { type: 'scroll-up' }
  | { type: 'scroll-down' }

  // Paste action (dispatcher checks clipboard content to route to image or text handler)
  | { type: 'paste' }

  // Out of credits action
  | { type: 'open-buy-credits' }

  // Sponsor dock (COD-457)
  | { type: 'toggle-dock-panel' }
  | { type: 'close-dock-panel' }
  | { type: 'toggle-sponsored-dock' }

  // No action needed
  | { type: 'none' }

const hasModifier = (key: KeyEvent) =>
  Boolean(key.ctrl || key.meta || key.option)

/**
 * Pure function that resolves a keyboard action based on key event and state.
 * This implements the priority-based keyboard handling logic.
 */
export function resolveChatKeyboardAction(
  key: KeyEvent,
  state: ChatKeyboardState,
): ChatKeyboardAction {
  const isEscape = key.name === 'escape'
  const isCtrlC = key.ctrl && key.name === 'c'
  const isCtrlV = key.ctrl && key.name === 'v'
  const isBackspace = key.name === 'backspace'
  const isUp = key.name === 'up' && !hasModifier(key)
  const isDown = key.name === 'down' && !hasModifier(key)
  const isTab = key.name === 'tab' && !hasModifier(key)
  const isShiftTab =
    key.name === 'tab' && key.shift && !key.ctrl && !key.meta && !key.option
  const isEnter = isPlainEnterKey(key)
  const isPageUp = key.name === 'pageup' && !hasModifier(key)
  const isPageDown = key.name === 'pagedown' && !hasModifier(key)

  // Priority 0: Out of credits mode - Enter opens buy credits page
  if (state.inputMode === 'outOfCredits') {
    if (isEnter) {
      return { type: 'open-buy-credits' }
    }
    // Allow Escape or Ctrl+C to exit out-of-credits mode (return to normal input)
    if (isEscape || isCtrlC) {
      return { type: 'exit-input-mode' }
    }
    // Block most other inputs in this mode
    return { type: 'none' }
  }

  // Priority 1: Feedback mode - block global keys except Escape/Ctrl-C/Ctrl-V
  if (state.feedbackMode) {
    if (isEscape) {
      return { type: 'exit-feedback-mode' }
    }
    if (isCtrlC) {
      return state.inputValue.length === 0
        ? { type: 'exit-feedback-mode' }
        : { type: 'clear-feedback-input' }
    }
    if (isCtrlV) {
      return { type: 'paste' }
    }
    return { type: 'none' }
  }

  // Priority 1.5: The sponsor dock's detail panel (COD-457).
  //
  // Escape is claimed here and NOWHERE ELSE, and only while the panel is
  // actually open — so with it shut, Escape keeps every one of the six
  // meanings below untouched, which is the acceptance criterion. It sits above
  // priority 2 and priority 4 deliberately: a user pressing Escape at an open
  // panel means "close this", not "exit the mode" and not "interrupt the run".
  // It sits BELOW the out-of-credits and feedback takeovers, which own the
  // whole keyboard while they are up.
  //
  // The chord is Ctrl+O: verified unclaimed across every `useKeyboard`
  // consumer and inert in the composer (`getPrintableKeySequence` returns null
  // for any modified key). In the control arm `dockExpandable` is false and
  // both branches fall through to `none`, so the chord does nothing at all.
  const isDockChord =
    key.ctrl && key.name === 'o' && !key.meta && !key.option && !key.shift
  if (state.sponsoredDockActive && isDockChord) {
    return { type: 'toggle-sponsored-dock' }
  }
  if (state.dockExpandable) {
    if (isEscape && state.dockPanelOpen) {
      return { type: 'close-dock-panel' }
    }
    if (isDockChord) {
      return { type: 'toggle-dock-panel' }
    }
  }

  // Priority 2: Non-default input mode escape
  // Escape should exit the current mode BEFORE interrupting streams
  // Exception: modes with blockKeyboardExit cannot be escaped
  const modeConfig = getInputModeConfig(state.inputMode)
  if (isEscape && state.inputMode !== 'default' && !modeConfig.blockKeyboardExit) {
    return { type: 'exit-input-mode' }
  }

  // Priority 2.5: Open the queue editor (Ctrl+Q). Ahead of the ctrl-c rules
  // below so it works with a half-typed message still in the composer; raw
  // mode disables XON/XOFF, so ctrl-q is ours to use.
  if (key.ctrl && key.name === 'q' && !key.meta && !key.option) {
    return state.queuedCount > 0
      ? { type: 'open-queue-panel' }
      : { type: 'none' }
  }

  // Priority 3: Clear input with ctrl-c when there's text
  if (isCtrlC && state.inputValue.trim().length > 0) {
    return { type: 'clear-input' }
  }

  // Priority 4: Interrupt streaming
  if (
    (isEscape || isCtrlC) &&
    (state.isStreaming || state.isWaitingForResponse)
  ) {
    return { type: 'interrupt-stream' }
  }

  // Priority 5: Backspace at position 0 exits non-default mode
  // Exception: modes with blockKeyboardExit cannot be exited via keyboard
  if (
    isBackspace &&
    state.cursorPosition === 0 &&
    state.inputMode !== 'default' &&
    !modeConfig.blockKeyboardExit &&
    state.inputValue.length === 0
  ) {
    return { type: 'backspace-exit-mode' }
  }

  // Priority 6: Slash menu navigation (when active and not disabled)
  // Skip menu navigation for Up/Down if history navigation is enabled (user is paging through history)
  if (
    state.slashMenuActive &&
    state.slashMatchesLength > 0 &&
    !state.disableSlashSuggestions
  ) {
    if (isDown && !state.historyNavDownEnabled) {
      return state.slashSelectedIndex < state.slashMatchesLength - 1
        ? { type: 'slash-menu-down' }
        : { type: 'none' } // At bottom, don't navigate
    }
    if (isUp && !state.historyNavUpEnabled) {
      return state.slashSelectedIndex > 0
        ? { type: 'slash-menu-up' }
        : { type: 'none' } // At top, don't navigate
    }
    if (isTab || isShiftTab) {
      // Tab accepts the highlighted command into the input without executing
      // it, leaving the cursor after it so the user can keep typing (e.g. extra
      // params for a skill). Tab no longer navigates between items — use the
      // arrow keys for that. Enter (below) selects the highlighted item; the
      // command decides whether selection inserts text or executes immediately.
      return { type: 'slash-menu-complete' }
    }
    if (isEnter) {
      return { type: 'slash-menu-select' }
    }
  }

  // Priority 7: Mention menu navigation (when active)
  // Skip menu navigation for Up/Down if history navigation is enabled (user is paging through history)
  if (state.mentionMenuActive && state.totalMentionMatches > 0) {
    if (isDown && !state.historyNavDownEnabled) {
      return state.agentSelectedIndex < state.totalMentionMatches - 1
        ? { type: 'mention-menu-down' }
        : { type: 'none' } // At bottom, don't navigate
    }
    if (isUp && !state.historyNavUpEnabled) {
      return state.agentSelectedIndex > 0
        ? { type: 'mention-menu-up' }
        : { type: 'none' } // At top, don't navigate
    }
    if (isShiftTab) {
      return { type: 'mention-menu-shift-tab' }
    }
    if (isTab) {
      // Multiple matches: cycle through options
      // Single match: complete the word without executing
      if (state.totalMentionMatches > 1) {
        return { type: 'mention-menu-tab' }
      }
      return { type: 'mention-menu-complete' }
    }
    if (isEnter) {
      return { type: 'mention-menu-select' }
    }
  }

  // Priority 8: Tab to open file menu (when not in a menu, not shift-tab, and suggestions enabled)
  // This is handled by the hook since it needs to check word at cursor
  if (
    isTab &&
    !key.shift &&
    !state.mentionMenuActive &&
    !state.slashMenuActive &&
    !state.disableSlashSuggestions
  ) {
    return { type: 'open-file-menu-with-tab' }
  }

  // Priority 9: Queue management
  if (isCtrlC && state.queuePaused && state.queuedCount > 0) {
    return { type: 'clear-queue' }
  }

  // Priority 10: Bash history navigation (when in bash mode)
  if (state.inputMode === 'bash') {
    if (isUp && state.historyNavUpEnabled) {
      return { type: 'bash-history-up' }
    }
    if (isDown && state.historyNavDownEnabled) {
      return { type: 'bash-history-down' }
    }
  }

  // Priority 10.5: Regular history navigation (when at edges and enabled)
  if (isUp && state.historyNavUpEnabled) {
    return { type: 'history-up' }
  }
  if (isDown && state.historyNavDownEnabled) {
    return { type: 'history-down' }
  }

  // Priority 11: Toggle all collapsed/expanded (Ctrl+T)
  const isCtrlT = key.ctrl && key.name === 't' && !key.meta && !key.option

  if (isCtrlT) {
    return { type: 'toggle-all' }
  }

  // Priority 12: Agent mode toggle (tab or shift-tab when not in menus)
  if (
    (isShiftTab || isTab) &&
    !state.slashMenuActive &&
    !state.mentionMenuActive
  ) {
    return { type: 'toggle-agent-mode' }
  }

  // Priority 13: Unfocus agent
  if (isEscape && state.focusedAgentId !== null) {
    return { type: 'unfocus-agent' }
  }

  // Priority 14: Scroll with PageUp/PageDown
  if (isPageUp) {
    return { type: 'scroll-up' }
  }
  if (isPageDown) {
    return { type: 'scroll-down' }
  }

  // Priority 15: Paste (ctrl-v)
  if (isCtrlV) {
    return { type: 'paste' }
  }

  // Priority 16: Exit app (ctrl-c double-tap)
  if (isCtrlC) {
    if (state.nextCtrlCWillExit) {
      return { type: 'exit-app' }
    }
    return { type: 'exit-app-warning' }
  }

  return { type: 'none' }
}

/**
 * Creates default chat keyboard state for initialization.
 */
export function createDefaultChatKeyboardState(): ChatKeyboardState {
  return {
    inputMode: 'default',
    inputValue: '',
    cursorPosition: 0,
    isStreaming: false,
    isWaitingForResponse: false,
    feedbackMode: false,
    focusedAgentId: null,
    slashMenuActive: false,
    mentionMenuActive: false,
    slashSelectedIndex: 0,
    agentSelectedIndex: 0,
    slashMatchesLength: 0,
    totalMentionMatches: 0,
    disableSlashSuggestions: false,
    queuePaused: false,
    queuedCount: 0,
    historyNavUpEnabled: false,
    historyNavDownEnabled: false,
    nextCtrlCWillExit: false,
    dockExpandable: false,
    dockPanelOpen: false,
  }
}
