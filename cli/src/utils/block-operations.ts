import { updateBlocksRecursively } from './message-block-helpers'
import {
  parseThinkTags,
  getPartialTagLength,
  THINK_OPEN_TAG,
  THINK_CLOSE_TAG,
} from './think-tag-parser'

import type {
  ContentBlock,
  ToolContentBlock,
  TextContentBlock,
} from '../types/chat'

let thinkingIdCounter = 0
const generateThinkingId = (): string => {
  thinkingIdCounter++
  return `thinking-${thinkingIdCounter}`
}

type AgentTextUpdate =
  | { type: 'text'; mode: 'append'; content: string; textType: 'text' | 'reasoning' }
  | { type: 'text'; mode: 'replace'; content: string }

const updateAgentText = (
  blocks: ContentBlock[],
  agentId: string,
  update: AgentTextUpdate,
) => {
  return updateBlocksRecursively(blocks, agentId, (block) => {
    if (block.type !== 'agent') {
      return block
    }

    const agentBlocks = block.blocks ? [...block.blocks] : []
    const text = update.content ?? ''

    if (update.mode === 'replace') {
      const updatedBlocks = [...agentBlocks]
      let replaced = false

      for (let i = updatedBlocks.length - 1; i >= 0; i--) {
        const entry = updatedBlocks[i]
        if (entry.type === 'text') {
          replaced = true
          if (entry.content === text && block.content === text) {
            return block
          }
          updatedBlocks[i] = { ...entry, content: text }
          break
        }
      }

      if (!replaced) {
        updatedBlocks.push({ type: 'text', content: text })
      }

      return {
        ...block,
        content: text,
        blocks: updatedBlocks,
      }
    }

    if (!text) {
      return block
    }

    // Handle native reasoning chunks for agent blocks
    if (update.textType === 'reasoning') {
      const updatedAgentBlocks = appendNativeReasoningToBlocks(agentBlocks, text)
      const updatedContent = (block.content ?? '') + text
      return {
        ...block,
        content: updatedContent,
        blocks: updatedAgentBlocks,
      }
    }

    // For regular text: first close any open native reasoning block, then use think tag parsing
    const blocksWithClosedReasoning = closeNativeReasoningBlock(agentBlocks)
    const updatedAgentBlocks = appendTextWithThinkParsingToBlocks(
      blocksWithClosedReasoning,
      text,
    )
    const updatedContent = (block.content ?? '') + text
    return {
      ...block,
      content: updatedContent,
      blocks: updatedAgentBlocks,
    }
  })
}

/**
 * Check if a text block represents an open (unclosed) thinking block.
 */
const isOpenThinkingBlock = (block: ContentBlock | undefined): boolean => {
  if (!block || block.type !== 'text') {
    return false
  }
  return block.textType === 'reasoning' && block.thinkingOpen === true
}

/**
 * Creates a new reasoning (thinking) text block.
 */
const createReasoningBlock = (
  content: string,
  thinkingOpen: boolean,
  thinkingId: string,
): TextContentBlock => ({
  type: 'text',
  content,
  textType: 'reasoning',
  thinkingCollapseState: 'preview',
  thinkingOpen,
  thinkingId,
})

/**
 * Creates a new regular text block.
 */
const createTextBlock = (content: string): TextContentBlock => ({
  type: 'text',
  content,
  textType: 'text',
})

/**
 * Shared logic for appending text with think tag parsing.
 * Used by both root stream and agent blocks.
 */
