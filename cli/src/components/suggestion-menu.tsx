import React, { useEffect, useState } from 'react'

import { Button } from './button'
import { HighlightedSubsequenceText } from './highlighted-text'
import { useTerminalDimensions } from '../hooks/use-terminal-dimensions'
import { useTheme } from '../hooks/use-theme'

export interface SuggestionItem {
  id: string
  label: string
  labelHighlightIndices?: number[] | null
  description: string
  descriptionHighlightIndices?: number[] | null
}

interface SuggestionMenuProps {
  items: SuggestionItem[]
  selectedIndex: number
  maxVisible: number
  prefix?: string
  onItemClick?: (index: number) => void
  /** Muted hint line rendered below the suggestions */
  footer?: string
  /**
   * An extra row drawn directly under one item, when that item is visible.
   *
   * NOT AN ITEM. It takes no index, so `selectedIndex`, the scroll window and
   * every keyboard action stay a function of `items` alone — the row cannot
   * be selected with the arrow keys and Enter never lands on it. Only a click
   * reaches it.
   *
   * It exists for the partner placement under `/review`, which is the
   * advertiser's own chrome next to the command it is about. A menu entry
   * would have been a command that is not a command.
   */
  afterItem?: { id: string; node: React.ReactNode }
}

export const SuggestionMenu = ({
  items,
  selectedIndex,
  maxVisible,
  prefix = '/',
  onItemClick,
  footer,
  afterItem,
}: SuggestionMenuProps) => {
  const theme = useTheme()
  const { terminalWidth } = useTerminalDimensions()
  const screenPadding = 4
  const menuWidth = Math.max(10, terminalWidth - screenPadding * 2)

  // Hover state: only highlight on hover after user has moved mouse
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null)
  const [hasHoveredSinceOpen, setHasHoveredSinceOpen] = useState(false)

  // Reset hover state when items change (new menu session)
  useEffect(() => {
    setHasHoveredSinceOpen(false)
    setHoveredIndex(null)
  }, [items])

  if (items.length === 0) {
    return null
  }

  const effectivePrefix = prefix ?? ''

  const clampedSelected = Math.min(
    Math.max(selectedIndex, 0),
    Math.max(items.length - 1, 0),
  )
  const visibleCount = Math.min(Math.max(maxVisible, 1), items.length)

  const maxStart = Math.max(items.length - visibleCount, 0)
  const idealStart = clampedSelected - Math.floor((visibleCount - 1) / 2)
  const start = Math.max(0, Math.min(idealStart, maxStart))
  const visibleItems = items.slice(start, start + visibleCount)

  // Calculate max label length for alignment
  const maxLabelLength = Math.max(
    ...visibleItems.map(
      (item) => effectivePrefix.length + item.label.length,
    ),
  )

  // Find the longest description to determine if we can use same-line layout
  const maxDescriptionLength = Math.max(
    ...visibleItems.map((item) => item.description.length),
  )

  // Check if all items can fit on same line with aligned descriptions
  const minWidthForSameLine = maxLabelLength + 2 + maxDescriptionLength
  const useSameLine = menuWidth >= minWidthForSameLine

  const renderSuggestionItem = (item: SuggestionItem, idx: number) => {
    const absoluteIndex = start + idx
    const isSelected = absoluteIndex === clampedSelected
    const isHovered = hasHoveredSinceOpen && absoluteIndex === hoveredIndex
    const isHighlighted = isSelected || isHovered
    const labelLength = effectivePrefix.length + item.label.length
    const textColor = isHighlighted ? theme.foreground : theme.inputFg
    const descriptionColor = isHighlighted ? theme.foreground : theme.muted
    const highlightColor = theme.primary

    const handleClick = onItemClick ? () => onItemClick(absoluteIndex) : undefined
    const handleMouseOver = () => {
      setHoveredIndex(absoluteIndex)
      setHasHoveredSinceOpen(true)
    }

    if (useSameLine) {
      // Calculate padding to align descriptions
      const paddingLength = maxLabelLength - labelLength
      const padding = ' '.repeat(paddingLength)
      // Wide terminal: description on same line with 2-space gap
      return (
        <Button
          key={item.id}
          onClick={handleClick}
          onMouseOver={handleMouseOver}
          style={{
            flexDirection: 'column',
            gap: 0,
            paddingLeft: 1,
            paddingRight: 1,
            paddingTop: 0,
            paddingBottom: 0,
            backgroundColor: isHighlighted ? theme.surfaceHover : theme.background,
            width: '100%',
          }}
        >
          <text
            style={{
              fg: textColor,
              marginBottom: 0,
            }}
          >
            <span fg={theme.primary}>{effectivePrefix}</span>
            <HighlightedSubsequenceText
              text={item.label}
              indices={item.labelHighlightIndices}
              color={textColor}
              highlightColor={highlightColor}
            />
            <span>{padding}  </span>
            <HighlightedSubsequenceText
              text={item.description}
              indices={item.descriptionHighlightIndices}
              color={descriptionColor}
              highlightColor={highlightColor}
            />
          </text>
        </Button>
      )
    } else {
      // Narrow terminal: description on next line
      return (
        <Button
          key={item.id}
          onClick={handleClick}
          onMouseOver={handleMouseOver}
          style={{
            flexDirection: 'column',
            gap: 0,
            paddingLeft: 1,
            paddingRight: 1,
            paddingTop: 0,
            paddingBottom: 0,
            backgroundColor: isHighlighted ? theme.surfaceHover : theme.background,
            width: '100%',
          }}
        >
          <text
            style={{
              fg: textColor,
              marginBottom: 0,
            }}
          >
            <span fg={theme.primary}>{effectivePrefix}</span>
            <HighlightedSubsequenceText
              text={item.label}
              indices={item.labelHighlightIndices}
              color={textColor}
              highlightColor={highlightColor}
            />
          </text>
          <text
            style={{
              fg: descriptionColor,
              marginBottom: 0,
              marginLeft: 2,
            }}
          >
            <HighlightedSubsequenceText
              text={item.description}
              indices={item.descriptionHighlightIndices}
              color={descriptionColor}
              highlightColor={highlightColor}
            />
          </text>
        </Button>
      )
    }
  }

  return (
    <box
      style={{
        flexDirection: 'column',
        gap: 0,
        paddingLeft: 0,
        paddingRight: 0,
        paddingTop: 0,
        paddingBottom: 0,
        backgroundColor: theme.surface,
        width: '100%',
      }}
      onMouseOut={() => setHoveredIndex(null)}
    >
      {visibleItems.map((item, idx) =>
        afterItem && item.id === afterItem.id ? (
          <React.Fragment key={item.id}>
            {renderSuggestionItem(item, idx)}
            {afterItem.node}
          </React.Fragment>
        ) : (
          renderSuggestionItem(item, idx)
        ),
      )}
      {footer ? (
        <box style={{ paddingLeft: 1, paddingRight: 1 }}>
          <text style={{ fg: theme.muted, wrapMode: 'word' }}>{footer}</text>
        </box>
      ) : null}
    </box>
  )
}
