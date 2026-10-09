import { describe, test, expect } from 'bun:test'

import {
  appendTextToRootStream,
  appendTextToAgentBlock,
  appendToolToAgentBlock,
  isNativeReasoningBlock,
  closeNativeReasoningBlock,
  closeNativeReasoningInAgent,
  markAgentComplete,
  markRunningAgentsAsCancelled,
} from '../block-operations'
import {
  updateBlocksRecursively,
  scrubPlanTags,
  scrubPlanTagsInBlocks,
  extractPlanFromBuffer,
  createAgentBlock,
  getAgentBaseName,
  autoCollapseBlocks,
  updateToolBlockWithOutput,
  transformAskUserBlocks,
  appendInterruptionNotice,
  extractSpawnAgentResultContent,
} from '../message-block-helpers'
import {
  createModeDividerMessage,
  createAiMessageShell,
  createErrorMessage,
  generateAiMessageId,
  autoCollapsePreviousMessages,
  isSpawnAgentsResult,
  sanitizeRestoredMessages,
} from '../send-message-helpers'

import type {
  ContentBlock,
  AgentContentBlock,
  AskUserContentBlock,
  ChatMessage,
  ModeDividerContentBlock,
  TextContentBlock,
  ToolContentBlock,
} from '../../types/chat'

// ============================================================================
// Block Manipulation Helpers Tests (from message-block-helpers)
// ============================================================================

describe('updateBlocksRecursively', () => {
  test('updates a top-level agent block', () => {
    const blocks: ContentBlock[] = [
      {
        type: 'agent',
        agentId: 'agent-1',
        agentName: 'Test',
        agentType: 'test',
        content: '',
        status: 'running',
      },
    ]

    const result = updateBlocksRecursively(blocks, 'agent-1', (block) => ({
      ...block,
      status: 'complete' as const,
    }))

    expect(result[0].type).toBe('agent')
    expect((result[0] as AgentContentBlock).status).toBe('complete')
  })

  test('updates a nested agent block', () => {
    const blocks: ContentBlock[] = [
      {
        type: 'agent',
        agentId: 'parent',
        agentName: 'Parent',
        agentType: 'parent',
        content: '',
        status: 'running',
        blocks: [
          {
            type: 'agent',
            agentId: 'child',
            agentName: 'Child',
            agentType: 'child',
            content: '',
            status: 'running',
          },
        ],
      },
    ]

    const result = updateBlocksRecursively(blocks, 'child', (block) => ({
      ...block,
      status: 'complete' as const,
    }))

    const parent = result[0] as AgentContentBlock
    const child = parent.blocks![0] as AgentContentBlock
    expect(child.status).toBe('complete')
  })

  test('returns original array if no match found', () => {
    const blocks: ContentBlock[] = [{ type: 'text', content: 'Hello' }]

    const result = updateBlocksRecursively(blocks, 'nonexistent', (block) => ({
      ...block,
    }))

    expect(result).toBe(blocks) // Same reference
  })

  test('does not create new blocks for unchanged nested structures', () => {
    const blocks: ContentBlock[] = [
      {
        type: 'agent',
        agentId: 'agent-1',
        agentName: 'Test',
        agentType: 'test',
        content: '',
        status: 'running',
        blocks: [{ type: 'text', content: 'Nested text' }],
      },
    ]

    const result = updateBlocksRecursively(blocks, 'nonexistent', (block) => ({
      ...block,
    }))

    expect(result).toBe(blocks)
  })
})

describe('scrubPlanTags', () => {
  test('removes complete PLAN tags', () => {
    const input = 'Before <PLAN>plan content</cb_plan> After'
    expect(scrubPlanTags(input)).toBe('Before  After')
  })

  test('removes incomplete trailing PLAN tags', () => {
    const input = 'Content <PLAN>incomplete plan'
    expect(scrubPlanTags(input)).toBe('Content ')
  })

  test('handles string with no PLAN tags', () => {
    const input = 'Just regular content'
    expect(scrubPlanTags(input)).toBe('Just regular content')
  })

  test('handles empty string', () => {
    expect(scrubPlanTags('')).toBe('')
  })
})

describe('scrubPlanTagsInBlocks', () => {
  test('removes plan tags from text blocks', () => {
    const blocks: ContentBlock[] = [
      { type: 'text', content: 'Hello <PLAN>plan</cb_plan> World' },
    ]

    const result = scrubPlanTagsInBlocks(blocks)
    expect((result[0] as TextContentBlock).content).toBe('Hello  World')
  })

  test('filters out empty text blocks after scrubbing', () => {
    const blocks: ContentBlock[] = [
      { type: 'text', content: '<PLAN>only plan</cb_plan>' },
      { type: 'text', content: 'Keep this' },
    ]

    const result = scrubPlanTagsInBlocks(blocks)
    expect(result).toHaveLength(1)
    expect((result[0] as TextContentBlock).content).toBe('Keep this')
  })

  test('preserves non-text blocks', () => {
    const blocks: ContentBlock[] = [
      {
        type: 'agent',
        agentId: '1',
        agentName: 'Test',
        agentType: 'test',
        content: '',
        status: 'running',
      },
    ]

    const result = scrubPlanTagsInBlocks(blocks)
    expect(result).toEqual(blocks)
  })
})

// ============================================================================
// Message Creation Helpers Tests (from send-message-helpers)
// ============================================================================

describe('createModeDividerMessage', () => {
  test('creates a mode divider message', () => {
    const message = createModeDividerMessage('MAX')

    expect(message.variant).toBe('ai')
    expect(message.content).toBe('')
    expect(message.blocks).toHaveLength(1)
    expect(message.blocks![0].type).toBe('mode-divider')
    expect((message.blocks![0] as ModeDividerContentBlock).mode).toBe('MAX')
    expect(message.id).toMatch(/^divider-/)
  })
})

describe('createAiMessageShell', () => {
  test('creates an empty AI message shell', () => {
    const message = createAiMessageShell('ai-123')

    expect(message.id).toBe('ai-123')
    expect(message.variant).toBe('ai')
    expect(message.content).toBe('')
    expect(message.blocks).toEqual([])
    expect(message.metadata?.allowInlineAds).toBe(true)
  })
})

