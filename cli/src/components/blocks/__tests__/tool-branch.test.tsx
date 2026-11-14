import { describe, expect, test } from 'bun:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { initializeThemeStore } from '../../../hooks/use-theme'
import { chatThemes, createMarkdownPalette } from '../../../utils/theme-system'
import { ToolBranch } from '../tool-branch'

import type { ToolContentBlock } from '../../../types/chat'

initializeThemeStore()

const palette = createMarkdownPalette(chatThemes.light)

const render = (toolBlock: ToolContentBlock) =>
  renderToStaticMarkup(
    <ToolBranch
      toolBlock={toolBlock}
      keyPrefix="test"
      availableWidth={80}
      onToggleCollapsed={() => {}}
      markdownPalette={palette}
    />,
  )

describe('ToolBranch', () => {
  test('drops a bookkeeping call the agent hides', () => {
    const markup = render({
      type: 'tool',
      toolCallId: 'hidden-output',
      toolName: 'set_output',
      input: { message: 'done' },
      includeToolCall: false,
    })

    expect(markup).toBe('')
  })

  test('still shows a terminal command the agent hides, collapsed to one line', () => {
    const markup = render({
      type: 'tool',
      toolCallId: 'hidden-command',
      toolName: 'run_terminal_command',
      input: {
        command: "set -e\ncat > /tmp/helper.sh << 'EOF'\necho hi\nEOF",
      },
      output: 'ok',
      includeToolCall: false,
    })

    expect(markup).toContain('$ set -e (+3 lines)')
    expect(markup).not.toContain('/tmp/helper.sh')
  })
})
