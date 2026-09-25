import { statSync } from 'fs'

import { useKeyboard } from '@opentui/react'
import { useCallback, useRef } from 'react'

import { getProjectRoot } from '../project-files'
import { reportActivity } from '../utils/activity-tracker'
import { hasClipboardImage, readClipboardText, readClipboardFilePath, getImageFilePathFromText } from '../utils/clipboard-image'
import { isImageFile } from '../utils/image-handler'
import {
  resolveChatKeyboardAction,
  type ChatKeyboardState,
  type ChatKeyboardAction,
} from '../utils/keyboard-actions'
import { markReturnKeySeenForKey } from '../utils/terminal-enter-detection'

import type { KeyEvent } from '@opentui/core'

// Throttle interval for keyboard activity reporting (ms)
const KEYBOARD_ACTIVITY_THROTTLE_MS = 1000

/**
 * Handlers for chat keyboard actions.
 * Each handler corresponds to a ChatKeyboardAction type.
 */
export type ChatKeyboardHandlers = {
  // Mode handlers
  onExitInputMode: () => void
  onExitFeedbackMode: () => void
  onClearFeedbackInput: () => void

  // Input handlers
  onClearInput: () => void
  onBackspaceExitMode: () => void

  // Stream handlers
  onInterruptStream: () => void

  // Slash menu handlers
  onSlashMenuDown: () => void
  onSlashMenuUp: () => void
  onSlashMenuSelect: () => Promise<void> | void
  onSlashMenuComplete: () => void

  // Mention menu handlers
  onMentionMenuDown: () => void
  onMentionMenuUp: () => void
  onMentionMenuTab: () => void
  onMentionMenuShiftTab: () => void
  onMentionMenuSelect: () => void
  onMentionMenuComplete: () => void

  // File menu handler
  onOpenFileMenuWithTab: () => boolean // Returns true if menu was opened

  // History handlers
  onHistoryUp: () => void
  onHistoryDown: () => void

  // Agent handlers
  onToggleAgentMode: () => void
  onUnfocusAgent: () => void

  // Queue handlers
  onClearQueue: () => void
  onOpenQueuePanel: () => void

  // Exit handlers
  onExitAppWarning: () => void
  onExitApp: () => void

  // Bash history handlers
  onBashHistoryUp: () => void
  onBashHistoryDown: () => void

  // Clipboard handlers
  onPasteImage: () => void
  onPasteImagePath: (imagePath: string) => void
  onPasteFilePath: (filePath: string, isDirectory: boolean) => void
  onPasteText: (text: string) => void

  // Scroll handlers
  onScrollUp: () => void
  onScrollDown: () => void

  // Toggle all handler
  onToggleAll: () => void

  // Out of credits handler
  onOpenBuyCredits: () => void

  // Sponsor dock (COD-457)
  onToggleDockPanel: () => void
  onCloseDockPanel: () => void
  /** Ctrl+O while a sponsored proposal holds the dock: open its details. */
  onToggleSponsoredDock?: () => void
}

/**
 * Options for the useChatKeyboard hook.
 */
export type UseChatKeyboardOptions = {
  /** Current keyboard state extracted from stores */
  state: ChatKeyboardState
  /** Handlers for keyboard actions */
  handlers: ChatKeyboardHandlers
  /** Whether keyboard handling is disabled (e.g., during ask-user) */
  disabled?: boolean
}

/**
 * Dispatches a keyboard action to the appropriate handler.
 */
function assertNever(action: never): never {
  throw new Error(`Unhandled chat keyboard action: ${String(action)}`)
}

