import { TextAttributes } from '@opentui/core'
import { memo, useCallback, useMemo, type ReactNode } from 'react'
import React from 'react'
import { useShallow } from 'zustand/react/shallow'

import { Button } from './button'
import { ErrorBoundary } from './error-boundary'
import { GridLayout } from './grid-layout'
import { MessageBlock } from './message-block'
import { ModeDivider } from './mode-divider'
import { useChatStore } from '../state/chat-store'
import { useMessageBlockStore } from '../state/message-block-store'
import { splitByAgentSize } from '../utils/block-processor'
import { getCliEnv } from '../utils/env'
import {
  AGENT_CONTENT_HORIZONTAL_PADDING,
  MAX_AGENT_DEPTH,
} from '../utils/layout-helpers'
import {
  renderMarkdown,
  hasMarkdown,
  type MarkdownPalette,
} from '../utils/markdown-renderer'

import type { ChatMessage } from '../types/chat'
import type { FeedbackCategory } from '@codebuff/common/constants/feedback'

interface AgentChildrenGridProps {
  agentChildren: ChatMessage[]
  depth: number
  availableWidth: number
}

const AgentChildrenGrid = memo(
  ({ agentChildren, depth, availableWidth }: AgentChildrenGridProps) => {
    const theme = useMessageBlockStore((state) => state.context.theme)

    const getItemKey = useCallback((agent: ChatMessage) => agent.id, [])

    const renderAgentChild = useCallback(
      (agent: ChatMessage, _idx: number, columnWidth: number) => (
        <MessageWithAgents
          message={agent}
          depth={depth + 1}
          isLastMessage={false}
          availableWidth={columnWidth}
        />
      ),
      [depth],
    )

    const subGroups = useMemo(
      () => splitByAgentSize(agentChildren, (m) => m.agent?.agentType ?? ''),
      [agentChildren],
    )

    if (agentChildren.length === 0) return null

    if (depth >= MAX_AGENT_DEPTH) {
      if (getCliEnv().NODE_ENV === 'development') {
        console.warn(
          `[AgentChildrenGrid] Depth limit (${MAX_AGENT_DEPTH}) reached, truncating agent tree`,
        )
      }
      return (
        <text fg={theme?.muted} attributes={TextAttributes.ITALIC}>
          {`${agentChildren.length} nested agent${
            agentChildren.length > 1 ? 's' : ''
          } not shown (depth limit)`}
        </text>
      )
    }

    const errorFallback = (
      <text fg={theme?.error}>Error rendering agent children</text>
    )

    return (
      <ErrorBoundary fallback={errorFallback} componentName="AgentChildrenGrid">
        <box style={{ flexDirection: 'column', gap: 0, width: '100%' }}>
          {subGroups.map((group) => (
            <GridLayout
              key={getItemKey(group[0])}
              items={group}
              availableWidth={availableWidth}
              getItemKey={getItemKey}
              renderItem={renderAgentChild}
            />
          ))}
        </box>
      </ErrorBoundary>
    )
  },
)

interface MessageWithAgentsProps {
  message: ChatMessage
  depth: number
  isLastMessage: boolean
  availableWidth: number
}

