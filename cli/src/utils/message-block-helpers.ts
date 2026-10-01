import { isEqual } from 'lodash'

import { formatToolOutput } from './codebuff-client'
import {
  shouldCollapseByDefault,
  shouldCollapseForParent,
  shouldHideAgent,
} from './constants'

import type {
  ContentBlock,
  AgentContentBlock,
  AskUserContentBlock,
} from '../types/chat'

/**
 * Extracts the base agent name from a potentially scoped/versioned agent type string.
 *
 * @example
 * getAgentBaseName('codebuff/file-picker@0.0.2') // 'file-picker'
 * getAgentBaseName('file-picker@1.0.0') // 'file-picker'
 * getAgentBaseName('file-picker') // 'file-picker'
 * getAgentBaseName('file_picker') // 'file-picker'
 */
export const getAgentBaseName = (type: string): string => {
  const segment = type.split('/').pop() ?? type
  return segment.split('@')[0].replace(/_/g, '-')
}

/**
 * Extracts plan content from a buffer containing <PLAN>...</PLAN> tags.
 * Returns the trimmed content between tags, or null if not found.
 */
export const extractPlanFromBuffer = (buffer: string): string | null => {
  const openIdx = buffer.indexOf('<PLAN>')
  const closeIdx = buffer.indexOf('</PLAN>')
  if (openIdx !== -1 && closeIdx !== -1 && closeIdx > openIdx) {
    return buffer.slice(openIdx + '<PLAN>'.length, closeIdx).trim()
  }
  return null
}

export const scrubPlanTags = (s: string): string => {
  // Support both the canonical </PLAN> tag and the legacy </cb_plan> tag.
  const closingTagPattern = '(?:<\\/PLAN>|<\\/cb_plan>)'
  return s
    .replace(new RegExp(`<PLAN>[\\s\\S]*?${closingTagPattern}`, 'g'), '')
    .replace(/<PLAN>[\s\S]*$/g, '')
}

export const scrubPlanTagsInBlocks = (
  blocks: ContentBlock[],
): ContentBlock[] => {
  return blocks
    .map((block) => {
      if (block.type !== 'text') {
        return block
      }
      const newContent = scrubPlanTags(block.content)
      return { ...block, content: newContent }
    })
    .filter((block) => block.type !== 'text' || block.content.trim() !== '')
}

export const insertPlanBlock = (
  blocks: ContentBlock[],
  planContent: string,
): ContentBlock[] => {
  const cleanedBlocks = scrubPlanTagsInBlocks(blocks)
  return [
    ...cleanedBlocks,
    {
      type: 'plan',
      content: planContent,
    },
  ]
}

/**
 * Recursively removes agent blocks that should never be rendered (e.g.
 * context-pruner). Live streams filter these at the event handlers;
 * sanitizeRestoredMessages uses this to clean transcripts persisted before
 * that filter matched the bundled agent ids. Returns the same array when
 * nothing needs stripping. Operates on persisted data, so corrupted shapes
 * (non-array input, null entries, missing fields) pass through untouched
 * rather than throwing.
 */
export const stripHiddenAgentBlocks = (
  blocks: ContentBlock[],
): ContentBlock[] => {
  if (!Array.isArray(blocks)) {
    return blocks
  }
  let changed = false
  const result: ContentBlock[] = []
  for (const block of blocks) {
    if (block?.type !== 'agent') {
      result.push(block)
      continue
    }
    if (shouldHideAgent(block.agentType ?? '')) {
      changed = true
      continue
    }
    const strippedChildren = Array.isArray(block.blocks)
      ? stripHiddenAgentBlocks(block.blocks)
      : undefined
    if (strippedChildren && strippedChildren !== block.blocks) {
      changed = true
      result.push({ ...block, blocks: strippedChildren })
    } else {
      result.push(block)
    }
  }
  return changed ? result : blocks
}

