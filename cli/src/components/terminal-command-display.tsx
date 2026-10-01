import { TextAttributes } from '@opentui/core'
import { useState } from 'react'

import { Button } from './button'
import { useTerminalDimensions } from '../hooks/use-terminal-dimensions'
import { useTheme } from '../hooks/use-theme'
import { formatTimeout } from '../utils/format-timeout'
import { getLastNVisualLines } from '../utils/text-layout'

interface TerminalCommandDisplayProps {
  command: string
  output: string | null
  /** Whether to show an expandable "Show more" button for long output */
  expandable?: boolean
  /** Max lines to show before truncation (default 5 for expandable, 10 for non-expandable) */
  maxVisibleLines?: number
  /** Whether command is still running */
  isRunning?: boolean
  /** Working directory where the command was run */
  cwd?: string
  /** Timeout in seconds for the command */
  timeoutSeconds?: number
  /** Optional width override for wrapping calculations */
  availableWidth?: number
}

/**
 * Shared component for displaying terminal command with output.
 * Used in both the ghost message (pending bash) and message history.
 */
export const TerminalCommandDisplay = ({
  command,
  output,
  expandable = true,
  maxVisibleLines,
  isRunning = false,
  timeoutSeconds,
  availableWidth,
}: TerminalCommandDisplayProps) => {
  const theme = useTheme()
  const { separatorWidth } = useTerminalDimensions()
  const [isExpanded, setIsExpanded] = useState(false)

  // Default max lines depends on whether expandable
  const defaultMaxLines = expandable ? 5 : 10
  const maxLines = maxVisibleLines ?? defaultMaxLines

  // Format timeout display - show when provided and not the default (30s)
  const DEFAULT_TIMEOUT_SECONDS = 30
  const timeoutLabel =
    timeoutSeconds !== undefined && timeoutSeconds !== DEFAULT_TIMEOUT_SECONDS
      ? formatTimeout(timeoutSeconds)
      : null

  // Command header - shared between output and no-output cases
  const commandHeader = (
    <text style={{ wrapMode: 'word' }}>
      <span fg={theme.success}>$ </span>
      <span fg={theme.foreground} attributes={TextAttributes.BOLD}>
        {command}
      </span>
      {timeoutLabel && (
        <span fg={theme.muted} attributes={TextAttributes.DIM}>
          {' '}({timeoutLabel})
        </span>
      )}
    </text>
  )

  // No output case
  if (!output) {
    return (
      <box style={{ flexDirection: 'column', gap: 0, width: '100%' }}>
        {commandHeader}
        {/* Running indicator */}
        {isRunning && <text fg={theme.muted}>...</text>}
      </box>
    )
  }

  // With output - calculate visual lines
  const width = Math.max(10, availableWidth ?? separatorWidth)
  const allLines = output.split('\n')

  // Calculate total visual lines across all output lines
  let totalVisualLines = 0
  const visualLinesByOriginalLine: string[][] = []

  for (const line of allLines) {
    const { lines: wrappedLines } = getLastNVisualLines(line, width, Infinity)
    visualLinesByOriginalLine.push(wrappedLines)
    totalVisualLines += wrappedLines.length
  }

  const hasMoreLines = totalVisualLines > maxLines
  const hiddenLinesCount = totalVisualLines - maxLines

  // Build display output
  let displayOutput: string
  if (isExpanded || !hasMoreLines) {
    displayOutput = output
  } else {
    // Take first N visual lines
    const displayLines: string[] = []
    let count = 0

    for (const wrappedLines of visualLinesByOriginalLine) {
      for (const line of wrappedLines) {
        if (count >= maxLines) break
        displayLines.push(line)
        count++
      }
      if (count >= maxLines) break
    }

    displayOutput = displayLines.join('\n')
  }

  return (
    <box style={{ flexDirection: 'column', gap: 0, width: '100%' }}>
      {commandHeader}
      {/* Output */}
      <box style={{ flexDirection: 'column', gap: 0, width: '100%' }}>
        {hasMoreLines && !expandable && (
          <text fg={theme.muted} attributes={TextAttributes.DIM}>
            ... ({hiddenLinesCount} more lines above)
          </text>
        )}
        <text fg={theme.muted} style={{ wrapMode: 'word' }}>
          {displayOutput}
        </text>
        {hasMoreLines && expandable && (
          <Button
            style={{ marginTop: 0 }}
            onClick={() => setIsExpanded(!isExpanded)}
          >
            <text
              fg={theme.secondary}
              style={{ wrapMode: 'word' }}
              attributes={TextAttributes.UNDERLINE}
            >
              {isExpanded
                ? 'Show less'
                : `Show ${hiddenLinesCount} more ${hiddenLinesCount === 1 ? 'line' : 'lines'}`}
            </text>
          </Button>
        )}
      </box>
    </box>
  )
}
