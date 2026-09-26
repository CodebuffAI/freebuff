import { TextAttributes } from '@opentui/core'
import React, { useCallback, useEffect, useMemo, useState } from 'react'

import { Button } from './button'
import { MultilineInput } from './multiline-input'
import { SelectableList } from './selectable-list'
import { useSearchableList } from '../hooks/use-searchable-list'
import { useTerminalLayout } from '../hooks/use-terminal-layout'
import { useTheme } from '../hooks/use-theme'
import {
  deleteChatSession,
  formatRelativeTime,
  getAllChats,
} from '../utils/chat-history'
import { isPlainEnterKey } from '../utils/terminal-enter-detection'

import type { SelectableListItem } from './selectable-list'

const LAYOUT = {
  CONTENT_PADDING: 4,
  COMPACT_MODE_THRESHOLD: 20, // Hide header when terminal height is below this
  NARROW_WIDTH_THRESHOLD: 70, // Hide buttons when terminal width is below this
  MAIN_CONTENT_PADDING: 2,
  INITIAL_CHATS: 25, // Load this many immediately for fast display
  BACKGROUND_CHATS: 475, // Load this many more in the background for search
  MAX_RENDERED_CHATS: 100, // Only render this many in the list
  TIME_COL_WIDTH: 12, // e.g., "2 hours ago"
  MSGS_COL_WIDTH: 8, // e.g., "99 msgs"
  DELETE_COL_WIDTH: 6, // e.g., "[×]" + marginRight
  GAP_WIDTH: 3, // gap between columns
} as const

interface ChatHistoryScreenProps {
  onSelectChat: (chatId: string) => void
  onCancel: () => void
  onNewChat: () => void
}