/**
 * Recursively collapses blocks that weren't manually opened by the user.
 * Preserves user intent by keeping blocks open if userOpened is true.
 */
export const autoCollapseBlocks = (blocks: ContentBlock[]): ContentBlock[] => {
  return blocks.map((block) => {
    // Handle thinking blocks (grouped text blocks)
    if (block.type === 'text' && block.thinkingId) {
      return block.userOpened
        ? block
        : { ...block, thinkingCollapseState: 'hidden' as const }
    }

    // Handle agent blocks
    if (block.type === 'agent') {
      const updatedBlock = block.userOpened
        ? block
        : { ...block, isCollapsed: true }

      // Recursively update nested blocks
      if (updatedBlock.blocks) {
        return {
          ...updatedBlock,
          blocks: autoCollapseBlocks(updatedBlock.blocks),
        }
      }
      return updatedBlock
    }

    // Handle tool blocks
    if (block.type === 'tool') {
      return block.userOpened ? block : { ...block, isCollapsed: true }
    }

    // Handle agent-list blocks
    if (block.type === 'agent-list') {
      return block.userOpened ? block : { ...block, isCollapsed: true }
    }

    return block
  })
}

/**
 * Result of extracting content from a spawn_agents result value.
 */
export interface SpawnAgentResultContent {
  content: string
  hasError: boolean
}

/**
 * Extracts text content from a Message object's content array.
 * Handles assistant messages with TextPart content.
 */
const extractTextFromMessageContent = (content: unknown): string => {
  if (!Array.isArray(content)) {
    return ''
  }
  return content
    .filter(
      (part: any) => part?.type === 'text' && typeof part?.text === 'string',
    )
    .map((part: any) => part.text)
    .join('')
}

/**
 * Extracts displayable content from a spawn_agents result value.
 * Handles various nested structures that can come back from agent spawns.
 */
export const extractSpawnAgentResultContent = (
  resultValue: unknown,
): SpawnAgentResultContent => {
  // Handle null/undefined
  if (!resultValue) {
    return { content: '', hasError: false }
  }

  // Handle direct string
  if (typeof resultValue === 'string') {
    return { content: resultValue, hasError: false }
  }

  if (typeof resultValue !== 'object') {
    return { content: '', hasError: false }
  }

  const obj = resultValue as Record<string, unknown>

  // Handle empty object
  if (Object.keys(obj).length === 0) {
    return { content: '', hasError: false }
  }

  // Handle error messages (check both top-level and nested)
  if (obj.errorMessage) {
    return { content: String(obj.errorMessage), hasError: true }
  }
  if ((obj.value as any)?.errorMessage) {
    return { content: String((obj.value as any).errorMessage), hasError: true }
  }

  // Handle lastMessage and allMessages output modes: { type: "lastMessage"|"allMessages", value: [Message array] }
  // This is common for agents like researcher-web
  if (
    (obj.type === 'lastMessage' || obj.type === 'allMessages') &&
    Array.isArray(obj.value)
  ) {
    const messages = obj.value as Array<{ role?: string; content?: unknown }>
    const textContent = messages
      .filter((msg) => msg?.role === 'assistant')
      .map((msg) => extractTextFromMessageContent(msg?.content))
      .filter(Boolean)
      .join('\n')
    return { content: textContent, hasError: false }
  }

  // Handle structuredOutput mode: { type: "structuredOutput", value: any }
  if (obj.type === 'structuredOutput') {
    const value = obj.value
    // Check for message field in structured output
    if (value && typeof value === 'object') {
      const valueObj = value as Record<string, unknown>
      if (typeof valueObj.message === 'string') {
        return { content: valueObj.message, hasError: false }
      }
      // Check for data.message pattern
      if (valueObj.data && typeof valueObj.data === 'object') {
        const dataObj = valueObj.data as Record<string, unknown>
        if (typeof dataObj.message === 'string') {
          return { content: dataObj.message, hasError: false }
        }
      }
    }
    // Fall through to format as JSON
    return {
      content: formatToolOutput([{ type: 'json', value: obj.value }]),
      hasError: false,
    }
  }

  // Handle nested string value: { value: "..." }
  if (typeof obj.value === 'string') {
    return { content: obj.value, hasError: false }
  }

  // Handle message field (top-level or nested)
  if (obj.message) {
    return { content: String(obj.message), hasError: false }
  }
  if ((obj.value as any)?.message) {
    return { content: String((obj.value as any).message), hasError: false }
  }

  // Fallback to formatted output
  return {
    content: formatToolOutput([{ type: 'json', value: resultValue }]),
    hasError: false,
  }
}

