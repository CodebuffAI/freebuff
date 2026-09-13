import { TextAttributes } from '@opentui/core'
import { memo, useState } from 'react'

import { BlocksRenderer } from './blocks/blocks-renderer'
import { CommandResultBlock } from './blocks/command-result-block'
import { UserContentWithCopyButton } from './blocks/user-content-copy'
import { Button } from './button'
import { FileAttachmentCard } from './file-attachment-card'
import { ImageCard } from './image-card'
import { MessageFooter } from './message-footer'
import { TextAttachmentCard } from './text-attachment-card'
import { UserErrorBanner } from './user-error-banner'
import { ValidationErrorPopover } from './validation-error-popover'
import { useTheme } from '../hooks/use-theme'
import { useWhyDidYouUpdateById } from '../hooks/use-why-did-you-update'
import { getCliEnv } from '../utils/env'
import { type MarkdownPalette } from '../utils/markdown-renderer'
import { formatCwd } from '../utils/path-helpers'

import type { FeedbackCategory } from '@codebuff/common/constants/feedback'

import type {
  ContentBlock,
  FileAttachment,
  ImageAttachment,
  TextAttachment,
  ChatMessageMetadata,
} from '../types/chat'
import type { ThemeColor } from '../types/theme-system'

interface MessageBlockProps {
  messageId: string
  blocks?: ContentBlock[]
  content: string
  isUser: boolean
  isAi: boolean
  isLoading: boolean
  timestamp: string
  isComplete?: boolean
  completionTime?: string
  credits?: number
  timerStartTime: number | null
  textColor?: ThemeColor
  timestampColor: string
  markdownOptions: { codeBlockWidth: number; palette: MarkdownPalette }
  availableWidth: number
  markdownPalette: MarkdownPalette
  onToggleCollapsed: (id: string) => void
  onBuildFast: () => void
  onBuildMax: () => void
  onBuildLite: () => void
  onFeedback?: (messageId: string) => void
  onCloseFeedback?: () => void
  validationErrors?: Array<{ id: string; message: string }>
  /** Runtime error to display in UI but NOT send to LLM */
  userError?: string
  onOpenFeedback?: (options?: {
    category?: FeedbackCategory
    footerMessage?: string
    errors?: Array<{ id: string; message: string }>
  }) => void
  attachments?: ImageAttachment[]
  textAttachments?: TextAttachment[]
  fileAttachments?: FileAttachment[]
  metadata?: ChatMessageMetadata
  isLastMessage?: boolean
}

const MessageAttachments = memo(({
  imageAttachments,
  textAttachments,
  fileAttachments,
}: {
  imageAttachments: ImageAttachment[]
  textAttachments: TextAttachment[]
  fileAttachments: FileAttachment[]
}) => {
  if (imageAttachments.length === 0 && textAttachments.length === 0 && fileAttachments.length === 0) {
    return null
  }

  return (
    <box
      style={{
        flexDirection: 'row',
        gap: 1,
        flexWrap: 'wrap',
      }}
    >
      {imageAttachments.map((attachment) => (
        <ImageCard
          key={attachment.path}
          image={attachment}
          showRemoveButton={false}
        />
      ))}
      {textAttachments.map((attachment) => (
        <TextAttachmentCard
          key={attachment.id}
          attachment={attachment}
          showRemoveButton={false}
        />
      ))}
      {fileAttachments.map((attachment) => (
        <FileAttachmentCard
          key={attachment.path}
          attachment={attachment}
          showRemoveButton={false}
        />
      ))}
    </box>
  )
})

