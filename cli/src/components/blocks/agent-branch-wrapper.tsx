import { TextAttributes } from '@opentui/core'
import React, {
  memo,
  useCallback,
  useMemo,
  useRef,
  type ReactNode,
} from 'react'

import { AgentBlockGrid } from './agent-block-grid'
import { AgentBranchItem } from './agent-branch-item'
import { trimNewlines, sanitizePreview } from './block-helpers'
import { ContentWithMarkdown } from './content-with-markdown'
import { ImplementorGroup } from './implementor-row'
import { ThinkingBlock } from './thinking-block'
import { ToolBlockGroup } from './tool-block-group'
import { useTheme } from '../../hooks/use-theme'
import { useChatStore } from '../../state/chat-store'
import { isTextBlock } from '../../types/chat'
import {
  getAgentDisplayPrompt,
  getBasherFinishedOutputPreview,
} from '../../utils/agent-display'
import { getAgentStatusInfo } from '../../utils/agent-helpers'
import {
  processBlocks,
  type BlockProcessorHandlers,
} from '../../utils/block-processor'
import { getCodeSearcherCollapsedPreview } from '../../utils/code-search-summary'
import {
  shouldRenderAsSimpleText,
  isMultiPromptEditor,
} from '../../utils/constants'
import {
  isImplementorAgent,
  getImplementorIndex,
  getMultiPromptPreview,
} from '../../utils/implementor-helpers'
import { AGENT_CONTENT_HORIZONTAL_PADDING } from '../../utils/layout-helpers'

import type {
  AgentContentBlock,
  ContentBlock,
  TextContentBlock,
  HtmlContentBlock,
  ToolContentBlock,
} from '../../types/chat'
import type { MarkdownPalette } from '../../utils/markdown-renderer'

/**
 * Compute preview text for collapsed agent display.
 * Returns empty string when preview shouldn't be shown (expanded state).
 */
function getCollapsedPreview(
  agentBlock: AgentContentBlock,
  isStreaming: boolean,
  isCollapsed: boolean,
  availableWidth: number,
): string {
  // No preview needed if expanded and not streaming
  if (!isStreaming && !isCollapsed) {
    return ''
  }

  if (!isStreaming) {
    const outputPreview = getBasherFinishedOutputPreview(
      agentBlock,
      Math.max(24, Math.min(120, availableWidth - 4)),
    )
    if (outputPreview) {
      return outputPreview
    }
  }

  // For multi-prompt editors, try progress-focused preview first
  if (isMultiPromptEditor(agentBlock.agentType)) {
    const multiPromptPreview = getMultiPromptPreview(
      agentBlock.blocks,
      agentBlock.status === 'complete',
    )
    if (multiPromptPreview) {
      return multiPromptPreview
    }
  }

  const codeSearcherPreview = getCodeSearcherCollapsedPreview(agentBlock)
  if (codeSearcherPreview) {
    return codeSearcherPreview
  }

  // Default preview: use the displayed prompt or first line of text content.
  const displayPrompt = getAgentDisplayPrompt(agentBlock)
  if (displayPrompt) {
    return sanitizePreview(displayPrompt)
  }

  const textContent =
    agentBlock.blocks
      ?.filter(isTextBlock)
      .map((b) => b.content)
      .join('') || ''
  const firstLine = textContent.split('\n').find((line) => line.trim()) || ''
  return `${sanitizePreview(firstLine)}...`
}

interface AgentBodyProps {
  agentBlock: Extract<ContentBlock, { type: 'agent' }>
  keyPrefix: string
  parentIsStreaming: boolean
  availableWidth: number
  markdownPalette: MarkdownPalette
  onToggleCollapsed: (id: string) => void
  onBuildFast: () => void
  onBuildMax: () => void
  onBuildLite: () => void
  isLastMessage?: boolean
}

/** Props stored in ref for stable handler access in AgentBody */
interface AgentBodyPropsRef {
  agentBlock: AgentContentBlock
  keyPrefix: string
  nestedBlocks: ContentBlock[]
  parentIsStreaming: boolean
  availableWidth: number
  markdownPalette: MarkdownPalette
  onToggleCollapsed: (id: string) => void
  onBuildFast: () => void
  onBuildMax: () => void
  onBuildLite: () => void
  isLastMessage?: boolean
  theme: ReturnType<typeof useTheme>
  getAgentMarkdownOptions: (indent: number) => {
    codeBlockWidth: number
    palette: MarkdownPalette
  }
}