/**
 * Appends an interruption notice to blocks, either by modifying the last
 * text block or adding a new one.
 */
export const appendInterruptionNotice = (
  blocks: ContentBlock[],
): ContentBlock[] => {
  const lastBlock = blocks[blocks.length - 1]

  if (lastBlock && lastBlock.type === 'text') {
    const interruptedBlock: ContentBlock = {
      ...lastBlock,
      content: `${lastBlock.content}\n\n[response interrupted]`,
    }
    return [...blocks.slice(0, -1), interruptedBlock]
  }

  const interruptionNotice: ContentBlock = {
    type: 'text',
    content: '[response interrupted]',
  }
  return [...blocks, interruptionNotice]
}

/**
 * Recursively finds an agent block by ID and returns its agent type.
 * Returns undefined if not found.
 */
export const findAgentTypeById = (
  blocks: ContentBlock[],
  agentId: string,
): string | undefined => {
  for (const block of blocks) {
    if (block.type === 'agent') {
      if (block.agentId === agentId) {
        return block.agentType
      }
      if (block.blocks) {
        const found = findAgentTypeById(block.blocks, agentId)
        if (found) {
          return found
        }
      }
    }
  }
  return undefined
}

/**
 * Options for creating an agent content block.
 */
export interface CreateAgentBlockOptions {
  agentId: string
  agentType: string
  prompt?: string
  params?: Record<string, unknown>
  /** The spawn_agents tool call ID that created this block */
  spawnToolCallId?: string
  /** The index within the spawn_agents call */
  spawnIndex?: number
  /** The agent type of the parent agent that spawned this one */
  parentAgentType?: string
}

/**
 * Creates a new agent content block with standard defaults.
 */
export const createAgentBlock = (
  options: CreateAgentBlockOptions,
): AgentContentBlock => {
  const {
    agentId,
    agentType,
    prompt,
    params,
    spawnToolCallId,
    spawnIndex,
    parentAgentType,
  } = options
  const shouldCollapse =
    shouldCollapseByDefault(agentType || '') ||
    shouldCollapseForParent(agentType || '', parentAgentType)
  return {
    type: 'agent',
    agentId,
    agentName: agentType || 'Agent',
    agentType: agentType || 'unknown',
    content: '',
    status: 'running' as const,
    blocks: [] as ContentBlock[],
    initialPrompt: prompt || '',
    ...(params && { params }),
    ...(spawnToolCallId && { spawnToolCallId }),
    ...(spawnIndex !== undefined && { spawnIndex }),
    ...(shouldCollapse && { isCollapsed: true }),
  }
}

/**
 * Helper function to recursively update blocks by target agent ID.
 */
export const updateBlocksRecursively = (
  blocks: ContentBlock[],
  targetAgentId: string,
  updateFn: (block: ContentBlock) => ContentBlock,
): ContentBlock[] => {
  let foundTarget = false
  const result = blocks.map((block) => {
    if (block.type === 'agent' && block.agentId === targetAgentId) {
      foundTarget = true
      return updateFn(block)
    }
    if (block.type === 'agent' && block.blocks) {
      const updatedBlocks = updateBlocksRecursively(
        block.blocks,
        targetAgentId,
        updateFn,
      )
      if (updatedBlocks !== block.blocks) {
        foundTarget = true
        return {
          ...block,
          blocks: updatedBlocks,
        }
      }
    }
    return block
  })

  return foundTarget ? result : blocks
}