export const MessageBlock = memo(({
  messageId,
  blocks,
  content,
  isUser,
  isAi,
  isLoading,
  timestamp,
  isComplete,
  completionTime,
  credits,
  timerStartTime,
  textColor,
  timestampColor,
  markdownOptions,
  availableWidth,
  markdownPalette,
  onToggleCollapsed,
  onBuildFast,
  onBuildMax,
  onBuildLite,
  onFeedback,
  onCloseFeedback,
  validationErrors,
  userError,
  onOpenFeedback,
  attachments,
  textAttachments,
  fileAttachments,
  metadata,
  isLastMessage,
}: MessageBlockProps) => {
  const [showValidationPopover, setShowValidationPopover] = useState(false)

  const bashCwd = metadata?.bashCwd ? formatCwd(metadata.bashCwd) : undefined

  useWhyDidYouUpdateById(
    'MessageBlock',
    messageId,
    {
      messageId,
      blocks,
      content,
      isUser,
      isAi,
      isLoading,
      timestamp,
      isComplete,
      completionTime,
      credits,
      timerStartTime,
      textColor,
      timestampColor,
      markdownOptions,
      availableWidth,
      markdownPalette,
      onToggleCollapsed,
      onBuildFast,
      onBuildMax,
      onBuildLite,
      onFeedback,
      onCloseFeedback,
      validationErrors,
      onOpenFeedback,
      metadata,
      isLastMessage,
    },
    {
      logLevel: 'debug',
      enabled: getCliEnv().CODEBUFF_PERF_TEST === 'true',
    },
  )

  const theme = useTheme()
  const resolvedTextColor = textColor ?? theme.foreground

  return (
    <box
      style={{
        flexDirection: 'column',
        width: '100%',
      }}
    >
      {/* User message timestamp with error indicator (non-bash commands) */}
      {isUser && !bashCwd && (
        <box style={{ flexDirection: 'row', alignItems: 'center', gap: 1 }}>
          <text
            attributes={TextAttributes.DIM}
            style={{
              wrapMode: 'none',
              fg: timestampColor,
            }}
          >
            {`[${timestamp}]`}
          </text>

          {validationErrors && validationErrors.length > 0 && (
            <Button
              onClick={() => setShowValidationPopover(!showValidationPopover)}
            >
              <text
                style={{
                  fg: theme.error,
                  wrapMode: 'none',
                }}
              >
                [!]
              </text>
            </Button>
          )}
        </box>
      )}

      {/* Bash command metadata header (timestamp + cwd) - copy button moved inline */}
      {bashCwd && (
        <box style={{ flexDirection: 'row', alignItems: 'center', gap: 1 }}>
          <text
            attributes={TextAttributes.DIM}
            style={{
              wrapMode: 'none',
              fg: timestampColor,
            }}
          >
            {`[${timestamp}]`}
          </text>
          <text
            attributes={TextAttributes.DIM}
            style={{
              wrapMode: 'none',
              fg: theme.muted,
            }}
          >
            •
          </text>
          <text
            attributes={TextAttributes.DIM}
            style={{
              wrapMode: 'word',
              fg: theme.muted,
            }}
          >
            {bashCwd}
          </text>
        </box>
      )}

      {/* Show validation popover below timestamp when expanded */}
      {isUser &&
        !bashCwd &&
        validationErrors &&
        validationErrors.length > 0 &&
        showValidationPopover && (
          <box style={{ paddingTop: 1, paddingBottom: 1 }}>
            <ValidationErrorPopover
              errors={validationErrors}
              onOpenFeedback={onOpenFeedback}
              onClose={() => setShowValidationPopover(false)}
            />
          </box>
        )}

      <box style={{ flexDirection: 'column', gap: 1, width: '100%' }}>
        {metadata?.commandResult ? (
          <CommandResultBlock
            content={content}
            commandResult={metadata.commandResult}
          />
        ) : blocks ? (
          <box
            style={{
              flexDirection: 'column',
              gap: 1,
              width: '100%',
            }}
          >
            <BlocksRenderer
              sourceBlocks={blocks}
              messageId={messageId}
              isLoading={isLoading}
              isComplete={isComplete}
              isUser={isUser}
              textColor={resolvedTextColor}
              availableWidth={availableWidth}
              markdownPalette={markdownPalette}
              onToggleCollapsed={onToggleCollapsed}
              onBuildFast={onBuildFast}
              onBuildMax={onBuildMax}
              onBuildLite={onBuildLite}
              isLastMessage={isLastMessage}
              contentToCopy={isUser ? content : undefined}
            />
          </box>
        ) : (
          <UserContentWithCopyButton
            content={content}
            messageId={messageId}
            isLoading={isLoading}
            isComplete={isComplete}
            isUser={isUser}
            textColor={resolvedTextColor}
            codeBlockWidth={markdownOptions.codeBlockWidth}
            palette={markdownOptions.palette}
            showCopyButton={isUser}
          />
        )}
        {/* Show attachments for user messages */}
        {isUser &&
          ((attachments && attachments.length > 0) ||
            (textAttachments && textAttachments.length > 0) ||
            (fileAttachments && fileAttachments.length > 0)) && (
            <MessageAttachments
              imageAttachments={attachments ?? []}
              textAttachments={textAttachments ?? []}
              fileAttachments={fileAttachments ?? []}
            />
          )}
      </box>

      {/* Display runtime error banner for AI messages */}
      {isAi && userError && <UserErrorBanner error={userError} />}

      {isAi && (
        <MessageFooter
          messageId={messageId}
          blocks={blocks}
          content={content}
          isLoading={isLoading}
          isComplete={isComplete}
          completionTime={completionTime}
          credits={credits}
          timerStartTime={timerStartTime}
          onFeedback={onFeedback}
          onCloseFeedback={onCloseFeedback}
        />
      )}
    </box>
  )
})