export const ChatHistoryScreen: React.FC<ChatHistoryScreenProps> = ({
  onSelectChat,
  onCancel,
  onNewChat,
}) => {
  const theme = useTheme()
  const { terminalWidth, terminalHeight } = useTerminalLayout()

  // Layout calculations - use full width
  const contentWidth = terminalWidth - LAYOUT.CONTENT_PADDING

  // Two-phase loading: load initial chats immediately, then more in background
  const [chats, setChats] = useState(() => getAllChats(LAYOUT.INITIAL_CHATS))
  const [statusMessage, setStatusMessage] = useState<string | null>(null)

  // Load more chats in the background after initial render
  useEffect(() => {
    // Use setTimeout to defer the expensive loading to after first paint
    const timer = setTimeout(() => {
      setChats(getAllChats(LAYOUT.INITIAL_CHATS + LAYOUT.BACKGROUND_CHATS))
    }, 0)
    return () => clearTimeout(timer)
  }, [])

  const handleDeleteChat = useCallback((chatId: string) => {
    const deleted = deleteChatSession(chatId)
    if (deleted) {
      setChats((prev) => prev.filter((chat) => chat.chatId !== chatId))
      setStatusMessage('Chat deleted')
      return
    }

    setStatusMessage('Could not delete chat')
  }, [])

  // Calculate available width for the prompt text (last column, variable width)
  // Format: "[time]   [msgs]   [prompt...] [×]"
  // reservedWidth accounts for: time col, msgs col, delete button area,
  // 2 gaps between columns, list border (2), scrollbar (1), and button padding (2)
  const reservedWidth =
    LAYOUT.TIME_COL_WIDTH +
    LAYOUT.MSGS_COL_WIDTH +
    LAYOUT.DELETE_COL_WIDTH +
    LAYOUT.GAP_WIDTH * 2 +
    5 // border + scrollbar + button padding
  const maxPromptWidth = Math.max(20, contentWidth - reservedWidth)

  // Truncate text to fit single line
  const truncateText = (text: string, maxLen: number): string => {
    const singleLine = text.replace(/\n/g, ' ').trim()
    if (singleLine.length <= maxLen) return singleLine
    return singleLine.slice(0, maxLen - 1) + '…'
  }

  // Pad text to fixed width (right-pad with spaces)
  const padRight = (text: string, width: number): string => {
    // Use Array.from to count code points so emoji/wide chars don't break padding
    const len = Array.from(text).length
    if (len >= width) return text
    return text + ' '.repeat(width - len)
  }

  // Convert chats to SelectableListItem format with aligned columns
  // Order: time | message count | prompt
  const chatItems: SelectableListItem[] = useMemo(
    () =>
      chats.map((chat) => {
        const time = padRight(
          formatRelativeTime(chat.timestamp),
          LAYOUT.TIME_COL_WIDTH,
        )
        const msgs = padRight(
          chat.unreadable ? '—' : `${chat.messageCount} msgs`,
          LAYOUT.MSGS_COL_WIDTH,
        )
        const prompt = padRight(
          truncateText(chat.lastPrompt, maxPromptWidth),
          maxPromptWidth,
        )

        return {
          id: chat.chatId,
          // Combine all columns into label for correct display order: time | msgs | prompt
          // The full prompt is kept in secondary for search filtering
          label: `${time}${' '.repeat(LAYOUT.GAP_WIDTH)}${msgs}${' '.repeat(LAYOUT.GAP_WIDTH)}${prompt}`,
          icon: undefined,
          secondary: chat.lastPrompt, // Keep original prompt for search
          hideSecondary: true, // Don't display secondary, only use for filtering
        }
      }),
    [chats, maxPromptWidth],
  )

  // Custom filter function that searches the original prompt (stored in secondary)
  const filterByPrompt = useCallback(
    (item: SelectableListItem, query: string) =>
      (item.secondary ?? '').toLowerCase().includes(query.toLowerCase()),
    [],
  )

  // Search filtering and focus management
  const {
    searchQuery,
    setSearchQuery,
    focusedIndex,
    setFocusedIndex,
    filteredItems,
    handleFocusChange,
  } = useSearchableList({
    items: chatItems,
    filterFn: filterByPrompt,
  })

  const isCompactMode = terminalHeight < LAYOUT.COMPACT_MODE_THRESHOLD
  const isNarrowWidth = terminalWidth < LAYOUT.NARROW_WIDTH_THRESHOLD

  // No need to calculate listHeight - let flexbox handle it naturally

  // Unreadable chats (corrupt chat-messages.json) can be deleted but not resumed
  const unreadableChatIds = useMemo(
    () => new Set(chats.filter((chat) => chat.unreadable).map((c) => c.chatId)),
    [chats],
  )

  // Handle chat selection
  const selectChat = useCallback(
    (chatId: string) => {
      if (unreadableChatIds.has(chatId)) {
        setStatusMessage("Chat file is corrupted and can't be opened")
        return
      }
      onSelectChat(chatId)
    },
    [onSelectChat, unreadableChatIds],
  )

  const handleChatSelect = useCallback(
    (item: SelectableListItem) => {
      selectChat(item.id)
    },
    [selectChat],
  )

  const handleChatDelete = useCallback(
    (item: SelectableListItem) => {
      handleDeleteChat(item.id)
    },
    [handleDeleteChat],
  )

  // Handle keyboard input
  const handleKeyIntercept = useCallback(
    (key: {
      name?: string
      sequence?: string
      shift?: boolean
      ctrl?: boolean
      meta?: boolean
      option?: boolean
    }) => {
      if (key.name === 'escape') {
        if (searchQuery.length > 0) {
          setSearchQuery('')
        } else {
          onCancel()
        }
        return true
      }
      if (key.name === 'up') {
        setFocusedIndex((prev) => Math.max(0, prev - 1))
        return true
      }
      if (key.name === 'down') {
        const maxIndex =
          Math.min(filteredItems.length, LAYOUT.MAX_RENDERED_CHATS) - 1
        setFocusedIndex((prev) => Math.min(maxIndex, prev + 1))
        return true
      }
      const isPlainRightArrow =
        key.name === 'right' && !key.ctrl && !key.meta && !key.option && !key.shift
      if (isPlainEnterKey(key) || isPlainRightArrow) {
        const focused = filteredItems[focusedIndex]
        if (focused) {
          selectChat(focused.id)
        }
        return true
      }
      if (key.name === 'c' && key.ctrl) {
        onCancel()
        return true
      }
      return false
    },
    [
      searchQuery,
      setSearchQuery,
      setFocusedIndex,
      filteredItems,
      focusedIndex,
      selectChat,
      onCancel,
    ],
  )

  return (
    <box
      style={{
        width: '100%',
        height: '100%',
        backgroundColor: theme.surface,
        padding: 0,
        flexDirection: 'column',
      }}
    >
      {/* Main content area */}
      <box
        style={{
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'flex-start',
          width: '100%',
          paddingLeft: 2,
          paddingRight: 2,
          paddingTop: isCompactMode ? 0 : 1,
          paddingBottom: 0,
          gap: 0,
          flexGrow: 1,
          flexShrink: 1,
        }}
      >
        {/* Title */}
        {!isCompactMode && (
          <box
            style={{
              flexDirection: 'column',
              alignItems: 'center',
              marginBottom: 1,
              marginTop: 1,
              flexShrink: 0,
            }}
          >
            <text
              style={{ fg: theme.foreground, attributes: TextAttributes.BOLD }}
            >
              Select a chat to resume
            </text>
          </box>
        )}

        {/* Search input */}
        <box
          style={{
            width: contentWidth,
            flexShrink: 0,
            marginBottom: 0,
          }}
        >
          <MultilineInput
            value={searchQuery}
            onChange={({ text }) => setSearchQuery(text)}
            onSubmit={() => {}}
            onPaste={() => {}}
            onKeyIntercept={handleKeyIntercept}
            placeholder="Search chats..."
            focused={true}
            maxHeight={1}
            minHeight={1}
            cursorPosition={searchQuery.length}
          />
        </box>

        {/* Chat list - grows to fill remaining space */}
        <box
          style={{
            flexDirection: 'column',
            width: contentWidth,
            borderStyle: 'single',
            borderColor: theme.muted,
            flexGrow: 1,
            flexShrink: 1,
            overflow: 'hidden',
          }}
          border={['top', 'bottom', 'left', 'right']}
        >
          <SelectableList
            items={filteredItems.slice(0, LAYOUT.MAX_RENDERED_CHATS)}
            focusedIndex={focusedIndex}
            onSelect={handleChatSelect}
            actionLabel="[×]"
            onAction={handleChatDelete}
            onFocusChange={handleFocusChange}
            emptyMessage={
              chats.length === 0
                ? 'No chat history yet'
                : searchQuery
                  ? 'No matching chats'
                  : 'No chats found'
            }
          />
        </box>
      </box>

      {/* Bottom bar */}
      <box
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          width: '100%',
          paddingTop: 0,
          paddingBottom: 0,
          borderStyle: 'single',
          borderColor: theme.border,
          flexShrink: 0,
          backgroundColor: theme.surface,
        }}
        border={['top']}
      >
        <box
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            width: contentWidth,
          }}
        >
          {/* Help text */}
          <box style={{ flexGrow: 1, flexShrink: 1 }}>
            <text style={{ fg: theme.muted }}>
              ↑↓ navigate · → / Enter open chat · Click [×] to remove · Esc cancel
            </text>
            {statusMessage && (
              <text style={{ fg: theme.muted }}>
                {' · '}
                {statusMessage}
              </text>
            )}
          </box>

          {/* Buttons - hidden on narrow screens */}
          {!isNarrowWidth && (
            <box style={{ flexDirection: 'row', gap: 1 }}>
              <Button
                onClick={onNewChat}
                style={{
                  paddingLeft: 2,
                  paddingRight: 2,
                  paddingTop: 0,
                  paddingBottom: 0,
                  borderStyle: 'single',
                  borderColor: theme.primary,
                }}
                border={['top', 'bottom', 'left', 'right']}
              >
                <text style={{ fg: theme.primary }}>New Chat</text>
              </Button>
              <Button
                onClick={onCancel}
                style={{
                  paddingLeft: 2,
                  paddingRight: 2,
                  paddingTop: 0,
                  paddingBottom: 0,
                  borderStyle: 'single',
                  borderColor: theme.muted,
                }}
                border={['top', 'bottom', 'left', 'right']}
              >
                <text style={{ fg: theme.muted }}>Cancel</text>
              </Button>
            </box>
          )}
        </box>
      </box>
    </box>
  )
}
