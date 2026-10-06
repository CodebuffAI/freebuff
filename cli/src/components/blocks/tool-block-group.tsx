import React, { memo, type ReactNode } from 'react'

import { ToolBranch } from './tool-branch'

import type { ContentBlock } from '../../types/chat'
import type { MarkdownPalette } from '../../utils/markdown-renderer'

interface ToolBlockGroupProps {
  toolBlocks: Extract<ContentBlock, { type: 'tool' }>[]
  keyPrefix: string
  startIndex: number
  availableWidth: number
  onToggleCollapsed: (id: string) => void
  markdownPalette: MarkdownPalette
}

export const ToolBlockGroup = memo(
  ({
    toolBlocks,
    keyPrefix,
    startIndex,
    availableWidth,
    onToggleCollapsed,
    markdownPalette,
  }: ToolBlockGroupProps): ReactNode => {
    const groupNodes = toolBlocks
      .map((toolBlock) => (
        <ToolBranch
          key={`${keyPrefix}-tool-${toolBlock.toolCallId}`}
          toolBlock={toolBlock}
          keyPrefix={`${keyPrefix}-tool-${toolBlock.toolCallId}`}
          availableWidth={availableWidth}
          onToggleCollapsed={onToggleCollapsed}
          markdownPalette={markdownPalette}
        />
      ))
      .filter(Boolean)

    if (groupNodes.length === 0) return null

    return (
      <box
        key={`${keyPrefix}-tool-group-${startIndex}`}
        style={{
          flexDirection: 'column',
          gap: 0,
        }}
      >
        {groupNodes}
      </box>
    )
  },
)