function dispatchAction(
  action: ChatKeyboardAction,
  handlers: ChatKeyboardHandlers,
): boolean {
  switch (action.type) {
    case 'exit-input-mode':
      handlers.onExitInputMode()
      return true
    case 'exit-feedback-mode':
      handlers.onExitFeedbackMode()
      return true
    case 'clear-feedback-input':
      handlers.onClearFeedbackInput()
      return true
    case 'clear-input':
      handlers.onClearInput()
      return true
    case 'backspace-exit-mode':
      handlers.onBackspaceExitMode()
      return true
    case 'interrupt-stream':
      handlers.onInterruptStream()
      return true
    case 'slash-menu-down':
      handlers.onSlashMenuDown()
      return true
    case 'slash-menu-up':
      handlers.onSlashMenuUp()
      return true
    case 'slash-menu-select':
      handlers.onSlashMenuSelect()
      return true
    case 'slash-menu-complete':
      handlers.onSlashMenuComplete()
      return true
    case 'mention-menu-down':
      handlers.onMentionMenuDown()
      return true
    case 'mention-menu-up':
      handlers.onMentionMenuUp()
      return true
    case 'mention-menu-tab':
      handlers.onMentionMenuTab()
      return true
    case 'mention-menu-shift-tab':
      handlers.onMentionMenuShiftTab()
      return true
    case 'mention-menu-select':
      handlers.onMentionMenuSelect()
      return true
    case 'mention-menu-complete':
      handlers.onMentionMenuComplete()
      return true
    case 'open-file-menu-with-tab': {
      const opened = handlers.onOpenFileMenuWithTab()
      if (!opened) {
        handlers.onToggleAgentMode()
      }
      return true
    }
    case 'history-up':
      handlers.onHistoryUp()
      return true
    case 'history-down':
      handlers.onHistoryDown()
      return true
    case 'toggle-agent-mode':
      handlers.onToggleAgentMode()
      return true
    case 'unfocus-agent':
      handlers.onUnfocusAgent()
      return true
    case 'clear-queue':
      handlers.onClearQueue()
      return true
    case 'open-queue-panel':
      handlers.onOpenQueuePanel()
      return true
    case 'exit-app-warning':
      handlers.onExitAppWarning()
      return true
    case 'exit-app':
      handlers.onExitApp()
      return true
    case 'bash-history-up':
      handlers.onBashHistoryUp()
      return true
    case 'bash-history-down':
      handlers.onBashHistoryDown()
      return true
    case 'paste': {
      const cwd = getProjectRoot() ?? process.cwd()
      
      // First, check if clipboard contains a copied file (e.g., from Finder)
      // This is different from text - it's when you Cmd+C a file in Finder
      const copiedFilePath = readClipboardFilePath()
      if (copiedFilePath) {
        if (isImageFile(copiedFilePath)) {
          handlers.onPasteImagePath(copiedFilePath)
          return true
        }
        // Non-image file or directory
        try {
          const fileStats = statSync(copiedFilePath)
          handlers.onPasteFilePath(copiedFilePath, fileStats.isDirectory())
          return true
        } catch {
          // Fall through to other paste handlers
        }
      }
      
      // Next, read clipboard text to check if it's a file path
      // This handles the case where a file is dragged/dropped - we want to use
      // the file path, not any stale image data that might be in the clipboard
      const rawText = readClipboardText()
      const text = rawText ? Bun.stripANSI(rawText) : null
      if (text) {
        // Check if the text is a path to an image file
        const imagePath = getImageFilePathFromText(text, cwd)
        if (imagePath) {
          handlers.onPasteImagePath(imagePath)
          return true
        }
      }
      
      // Check for actual image data in clipboard (screenshots, copied images)
      // This comes AFTER the file path check so dragged files take priority
      if (hasClipboardImage()) {
        handlers.onPasteImage()
        return true
      }
      
      // Regular text paste
      if (text) {
        handlers.onPasteText(text)
        return true
      }
      return true
    }
    case 'scroll-up':
      handlers.onScrollUp()
      return true
    case 'scroll-down':
      handlers.onScrollDown()
      return true
    case 'toggle-all':
      handlers.onToggleAll()
      return true
    case 'open-buy-credits':
      handlers.onOpenBuyCredits()
      return true
    case 'toggle-dock-panel':
      handlers.onToggleDockPanel()
      return true
    case 'close-dock-panel':
      handlers.onCloseDockPanel()
      return true
    case 'toggle-sponsored-dock':
      handlers.onToggleSponsoredDock?.()
      return true
    case 'none':
      return false
  }

  return assertNever(action)
}

/**
 * Hook for handling keyboard input in chat text input contexts.
 * Integrates priority-based action resolution with handlers.
 *
 * This hook handles:
 * - Mode switching (bash, etc.)
 * - Stream interruption
 * - Suggestion menu navigation (slash and mention menus)
 * - History navigation
 * - Agent mode toggle
 * - Exit handling
 *
 * For feedback mode, the hook respects the feedbackMode state and routes
 * escape/ctrl-c appropriately.
 */
export function useChatKeyboard({
  state,
  handlers,
  disabled = false,
}: UseChatKeyboardOptions): void {
  const lastKeyboardActivityRef = useRef<number>(0)

  useKeyboard(
    useCallback(
      (key: KeyEvent) => {
        if (disabled) return

        // Report keyboard activity for activity-aware features (throttled)
        const now = Date.now()
        if (now - lastKeyboardActivityRef.current > KEYBOARD_ACTIVITY_THROTTLE_MS) {
          lastKeyboardActivityRef.current = now
          reportActivity()
        }

        markReturnKeySeenForKey(key)

        const action = resolveChatKeyboardAction(key, state)
        const handled = dispatchAction(action, handlers)

        // Prevent default for handled actions
        if (
          handled &&
          'preventDefault' in key &&
          typeof key.preventDefault === 'function'
        ) {
          key.preventDefault()
        }
      },
      [state, handlers, disabled],
    ),
  )
}