const appendTextWithThinkParsingToBlocks = (
  blocks: ContentBlock[],
  text: string,
): ContentBlock[] => {
  if (!text) {
    return blocks
  }

  const nextBlocks = [...blocks]
  const lastBlock = nextBlocks[nextBlocks.length - 1]
  const wasInsideThinking = isOpenThinkingBlock(lastBlock)

  let textToParse = text

  if (wasInsideThinking && lastBlock?.type === 'text') {
    const lastBlockContent = lastBlock.content

    const partialLen = getPartialTagLength(lastBlockContent)
    if (partialLen > 0) {
      const potentialTag = lastBlockContent.slice(-partialLen) + text
      if (potentialTag.startsWith(THINK_CLOSE_TAG)) {
        const newLastContent = lastBlockContent.slice(0, -partialLen)
        textToParse = lastBlockContent.slice(-partialLen) + text

        if (newLastContent) {
          nextBlocks[nextBlocks.length - 1] = {
            ...lastBlock,
            content: newLastContent,
          }
        } else {
          nextBlocks.pop()
        }
      }
    }
  } else if (
    !wasInsideThinking &&
    lastBlock?.type === 'text' &&
    lastBlock.textType === 'text'
  ) {
    const combinedText = lastBlock.content + text

    if (
      combinedText.includes(THINK_OPEN_TAG) ||
      combinedText.includes(THINK_CLOSE_TAG)
    ) {
      textToParse = combinedText
      nextBlocks.pop()
    }
  }

  const currentLastBlock = nextBlocks[nextBlocks.length - 1]
  const insideThinking = isOpenThinkingBlock(currentLastBlock)

  if (insideThinking && !textToParse.includes('<')) {
    if (currentLastBlock?.type === 'text') {
      nextBlocks[nextBlocks.length - 1] = {
        ...currentLastBlock,
        content: currentLastBlock.content + textToParse,
      }
      return nextBlocks
    }
  }

  if (!insideThinking && !textToParse.includes('<')) {
    if (
      currentLastBlock?.type === 'text' &&
      currentLastBlock.textType === 'text'
    ) {
      nextBlocks[nextBlocks.length - 1] = {
        ...currentLastBlock,
        content: currentLastBlock.content + textToParse,
      }
      return nextBlocks
    }
    return [...nextBlocks, createTextBlock(textToParse)]
  }

  const fullText = insideThinking ? THINK_OPEN_TAG + textToParse : textToParse

  const segments = parseThinkTags(fullText)

  let segmentStartIdx = 0
  if (
    insideThinking &&
    segments.length > 0 &&
    segments[0].type === 'thinking'
  ) {
    const firstSegment = segments[0]
    if (currentLastBlock?.type === 'text') {
      const hasMoreSegments = segments.length > 1
      const thinkingOpen =
        !hasMoreSegments && !textToParse.includes(THINK_CLOSE_TAG)

      nextBlocks[nextBlocks.length - 1] = {
        ...currentLastBlock,
        content: currentLastBlock.content + firstSegment.content,
        thinkingOpen,
      }
    }
    segmentStartIdx = 1
  } else if (insideThinking && textToParse.includes(THINK_CLOSE_TAG)) {
    // Handle case where we're inside thinking and receive </think> with no content
    // (e.g., just "</think>" or "</think>text"). In this case parseThinkTags returns
    // empty or starts with text, but we still need to close the thinking block.
    if (currentLastBlock?.type === 'text') {
      nextBlocks[nextBlocks.length - 1] = {
        ...currentLastBlock,
        thinkingOpen: false,
      }
    }
  }

  for (let i = segmentStartIdx; i < segments.length; i++) {
    const segment = segments[i]
    const isLastSegment = i === segments.length - 1

    if (segment.type === 'thinking') {
      const thinkingOpen =
        isLastSegment && !textToParse.endsWith(THINK_CLOSE_TAG)
      nextBlocks.push(
        createReasoningBlock(
          segment.content,
          thinkingOpen,
          generateThinkingId(),
        ),
      )
    } else {
      const prevBlock = nextBlocks[nextBlocks.length - 1]
      if (
        prevBlock?.type === 'text' &&
        prevBlock.textType === 'text' &&
        !prevBlock.thinkingOpen
      ) {
        nextBlocks[nextBlocks.length - 1] = {
          ...prevBlock,
          content: prevBlock.content + segment.content,
        }
      } else {
        nextBlocks.push(createTextBlock(segment.content))
      }
    }
  }

  return nextBlocks
}

/** Appends native reasoning content to blocks. */
const appendNativeReasoningToBlocks = (
  blocks: ContentBlock[],
  text: string,
): ContentBlock[] => {
  if (!text) {
    return blocks
  }

  const nextBlocks = [...blocks]
  const lastBlock = nextBlocks[nextBlocks.length - 1]

  // If last block is already an open native reasoning block, append to it
  // Only append if it's a native reasoning block (thinkingOpen === undefined),
  // not a closed one or a <think> tag block
  if (isNativeReasoningBlock(lastBlock) && lastBlock.type === 'text') {
    const updatedBlock: ContentBlock = {
      ...lastBlock,
      content: lastBlock.content + text,
    }
    nextBlocks[nextBlocks.length - 1] = updatedBlock
    return nextBlocks
  }

  // Create a new native reasoning block
  const newBlock: ContentBlock = {
    type: 'text',
    content: text,
    textType: 'reasoning',
    thinkingCollapseState: 'preview',
    thinkingId: generateThinkingId(),
  }

  return [...nextBlocks, newBlock]
}

/**
 * Checks if a block is a native reasoning block (not from <think> tags).
 * Native reasoning blocks have textType === 'reasoning' but thinkingOpen === undefined.
 */
export const isNativeReasoningBlock = (block: ContentBlock | undefined): boolean => {
  if (!block || block.type !== 'text') {
    return false
  }
  return block.textType === 'reasoning' && block.thinkingOpen === undefined
}