const AgentBody = memo(
  ({
    agentBlock,
    keyPrefix,
    parentIsStreaming,
    availableWidth,
    markdownPalette,
    onToggleCollapsed,
    onBuildFast,
    onBuildMax,
    onBuildLite,
    isLastMessage,
  }: AgentBodyProps): ReactNode[] => {
    const theme = useTheme()
    const nestedBlocks = agentBlock.blocks ?? []

    const getAgentMarkdownOptions = useCallback(
      (indent: number) => {
        const indentationOffset = indent * 2
        return {
          codeBlockWidth: Math.max(
            10,
            availableWidth -
              AGENT_CONTENT_HORIZONTAL_PADDING -
              indentationOffset,
          ),
          palette: {
            ...markdownPalette,
            codeTextFg: theme.foreground,
          },
        }
      },
      [availableWidth, markdownPalette, theme.foreground],
    )

    // Store props in ref for stable handler access (avoids 12+ useMemo dependencies)
    const propsRef = useRef<AgentBodyPropsRef>(null!)
    propsRef.current = {
      agentBlock,
      keyPrefix,
      nestedBlocks,
      parentIsStreaming,
      availableWidth,
      markdownPalette,
      onToggleCollapsed,
      onBuildFast,
      onBuildMax,
      onBuildLite,
      isLastMessage,
      theme,
      getAgentMarkdownOptions,
    }

    // Handlers are stable (empty deps) and read latest props from ref
    const handlers: BlockProcessorHandlers = useMemo(
      () => ({
        onReasoningGroup: (reasoningBlocks, startIndex) => {
          const p = propsRef.current
          return (
            <ThinkingBlock
              key={
                reasoningBlocks[0]?.thinkingId ??
                `${p.keyPrefix}-thinking-${startIndex}`
              }
              blocks={reasoningBlocks}
              onToggleCollapsed={p.onToggleCollapsed}
              availableWidth={p.availableWidth}
              isNested={true}
              isMessageComplete={p.agentBlock.status === 'complete'}
            />
          )
        },

        onToolGroup: (toolBlocks, startIndex) => {
          const p = propsRef.current
          return (
            <ToolBlockGroup
              key={`${p.keyPrefix}-tool-group-${startIndex}`}
              toolBlocks={toolBlocks}
              keyPrefix={p.keyPrefix}
              startIndex={startIndex}
              availableWidth={p.availableWidth}
              onToggleCollapsed={p.onToggleCollapsed}
              markdownPalette={p.markdownPalette}
            />
          )
        },

        onImplementorGroup: (implementors, startIndex) => {
          const p = propsRef.current
          return (
            <ImplementorGroup
              key={`${p.keyPrefix}-implementor-group-${startIndex}`}
              implementors={implementors}
              siblingBlocks={p.nestedBlocks}
              availableWidth={p.availableWidth}
            />
          )
        },

        onAgentGroup: (agentBlocks, startIndex) => {
          const p = propsRef.current
          return (
            <AgentBlockGrid
              key={`${p.keyPrefix}-agent-grid-${startIndex}`}
              agentBlocks={agentBlocks}
              keyPrefix={`${p.keyPrefix}-agent-grid-${startIndex}`}
              availableWidth={p.availableWidth}
              renderAgentBranch={(innerAgentBlock, prefix, width) => (
                <AgentBranchWrapper
                  agentBlock={innerAgentBlock}
                  keyPrefix={prefix}
                  availableWidth={width}
                  markdownPalette={p.markdownPalette}
                  onToggleCollapsed={p.onToggleCollapsed}
                  onBuildFast={p.onBuildFast}
                  onBuildMax={p.onBuildMax}
                  onBuildLite={p.onBuildLite}
                  siblingBlocks={p.nestedBlocks}
                  isLastMessage={p.isLastMessage}
                />
              )}
            />
          )
        },

        onSingleBlock: (block, index) => {
          const p = propsRef.current
          if (block.type === 'text') {
            const textBlock = block as TextContentBlock
            const nestedStatus = textBlock.status
            const isNestedStreamingText =
              p.parentIsStreaming || nestedStatus === 'running'
            const filteredNestedContent = isNestedStreamingText
              ? trimNewlines(textBlock.content)
              : textBlock.content.trim()
            if (!filteredNestedContent) {
              return null
            }
            const markdownOptionsForLevel = p.getAgentMarkdownOptions(0)
            const explicitColor = textBlock.color
            const nestedTextColor = explicitColor ?? p.theme.foreground

            return (
              <text
                key={`${p.keyPrefix}-text-${index}`}
                style={{
                  wrapMode: 'word',
                  fg: nestedTextColor,
                }}
              >
                <ContentWithMarkdown
                  content={filteredNestedContent}
                  isStreaming={isNestedStreamingText}
                  codeBlockWidth={markdownOptionsForLevel.codeBlockWidth}
                  palette={markdownOptionsForLevel.palette}
                />
              </text>
            )
          }

          if (block.type === 'html') {
            const htmlBlock = block as HtmlContentBlock

            return (
              <box
                key={`${p.keyPrefix}-html-${index}`}
                style={{
                  flexDirection: 'column',
                  gap: 0,
                }}
              >
                {htmlBlock.render({
                  textColor: p.theme.foreground,
                  theme: p.theme,
                })}
              </box>
            )
          }

          // Fallback for unknown block types
          return null
        },
      }),
      [], // Empty deps - handlers read from propsRef.current
    )

    return processBlocks(nestedBlocks, handlers) as ReactNode[]
  },
)