describe('createErrorMessage', () => {
  test('creates an error message', () => {
    const message = createErrorMessage('Something went wrong')

    expect(message.variant).toBe('error')
    expect(message.content).toBe('Something went wrong')
    expect(message.id).toMatch(/^error-/)
  })
})

describe('generateAiMessageId', () => {
  test('generates unique IDs', () => {
    const id1 = generateAiMessageId()
    const id2 = generateAiMessageId()

    expect(id1).toMatch(/^ai-\d+-[a-f0-9]+$/)
    expect(id1).not.toBe(id2)
  })
})

// ============================================================================
// Auto-Collapse Logic Tests
// ============================================================================

describe('autoCollapseBlocks', () => {
  test('collapses text blocks with thinkingId', () => {
    const blocks: ContentBlock[] = [
      { type: 'text', content: 'thinking', thinkingId: 'think-1' },
    ]

    const result = autoCollapseBlocks(blocks)
    expect((result[0] as TextContentBlock).thinkingCollapseState).toBe('hidden')
  })

  test('does not collapse user-opened blocks', () => {
    const blocks: ContentBlock[] = [
      {
        type: 'text',
        content: 'thinking',
        thinkingId: 'think-1',
        userOpened: true,
      },
    ]

    const result = autoCollapseBlocks(blocks)
    expect((result[0] as TextContentBlock).isCollapsed).toBeUndefined()
  })

  test('collapses agent blocks', () => {
    const blocks: ContentBlock[] = [
      {
        type: 'agent',
        agentId: '1',
        agentName: 'Test',
        agentType: 'test',
        content: '',
        status: 'running',
      },
    ]

    const result = autoCollapseBlocks(blocks)
    expect((result[0] as AgentContentBlock).isCollapsed).toBe(true)
  })

  test('collapses tool blocks', () => {
    const blocks: ContentBlock[] = [
      {
        type: 'tool',
        toolCallId: 'tool-1',
        toolName: 'read_files',
        input: {},
      },
    ]

    const result = autoCollapseBlocks(blocks)
    expect((result[0] as ToolContentBlock).isCollapsed).toBe(true)
  })

  test('recursively collapses nested agent blocks', () => {
    const blocks: ContentBlock[] = [
      {
        type: 'agent',
        agentId: 'parent',
        agentName: 'Parent',
        agentType: 'parent',
        content: '',
        status: 'running',
        blocks: [
          {
            type: 'agent',
            agentId: 'child',
            agentName: 'Child',
            agentType: 'child',
            content: '',
            status: 'running',
          },
        ],
      },
    ]

    const result = autoCollapseBlocks(blocks)
    const parent = result[0] as AgentContentBlock
    const child = parent.blocks![0] as AgentContentBlock

    expect(parent.isCollapsed).toBe(true)
    expect(child.isCollapsed).toBe(true)
  })
})

describe('autoCollapsePreviousMessages', () => {
  test('does not collapse the current AI message', () => {
    const messages: ChatMessage[] = [
      {
        id: 'ai-123',
        variant: 'ai',
        content: '',
        blocks: [
          {
            type: 'agent',
            agentId: '1',
            agentName: 'Test',
            agentType: 'test',
            content: '',
            status: 'running',
          },
        ],
        timestamp: '',
      },
    ]

    const result = autoCollapsePreviousMessages(messages, 'ai-123')
    expect(
      (result[0].blocks![0] as AgentContentBlock).isCollapsed,
    ).toBeUndefined()
  })

  test('collapses previous messages', () => {
    const messages: ChatMessage[] = [
      {
        id: 'ai-old',
        variant: 'ai',
        content: '',
        blocks: [
          {
            type: 'agent',
            agentId: '1',
            agentName: 'Test',
            agentType: 'test',
            content: '',
            status: 'running',
          },
        ],
        timestamp: '',
      },
      {
        id: 'ai-new',
        variant: 'ai',
        content: '',
        blocks: [],
        timestamp: '',
      },
    ]

    const result = autoCollapsePreviousMessages(messages, 'ai-new')
    expect((result[0].blocks![0] as AgentContentBlock).isCollapsed).toBe(true)
  })

  test('respects user-opened agent messages', () => {
    const messages: ChatMessage[] = [
      {
        id: 'agent-msg',
        variant: 'agent',
        content: '',
        timestamp: '',
        metadata: { userOpened: true },
      },
    ]

    const result = autoCollapsePreviousMessages(messages, 'ai-new')
    expect(result[0].metadata?.isCollapsed).toBeUndefined()
  })
})

// ============================================================================
// Stream Chunk Processing Tests (from block-operations)
// ============================================================================