/**
 * Result from nestBlockUnderParent indicating whether the parent was found.
 */
export interface NestBlockResult {
  blocks: ContentBlock[]
  parentFound: boolean
}

/**
 * Nests a block under a parent agent, or returns it at top level if parent not found.
 */
export const nestBlockUnderParent = (
  blocks: ContentBlock[],
  parentAgentId: string,
  blockToNest: ContentBlock,
): NestBlockResult => {
  let parentFound = false
  const updatedBlocks = updateBlocksRecursively(
    blocks,
    parentAgentId,
    (parentBlock) => {
      if (parentBlock.type !== 'agent') {
        return parentBlock
      }
      parentFound = true
      return {
        ...parentBlock,
        blocks: [...(parentBlock.blocks || []), blockToNest],
      }
    },
  )

  return { blocks: updatedBlocks, parentFound }
}

/**
 * Checks if a block with the given targetId exists anywhere in the children of the blocks.
 */
const findBlockInChildren = (
  blocks: ContentBlock[],
  targetId: string,
): boolean => {
  for (const block of blocks) {
    if (block.type === 'agent' && block.agentId === targetId) {
      return true
    }
    if (block.type === 'agent' && block.blocks) {
      if (findBlockInChildren(block.blocks, targetId)) {
        return true
      }
    }
  }
  return false
}

/**
 * Checks if a block with the given agentId is already nested under the specified parent.
 */
const checkBlockIsUnderParent = (
  blocks: ContentBlock[],
  targetAgentId: string,
  parentAgentId: string,
): boolean => {
  for (const block of blocks) {
    if (block.type === 'agent' && block.agentId === parentAgentId) {
      // Found the parent, check if target is anywhere in its children
      return findBlockInChildren(block.blocks || [], targetAgentId)
    }
    if (block.type === 'agent' && block.blocks) {
      // Recurse into other agent blocks to find the parent
      if (checkBlockIsUnderParent(block.blocks, targetAgentId, parentAgentId)) {
        return true
      }
    }
  }
  return false
}

/**
 * Extracts a block with given agentId from nested blocks structure.
 * Returns the remaining blocks and the extracted block (if found).
 */
export const extractBlockById = (
  blocks: ContentBlock[],
  targetAgentId: string,
): { remainingBlocks: ContentBlock[]; extractedBlock: ContentBlock | null } => {
  let extractedBlock: ContentBlock | null = null

  const extractRecursively = (blocks: ContentBlock[]): ContentBlock[] => {
    const result: ContentBlock[] = []
    for (const block of blocks) {
      if (block.type === 'agent' && block.agentId === targetAgentId) {
        extractedBlock = block
        // Don't add to result - we're extracting it
        continue
      }
      if (block.type === 'agent' && block.blocks) {
        result.push({
          ...block,
          blocks: extractRecursively(block.blocks),
        })
        continue
      }
      result.push(block)
    }
    return result
  }

  const remainingBlocks = extractRecursively(blocks)
  return { remainingBlocks, extractedBlock }
}