export const MessageWithAgents = memo(
  ({ message, depth, isLastMessage, availableWidth }: MessageWithAgentsProps): ReactNode => {
    const SIDE_GUTTER = 1
    const isAgent = message.variant === 'agent'

    // Use useShallow for grouped selectors to prevent unnecessary re-renders
    const { theme, markdownPalette, messageTree, isWaitingForResponse, timerStartTime } =
      useMessageBlockStore(
        useShallow((state) => ({
          theme: state.context.theme,
          markdownPalette: state.context.markdownPalette,
          messageTree: state.context.messageTree,
          isWaitingForResponse: state.context.isWaitingForResponse,
          timerStartTime: state.context.timerStartTime,
        })),
      )

    const { onToggleCollapsed, onBuildFast, onBuildMax, onBuildLite, onFeedback, onCloseFeedback } =
      useMessageBlockStore(
        useShallow((state) => ({
          onToggleCollapsed: state.callbacks.onToggleCollapsed,
          onBuildFast: state.callbacks.onBuildFast,
          onBuildMax: state.callbacks.onBuildMax,
          onBuildLite: state.callbacks.onBuildLite,
          onFeedback: state.callbacks.onFeedback,
          onCloseFeedback: state.callbacks.onCloseFeedback,
        })),
      )

    // Memoize onOpenFeedback to prevent unnecessary re-renders
    const onOpenFeedback = useCallback(
      (options?: {
        category?: FeedbackCategory
        footerMessage?: string
        errors?: Array<{ id: string; message: string }>
      }) => {
        onFeedback(message.id, options)
      },
      [onFeedback, message.id],
    )

    const contentBoxStyle = useMemo(
      () => ({
        backgroundColor: theme?.background,
        padding: 0,
        paddingLeft: SIDE_GUTTER,
        paddingRight: SIDE_GUTTER,
        paddingTop: 0,
        paddingBottom: 0,
        gap: 0,
        width: '100%' as const,
        flexGrow: 1,
        justifyContent: 'center' as const,
      }),
      [theme?.background],
    )

    if (isAgent) {
      return <AgentMessage message={message} depth={depth} availableWidth={availableWidth} />
    }

    const isAi = message.variant === 'ai'
    const isUser = message.variant === 'user'
    const isError = message.variant === 'error'

    if (
      message.blocks &&
      message.blocks.length === 1 &&
      message.blocks[0].type === 'mode-divider'
    ) {
      const dividerBlock = message.blocks[0]
      return (
        <ModeDivider
          key={message.id}
          mode={dividerBlock.mode}
          width={availableWidth}
        />
      )
    }

    // /undo and /redo confirmations get their own color so they don't read
    // as plain agent output: amber while reverting, green when restoring.
    // (Only textColor is used: the vertical line renders for user messages,
    // and these confirmations are ai-variant.)
    const commandResult = message.metadata?.commandResult
    const commandColor =
      commandResult === 'undo'
        ? theme?.warning
        : commandResult === 'redo'
          ? theme?.success
          : undefined
    const lineColor = isError
      ? 'red'
      : isAi
        ? theme?.aiLine ?? 'white'
        : theme?.userLine ?? 'white'
    const textColor = commandColor ?? theme?.foreground ?? 'white'
    const timestampColor = isError
      ? 'red'
      : isAi
        ? theme?.muted ?? 'white'
        : theme?.muted ?? 'white'

    const estimatedMessageWidth = availableWidth
    const codeBlockWidth = Math.max(10, estimatedMessageWidth - 8)

    const paletteForMessage: MarkdownPalette | undefined = useMemo(
      () => markdownPalette ? {
        ...markdownPalette,
        codeTextFg: textColor,
      } : undefined,
      [markdownPalette, textColor],
    )

    const markdownOptions = useMemo(
      () => ({ codeBlockWidth, palette: paletteForMessage! }),
      [codeBlockWidth, paletteForMessage],
    )

    const isLoading =
      isAi && message.content === '' && !message.blocks && isWaitingForResponse

    const agentChildren = messageTree?.get(message.id) ?? []
    const hasAgentChildren = agentChildren.length > 0
    // Show vertical line for user messages (including bash commands which are now user messages)
    const showVerticalLine = isUser

    return (
      <box
        key={message.id}
        style={{
          width: '100%',
          flexDirection: 'column',
          gap: 0,
          paddingBottom: isLastMessage ? 0 : 1,
        }}
      >
        <box
          style={{
            width: '100%',
            flexDirection: 'row',
          }}
        >
          {showVerticalLine ? (
            <box
              style={{
                flexDirection: 'row',
                gap: 0,
                alignItems: 'stretch',
                width: '100%',
                flexGrow: 1,
              }}
            >
              <box
                style={{
                  width: 1,
                  backgroundColor: lineColor,
                  marginTop: 0,
                  marginBottom: 0,
                }}
              />
              <box style={contentBoxStyle}>
                <MessageBlock
                  messageId={message.id}
                  blocks={message.blocks}
                  content={message.content}
                  isUser={isUser}
                  isAi={isAi}
                  isLoading={isLoading}
                  timestamp={message.timestamp}
                  isComplete={message.isComplete}
                  completionTime={message.completionTime}
                  credits={message.credits}
                  timerStartTime={timerStartTime}
                  textColor={textColor}
                  timestampColor={timestampColor}
                  markdownOptions={markdownOptions}
                  availableWidth={availableWidth}
                  markdownPalette={markdownPalette!}
                  onToggleCollapsed={onToggleCollapsed}
                  onBuildFast={onBuildFast}
                  onBuildMax={onBuildMax}
                  onBuildLite={onBuildLite}
                  onFeedback={onFeedback}
                  onCloseFeedback={onCloseFeedback}
                  validationErrors={message.validationErrors}
                  userError={message.userError}
                  onOpenFeedback={onOpenFeedback}
                  attachments={message.attachments}
                  textAttachments={message.textAttachments}
                  fileAttachments={message.fileAttachments}
                  metadata={message.metadata}
                  isLastMessage={isLastMessage}
                />
              </box>
            </box>
          ) : (
            <box style={contentBoxStyle}>
              <MessageBlock
                messageId={message.id}
                blocks={message.blocks}
                content={message.content}
                isUser={isUser}
                isAi={isAi}
                isLoading={isLoading}
                timestamp={message.timestamp}
                isComplete={message.isComplete}
                completionTime={message.completionTime}
                credits={message.credits}
                timerStartTime={timerStartTime}
                textColor={textColor}
                timestampColor={timestampColor}
                markdownOptions={markdownOptions}
                availableWidth={availableWidth}
                markdownPalette={markdownPalette!}
                onToggleCollapsed={onToggleCollapsed}
                onBuildFast={onBuildFast}
                onBuildMax={onBuildMax}
                onBuildLite={onBuildLite}
                onFeedback={onFeedback}
                onCloseFeedback={onCloseFeedback}
                validationErrors={message.validationErrors}
                userError={message.userError}
                onOpenFeedback={onOpenFeedback}
                attachments={message.attachments}
                textAttachments={message.textAttachments}
                fileAttachments={message.fileAttachments}
                metadata={message.metadata}
                isLastMessage={isLastMessage}
              />
            </box>
          )}
        </box>

        {hasAgentChildren && (
          <AgentChildrenGrid
            agentChildren={agentChildren}
            depth={depth}
            availableWidth={availableWidth}
          />
        )}
      </box>
    )
  },
)

