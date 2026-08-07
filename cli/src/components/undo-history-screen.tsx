import { TextAttributes } from '@opentui/core'
import React, { useCallback, useMemo, useState } from 'react'

import { Button } from './button'
import { MultilineInput } from './multiline-input'
import { SelectableList } from './selectable-list'
import { useSearchableList } from '../hooks/use-searchable-list'
import { useTerminalLayout } from '../hooks/use-terminal-layout'
import { useTheme } from '../hooks/use-theme'
import { getCurrentChatId } from '../project-files'
import { listRedoEntries, listUndoEntries } from '../state/undo-store'
import { formatRelativeTime } from '../utils/chat-history'
import { isPlainEnterKey } from '../utils/terminal-enter-detection'

import type { SelectableListItem } from './selectable-list'
import type { UndoRecord } from '../state/undo-store'

const LAYOUT = {
  CONTENT_PADDING: 4,
  COMPACT_MODE_THRESHOLD: 20, // Hide header when terminal height is below this
  NARROW_WIDTH_THRESHOLD: 70, // Hide buttons when terminal width is below this
  TIME_COL_WIDTH: 12, // e.g., "2 hours ago"
  FILES_COL_WIDTH: 8, // e.g., "12 files"
  GAP_WIDTH: 3, // gap between columns
  MAX_VISIBLE_FILES: 10, // files shown in the preview panel before truncating
} as const

interface UndoHistoryScreenProps {
  /** Which stack this screen is showing. */
  mode: 'undo' | 'redo'
  onSelect: (recordId: string) => void
  onCancel: () => void
}