describe('appendTextToRootStream', () => {
  test('creates new text block for empty blocks array', () => {
    const result = appendTextToRootStream([], { type: 'text', text: 'Hello' })

    expect(result).toHaveLength(1)
    expect(result[0].type).toBe('text')
    expect((result[0] as TextContentBlock).content).toBe('Hello')
  })

  test('appends to existing text block of same type', () => {
    const blocks: ContentBlock[] = [
      { type: 'text', content: 'Hello', textType: 'text' },
    ]

    const result = appendTextToRootStream(blocks, {
      type: 'text',
      text: ' World',
    })

    expect(result).toHaveLength(1)
    expect((result[0] as TextContentBlock).content).toBe('Hello World')
  })

  test('creates new block for different text type', () => {
    const blocks: ContentBlock[] = [
      { type: 'text', content: 'Hello', textType: 'text' },
    ]

    const result = appendTextToRootStream(blocks, {
      type: 'reasoning',
      text: 'Thinking...',
    })

    expect(result).toHaveLength(2)
    expect((result[1] as TextContentBlock).textType).toBe('reasoning')
    expect((result[1] as TextContentBlock).thinkingCollapseState).toBe(
      'preview',
    )
  })

  test('returns original blocks for empty text', () => {
    const blocks: ContentBlock[] = [{ type: 'text', content: 'Hello' }]

    const result = appendTextToRootStream(blocks, { type: 'text', text: '' })

    expect(result).toBe(blocks)
  })

  // Think tag parsing tests
  test('handles unclosed think tag', () => {
    const result = appendTextToRootStream([], {
      type: 'text',
      text: 'Before <think>unclosed thoughts',
    })

    expect(result).toHaveLength(2)
    expect((result[0] as TextContentBlock).content).toBe('Before ')
    expect((result[1] as TextContentBlock).content).toBe('unclosed thoughts')
    expect((result[1] as TextContentBlock).textType).toBe('reasoning')
    expect((result[1] as TextContentBlock).thinkingOpen).toBe(true)
  })

  test('continues appending to open thinking block', () => {
    const blocks: ContentBlock[] = [
      {
        type: 'text',
        content: 'initial thoughts',
        textType: 'reasoning',
        isCollapsed: true,
        thinkingOpen: true,
      },
    ]

    const result = appendTextToRootStream(blocks, {
      type: 'text',
      text: ' more thoughts',
    })

    expect(result).toHaveLength(1)
    expect((result[0] as TextContentBlock).content).toBe(
      'initial thoughts more thoughts',
    )
    expect((result[0] as TextContentBlock).textType).toBe('reasoning')
  })

  test('closes thinking block when close tag received', () => {
    const blocks: ContentBlock[] = [
      {
        type: 'text',
        content: 'initial thoughts',
        textType: 'reasoning',
        isCollapsed: true,
        thinkingOpen: true,
      },
    ]

    const result = appendTextToRootStream(blocks, {
      type: 'text',
      text: ' final</think> regular text',
    })

    expect(result).toHaveLength(2)
    expect((result[0] as TextContentBlock).content).toBe(
      'initial thoughts final',
    )
    expect((result[0] as TextContentBlock).textType).toBe('reasoning')
    expect((result[0] as TextContentBlock).thinkingOpen).toBe(false)
    expect((result[1] as TextContentBlock).content).toBe(' regular text')
    expect((result[1] as TextContentBlock).textType).toBe('text')
  })

  test('text without think tags works normally', () => {
    const result = appendTextToRootStream([], {
      type: 'text',
      text: 'Just regular text without tags',
    })

    expect(result).toHaveLength(1)
    expect((result[0] as TextContentBlock).content).toBe(
      'Just regular text without tags',
    )
    expect((result[0] as TextContentBlock).textType).toBe('text')
  })

  test('closes thinking block when receiving just </think> tag', () => {
    const blocks: ContentBlock[] = [
      {
        type: 'text',
        content: 'thoughts',
        textType: 'reasoning',
        isCollapsed: true,
        thinkingOpen: true,
      },
    ]

    const result = appendTextToRootStream(blocks, {
      type: 'text',
      text: '</think>',
    })

    expect(result).toHaveLength(1)
    expect((result[0] as TextContentBlock).content).toBe('thoughts')
    expect((result[0] as TextContentBlock).textType).toBe('reasoning')
    expect((result[0] as TextContentBlock).thinkingOpen).toBe(false)
  })

  test('closes thinking block and adds text after </think>', () => {
    const blocks: ContentBlock[] = [
      {
        type: 'text',
        content: 'thoughts',
        textType: 'reasoning',
        isCollapsed: true,
        thinkingOpen: true,
      },
    ]

    const result = appendTextToRootStream(blocks, {
      type: 'text',
      text: '</think>after',
    })

    expect(result).toHaveLength(2)
    expect((result[0] as TextContentBlock).content).toBe('thoughts')
    expect((result[0] as TextContentBlock).textType).toBe('reasoning')
    expect((result[0] as TextContentBlock).thinkingOpen).toBe(false)
    expect((result[1] as TextContentBlock).content).toBe('after')
    expect((result[1] as TextContentBlock).textType).toBe('text')
  })

  // Streaming simulation tests
  test('streaming: does not create duplicate block when closing existing thinking block', () => {
    // Simulate streaming: first chunk opens thinking, second chunk closes it
    // First chunk: '<think>My thoughts' creates open thinking block
    const afterFirstChunk = appendTextToRootStream([], {
      type: 'text',
      text: '<think>My thoughts',
    })

    expect(afterFirstChunk).toHaveLength(1)
    expect((afterFirstChunk[0] as TextContentBlock).textType).toBe('reasoning')
    expect((afterFirstChunk[0] as TextContentBlock).content).toBe('My thoughts')
    expect((afterFirstChunk[0] as TextContentBlock).thinkingOpen).toBe(true)

    // Second chunk: '</think> after' should close the block, not create a duplicate
    const afterSecondChunk = appendTextToRootStream(afterFirstChunk, {
      type: 'text',
      text: '</think> after',
    })

    expect(afterSecondChunk).toHaveLength(2)
    expect((afterSecondChunk[0] as TextContentBlock).textType).toBe('reasoning')
    expect((afterSecondChunk[0] as TextContentBlock).content).toBe(
      'My thoughts',
    )
    expect((afterSecondChunk[0] as TextContentBlock).thinkingOpen).toBe(false)
    expect((afterSecondChunk[1] as TextContentBlock).textType).toBe('text')
    expect((afterSecondChunk[1] as TextContentBlock).content).toBe(' after')
  })

  // Native reasoning tests
  test('closes native reasoning block when text arrives', () => {
    // Native reasoning block (thinkingOpen === undefined)
    const blocks: ContentBlock[] = [
      {
        type: 'text',
        content: 'Thinking...',
        textType: 'reasoning',
        isCollapsed: true,
        thinkingId: 'think-1',
        // Note: thinkingOpen is undefined for native reasoning
      },
    ]

    const result = appendTextToRootStream(blocks, {
      type: 'text',
      text: 'Regular text',
    })

    expect(result).toHaveLength(2)
    // Native reasoning block should be closed
    expect((result[0] as TextContentBlock).thinkingOpen).toBe(false)
    // New text block added
    expect((result[1] as TextContentBlock).content).toBe('Regular text')
    expect((result[1] as TextContentBlock).textType).toBe('text')
  })

  test('appends to existing native reasoning block', () => {
    const blocks: ContentBlock[] = [
      {
        type: 'text',
        content: 'First thought',
        textType: 'reasoning',
        isCollapsed: true,
        thinkingId: 'think-1',
        // thinkingOpen is undefined for native reasoning
      },
    ]

    const result = appendTextToRootStream(blocks, {
      type: 'reasoning',
      text: ' second thought',
    })

    expect(result).toHaveLength(1)
    expect((result[0] as TextContentBlock).content).toBe(
      'First thought second thought',
    )
    expect((result[0] as TextContentBlock).textType).toBe('reasoning')
  })
})