export interface AgentBranchWrapperProps {
  agentBlock: Extract<ContentBlock, { type: 'agent' }>
  keyPrefix: string
  availableWidth: number
  markdownPalette: MarkdownPalette
  onToggleCollapsed: (id: string) => void
  onBuildFast: () => void
  onBuildMax: () => void
  onBuildLite: () => void
  siblingBlocks?: ContentBlock[]
  isLastMessage?: boolean
}

export const AgentBranchWrapper = memo(
  ({
    agentBlock,
    keyPrefix,
    availableWidth,
    markdownPalette,
    onToggleCollapsed,
    onBuildFast,
    onBuildMax,
    onBuildLite,
    siblingBlocks,
    isLastMessage,
  }: AgentBranchWrapperProps) => {
    const theme = useTheme()
    // Derive streaming boolean for this specific agent to avoid re-renders when other agents change
    const agentIsStreaming = useChatStore((state) =>
      state.streamingAgents.has(agentBlock.agentId),
    )

    if (shouldRenderAsSimpleText(agentBlock.agentType)) {
      const isStreaming = agentBlock.status === 'running' || agentIsStreaming

      const effectiveStatus = isStreaming ? 'running' : agentBlock.status
      const { indicator: statusIndicator, color: statusColor } =
        getAgentStatusInfo(effectiveStatus, theme)

      let statusText = 'Selecting best'
      let reason: string | undefined

      const isComplete = agentBlock.status === 'complete'
      if (isComplete && siblingBlocks) {
        const blocks = agentBlock.blocks ?? []
        // Find the set_output tool call block (not necessarily the last block)
        const setOutputBlock = blocks.find(
          (b): b is ToolContentBlock =>
            b.type === 'tool' && b.toolName === 'set_output',
        )
        // set_output wraps data in a 'data' property, so we need to access input.data
        const outputData = (
          setOutputBlock?.input as { data?: Record<string, unknown> }
        )?.data
        const implementationId = outputData?.implementationId as
          | string
          | undefined
        if (implementationId) {
          const letterIndex = implementationId.charCodeAt(0) - 65
          const implementors = siblingBlocks.filter(
            (b): b is AgentContentBlock =>
              b.type === 'agent' && isImplementorAgent(b),
          )

          reason = outputData?.reason as string | undefined

          const selectedAgent = implementors[letterIndex]
          if (selectedAgent) {
            const index = getImplementorIndex(selectedAgent, siblingBlocks)
            statusText =
              index !== undefined
                ? `Selected Strategy #${index + 1}`
                : 'Selected'
          }
        }
      }

      return (
        <box
          key={keyPrefix}
          style={{
            flexDirection: 'column',
            gap: 0,
            width: '100%',
          }}
        >
          <text style={{ wrapMode: 'word' }}>
            <span fg={statusColor}>{statusIndicator}</span>
            <span fg={theme.foreground} attributes={TextAttributes.BOLD}>
              {' '}
              {statusText}
            </span>
          </text>
          {reason && (
            <text
              style={{
                wrapMode: 'word',
                fg: theme.foreground,
                marginLeft: 2,
              }}
            >
              {reason}
            </text>
          )}
        </box>
      )
    }

    const isCollapsed = agentBlock.isCollapsed ?? false
    const isStreaming = agentBlock.status === 'running' || agentIsStreaming

    // Compute collapsed preview text
    const preview = getCollapsedPreview(
      agentBlock,
      isStreaming,
      isCollapsed,
      availableWidth,
    )
    const displayPrompt = getAgentDisplayPrompt(agentBlock)

    const effectiveStatus = isStreaming ? 'running' : agentBlock.status
    const {
      indicator: statusIndicator,
      label: statusLabel,
      color: statusColor,
    } = getAgentStatusInfo(effectiveStatus, theme)

    const onToggle = useCallback(() => {
      onToggleCollapsed(agentBlock.agentId)
    }, [onToggleCollapsed, agentBlock.agentId])

    return (
      <box key={keyPrefix} style={{ flexDirection: 'column', gap: 0 }}>
        <AgentBranchItem
          name={agentBlock.agentName}
          prompt={displayPrompt}
          agentId={agentBlock.agentId}
          isCollapsed={isCollapsed}
          isStreaming={isStreaming}
          preview={preview}
          statusLabel={statusLabel ?? undefined}
          statusColor={statusColor}
          statusIndicator={statusIndicator}
          onToggle={onToggle}
        >
          <AgentBody
            agentBlock={agentBlock}
            keyPrefix={keyPrefix}
            parentIsStreaming={isStreaming}
            availableWidth={availableWidth}
            markdownPalette={markdownPalette}
            onToggleCollapsed={onToggleCollapsed}
            onBuildFast={onBuildFast}
            onBuildMax={onBuildMax}
            onBuildLite={onBuildLite}
            isLastMessage={isLastMessage}
          />
        </AgentBranchItem>
      </box>
    )
  },
)