export const UndoHistoryScreen: React.FC<UndoHistoryScreenProps> = ({
  mode,
  onSelect,
  onCancel,
}) => {
  const theme = useTheme()
  const { terminalWidth, terminalHeight } = useTerminalLayout()
  const contentWidth = terminalWidth - LAYOUT.CONTENT_PADDING

  // Load the stack once at mount, newest first for display.
  const entries = useMemo(() => {
    const chatId = getCurrentChatId()
    const stack =
      mode === 'undo' ? listUndoEntries(chatId) : listRedoEntries(chatId)
    return [...stack].reverse()
  }, [mode])

  const isCompactMode = terminalHeight < LAYOUT.COMPACT_MODE_THRESHOLD
  const isNarrowWidth = terminalWidth < LAYOUT.NARROW_WIDTH_THRESHOLD
  const [cancelHovered, setCancelHovered] = useState(false)

  // Format: "[time]   [n files]   [prompt title]"
  // reservedWidth accounts for: time col, files col, 2 gaps, list border (2),
  // scrollbar (1), and button padding (2).
  const reservedWidth =
    LAYOUT.TIME_COL_WIDTH +
    LAYOUT.FILES_COL_WIDTH +
    LAYOUT.GAP_WIDTH * 2 +
    5
  const maxPromptWidth = Math.max(20, contentWidth - reservedWidth)

  const truncateText = (text: string, maxLen: number): string => {
    const singleLine = text.replace(/\n/g, ' ').trim()
    if (singleLine.length <= maxLen) return singleLine
    return singleLine.slice(0, maxLen - 1) + '…'
  }

  const padRight = (text: string, width: number): string => {
    // Count code points so emoji/wide chars don't break padding
    const len = Array.from(text).length
    if (len >= width) return text
    return text + ' '.repeat(width - len)
  }

  const items: SelectableListItem[] = useMemo(
    () =>
      entries.map((record) => {
        const time = padRight(
          formatRelativeTime(new Date(record.createdAt)),
          LAYOUT.TIME_COL_WIDTH,
        )
        const fileCount = padRight(
          `${record.files.length} file${record.files.length === 1 ? '' : 's'}`,
          LAYOUT.FILES_COL_WIDTH,
        )
        const title = padRight(
          truncateText(record.message, maxPromptWidth),
          maxPromptWidth,
        )
        return {
          id: record.id,
          label: `${time}${' '.repeat(LAYOUT.GAP_WIDTH)}${fileCount}${' '.repeat(LAYOUT.GAP_WIDTH)}${title}`,
          // Keep the original prompt + files for search filtering.
          secondary: `${record.message} ${record.files.join(' ')}`,
          hideSecondary: true,
        }
      }),
    [entries, maxPromptWidth],
  )

  const filterByPromptAndFiles = useCallback(
    (item: SelectableListItem, query: string) =>
      (item.secondary ?? '').toLowerCase().includes(query.toLowerCase()),
    [],
  )

  const {
    searchQuery,
    setSearchQuery,
    focusedIndex,
    setFocusedIndex,
    filteredItems,
    handleFocusChange,
  } = useSearchableList({
    items,
    filterFn: filterByPromptAndFiles,
  })

  // The record behind the currently focused row, for the files panel.
  const focusedRecord: UndoRecord | undefined = useMemo(() => {
    const focused = filteredItems[focusedIndex]
    if (!focused) return undefined
    return entries.find((record) => record.id === focused.id)
  }, [filteredItems, focusedIndex, entries])

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
        const maxIndex = Math.max(0, filteredItems.length - 1)
        setFocusedIndex((prev) => Math.min(maxIndex, prev + 1))
        return true
      }
      if (isPlainEnterKey(key)) {
        const focused = filteredItems[focusedIndex]
        if (focused) {
          onSelect(focused.id)
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
      onSelect,
      onCancel,
    ],
  )

  const actionVerb = mode === 'undo' ? 'undo' : 'redo'
  const emptyMessage =
    entries.length === 0
      ? mode === 'undo'
        ? 'Nothing to undo yet'
        : 'Nothing to redo yet'
      : searchQuery
        ? 'No matching changes'
        : 'No changes found'

  const visibleFiles =
    focusedRecord?.files.slice(0, LAYOUT.MAX_VISIBLE_FILES) ?? []
  const hiddenFiles =
    (focusedRecord?.files.length ?? 0) - visibleFiles.length

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
              {mode === 'undo'
                ? 'Select a change to undo'
                : 'Select a change to redo'}
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
            placeholder="Search changes..."
            focused={true}
            maxHeight={1}
            minHeight={1}
            cursorPosition={searchQuery.length}
          />
        </box>

        {/* Change list - grows to fill remaining space */}
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
            items={filteredItems}
            focusedIndex={focusedIndex}
            onSelect={(item) => onSelect(item.id)}
            onFocusChange={handleFocusChange}
            emptyMessage={emptyMessage}
          />
        </box>

        {/* Files preview for the focused entry */}
        <box
          style={{
            flexDirection: 'column',
            width: contentWidth,
            borderStyle: 'single',
            borderColor: theme.muted,
            flexShrink: 0,
            paddingLeft: 1,
            paddingRight: 1,
          }}
          border={['top', 'bottom', 'left', 'right']}
        >
          <text
            style={{ fg: theme.foreground, attributes: TextAttributes.BOLD }}
          >
            {focusedRecord
              ? `Files (${focusedRecord.files.length})`
              : 'Files'}
          </text>
          {visibleFiles.map((file) => (
            <text key={file} style={{ fg: theme.muted }}>
              {`  • ${file}`}
            </text>
          ))}
          {hiddenFiles > 0 && (
            <text style={{ fg: theme.muted }}>
              {`  … and ${hiddenFiles} more`}
            </text>
          )}
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
          <box style={{ flexGrow: 1, flexShrink: 1 }}>
            <text style={{ fg: theme.muted }}>
              {`↑↓ navigate · Enter ${actionVerb} · Click to ${actionVerb} · Esc cancel`}
            </text>
          </box>

          {!isNarrowWidth && (
            <box style={{ flexDirection: 'row', gap: 1 }}>
              <Button
                onClick={onCancel}
                onMouseOver={() => setCancelHovered(true)}
                onMouseOut={() => setCancelHovered(false)}
                style={{
                  paddingLeft: 2,
                  paddingRight: 2,
                  paddingTop: 0,
                  paddingBottom: 0,
                  borderStyle: 'single',
                  borderColor: cancelHovered ? theme.foreground : theme.muted,
                }}
                border={['top', 'bottom', 'left', 'right']}
              >
                <text
                  style={{
                    fg: cancelHovered ? theme.foreground : theme.muted,
                  }}
                >
                  Cancel
                </text>
              </Button>
            </box>
          )}
        </box>
      </box>
    </box>
  )
}