// ============================================================================
// Native Reasoning Block Tests (from block-operations)
// ============================================================================

describe('isNativeReasoningBlock', () => {
  test('returns true for native reasoning block (thinkingOpen undefined)', () => {
    const block: ContentBlock = {
      type: 'text',
      content: 'Thinking...',
      textType: 'reasoning',
      isCollapsed: true,
      thinkingId: 'think-1',
    }

    expect(isNativeReasoningBlock(block)).toBe(true)
  })

  test('returns false for closed native reasoning block (thinkingOpen false)', () => {
    const block: ContentBlock = {
      type: 'text',
      content: 'Thinking...',
      textType: 'reasoning',
      isCollapsed: true,
      thinkingOpen: false,
      thinkingId: 'think-1',
    }

    expect(isNativeReasoningBlock(block)).toBe(false)
  })

  test('returns false for <think> tag block (thinkingOpen true)', () => {
    const block: ContentBlock = {
      type: 'text',
      content: 'Thinking...',
      textType: 'reasoning',
      isCollapsed: true,
      thinkingOpen: true,
      thinkingId: 'think-1',
    }

    expect(isNativeReasoningBlock(block)).toBe(false)
  })

  test('returns false for regular text block', () => {
    const block: ContentBlock = {
      type: 'text',
      content: 'Hello',
      textType: 'text',
    }

    expect(isNativeReasoningBlock(block)).toBe(false)
  })

  test('returns false for non-text blocks', () => {
    const agentBlock: ContentBlock = {
      type: 'agent',
      agentId: 'agent-1',
      agentName: 'Test',
      agentType: 'test',
      content: '',
      status: 'running',
    }

    expect(isNativeReasoningBlock(agentBlock)).toBe(false)
  })

  test('returns false for undefined', () => {
    expect(isNativeReasoningBlock(undefined)).toBe(false)
  })
})

describe('closeNativeReasoningBlock', () => {
  test('closes native reasoning block by setting thinkingOpen to false', () => {
    const blocks: ContentBlock[] = [
      {
        type: 'text',
        content: 'Thinking...',
        textType: 'reasoning',
        isCollapsed: true,
        thinkingId: 'think-1',
      },
    ]

    const result = closeNativeReasoningBlock(blocks)

    expect(result).toHaveLength(1)
    expect((result[0] as TextContentBlock).thinkingOpen).toBe(false)
    expect((result[0] as TextContentBlock).content).toBe('Thinking...')
  })

  test('returns original blocks if no native reasoning block exists', () => {
    const blocks: ContentBlock[] = [
      { type: 'text', content: 'Hello', textType: 'text' },
    ]

    const result = closeNativeReasoningBlock(blocks)

    expect(result).toBe(blocks) // Same reference
  })

  test('does not close already-closed reasoning blocks', () => {
    const blocks: ContentBlock[] = [
      {
        type: 'text',
        content: 'Already closed',
        textType: 'reasoning',
        isCollapsed: true,
        thinkingOpen: false,
        thinkingId: 'think-1',
      },
    ]

    const result = closeNativeReasoningBlock(blocks)

    expect(result).toBe(blocks) // Same reference, no change
  })

  test('does not close <think> tag blocks (thinkingOpen true)', () => {
    const blocks: ContentBlock[] = [
      {
        type: 'text',
        content: 'Think tag block',
        textType: 'reasoning',
        isCollapsed: true,
        thinkingOpen: true,
        thinkingId: 'think-1',
      },
    ]

    const result = closeNativeReasoningBlock(blocks)

    expect(result).toBe(blocks) // Same reference, no change
  })

  test('finds native reasoning block even when not at end', () => {
    const blocks: ContentBlock[] = [
      {
        type: 'text',
        content: 'Native reasoning',
        textType: 'reasoning',
        isCollapsed: true,
        thinkingId: 'think-1',
      },
      {
        type: 'agent',
        agentId: 'agent-1',
        agentName: 'Test',
        agentType: 'test',
        content: '',
        status: 'running',
      },
    ]

    const result = closeNativeReasoningBlock(blocks)

    expect((result[0] as TextContentBlock).thinkingOpen).toBe(false)
    expect(result[1]).toEqual(blocks[1]) // Agent block unchanged
  })
})

describe('closeNativeReasoningInAgent', () => {
  test('closes native reasoning in specific agent', () => {
    const blocks: ContentBlock[] = [
      {
        type: 'agent',
        agentId: 'agent-1',
        agentName: 'Test',
        agentType: 'test',
        content: '',
        status: 'running',
        blocks: [
          {
            type: 'text',
            content: 'Agent thinking...',
            textType: 'reasoning',
            isCollapsed: true,
            thinkingId: 'think-1',
          },
        ],
      },
    ]

    const result = closeNativeReasoningInAgent(blocks, 'agent-1')

    const agentBlock = result[0] as AgentContentBlock
    expect((agentBlock.blocks![0] as TextContentBlock).thinkingOpen).toBe(false)
  })

  test('does not modify other agents', () => {
    const blocks: ContentBlock[] = [
      {
        type: 'agent',
        agentId: 'agent-1',
        agentName: 'Test 1',
        agentType: 'test',
        content: '',
        status: 'running',
        blocks: [
          {
            type: 'text',
            content: 'Agent 1 thinking...',
            textType: 'reasoning',
            isCollapsed: true,
            thinkingId: 'think-1',
          },
        ],
      },
      {
        type: 'agent',
        agentId: 'agent-2',
        agentName: 'Test 2',
        agentType: 'test',
        content: '',
        status: 'running',
        blocks: [
          {
            type: 'text',
            content: 'Agent 2 thinking...',
            textType: 'reasoning',
            isCollapsed: true,
            thinkingId: 'think-2',
          },
        ],
      },
    ]

    const result = closeNativeReasoningInAgent(blocks, 'agent-1')

    const agent1 = result[0] as AgentContentBlock
    const agent2 = result[1] as AgentContentBlock
    expect((agent1.blocks![0] as TextContentBlock).thinkingOpen).toBe(false)
    // Agent 2 should still have undefined thinkingOpen
    expect((agent2.blocks![0] as TextContentBlock).thinkingOpen).toBeUndefined()
  })

  test('returns original blocks if agent not found', () => {
    const blocks: ContentBlock[] = [{ type: 'text', content: 'Hello' }]

    const result = closeNativeReasoningInAgent(blocks, 'nonexistent')

    expect(result).toBe(blocks)
  })
})