export const moveSpawnAgentBlock = (
  blocks: ContentBlock[],
  tempId: string,
  realId: string,
  parentId?: string,
  params?: Record<string, unknown>,
  prompt?: string,
  realAgentType?: string,
): ContentBlock[] => {
  const updateAgentBlock = (block: ContentBlock): ContentBlock => {
    if (block.type !== 'agent') {
      return block
    }
    const updatedBlock: ContentBlock = {
      ...block,
      agentId: realId,
    }

    if (params) {
      updatedBlock.params = params
    }

    if (prompt && block.initialPrompt === '') {
      updatedBlock.initialPrompt = prompt
    }

    if (realAgentType) {
      updatedBlock.agentType = realAgentType
      updatedBlock.agentName = realAgentType
    }

    return updatedBlock
  }

  // If there's a parentId, we need to move the block under the parent.
  // First check if the block is already under the correct parent.
  if (parentId) {
    const isAlreadyUnderParent = checkBlockIsUnderParent(
      blocks,
      tempId,
      parentId,
    )
    if (isAlreadyUnderParent) {
      // Block is already under the correct parent, just update it in place
      return updateBlocksRecursively(blocks, tempId, updateAgentBlock)
    }

    // Block needs to be moved under the parent - extract and nest
    const { remainingBlocks, extractedBlock } = extractBlockById(blocks, tempId)
    if (extractedBlock && extractedBlock.type === 'agent') {
      const blockToMove = updateAgentBlock(extractedBlock)
      const { blocks: nestedBlocks, parentFound } = nestBlockUnderParent(
        remainingBlocks,
        parentId,
        blockToMove,
      )
      if (parentFound) {
        return nestedBlocks
      }
      // Parent not found, update in place instead of appending to end
      return updateBlocksRecursively(blocks, tempId, updateAgentBlock)
    }
  }

  // No parentId or block not found - just update in place to preserve order
  return updateBlocksRecursively(blocks, tempId, updateAgentBlock)
}

/**
 * Options for transforming ask_user tool blocks to ask-user content blocks.
 */
export interface TransformAskUserOptions {
  toolCallId: string
  resultValue: unknown
}

/**
 * Transforms ask_user tool blocks into ask-user content blocks when tool results arrive.
 * Recursively processes nested agent blocks.
 */
export const transformAskUserBlocks = (
  blocks: ContentBlock[],
  options: TransformAskUserOptions,
): ContentBlock[] => {
  const { toolCallId, resultValue } = options

  return blocks.map((block) => {
    if (
      block.type === 'tool' &&
      block.toolCallId === toolCallId &&
      block.toolName === 'ask_user'
    ) {
      const skipped = (resultValue as any)?.skipped
      const answers = (resultValue as any)?.answers
      const questions = block.input.questions

      if (!answers && !skipped) {
        // If no result data, keep as tool block (fallback)
        return block
      }

      return {
        type: 'ask-user',
        toolCallId,
        questions,
        answers,
        skipped,
      } as AskUserContentBlock
    }

    if (block.type === 'agent' && block.blocks) {
      const updatedBlocks = transformAskUserBlocks(block.blocks, options)
      if (updatedBlocks !== block.blocks) {
        return { ...block, blocks: updatedBlocks }
      }
    }
    return block
  })
}

/**
 * Options for updating tool blocks with output.
 */
export interface UpdateToolBlockOptions {
  toolCallId: string
  toolOutput: unknown[]
}

/**
 * Updates tool blocks with their output when tool results arrive.
 * Handles special formatting for terminal command output.
 * Recursively processes nested agent blocks.
 */
export const updateToolBlockWithOutput = (
  blocks: ContentBlock[],
  options: UpdateToolBlockOptions,
): ContentBlock[] => {
  const { toolCallId, toolOutput } = options

  return blocks.map((block) => {
    if (block.type === 'tool' && block.toolCallId === toolCallId) {
      if (block.toolName !== 'run_terminal_command') {
        return { ...block, output: formatToolOutput(toolOutput) }
      }
      const parsed = (toolOutput?.[0] as any)?.value
      const output =
        parsed?.stdout || parsed?.stderr
          ? (parsed.stdout || '') + (parsed.stderr || '')
          : formatToolOutput(toolOutput)
      return { ...block, output }
    }
    if (block.type === 'agent' && block.blocks) {
      const updatedBlocks = updateToolBlockWithOutput(block.blocks, options)
      // Avoid creating new block if nested blocks didn't change
      if (isEqual(block.blocks, updatedBlocks)) {
        return block
      }
      return { ...block, blocks: updatedBlocks }
    }
    return block
  })
}
