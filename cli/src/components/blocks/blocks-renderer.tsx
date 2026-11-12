import React, { memo, useEffect, useMemo, useRef } from 'react'
import { useShallow } from 'zustand/react/shallow'

import { AgentBlockGrid } from './agent-block-grid'
import { AgentBranchWrapper } from './agent-branch-wrapper'
import { ImageBlock } from './image-block'
import { ImplementorGroup } from './implementor-row'
import { SingleBlock } from './single-block'
import { ThinkingBlock } from './thinking-block'
import { ToolBlockGroup } from './tool-block-group'
import { AdCard } from '../ad-banner'
import { useMessageBlockStore } from '../../state/message-block-store'
import { processBlocks, type BlockProcessorHandlers } from '../../utils/block-processor'
import { responseAdEndSlotCount } from '../../utils/response-ad-positions'
import type { MeasureRows } from '../../ads/ad-engagement'
import type { ContentBlock } from '../../types/chat'
import type { MarkdownPalette } from '../../utils/markdown-renderer'

// `availableWidth` is terminalWidth - 2, but message content is clipped
// tighter: the transcript scrollbox pads its content (1 left + 2 right) and
// the message adds a 1-col side gutter each side, for a net 3 columns less.
// Size the end-of-answer ad card to the clipped interior so their right border
// stays visible.
const RESPONSE_AD_WIDTH_INSET = 3

interface BlocksRendererProps {
  sourceBlocks: ContentBlock[]
  messageId: string
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
  /**
   * The answer's last screen row, where the end-of-answer card will draw. The
   * card is requested only once that row is in the transcript viewport.
   */
  measureEnd?: MeasureRows
}

/** Props stored in ref for stable handler access */
interface BlocksRendererPropsRef {
  sourceBlocks: ContentBlock[]
  messageId: string
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
  lastTextBlockIndex: number
}

export const BlocksRenderer = memo(
  ({
    sourceBlocks,
    messageId,
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
    measureEnd,
  }: BlocksRendererProps) => {
    const lastTextBlockIndex = contentToCopy
      ? sourceBlocks.reduceRight(
          (acc, block, idx) =>
            acc === -1 && block.type === 'text' ? idx : acc,
          -1,
        )
      : -1

    // Store props in ref for stable handler access (avoids 17 useMemo dependencies)
    const propsRef = useRef<BlocksRendererPropsRef>(null!)
    propsRef.current = {
      sourceBlocks,
      messageId,
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
      lastTextBlockIndex,
    }

    // Handlers are stable (empty deps) and read latest props from ref
    const handlers: BlockProcessorHandlers = useMemo(
      () => ({
        onReasoningGroup: (reasoningBlocks, startIndex) => {
          const p = propsRef.current
          return (
            <ThinkingBlock
              key={reasoningBlocks[0]?.thinkingId ?? `${p.messageId}-thinking-${startIndex}`}
              blocks={reasoningBlocks}
              onToggleCollapsed={p.onToggleCollapsed}
              availableWidth={p.availableWidth}
              isNested={false}
              isMessageComplete={p.isComplete ?? false}
            />
          )
        },

        onImageBlock: (block, index) => {
          const p = propsRef.current
          return (
            <ImageBlock
              key={`${p.messageId}-image-${index}`}
              block={block}
              availableWidth={p.availableWidth}
            />
          )
        },

        onToolGroup: (toolBlocks, startIndex) => {
          const p = propsRef.current
          return (
            <ToolBlockGroup
              key={`${p.messageId}-tool-group-${startIndex}`}
              toolBlocks={toolBlocks}
              keyPrefix={p.messageId}
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
              key={`${p.messageId}-implementor-group-${startIndex}`}
              implementors={implementors}
              siblingBlocks={p.sourceBlocks}
              availableWidth={p.availableWidth}
            />
          )
        },

        onAgentGroup: (agentBlocks, startIndex) => {
          const p = propsRef.current
          return (
            <AgentBlockGrid
              key={`${p.messageId}-agent-grid-${startIndex}`}
              agentBlocks={agentBlocks}
              keyPrefix={`${p.messageId}-agent-grid-${startIndex}`}
              availableWidth={p.availableWidth}
              renderAgentBranch={(agentBlock, prefix, width) => (
                <AgentBranchWrapper
                  agentBlock={agentBlock}
                  keyPrefix={prefix}
                  availableWidth={width}
                  markdownPalette={p.markdownPalette}
                  onToggleCollapsed={p.onToggleCollapsed}
                  onBuildFast={p.onBuildFast}
                  onBuildMax={p.onBuildMax}
                  onBuildLite={p.onBuildLite}
                  siblingBlocks={p.sourceBlocks}
                  isLastMessage={p.isLastMessage}
                />
              )}
            />
          )
        },

        onSingleBlock: (block, index) => {
          const p = propsRef.current
          return (
            <SingleBlock
              key={`${p.messageId}-block-${index}`}
              block={block}
              idx={index}
              messageId={p.messageId}
              blocks={p.sourceBlocks}
              isLoading={p.isLoading}
              isComplete={p.isComplete}
              isUser={p.isUser}
              textColor={p.textColor}
              availableWidth={p.availableWidth}
              markdownPalette={p.markdownPalette}
              onToggleCollapsed={p.onToggleCollapsed}
              onBuildFast={p.onBuildFast}
              onBuildMax={p.onBuildMax}
              onBuildLite={p.onBuildLite}
              isLastMessage={p.isLastMessage}
              contentToCopy={index === p.lastTextBlockIndex ? p.contentToCopy : undefined}
            />
          )
        },
      }),
      [], // Empty deps - handlers read from propsRef.current
    )

    // Ads assigned to this assistant response by the ads hook (via chat.tsx).
    // Only top-level streamed answers ever get an entry, so this is undefined
    // for user messages, agent branches, and system notices.
    const responseAds = useMessageBlockStore(
      (state) => state.context.responseAds[messageId],
    )
    const { onAdClick, onAdImpression, onResponseAdsNeeded } =
      useMessageBlockStore(
        useShallow((state) => ({
          onAdClick: state.callbacks.onAdClick,
          onAdImpression: state.callbacks.onAdImpression,
          onResponseAdsNeeded: state.callbacks.onResponseAdsNeeded,
        })),
      )

    const nodes = processBlocks(sourceBlocks, handlers)
    // One card per answer, after its last content, asked for only once the
    // answer has completed with enough content (the hook also waits for
    // terminal focus and for the answer's end to be on screen).
    const endSlotCount = responseAdEndSlotCount({
      nodeCount: nodes.length,
      isComplete: isComplete === true,
    })
    const measureEndRef = useRef(measureEnd)
    measureEndRef.current = measureEnd

    useEffect(() => {
      if (endSlotCount > 0) {
        onResponseAdsNeeded(messageId, endSlotCount, () =>
          measureEndRef.current ? measureEndRef.current() : null,
        )
      }
    }, [endSlotCount, messageId, onResponseAdsNeeded])

    const ad = endSlotCount > 0 ? responseAds?.[0] : undefined
    if (!ad) {
      return <>{nodes}</>
    }

    return (
      <>
        {nodes}
        <AdCard
          key={`response-ad-${messageId}`}
          ad={ad}
          width={Math.max(20, availableWidth - RESPONSE_AD_WIDTH_INSET)}
          variant="inline"
          onClick={onAdClick}
          onImpression={onAdImpression}
        />
      </>
    )
  },
)