describe('appendTextToAgentBlock with native reasoning', () => {
  test('creates native reasoning block when textType is reasoning', () => {
    const blocks: ContentBlock[] = [
      {
        type: 'agent',
        agentId: 'agent-1',
        agentName: 'Test',
        agentType: 'test',
        content: '',
        status: 'running',
        blocks: [],
      },
    ]

    const result = appendTextToAgentBlock(
      blocks,
      'agent-1',
      'Thinking...',
      'reasoning',
    )

    const agentBlock = result[0] as AgentContentBlock
    expect(agentBlock.blocks).toHaveLength(1)
    expect((agentBlock.blocks![0] as TextContentBlock).textType).toBe(
      'reasoning',
    )
    expect((agentBlock.blocks![0] as TextContentBlock).content).toBe(
      'Thinking...',
    )
    expect(
      (agentBlock.blocks![0] as TextContentBlock).thinkingCollapseState,
    ).toBe('preview')
    // Native reasoning has thinkingOpen undefined
    expect(
      (agentBlock.blocks![0] as TextContentBlock).thinkingOpen,
    ).toBeUndefined()
  })

  test('appends to existing open native reasoning block', () => {
    const blocks: ContentBlock[] = [
      {
        type: 'agent',
        agentId: 'agent-1',
        agentName: 'Test',
        agentType: 'test',
        content: 'First',
        status: 'running',
        blocks: [
          {
            type: 'text',
            content: 'First',
            textType: 'reasoning',
            isCollapsed: true,
            thinkingId: 'think-1',
          },
        ],
      },
    ]

    const result = appendTextToAgentBlock(
      blocks,
      'agent-1',
      ' second',
      'reasoning',
    )

    const agentBlock = result[0] as AgentContentBlock
    expect(agentBlock.blocks).toHaveLength(1)
    expect((agentBlock.blocks![0] as TextContentBlock).content).toBe(
      'First second',
    )
  })

  test('does NOT append to closed native reasoning block', () => {
    const blocks: ContentBlock[] = [
      {
        type: 'agent',
        agentId: 'agent-1',
        agentName: 'Test',
        agentType: 'test',
        content: 'Closed',
        status: 'running',
        blocks: [
          {
            type: 'text',
            content: 'Closed',
            textType: 'reasoning',
            isCollapsed: true,
            thinkingOpen: false, // Already closed
            thinkingId: 'think-1',
          },
        ],
      },
    ]

    const result = appendTextToAgentBlock(
      blocks,
      'agent-1',
      'New thought',
      'reasoning',
    )

    const agentBlock = result[0] as AgentContentBlock
    // Should create a NEW reasoning block, not append to closed one
    expect(agentBlock.blocks).toHaveLength(2)
    expect((agentBlock.blocks![0] as TextContentBlock).content).toBe('Closed')
    expect((agentBlock.blocks![1] as TextContentBlock).content).toBe(
      'New thought',
    )
  })

  test('does NOT append to <think> tag block', () => {
    const blocks: ContentBlock[] = [
      {
        type: 'agent',
        agentId: 'agent-1',
        agentName: 'Test',
        agentType: 'test',
        content: 'Think tag',
        status: 'running',
        blocks: [
          {
            type: 'text',
            content: 'Think tag',
            textType: 'reasoning',
            isCollapsed: true,
            thinkingOpen: true, // <think> tag block
            thinkingId: 'think-1',
          },
        ],
      },
    ]

    const result = appendTextToAgentBlock(
      blocks,
      'agent-1',
      'Native thought',
      'reasoning',
    )

    const agentBlock = result[0] as AgentContentBlock
    // Should create a NEW native reasoning block, not append to <think> block
    expect(agentBlock.blocks).toHaveLength(2)
    expect((agentBlock.blocks![0] as TextContentBlock).thinkingOpen).toBe(true)
    expect(
      (agentBlock.blocks![1] as TextContentBlock).thinkingOpen,
    ).toBeUndefined()
  })

  test('closes native reasoning when regular text arrives', () => {
    const blocks: ContentBlock[] = [
      {
        type: 'agent',
        agentId: 'agent-1',
        agentName: 'Test',
        agentType: 'test',
        content: 'Thinking',
        status: 'running',
        blocks: [
          {
            type: 'text',
            content: 'Thinking',
            textType: 'reasoning',
            isCollapsed: true,
            thinkingId: 'think-1',
          },
        ],
      },
    ]

    const result = appendTextToAgentBlock(
      blocks,
      'agent-1',
      'Regular text',
      'text',
    )

    const agentBlock = result[0] as AgentContentBlock
    expect(agentBlock.blocks).toHaveLength(2)
    // Native reasoning should be closed
    expect((agentBlock.blocks![0] as TextContentBlock).thinkingOpen).toBe(false)
    // New text block added
    expect((agentBlock.blocks![1] as TextContentBlock).content).toBe(
      'Regular text',
    )
    expect((agentBlock.blocks![1] as TextContentBlock).textType).toBe('text')
  })
})

describe('appendToolToAgentBlock closes native reasoning', () => {
  test('closes native reasoning when tool is appended', () => {
    const blocks: ContentBlock[] = [
      {
        type: 'agent',
        agentId: 'agent-1',
        agentName: 'Test',
        agentType: 'test',
        content: 'Thinking',
        status: 'running',
        blocks: [
          {
            type: 'text',
            content: 'Thinking',
            textType: 'reasoning',
            isCollapsed: true,
            thinkingId: 'think-1',
          },
        ],
      },
    ]

    const toolBlock: ToolContentBlock = {
      type: 'tool',
      toolCallId: 'tool-1',
      toolName: 'read_files',
      input: { paths: ['test.ts'] },
    }

    const result = appendToolToAgentBlock(blocks, 'agent-1', toolBlock)

    const agentBlock = result[0] as AgentContentBlock
    expect(agentBlock.blocks).toHaveLength(2)
    // Native reasoning should be closed
    expect((agentBlock.blocks![0] as TextContentBlock).thinkingOpen).toBe(false)
    // Tool block added
    expect(agentBlock.blocks![1].type).toBe('tool')
  })
})