interface AgentMessageProps {
  message: ChatMessage
  depth: number
  availableWidth: number
}

const AgentMessage = memo(
  ({ message, depth, availableWidth }: AgentMessageProps): ReactNode => {
    // Use useShallow for grouped selectors to prevent unnecessary re-renders
    const { theme, markdownPalette, messageTree, onToggleCollapsed } = useMessageBlockStore(
      useShallow((state) => ({
        theme: state.context.theme,
        markdownPalette: state.context.markdownPalette,
        messageTree: state.context.messageTree,
        onToggleCollapsed: state.callbacks.onToggleCollapsed,
      })),
    )

    // Derive streaming boolean for this specific message to avoid re-renders when other agents change
    const isStreaming = useChatStore((state) => state.streamingAgents.has(message.id))
    const setFocusedAgentId = useChatStore((state) => state.setFocusedAgentId)

    // Guard against missing agent info (should not happen for agent variant messages)
    if (!message.agent) {
      return (
        <text fg={theme?.error}>
          Error: Missing agent info for agent message
        </text>
      )
    }
    const agentInfo = message.agent

    // Get or initialize collapse state from message metadata
    const isCollapsed = message.metadata?.isCollapsed ?? false

    const agentChildren = messageTree?.get(message.id) ?? []

    const bulletChar = '• '
    const fullPrefix = bulletChar

    const lines = message.content.split('\n').filter((line) => line.trim())
    const firstLine = lines[0] || ''
    const lastLine = lines[lines.length - 1] || firstLine
    const rawDisplayContent = isCollapsed ? lastLine : message.content

    const streamingPreview = isStreaming
      ? firstLine.replace(/[#*_`~\[\]()]/g, '').trim() + '...'
      : ''

    const finishedPreview =
      !isStreaming && isCollapsed
        ? lastLine.replace(/[#*_`~\[\]()]/g, '').trim()
        : ''

    const agentCodeBlockWidth = Math.max(
      10,
      availableWidth - AGENT_CONTENT_HORIZONTAL_PADDING,
    )
    const agentPalette: MarkdownPalette | undefined = markdownPalette ? {
      ...markdownPalette,
      codeTextFg: theme?.foreground ?? markdownPalette.codeTextFg,
    } : undefined
    const agentMarkdownOptions = {
      codeBlockWidth: agentCodeBlockWidth,
      palette: agentPalette!,
    }
    const displayContent = hasMarkdown(rawDisplayContent)
      ? renderMarkdown(rawDisplayContent, agentMarkdownOptions)
      : rawDisplayContent

    const handleTitleClick = (): void => {
      onToggleCollapsed(message.id)
      setFocusedAgentId(message.id)
    }

    const handleContentClick = (): void => {
      if (!isCollapsed) {
        return
      }

      onToggleCollapsed(message.id)
      setFocusedAgentId(message.id)
    }

    return (
      <box
        key={message.id}
        style={{
          flexDirection: 'column',
          gap: 0,
          flexShrink: 0,
        }}
      >
        <box
          style={{
            flexDirection: 'row',
            flexShrink: 0,
          }}
        >
          <text style={{ wrapMode: 'none' }}>
            <span fg={theme?.success}>{fullPrefix}</span>
          </text>
          <box
            style={{
              flexDirection: 'column',
              gap: 0,
              flexShrink: 1,
              flexGrow: 1,
            }}
          >
            <Button
              style={{
                flexDirection: 'row',
                alignSelf: 'flex-start',
                backgroundColor: isCollapsed ? theme?.muted : theme?.success,
                paddingLeft: 1,
                paddingRight: 1,
              }}
              onClick={handleTitleClick}
            >
              <text style={{ wrapMode: 'word' }}>
                <span fg={theme?.foreground}>{isCollapsed ? '▸ ' : '▾ '}</span>
                <span fg={theme?.foreground} attributes={TextAttributes.BOLD}>
                  {agentInfo.agentName}
                </span>
              </text>
            </Button>
            <Button
              style={{ flexShrink: 1, paddingBottom: isCollapsed ? 1 : 0 }}
              onClick={handleContentClick}
            >
              {isStreaming && isCollapsed && streamingPreview && (
                <text
                  style={{ wrapMode: 'word', fg: theme?.foreground }}
                  attributes={TextAttributes.ITALIC}
                >
                  {streamingPreview}
                </text>
              )}
              {!isStreaming && isCollapsed && finishedPreview && (
                <text
                  style={{ wrapMode: 'word', fg: theme?.muted }}
                  attributes={TextAttributes.ITALIC}
                >
                  {finishedPreview}
                </text>
              )}
              {!isCollapsed && (
                <text
                  key={`agent-content-${message.id}`}
                  style={{ wrapMode: 'word', fg: theme?.foreground }}
                >
                  {displayContent}
                </text>
              )}
            </Button>
          </box>
        </box>
        {agentChildren.length > 0 && (
          <AgentChildrenGrid
            agentChildren={agentChildren}
            depth={depth}
            availableWidth={availableWidth}
          />
        )}
      </box>
    )
  },
)
