import { TextAttributes } from '@opentui/core'
import React, { memo, type ReactNode } from 'react'

import { AgentBranchWrapper } from './agent-branch-wrapper'
import { AgentListBranch } from './agent-list-branch'
import { AskUserBranch } from './ask-user-branch'
import { trimNewlines, isReasoningTextBlock } from './block-helpers'
import { ContentWithMarkdown } from './content-with-markdown'
import { ImageBlock } from './image-block'
import { UserBlockTextWithInlineCopy } from './user-content-copy'
import { useTheme } from '../../hooks/use-theme'
import { PlanBox } from '../renderers/plan-box'

import type {
  ContentBlock,
  TextContentBlock,
  ImageContentBlock,
} from '../../types/chat'
import type { MarkdownPalette } from '../../utils/markdown-renderer'

interface SingleBlockProps {
  block: ContentBlock
  idx: number
  messageId: string
  blocks?: ContentBlock[]
  isLoading: boolean
  isComplete?: boolean
  isUser: boolean
  textColor: string
  availableWidth: number
  markdownPalette: MarkdownPalette
  onToggleCollapsed: (id: string) => void
  onBuildFast: () => void
  onBuildMax: () => void
  onBuildLite: () => void
  isLastMessage?: boolean
  contentToCopy?: string
}

export const SingleBlock = memo(
  ({
    block,
    idx,
    messageId,
    blocks,
    isLoading,
    isComplete,
    isUser,
    textColor,
    availableWidth,
    markdownPalette,
    onToggleCollapsed,
    onBuildFast,
    onBuildMax,
    onBuildLite,
    isLastMessage,
    contentToCopy,
  }: SingleBlockProps): ReactNode => {
    const theme = useTheme()
    const codeBlockWidth = Math.max(10, availableWidth - 8)

    switch (block.type) {
      case 'text': {
        if (isReasoningTextBlock(block)) {
          return null
        }
        const textBlock = block as TextContentBlock
        const isStreamingText = isLoading || !isComplete
        const filteredContent = isStreamingText
          ? trimNewlines(textBlock.content)
          : textBlock.content.trim()
        if (!filteredContent) {
          return null
        }
        const renderKey = `${messageId}-text-${idx}`
        const explicitColor = textBlock.color
        const blockTextColor = explicitColor ?? textColor

        if (contentToCopy) {
          return (
            <UserBlockTextWithInlineCopy
              key={renderKey}
              content={filteredContent}
              contentToCopy={contentToCopy}
              isStreaming={isStreamingText}
              textColor={blockTextColor}
              codeBlockWidth={codeBlockWidth}
              palette={markdownPalette}
              marginTop={0}
              marginBottom={0}
            />
          )
        }

        return (
          <text
            key={renderKey}
            style={{
              wrapMode: 'word',
              fg: blockTextColor,
            }}
            attributes={isUser ? TextAttributes.ITALIC : undefined}
          >
            <ContentWithMarkdown
              content={filteredContent}
              isStreaming={isStreamingText}
              codeBlockWidth={codeBlockWidth}
              palette={markdownPalette}
            />
          </text>
        )
      }

      case 'plan': {
        return (
          <box key={`${messageId}-plan-${idx}`} style={{ width: '100%' }}>
            <PlanBox
              planContent={block.content}
              availableWidth={availableWidth}
              markdownPalette={markdownPalette}
              onBuildFast={onBuildFast}
              onBuildMax={onBuildMax}
              onBuildLite={onBuildLite}
            />
          </box>
        )
      }

      case 'html': {
        return (
          <box
            key={`${messageId}-html-${idx}`}
            style={{
              flexDirection: 'column',
              gap: 0,
              width: '100%',
            }}
          >
            {block.render({ textColor, theme })}
          </box>
        )
      }

      case 'tool': {
        return null
      }

      case 'ask-user': {
        return (
          <AskUserBranch
            key={`${messageId}-ask-user-${idx}`}
            block={block}
            availableWidth={availableWidth}
          />
        )
      }

      case 'sponsored-proposal': {
        // Drawn in the DOCK, not here: the block is the proposal's state, and
        // the dock above the composer is its one slot (`chat.tsx`).
        return null
      }

      case 'image': {
        return (
          <ImageBlock
            key={`${messageId}-image-${idx}`}
            block={block as ImageContentBlock}
            availableWidth={availableWidth}
          />
        )
      }

      case 'agent': {
        return (
          <AgentBranchWrapper
            key={`${messageId}-agent-${block.agentId}`}
            agentBlock={block}
            keyPrefix={`${messageId}-agent-${block.agentId}`}
            availableWidth={availableWidth}
            markdownPalette={markdownPalette}
            onToggleCollapsed={onToggleCollapsed}
            onBuildFast={onBuildFast}
            onBuildMax={onBuildMax}
            onBuildLite={onBuildLite}
            siblingBlocks={blocks}
            isLastMessage={isLastMessage}
          />
        )
      }

      case 'agent-list': {
        return (
          <AgentListBranch
            key={`${messageId}-agent-list-${block.id}`}
            agentListBlock={block}
            keyPrefix={`${messageId}-agent-list-${block.id}`}
            onToggleCollapsed={onToggleCollapsed}
          />
        )
      }

      default:
        return null
    }
  },
)