describe('markAgentComplete closes native reasoning', () => {
  test('closes native reasoning when agent completes', () => {
    const blocks: ContentBlock[] = [
      {
        type: 'agent',
        agentId: 'agent-1',
        agentName: 'Test',
        agentType: 'test',
        content: 'Thinking',
        status: 'running',
        blocks: [
          {
            type: 'text',
            content: 'Thinking',
            textType: 'reasoning',
            isCollapsed: true,
            thinkingId: 'think-1',
          },
        ],
      },
    ]

    const result = markAgentComplete(blocks, 'agent-1')

    const agentBlock = result[0] as AgentContentBlock
    expect(agentBlock.status).toBe('complete')
    expect((agentBlock.blocks![0] as TextContentBlock).thinkingOpen).toBe(false)
  })
})

describe('markRunningAgentsAsCancelled closes native reasoning', () => {
  test('closes native reasoning in cancelled agents', () => {
    const blocks: ContentBlock[] = [
      {
        type: 'agent',
        agentId: 'agent-1',
        agentName: 'Test',
        agentType: 'test',
        content: 'Thinking',
        status: 'running',
        blocks: [
          {
            type: 'text',
            content: 'Thinking',
            textType: 'reasoning',
            isCollapsed: true,
            thinkingId: 'think-1',
          },
        ],
      },
    ]

    const result = markRunningAgentsAsCancelled(blocks)

    const agentBlock = result[0] as AgentContentBlock
    expect(agentBlock.status).toBe('cancelled')
    expect((agentBlock.blocks![0] as TextContentBlock).thinkingOpen).toBe(false)
  })

  test('closes native reasoning in nested cancelled agents', () => {
    const blocks: ContentBlock[] = [
      {
        type: 'agent',
        agentId: 'parent',
        agentName: 'Parent',
        agentType: 'parent',
        content: '',
        status: 'running',
        blocks: [
          {
            type: 'agent',
            agentId: 'child',
            agentName: 'Child',
            agentType: 'child',
            content: 'Child thinking',
            status: 'running',
            blocks: [
              {
                type: 'text',
                content: 'Child thinking',
                textType: 'reasoning',
                isCollapsed: true,
                thinkingId: 'think-child',
              },
            ],
          },
        ],
      },
    ]

    const result = markRunningAgentsAsCancelled(blocks)

    const parentBlock = result[0] as AgentContentBlock
    const childBlock = parentBlock.blocks![0] as AgentContentBlock

    expect(parentBlock.status).toBe('cancelled')
    expect(childBlock.status).toBe('cancelled')
    expect((childBlock.blocks![0] as TextContentBlock).thinkingOpen).toBe(false)
  })

  test('closes native reasoning even in non-running agents during cancellation', () => {
    const blocks: ContentBlock[] = [
      {
        type: 'agent',
        agentId: 'agent-1',
        agentName: 'Test',
        agentType: 'test',
        content: '',
        status: 'complete', // Already complete
        blocks: [
          {
            type: 'agent',
            agentId: 'child',
            agentName: 'Child',
            agentType: 'child',
            content: 'Thinking',
            status: 'running',
            blocks: [
              {
                type: 'text',
                content: 'Thinking',
                textType: 'reasoning',
                isCollapsed: true,
                thinkingId: 'think-1',
              },
            ],
          },
        ],
      },
    ]

    const result = markRunningAgentsAsCancelled(blocks)

    const parentBlock = result[0] as AgentContentBlock
    const childBlock = parentBlock.blocks![0] as AgentContentBlock

    // Parent stays complete
    expect(parentBlock.status).toBe('complete')
    // Child is cancelled
    expect(childBlock.status).toBe('cancelled')
    // Child's reasoning is closed
    expect((childBlock.blocks![0] as TextContentBlock).thinkingOpen).toBe(false)
  })

  test('does not modify agents without native reasoning blocks', () => {
    const blocks: ContentBlock[] = [
      {
        type: 'agent',
        agentId: 'agent-1',
        agentName: 'Test',
        agentType: 'test',
        content: 'Hello',
        status: 'running',
        blocks: [{ type: 'text', content: 'Hello', textType: 'text' }],
      },
    ]

    const result = markRunningAgentsAsCancelled(blocks)

    const agentBlock = result[0] as AgentContentBlock
    expect(agentBlock.status).toBe('cancelled')
    // Text block should be unchanged
    expect(
      (agentBlock.blocks![0] as TextContentBlock).thinkingOpen,
    ).toBeUndefined()
  })
})

describe('extractPlanFromBuffer', () => {
  test('extracts plan content from complete tags', () => {
    const buffer = 'Some text <PLAN>This is the plan</PLAN> more text'

    const result = extractPlanFromBuffer(buffer)

    expect(result).toBe('This is the plan')
  })

  test('returns null for incomplete plan', () => {
    const buffer = 'Some text <PLAN>Incomplete plan'

    expect(extractPlanFromBuffer(buffer)).toBeNull()
  })

  test('returns null when no plan tags exist', () => {
    expect(extractPlanFromBuffer('No plan here')).toBeNull()
  })

  test('trims whitespace from extracted plan', () => {
    const buffer = '<PLAN>  Trimmed plan  </PLAN>'

    expect(extractPlanFromBuffer(buffer)).toBe('Trimmed plan')
  })
})

// ============================================================================
// Agent Block Helpers Tests (from message-block-helpers)
// ============================================================================

