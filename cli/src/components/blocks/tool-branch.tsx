import { memo, useCallback } from 'react'

import { ContentWithMarkdown } from './content-with-markdown'
import { useTheme } from '../../hooks/use-theme'
import { useChatStore } from '../../state/chat-store'
import { getToolDisplayInfo } from '../../utils/codebuff-client'
import { shouldCollapseToolByDefault } from '../../utils/constants'
import { renderToolComponent } from '../tools/registry'
import { ToolCallItem } from '../tools/tool-call-item'

import type { ContentBlock } from '../../types/chat'
import type { MarkdownPalette } from '../../utils/markdown-renderer'

interface ToolBranchProps {
  toolBlock: Extract<ContentBlock, { type: 'tool' }>
  keyPrefix: string
  availableWidth: number
  onToggleCollapsed: (id: string) => void
  markdownPalette: MarkdownPalette
}

export const ToolBranch = memo(
  ({
    toolBlock,
    keyPrefix,
    availableWidth,
    onToggleCollapsed,
    markdownPalette,
  }: ToolBranchProps) => {
    const theme = useTheme()
    // Derive streaming boolean for this specific tool to avoid re-renders when other tools/agents change
    const isStreaming = useChatStore((state) => state.streamingAgents.has(toolBlock.toolCallId))

    const sanitizePreview = (value: string): string =>
      value.replace(/[#*_`~\[\]()]/g, '').trim()

    if (toolBlock.toolName === 'end_turn') {
      return null
    }
    if (toolBlock.toolName === 'ask_user') {
      return null
    }
    if ('includeToolCall' in toolBlock && toolBlock.includeToolCall === false) {
      return null
    }

    const displayInfo = getToolDisplayInfo(toolBlock.toolName)
    
    // Check if there's a registered custom component for this tool
    const toolRenderConfig = renderToolComponent(toolBlock, theme, {
      availableWidth,
      indentationOffset: 0,
      previewPrefix: '',
      labelWidth: 0,
    })
    
    // Tools without a registered component (fallback rendering) should be collapsed by default
    const hasRegisteredComponent = toolRenderConfig !== undefined
    const isCollapsed = toolBlock.isCollapsed ?? 
      (hasRegisteredComponent ? shouldCollapseToolByDefault(toolBlock.toolName) : true)

    const inputContent = `\`\`\`json\n${JSON.stringify(toolBlock.input, null, 2)}\n\`\`\``
    const codeBlockLang =
      toolBlock.toolName === 'run_terminal_command' ? '' : 'yaml'
    const resultContent = toolBlock.output
      ? `\n\n**Result:**\n\`\`\`${codeBlockLang}\n${toolBlock.output}\n\`\`\``
      : ''
    const fullContent = inputContent + resultContent

    const lines = fullContent.split('\n').filter((line) => line.trim())
    const firstLine = lines[0] || ''
    const lastLine = lines[lines.length - 1] || firstLine
    const commandPreview =
      toolBlock.toolName === 'run_terminal_command' &&
      toolBlock.input &&
      typeof toolBlock.input === 'object' &&
      'command' in toolBlock.input &&
      typeof toolBlock.input.command === 'string'
        ? `$ ${toolBlock.input.command.trim()}`
        : null

    const streamingPreview = isStreaming
      ? commandPreview ?? `${sanitizePreview(firstLine)}...`
      : ''

    const getToolFinishedPreview = useCallback(
      (commandPrev: string | null, lastLn: string): string => {
        if (commandPrev) {
          return commandPrev
        }

        if (toolBlock.toolName === 'run_terminal_command' && toolBlock.output) {
          const outputLines = toolBlock.output
            .split('\n')
            .filter((line) => line.trim())
          const lastThreeLines = outputLines.slice(-3)
          const hasMoreLines = outputLines.length > 3
          const preview = lastThreeLines.join('\n')
          return hasMoreLines ? `...\n${preview}` : preview
        }

        return sanitizePreview(lastLn)
      },
      [toolBlock],
    )

    const finishedPreview = !isStreaming
      ? toolRenderConfig?.collapsedPreview ??
        getToolFinishedPreview(commandPreview, lastLine)
      : ''

    const agentMarkdownOptions = {
      codeBlockWidth: Math.max(10, availableWidth - 12),
      palette: {
        ...markdownPalette,
        codeTextFg: theme.foreground,
      },
    }

    const displayContent = (
      <ContentWithMarkdown
        content={fullContent}
        isStreaming={false}
        codeBlockWidth={agentMarkdownOptions.codeBlockWidth}
        palette={agentMarkdownOptions.palette}
      />
    )

    const renderableDisplayContent =
      displayContent === null ||
      displayContent === undefined ||
      displayContent === false ||
      displayContent === '' ? null : (
        <text
          fg={theme.foreground}
          style={{ wrapMode: 'word' }}
          attributes={
            theme.messageTextAttributes && theme.messageTextAttributes !== 0
              ? theme.messageTextAttributes
              : undefined
          }
        >
          {displayContent}
        </text>
      )

    const headerName = displayInfo.name

    const handleToggle = useCallback(() => {
      onToggleCollapsed(toolBlock.toolCallId)
    }, [onToggleCollapsed, toolBlock.toolCallId])

    return (
      <box key={keyPrefix}>
        {toolRenderConfig ? (
          toolRenderConfig.content
        ) : (
          <ToolCallItem
            name={headerName}
            content={renderableDisplayContent}
            isCollapsed={isCollapsed}
            isStreaming={isStreaming}
            streamingPreview={streamingPreview}
            finishedPreview={finishedPreview}
            onToggle={handleToggle}
            titleSuffix={undefined}
          />
        )}
      </box>
    )
  },
)
