import { sanitizeTerminalOutput } from '@codebuff/common/util/terminal-safe-text'
import { memo, useCallback } from 'react'

import { MarkdownBody } from './markdown-body'
import { useTheme } from '../../hooks/use-theme'
import { useChatStore } from '../../state/chat-store'
import { getToolDisplayInfo } from '../../utils/codebuff-client'
import {
  canAgentHideToolCall,
  shouldCollapseToolByDefault,
} from '../../utils/constants'
import { renderToolComponent } from '../tools/registry'
import { ToolCallItem } from '../tools/tool-call-item'

import type { ContentBlock } from '../../types/chat'
import type { MarkdownPalette } from '../../utils/markdown-renderer'

const firstLineOf = (text: string): string => {
  const [first = '', ...rest] = text.split('\n')
  return rest.length > 0 ? `${first} (+${rest.length} lines)` : first
}

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
    // An agent can hide its own bookkeeping calls. Any other call it hides,
    // such as a terminal command, is drawn collapsed to one line instead.
    const hiddenByAgent =
      'includeToolCall' in toolBlock && toolBlock.includeToolCall === false
    if (hiddenByAgent && canAgentHideToolCall(toolBlock.toolName)) {
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
      (hasRegisteredComponent && !hiddenByAgent
        ? shouldCollapseToolByDefault(toolBlock.toolName)
        : true)

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
        ? `$ ${sanitizeTerminalOutput(toolBlock.input.command.trim())}`
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

    const renderableDisplayContent = fullContent ? (
      <MarkdownBody
        content={fullContent}
        isStreaming={false}
        codeBlockWidth={agentMarkdownOptions.codeBlockWidth}
        palette={agentMarkdownOptions.palette}
        fg={theme.foreground}
        attributes={
          theme.messageTextAttributes && theme.messageTextAttributes !== 0
            ? theme.messageTextAttributes
            : undefined
        }
      />
    ) : null

    const headerName = displayInfo.name

    const handleToggle = useCallback(() => {
      onToggleCollapsed(toolBlock.toolCallId)
    }, [onToggleCollapsed, toolBlock.toolCallId])

    return (
      <box key={keyPrefix}>
        {toolRenderConfig && !hiddenByAgent ? (
          toolRenderConfig.content
        ) : (
          <ToolCallItem
            name={headerName}
            content={toolRenderConfig?.content ?? renderableDisplayContent}
            isCollapsed={isCollapsed}
            isStreaming={isStreaming}
            streamingPreview={
              hiddenByAgent ? firstLineOf(streamingPreview) : streamingPreview
            }
            finishedPreview={
              hiddenByAgent ? firstLineOf(finishedPreview) : finishedPreview
            }
            onToggle={handleToggle}
            titleSuffix={undefined}
          />
        )}
      </box>
    )
  },
)