describe('createAgentBlock', () => {
  test('creates an agent block with required fields', () => {
    const block = createAgentBlock({
      agentId: 'agent-1',
      agentType: 'file-picker',
    })

    expect(block.type).toBe('agent')
    expect(block.agentId).toBe('agent-1')
    expect(block.agentType).toBe('file-picker')
    expect(block.status).toBe('running')
    expect(block.content).toBe('')
  })

  test('includes optional prompt', () => {
    const block = createAgentBlock({
      agentId: 'agent-1',
      agentType: 'file-picker',
      prompt: 'Find files',
    })

    expect(block.initialPrompt).toBe('Find files')
  })

  test('includes optional params', () => {
    const block = createAgentBlock({
      agentId: 'agent-1',
      agentType: 'file-picker',
      params: { path: '/src' },
    })

    expect(block.params).toEqual({ path: '/src' })
  })
})

describe('getAgentBaseName', () => {
  test('extracts base name from scoped versioned name', () => {
    expect(getAgentBaseName('codebuff/file-picker@0.0.2')).toBe('file-picker')
  })

  test('extracts base name from simple versioned name', () => {
    expect(getAgentBaseName('file-picker@1.0.0')).toBe('file-picker')
  })

  test('returns simple name unchanged', () => {
    expect(getAgentBaseName('file-picker')).toBe('file-picker')
  })

  test('normalizes direct tool aliases to canonical agent names', () => {
    expect(getAgentBaseName('code_reviewer_lite')).toBe('code-reviewer-lite')
  })
})

describe('agentTypesMatch', () => {
  test('matches same base names with different versions', () => {
    expect(
      getAgentBaseName('codebuff/file-picker@0.0.2') ===
        getAgentBaseName('file-picker@1.0.0'),
    ).toBe(true)
  })

  test('matches same simple names', () => {
    expect(
      getAgentBaseName('file-picker') === getAgentBaseName('file-picker'),
    ).toBe(true)
  })

  test('does not match different base names', () => {
    expect(
      getAgentBaseName('file-picker') === getAgentBaseName('code-searcher'),
    ).toBe(false)
  })
})

// ============================================================================
// Tool Block Helpers Tests (from message-block-helpers)
// ============================================================================

describe('updateToolBlockWithOutput', () => {
  test('updates tool block with output', () => {
    const blocks: ContentBlock[] = [
      {
        type: 'tool',
        toolCallId: 'tool-1',
        toolName: 'read_files',
        input: {},
      },
    ]

    const result = updateToolBlockWithOutput(blocks, {
      toolCallId: 'tool-1',
      toolOutput: ['File contents'],
    })

    expect((result[0] as ToolContentBlock).output).toBe('File contents')
  })

  test('updates nested tool block', () => {
    const blocks: ContentBlock[] = [
      {
        type: 'agent',
        agentId: 'agent-1',
        agentName: 'Test',
        agentType: 'test',
        content: '',
        status: 'running',
        blocks: [
          {
            type: 'tool',
            toolCallId: 'tool-1',
            toolName: 'read_files',
            input: {},
          },
        ],
      },
    ]

    const result = updateToolBlockWithOutput(blocks, {
      toolCallId: 'tool-1',
      toolOutput: ['File contents'],
    })
    const agent = result[0] as AgentContentBlock
    expect((agent.blocks![0] as ToolContentBlock).output).toBe('File contents')
  })

  test('returns same reference if no match', () => {
    const blocks: ContentBlock[] = [{ type: 'text', content: 'Hello' }]

    const result = updateToolBlockWithOutput(blocks, {
      toolCallId: 'tool-1',
      toolOutput: ['Output'],
    })

    expect(result).toEqual(blocks)
  })
})

// ============================================================================
// Ask User Transformation Tests (from message-block-helpers)
// ============================================================================

describe('transformAskUserBlocks', () => {
  test('transforms ask_user tool block to ask-user block', () => {
    const blocks: ContentBlock[] = [
      {
        type: 'tool',
        toolCallId: 'tool-1',
        toolName: 'ask_user',
        input: { questions: [{ question: 'Choose?', options: ['A', 'B'] }] },
      },
    ]

    const result = transformAskUserBlocks(blocks, {
      toolCallId: 'tool-1',
      resultValue: { answers: [{ questionIndex: 0, selectedOption: 'A' }] },
    })

    expect(result[0].type).toBe('ask-user')
    expect((result[0] as AskUserContentBlock).answers).toEqual([
      { questionIndex: 0, selectedOption: 'A' },
    ])
  })

  test('keeps tool block if no answers or skipped', () => {
    const blocks: ContentBlock[] = [
      {
        type: 'tool',
        toolCallId: 'tool-1',
        toolName: 'ask_user',
        input: { questions: [] },
      },
    ]

    const result = transformAskUserBlocks(blocks, {
      toolCallId: 'tool-1',
      resultValue: {},
    })

    expect(result[0].type).toBe('tool')
  })

  test('handles skipped state', () => {
    const blocks: ContentBlock[] = [
      {
        type: 'tool',
        toolCallId: 'tool-1',
        toolName: 'ask_user',
        input: { questions: [] },
      },
    ]

    const result = transformAskUserBlocks(blocks, {
      toolCallId: 'tool-1',
      resultValue: { skipped: true },
    })

    expect(result[0].type).toBe('ask-user')
    expect((result[0] as AskUserContentBlock).skipped).toBe(true)
  })
})

// ============================================================================
// Interruption Handling Tests (from message-block-helpers)
// ============================================================================

describe('appendInterruptionNotice', () => {
  test('appends to existing text block', () => {
    const blocks: ContentBlock[] = [
      { type: 'text', content: 'Partial response' },
    ]

    const result = appendInterruptionNotice(blocks)

    expect((result[0] as TextContentBlock).content).toBe(
      'Partial response\n\n[response interrupted]',
    )
  })

  test('creates new text block if no existing text', () => {
    const blocks: ContentBlock[] = []

    const result = appendInterruptionNotice(blocks)

    expect(result).toHaveLength(1)
    expect((result[0] as TextContentBlock).content).toBe(
      '[response interrupted]',
    )
  })

  test('creates new block if last block is not text', () => {
    const blocks: ContentBlock[] = [
      {
        type: 'tool',
        toolCallId: 'tool-1',
        toolName: 'read_files',
        input: {},
      },
    ]

    const result = appendInterruptionNotice(blocks)

    expect(result).toHaveLength(2)
    expect(result[1].type).toBe('text')
  })
})

// ============================================================================
// Spawn Agents Helpers Tests (from send-message-helpers)
// ============================================================================