/**
 * Closes native reasoning blocks within a specific agent's blocks.
 * Used when a tool call happens for a subagent.
 */
export const closeNativeReasoningInAgent = (
  blocks: ContentBlock[],
  agentId: string,
): ContentBlock[] => {
  return updateBlocksRecursively(blocks, agentId, (block) => {
    if (block.type !== 'agent') {
      return block
    }
    const closedBlocks = block.blocks ? closeNativeReasoningBlock(block.blocks) : undefined
    if (closedBlocks && closedBlocks !== block.blocks) {
      return { ...block, blocks: closedBlocks }
    }
    return block
  })
}

/**
 * Marks the last native reasoning block as complete by setting thinkingOpen: false.
 * This triggers the UI to collapse the thinking block.
 * 
 * Note: We search backwards through all blocks because agent/tool blocks may have
 * been added after the reasoning block but before text output starts.
 */
export const closeNativeReasoningBlock = (
  blocks: ContentBlock[],
): ContentBlock[] => {
  // Find the last native reasoning block (not just the last block)
  let lastReasoningIndex = -1
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (isNativeReasoningBlock(blocks[i])) {
      lastReasoningIndex = i
      break
    }
  }
  
  if (lastReasoningIndex === -1) {
    return blocks
  }
  
  const reasoningBlock = blocks[lastReasoningIndex]
  if (reasoningBlock.type !== 'text') {
    return blocks
  }
  
  const nextBlocks = [...blocks]
  nextBlocks[lastReasoningIndex] = {
    ...reasoningBlock,
    thinkingOpen: false,
  }
  return nextBlocks
}

export const appendTextToRootStream = (
  blocks: ContentBlock[],
  delta: { type: 'text' | 'reasoning'; text: string },
) => {
  if (!delta.text) {
    return blocks
  }

  if (delta.type === 'reasoning') {
    return appendNativeReasoningToBlocks(blocks, delta.text)
  }

  // For text type: first close any open native reasoning block, then parse for <think> tags
  const blocksWithClosedReasoning = closeNativeReasoningBlock(blocks)
  return appendTextWithThinkParsingToBlocks(blocksWithClosedReasoning, delta.text)
}

export const appendTextToAgentBlock = (
  blocks: ContentBlock[],
  agentId: string,
  text: string,
  textType: 'text' | 'reasoning' = 'text',
) =>
  updateAgentText(blocks, agentId, {
    type: 'text',
    mode: 'append',
    content: text,
    textType,
  })

export const appendToolToAgentBlock = (
  blocks: ContentBlock[],
  agentId: string,
  toolBlock: ToolContentBlock,
) =>
  updateBlocksRecursively(blocks, agentId, (block) => {
    if (block.type !== 'agent') {
      return block
    }
    // Close any open native reasoning blocks before adding the tool
    const agentBlocks = block.blocks ? closeNativeReasoningBlock([...block.blocks]) : []
    return { ...block, blocks: [...agentBlocks, toolBlock] }
  })

export const markAgentComplete = (blocks: ContentBlock[], agentId: string) =>
  updateBlocksRecursively(blocks, agentId, (block) => {
    if (block.type !== 'agent') {
      return block
    }
    // Close any open native reasoning blocks when the agent completes
    const closedBlocks = block.blocks ? closeNativeReasoningBlock(block.blocks) : undefined
    return { 
      ...block, 
      status: 'complete' as const,
      ...(closedBlocks && { blocks: closedBlocks }),
    }
  })

/**
 * Recursively marks all agent blocks with status 'running' as 'cancelled'.
 * Used when the user interrupts a response to indicate subagents were stopped.
 * Also closes any open native reasoning blocks so they don't appear "streaming".
 */
export const markRunningAgentsAsCancelled = (
  blocks: ContentBlock[],
): ContentBlock[] => {
  return blocks.map((block) => {
    if (block.type !== 'agent') {
      return block
    }

    // First recursively process nested agents, then close any reasoning blocks
    let updatedBlocks = block.blocks
      ? markRunningAgentsAsCancelled(block.blocks)
      : undefined
    
    // Close any open native reasoning blocks in this agent
    if (updatedBlocks) {
      updatedBlocks = closeNativeReasoningBlock(updatedBlocks)
    }

    if (block.status === 'running') {
      return {
        ...block,
        status: 'cancelled' as const,
        ...(updatedBlocks && { blocks: updatedBlocks }),
      }
    }

    if (updatedBlocks && updatedBlocks !== block.blocks) {
      return { ...block, blocks: updatedBlocks }
    }

    return block
  })
}
