import { TextAttributes } from '@opentui/core'
import React, { memo, type ReactNode } from 'react'

import { Button } from './button'
import { useTerminalDimensions } from '../hooks/use-terminal-dimensions'
import { useTheme } from '../hooks/use-theme'
import { getLastNVisualLines } from '../utils/text-layout'

import type { ThinkingCollapseState } from '../types/chat'

const PREVIEW_LINE_COUNT = 5

interface ThinkingProps {
  content: string
  thinkingCollapseState: ThinkingCollapseState
  /** Whether the thinking has completed (streaming finished) */
  isThinkingComplete: boolean
  onToggle: () => void
  availableWidth?: number
}

export const Thinking = memo(
  ({
    content,
    thinkingCollapseState,
    isThinkingComplete,
    onToggle,
    availableWidth,
  }: ThinkingProps): ReactNode => {
    const theme = useTheme()
    const { contentMaxWidth } = useTerminalDimensions()

    // Special case: single **bold** string under 100 chars gets compact rendering
    const singleBoldMatch = content.length < 100 ? content.trim().match(/^\*\*([^*]+)\*\*$/) : null
    if (singleBoldMatch) {
      return (
        null
      )
    }

    const showFull = thinkingCollapseState === 'expanded'
    const isPreviewCandidate = thinkingCollapseState === 'preview'

    let lines: string[] = []
    let hasMore = false
    if (isPreviewCandidate) {
      const width = Math.max(10, availableWidth ?? contentMaxWidth)
      // Normalize content to single line for consistent preview (but preserve in expanded mode)
      const normalizedContent = content.replace(/\n+/g, ' ').trim()
      // Account for "..." prefix (3 chars) when calculating line widths
      const effectiveWidth = width - 3
      const result = getLastNVisualLines(
        normalizedContent,
        effectiveWidth,
        PREVIEW_LINE_COUNT,
      )
      lines = result.lines
      hasMore = result.hasMore
    }

    // In expanded mode, preserve original line breaks for proper markdown rendering
    const expandedContent = showFull
      ? content.replace(/\n\n+/g, '\n\n').trim()
      : ''

    const showPreview = isPreviewCandidate && lines.length > 0

    const toggleIndicator =
      !isThinkingComplete ? '• '
        : showFull ? '▾ '
          : showPreview ? '• '
            : '▸ '

    return (
      <Button
        style={{
          flexDirection: 'column',
          gap: 0,
        }}
        onClick={onToggle}
      >
        <text style={{ fg: theme.foreground }}>
          <span>{toggleIndicator}</span>
          <span attributes={TextAttributes.BOLD}>Thinking</span>
        </text>
        {showPreview && (
          <box style={{ paddingLeft: 2 }}>
            <text
              style={{
                wrapMode: 'none',
                fg: theme.muted,
              }}
              attributes={TextAttributes.ITALIC}
            >
              {hasMore ? '...' + lines.join('\n') : lines.join('\n')}
            </text>
          </box>
        )}
        {showFull && (
          <box style={{ paddingLeft: 2 }}>
            <text
              style={{
                wrapMode: 'word',
                fg: theme.muted,
              }}
              attributes={TextAttributes.ITALIC}
            >
              {expandedContent}
            </text>
          </box>
        )}
      </Button>
    )
  },
)
