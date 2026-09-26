import React from 'react'
import { TextAttributes } from '@opentui/core'

import { useTheme } from '../hooks/use-theme'
import { useTerminalDimensions } from '../hooks/use-terminal-dimensions'
import { IS_FREEBUFF } from '../utils/constants'

const SECTIONS = [
  {
    title: 'Compose',
    rows: [
      ['/', 'Commands'],
      ['@files', 'Mention files'],
      ['@agents', 'Use an agent'],
      ['Ctrl+J', 'New line'],
      ['Opt+Enter', 'New line'],
      ['/bash', 'Shell command'],
    ],
  },
  {
    title: 'Chat',
    rows: [
      ['?', 'Help (empty input)'],
      ['←', 'History (empty input)'],
      ['↑ / ↓', 'Prompts (empty input)'],
      ['/new', 'New chat'],
      ['/model', 'Model / reasoning'],
      ['Ctrl+Q', 'Edit queued messages'],
    ],
  },
  {
    title: 'Conversation',
    rows: [
      ['Esc', 'Close help / stop'],
      ['Ctrl+C', 'Clear / stop / quit'],
      ['Ctrl+T', 'Expand / collapse agents'],
      ['/copy', 'Copy chat'],
      ['/export', 'Export chat'],
      ['Drag', 'Select and copy text'],
    ],
  },
] as const

/** Aligned shortcut columns; wrap whole columns on smaller terminals. */
export const HelpBanner = () => {
  const theme = useTheme()
  const { terminalWidth, terminalHeight } = useTerminalDimensions()
  const width = Math.max(16, terminalWidth - 4)
  const columnWidth = Math.min(37, width)
  const columns = Math.max(1, Math.floor((width + 2) / (columnWidth + 2)))
  const contentRows = Math.ceil(SECTIONS.length / columns) * 8 - 1 + (IS_FREEBUFF ? 0 : 2)
  return (
    <box
      style={{
        flexDirection: 'column',
        paddingLeft: 1,
        paddingRight: 1,
        marginBottom: 1,
        flexShrink: 0,
      }}
    >
      <text
        style={{
          fg: theme.foreground,
          attributes: TextAttributes.BOLD,
          marginBottom: 1,
        }}
      >
        Keyboard shortcuts
      </text>
      <scrollbox
        style={{
          height: Math.min(contentRows, Math.max(5, Math.floor(terminalHeight / 2))),
          width: '100%',
        }}
        scrollX={false}
      >
        <box
          style={{
            flexDirection: 'row',
            flexWrap: 'wrap',
            columnGap: 2,
            rowGap: 1,
          }}
        >
          {SECTIONS.map((section) => (
            <box
              key={section.title}
              style={{
                flexDirection: 'column',
                width: columnWidth,
                flexShrink: 0,
              }}
            >
              <text
                style={{
                  fg: theme.foreground,
                  attributes: TextAttributes.BOLD,
                }}
              >
                {section.title}
              </text>
              {section.rows
                .filter(([key]) => IS_FREEBUFF || key !== '/model')
                .map(([key, description]) => (
                  <box key={key} style={{ flexDirection: 'row' }}>
                    <text
                      style={{ fg: theme.primary, width: 11, flexShrink: 0 }}
                    >
                      {key}
                    </text>
                    <text
                      style={{
                        fg: theme.muted,
                        flexShrink: 1,
                        flexGrow: 1,
                        flexBasis: 0,
                        wrapMode: 'word',
                      }}
                    >
                      {description}
                    </text>
                  </box>
                ))}
            </box>
          ))}
        </box>
        {!IS_FREEBUFF && (
          <text style={{ fg: theme.muted, marginTop: 1 }}>
            /subscribe · /usage · 1 credit = 1 cent
          </text>
        )}
      </scrollbox>
    </box>
  )
}