describe('isSpawnAgentsResult', () => {
  test('returns true for spawn_agents result structure', () => {
    const output = [{ agentName: 'file-picker', value: 'result' }]

    expect(isSpawnAgentsResult(output)).toBe(true)
  })

  test('returns false for non-array', () => {
    expect(isSpawnAgentsResult('string')).toBe(false)
    expect(isSpawnAgentsResult(null)).toBe(false)
  })

  test('returns false for array without agent properties', () => {
    expect(isSpawnAgentsResult([{ foo: 'bar' }])).toBe(false)
  })
})

describe('extractSpawnAgentResultContent', () => {
  test('extracts string value directly', () => {
    const result = extractSpawnAgentResultContent('Simple result')

    expect(result.content).toBe('Simple result')
    expect(result.hasError).toBe(false)
  })

  test('extracts string from value property', () => {
    const result = extractSpawnAgentResultContent({ value: 'Nested string' })

    expect(result.content).toBe('Nested string')
    expect(result.hasError).toBe(false)
  })

  test('extracts error message', () => {
    const result = extractSpawnAgentResultContent({ errorMessage: 'Failed!' })

    expect(result.content).toBe('Failed!')
    expect(result.hasError).toBe(true)
  })

  test('extracts nested error message', () => {
    const result = extractSpawnAgentResultContent({
      value: { errorMessage: 'Nested error!' },
    })

    expect(result.content).toBe('Nested error!')
    expect(result.hasError).toBe(true)
  })

  test('extracts message property', () => {
    const result = extractSpawnAgentResultContent({
      message: 'Message content',
    })

    expect(result.content).toBe('Message content')
    expect(result.hasError).toBe(false)
  })

  test('extracts nested message property', () => {
    const result = extractSpawnAgentResultContent({
      value: { message: 'Nested message' },
    })

    expect(result.content).toBe('Nested message')
    expect(result.hasError).toBe(false)
  })

  test('returns empty for null/undefined', () => {
    const result = extractSpawnAgentResultContent(null)

    expect(result.content).toBe('')
    expect(result.hasError).toBe(false)
  })

  test('returns empty for empty object', () => {
    const result = extractSpawnAgentResultContent({})

    expect(result.content).toBe('')
    expect(result.hasError).toBe(false)
  })
})

// ============================================================================
// sanitizeRestoredMessages Tests
// ============================================================================

describe('sanitizeRestoredMessages', () => {
  const streamedShell = (
    overrides: Partial<ChatMessage> = {},
  ): ChatMessage => ({
    id: 'ai-1750000000000-abc123',
    variant: 'ai',
    content: '',
    timestamp: new Date().toISOString(),
    blocks: [{ type: 'text', content: 'partial answer' }],
    ...overrides,
  })

  test('marks an interrupted AI response complete with an interruption notice', () => {
    const [result] = sanitizeRestoredMessages([streamedShell()])

    expect(result.isComplete).toBe(true)
    const lastBlock = result.blocks![result.blocks!.length - 1]
    expect(lastBlock.type).toBe('text')
    expect((lastBlock as TextContentBlock).content).toContain(
      '[response interrupted]',
    )
  })

  test('cancels running agent blocks in an interrupted AI response', () => {
    const [result] = sanitizeRestoredMessages([
      streamedShell({
        blocks: [
          {
            type: 'agent',
            agentId: 'agent-1',
            agentName: 'TestAgent',
            agentType: 'inline',
            content: '',
            status: 'running',
            blocks: [],
          },
        ],
      }),
    ])

    const agentBlock = result.blocks![0] as AgentContentBlock
    expect(agentBlock.status).toBe('cancelled')
  })

  test('adds a notice to an interrupted AI response with no blocks yet', () => {
    const [result] = sanitizeRestoredMessages([streamedShell({ blocks: [] })])

    expect(result.isComplete).toBe(true)
    expect(result.blocks).toHaveLength(1)
    expect((result.blocks![0] as TextContentBlock).content).toBe(
      '[response interrupted]',
    )
  })

  test('leaves completed AI responses untouched', () => {
    const message = streamedShell({ isComplete: true })
    const [result] = sanitizeRestoredMessages([message])

    expect(result).toBe(message)
  })

  test('strips the live inline-ad marker from restored responses', () => {
    const [result] = sanitizeRestoredMessages([
      streamedShell({
        isComplete: true,
        metadata: { allowInlineAds: true, userOpened: true },
      }),
    ])

    expect(result.metadata).toEqual({ userOpened: true })
  })

  test('drops persisted hidden agent blocks (context-pruner)', () => {
    const [result] = sanitizeRestoredMessages([
      streamedShell({
        isComplete: true,
        blocks: [
          {
            type: 'agent',
            agentId: 'agent-1',
            agentName: 'context-pruner',
            agentType: 'context-pruner',
            content: '',
            status: 'complete',
          },
          { type: 'text', content: 'answer' },
        ],
      }),
    ])

    expect(result.blocks).toHaveLength(1)
    expect(result.blocks![0].type).toBe('text')
  })

  test('leaves mode dividers, system messages, and user messages untouched', () => {
    const divider = createModeDividerMessage('DEFAULT' as any)
    const system: ChatMessage = {
      id: 'sys-123',
      variant: 'ai',
      content: 'system notice',
      timestamp: new Date().toISOString(),
    }
    const user: ChatMessage = {
      id: 'user-123',
      variant: 'user',
      content: 'hello',
      timestamp: new Date().toISOString(),
    }

    const results = sanitizeRestoredMessages([divider, system, user])

    expect(results[0]).toBe(divider)
    expect(results[1]).toBe(system)
    expect(results[2]).toBe(user)
  })
})

describe('sanitizeRestoredMessages corruption tolerance', () => {
  test('does not throw on null entries in a restored blocks array', () => {
    const corrupted: ChatMessage = {
      id: 'ai-1750000000000-abc123',
      variant: 'ai',
      content: '',
      timestamp: new Date().toISOString(),
      blocks: [null as unknown as ContentBlock, { type: 'text', content: 'x' }],
    }

    const [result] = sanitizeRestoredMessages([corrupted])

    expect(result.isComplete).toBe(true)
  })
})
