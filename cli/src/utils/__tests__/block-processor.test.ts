import { describe, expect, test } from 'bun:test'

import {
  processBlocks,
  splitAgentsBySize,
  isReasoningTextBlock,
  type BlockProcessorHandlers,
} from '../block-processor'

import type {
  ContentBlock,
  TextContentBlock,
  ToolContentBlock,
  AgentContentBlock,
  ImageContentBlock,
} from '../../types/chat'

// ============================================================================
// Test Helpers - Block Factories
// ============================================================================

function createTextBlock(
  content: string,
  textType?: 'reasoning' | 'text',
): TextContentBlock {
  return {
    type: 'text',
    content,
    textType,
  } as TextContentBlock
}

function createReasoningBlock(content: string): TextContentBlock {
  return createTextBlock(content, 'reasoning')
}

function createToolBlock(
  toolName: string,
  toolCallId: string = `tool-${toolName}`,
): ToolContentBlock {
  return {
    type: 'tool',
    toolCallId,
    toolName: toolName as ToolContentBlock['toolName'],
    input: {},
  }
}

function createImageBlock(
  mediaType: string = 'image/png',
  image: string = 'base64data',
): ImageContentBlock {
  return {
    type: 'image',
    mediaType,
    image,
  } as ImageContentBlock
}

function createImplementorAgent(
  agentId: string,
  agentType: string = 'editor-implementor',
): AgentContentBlock {
  return {
    type: 'agent',
    agentId,
    agentName: `Implementor ${agentId}`,
    agentType,
    content: '',
    status: 'complete',
    blocks: [],
  } as AgentContentBlock
}

function createNonImplementorAgent(
  agentId: string,
  agentType: string = 'file-picker',
): AgentContentBlock {
  return {
    type: 'agent',
    agentId,
    agentName: agentType,
    agentType,
    content: '',
    status: 'complete',
    blocks: [],
  } as AgentContentBlock
}

// ============================================================================
// Test Helpers - Mock Handlers
// ============================================================================

interface MockCallRecord {
  handler: string
  args: unknown[]
}

function createMockHandlers(): {
  handlers: BlockProcessorHandlers
  calls: MockCallRecord[]
} {
  const calls: MockCallRecord[] = []

  const handlers: BlockProcessorHandlers = {
    onReasoningGroup: (blocks, startIndex) => {
      calls.push({ handler: 'onReasoningGroup', args: [blocks, startIndex] })
      return `reasoning-${startIndex}`
    },
    onImageBlock: (block, index) => {
      calls.push({ handler: 'onImageBlock', args: [block, index] })
      return `image-${index}`
    },
    onToolGroup: (blocks, startIndex, nextIndex) => {
      calls.push({
        handler: 'onToolGroup',
        args: [blocks, startIndex, nextIndex],
      })
      return `tools-${startIndex}-${nextIndex}`
    },
    onImplementorGroup: (blocks, startIndex, nextIndex) => {
      calls.push({
        handler: 'onImplementorGroup',
        args: [blocks, startIndex, nextIndex],
      })
      return `implementors-${startIndex}-${nextIndex}`
    },
    onAgentGroup: (blocks, startIndex, nextIndex) => {
      calls.push({
        handler: 'onAgentGroup',
        args: [blocks, startIndex, nextIndex],
      })
      return `agents-${startIndex}-${nextIndex}`
    },
    onSingleBlock: (block, index) => {
      calls.push({ handler: 'onSingleBlock', args: [block, index] })
      return `single-${index}`
    },
  }

  return { handlers, calls }
}

// ============================================================================
// Tests: isReasoningTextBlock
// ============================================================================

describe('isReasoningTextBlock', () => {
  test('returns true for text block with textType "reasoning"', () => {
    const block = createReasoningBlock('thinking...')
    expect(isReasoningTextBlock(block)).toBe(true)
  })

  test('returns false for text block without textType', () => {
    const block = createTextBlock('normal text')
    expect(isReasoningTextBlock(block)).toBe(false)
  })

  test('returns false for text block with textType "text"', () => {
    const block = createTextBlock('normal text', 'text')
    expect(isReasoningTextBlock(block)).toBe(false)
  })

  test('returns false for non-text blocks', () => {
    expect(isReasoningTextBlock(createToolBlock('str_replace'))).toBe(false)
    expect(isReasoningTextBlock(createImageBlock())).toBe(false)
    expect(isReasoningTextBlock(createNonImplementorAgent('a1'))).toBe(false)
  })
})

// ============================================================================
// Tests: processBlocks - Basic Cases
// ============================================================================

describe('processBlocks', () => {
  describe('basic cases', () => {
    test('returns empty array for empty blocks', () => {
      const { handlers, calls } = createMockHandlers()
      const result = processBlocks([], handlers)

      expect(result).toEqual([])
      expect(calls).toHaveLength(0)
    })

    test('processes single text block with onSingleBlock', () => {
      const { handlers, calls } = createMockHandlers()
      const blocks: ContentBlock[] = [createTextBlock('hello')]

      const result = processBlocks(blocks, handlers)

      expect(result).toEqual(['single-0'])
      expect(calls).toHaveLength(1)
      expect(calls[0].handler).toBe('onSingleBlock')
      expect((calls[0].args[0] as TextContentBlock).content).toBe('hello')
      expect(calls[0].args[1]).toBe(0)
    })

    // COD-376. A sponsored proposal is one card and never groups with its
    // neighbours, so it falls through to `onSingleBlock` like text and html.
    // Asserted rather than assumed: the fall-through is the default branch,
    // which means nothing here names this block type -- and a future grouping
    // rule added above it would swallow it silently.
    test('a sponsored-proposal block falls through to onSingleBlock', () => {
      const { handlers, calls } = createMockHandlers()
      const proposal = {
        type: 'sponsored-proposal',
        target: 'acme/deploys',
        proposal: {
          _id: 'p1',
          advertiser_id: 'adv',
          state: 'offered',
          advertiser_name: 'Acme Deploys',
          headline: 'h',
          body: 'b',
        },
      } as ContentBlock

      expect(processBlocks([proposal], handlers)).toEqual(['single-0'])
      expect(calls).toHaveLength(1)
      expect(calls[0].handler).toBe('onSingleBlock')
    })
  })

  // ==========================================================================
  // Tests: Reasoning Block Grouping
  // ==========================================================================

  describe('reasoning block grouping', () => {
    test('groups single reasoning block', () => {
      const { handlers, calls } = createMockHandlers()
      const blocks: ContentBlock[] = [createReasoningBlock('thinking')]

      const result = processBlocks(blocks, handlers)

      expect(result).toEqual(['reasoning-0'])
      expect(calls).toHaveLength(1)
      expect(calls[0].handler).toBe('onReasoningGroup')
      expect((calls[0].args[0] as TextContentBlock[]).length).toBe(1)
      expect(calls[0].args[1]).toBe(0)
    })

    test('groups consecutive reasoning blocks together', () => {
      const { handlers, calls } = createMockHandlers()
      const blocks: ContentBlock[] = [
        createReasoningBlock('thought 1'),
        createReasoningBlock('thought 2'),
        createReasoningBlock('thought 3'),
      ]

      const result = processBlocks(blocks, handlers)

      expect(result).toEqual(['reasoning-0'])
      expect(calls).toHaveLength(1)
      expect(calls[0].handler).toBe('onReasoningGroup')
      const reasoningBlocks = calls[0].args[0] as TextContentBlock[]
      expect(reasoningBlocks).toHaveLength(3)
      expect(reasoningBlocks[0].content).toBe('thought 1')
      expect(reasoningBlocks[1].content).toBe('thought 2')
      expect(reasoningBlocks[2].content).toBe('thought 3')
    })

    test('separates reasoning groups interrupted by other blocks', () => {
      const { handlers, calls } = createMockHandlers()
      const blocks: ContentBlock[] = [
        createReasoningBlock('thought 1'),
        createTextBlock('response'),
        createReasoningBlock('thought 2'),
      ]

      const result = processBlocks(blocks, handlers)

      expect(result).toEqual(['reasoning-0', 'single-1', 'reasoning-2'])
      expect(calls).toHaveLength(3)
      expect(calls[0].handler).toBe('onReasoningGroup')
      expect(calls[1].handler).toBe('onSingleBlock')
      expect(calls[2].handler).toBe('onReasoningGroup')
    })
  })

  // ==========================================================================
  // Tests: Image Block Handling
  // ==========================================================================

  describe('image block handling', () => {
    test('handles image block with onImageBlock handler', () => {
      const { handlers, calls } = createMockHandlers()
      const blocks: ContentBlock[] = [createImageBlock('image/png', 'data123')]

      const result = processBlocks(blocks, handlers)

      expect(result).toEqual(['image-0'])
      expect(calls).toHaveLength(1)
      expect(calls[0].handler).toBe('onImageBlock')
      expect((calls[0].args[0] as ImageContentBlock).image).toBe('data123')
      expect(calls[0].args[1]).toBe(0)
    })

    test('skips image blocks when onImageBlock is not provided', () => {
      const calls: MockCallRecord[] = []
      const handlers: BlockProcessorHandlers = {
        onReasoningGroup: () => null,
        // onImageBlock intentionally omitted
        onToolGroup: () => null,
        onImplementorGroup: () => null,
        onAgentGroup: () => null,
        onSingleBlock: (block, index) => {
          calls.push({ handler: 'onSingleBlock', args: [block, index] })
          return `single-${index}`
        },
      }

      const blocks: ContentBlock[] = [
        createTextBlock('before'),
        createImageBlock(),
        createTextBlock('after'),
      ]

      const result = processBlocks(blocks, handlers)

      expect(result).toEqual(['single-0', 'single-2'])
      expect(calls).toHaveLength(2)
      // Image at index 1 was skipped, not passed to onSingleBlock
    })

    test('handles multiple consecutive images', () => {
      const { handlers, calls } = createMockHandlers()
      const blocks: ContentBlock[] = [
        createImageBlock('image/png', 'img1'),
        createImageBlock('image/jpeg', 'img2'),
      ]

      const result = processBlocks(blocks, handlers)

      expect(result).toEqual(['image-0', 'image-1'])
      expect(calls).toHaveLength(2)
      expect(calls[0].handler).toBe('onImageBlock')
      expect(calls[1].handler).toBe('onImageBlock')
    })
  })

  // ==========================================================================
  // Tests: Tool Block Grouping
  // ==========================================================================

  describe('tool block grouping', () => {
    test('groups single tool block', () => {
      const { handlers, calls } = createMockHandlers()
      const blocks: ContentBlock[] = [createToolBlock('str_replace', 'tool-1')]

      const result = processBlocks(blocks, handlers)

      expect(result).toEqual(['tools-0-1'])
      expect(calls).toHaveLength(1)
      expect(calls[0].handler).toBe('onToolGroup')
      expect((calls[0].args[0] as ToolContentBlock[]).length).toBe(1)
      expect(calls[0].args[1]).toBe(0) // startIndex
      expect(calls[0].args[2]).toBe(1) // nextIndex
    })

    test('groups consecutive tool blocks with correct indices', () => {
      const { handlers, calls } = createMockHandlers()
      const blocks: ContentBlock[] = [
        createToolBlock('str_replace', 'tool-1'),
        createToolBlock('write_file', 'tool-2'),
        createToolBlock('read_files', 'tool-3'),
      ]

      const result = processBlocks(blocks, handlers)

      expect(result).toEqual(['tools-0-3'])
      expect(calls).toHaveLength(1)
      expect(calls[0].handler).toBe('onToolGroup')
      const toolBlocks = calls[0].args[0] as ToolContentBlock[]
      expect(toolBlocks).toHaveLength(3)
      expect(toolBlocks[0].toolCallId).toBe('tool-1')
      expect(toolBlocks[1].toolCallId).toBe('tool-2')
      expect(toolBlocks[2].toolCallId).toBe('tool-3')
      expect(calls[0].args[1]).toBe(0) // startIndex
      expect(calls[0].args[2]).toBe(3) // nextIndex
    })

    test('separates tool groups interrupted by text', () => {
      const { handlers, calls } = createMockHandlers()
      const blocks: ContentBlock[] = [
        createToolBlock('str_replace', 'tool-1'),
        createTextBlock('middle'),
        createToolBlock('write_file', 'tool-2'),
      ]

      const result = processBlocks(blocks, handlers)

      expect(result).toEqual(['tools-0-1', 'single-1', 'tools-2-3'])
      expect(calls).toHaveLength(3)
      expect(calls[0].handler).toBe('onToolGroup')
      expect(calls[0].args[1]).toBe(0)
      expect(calls[0].args[2]).toBe(1)
      expect(calls[1].handler).toBe('onSingleBlock')
      expect(calls[2].handler).toBe('onToolGroup')
      expect(calls[2].args[1]).toBe(2)
      expect(calls[2].args[2]).toBe(3)
    })
  })

  // ==========================================================================
  // Tests: Implementor Agent Grouping
  // ==========================================================================

  describe('implementor agent grouping', () => {
    test('groups single implementor agent', () => {
      const { handlers, calls } = createMockHandlers()
      const blocks: ContentBlock[] = [
        createImplementorAgent('impl-1', 'editor-implementor'),
      ]

      const result = processBlocks(blocks, handlers)

      expect(result).toEqual(['implementors-0-1'])
      expect(calls).toHaveLength(1)
      expect(calls[0].handler).toBe('onImplementorGroup')
    })

    test('groups consecutive implementor agents of different types', () => {
      const { handlers, calls } = createMockHandlers()
      const blocks: ContentBlock[] = [
        createImplementorAgent('impl-1', 'editor-implementor'),
        createImplementorAgent('impl-2', 'editor-implementor-opus'),
        createImplementorAgent('impl-3', 'editor-implementor-gpt-5'),
      ]

      const result = processBlocks(blocks, handlers)

      expect(result).toEqual(['implementors-0-3'])
      expect(calls).toHaveLength(1)
      expect(calls[0].handler).toBe('onImplementorGroup')
      const implBlocks = calls[0].args[0] as AgentContentBlock[]
      expect(implBlocks).toHaveLength(3)
    })

    test('separates implementor groups from non-implementor agents', () => {
      const { handlers, calls } = createMockHandlers()
      const blocks: ContentBlock[] = [
        createImplementorAgent('impl-1'),
        createNonImplementorAgent('fp-1', 'file-picker'),
        createImplementorAgent('impl-2'),
      ]

      const result = processBlocks(blocks, handlers)

      expect(result).toEqual([
        'implementors-0-1',
        'agents-1-2',
        'implementors-2-3',
      ])
      expect(calls).toHaveLength(3)
    })
  })

  // ==========================================================================
  // Tests: Non-Implementor Agent Grouping
  // ==========================================================================

  describe('non-implementor agent grouping', () => {
    test('groups single non-implementor agent', () => {
      const { handlers, calls } = createMockHandlers()
      const blocks: ContentBlock[] = [
        createNonImplementorAgent('fp-1', 'file-picker'),
      ]

      const result = processBlocks(blocks, handlers)

      expect(result).toEqual(['agents-0-1'])
      expect(calls).toHaveLength(1)
      expect(calls[0].handler).toBe('onAgentGroup')
    })

    test('groups consecutive small (collapsed-by-default) agents together', () => {
      const { handlers, calls } = createMockHandlers()
      const blocks: ContentBlock[] = [
        createNonImplementorAgent('fp-1', 'file-picker'),
        createNonImplementorAgent('b-1', 'basher'),
        createNonImplementorAgent('cs-1', 'code-searcher'),
      ]

      const result = processBlocks(blocks, handlers)

      expect(result).toEqual(['agents-0-3'])
      expect(calls).toHaveLength(1)
      expect(calls[0].handler).toBe('onAgentGroup')
      const agentBlocks = calls[0].args[0] as AgentContentBlock[]
      expect(agentBlocks).toHaveLength(3)
      expect(agentBlocks[0].agentType).toBe('file-picker')
      expect(agentBlocks[1].agentType).toBe('basher')
      expect(agentBlocks[2].agentType).toBe('code-searcher')
    })

    test('groups consecutive non-implementor agents including mixed sizes', () => {
      const { handlers, calls } = createMockHandlers()
      const blocks: ContentBlock[] = [
        createNonImplementorAgent('fp-1', 'file-picker'),
        createNonImplementorAgent('cr-1', 'code-reviewer'),
        createNonImplementorAgent('cs-1', 'code-searcher'),
      ]

      const result = processBlocks(blocks, handlers)

      // All consecutive non-implementor agents go into a single onAgentGroup call
      expect(result).toEqual(['agents-0-3'])
      expect(calls).toHaveLength(1)
      expect(calls[0].handler).toBe('onAgentGroup')
      const agentBlocks = calls[0].args[0] as AgentContentBlock[]
      expect(agentBlocks).toHaveLength(3)
      expect(agentBlocks[0].agentType).toBe('file-picker')
      expect(agentBlocks[1].agentType).toBe('code-reviewer')
      expect(agentBlocks[2].agentType).toBe('code-searcher')
    })

    test('separates non-implementor groups from other block types', () => {
      const { handlers, calls } = createMockHandlers()
      const blocks: ContentBlock[] = [
        createNonImplementorAgent('fp-1', 'file-picker'),
        createTextBlock('commentary'),
        createNonImplementorAgent('cmd-1', 'commander'),
      ]

      const result = processBlocks(blocks, handlers)

      expect(result).toEqual(['agents-0-1', 'single-1', 'agents-2-3'])
      expect(calls).toHaveLength(3)
    })
  })

  // ==========================================================================
  // Tests: Single Block Fallback
  // ==========================================================================

  describe('single block fallback', () => {
    test('handles regular text blocks with onSingleBlock', () => {
      const { handlers, calls } = createMockHandlers()
      const blocks: ContentBlock[] = [
        createTextBlock('hello'),
        createTextBlock('world'),
      ]

      const result = processBlocks(blocks, handlers)

      expect(result).toEqual(['single-0', 'single-1'])
      expect(calls).toHaveLength(2)
      expect(calls[0].handler).toBe('onSingleBlock')
      expect(calls[1].handler).toBe('onSingleBlock')
    })

    test('handles html blocks with onSingleBlock', () => {
      const { handlers, calls } = createMockHandlers()
      const htmlBlock: ContentBlock = {
        type: 'html',
        render: () => null,
      } as ContentBlock

      const blocks: ContentBlock[] = [htmlBlock]
      const result = processBlocks(blocks, handlers)

      expect(result).toEqual(['single-0'])
      expect(calls).toHaveLength(1)
      expect(calls[0].handler).toBe('onSingleBlock')
    })
  })

  // ==========================================================================
  // Tests: Null Filtering
  // ==========================================================================

  describe('null filtering', () => {
    test('filters out null returns from handlers', () => {
      const handlers: BlockProcessorHandlers = {
        onReasoningGroup: () => null,
        onImageBlock: () => null,
        onToolGroup: () => null,
        onImplementorGroup: () => null,
        onAgentGroup: () => null,
        onSingleBlock: (block, index) =>
          index % 2 === 0 ? `single-${index}` : null,
      }

      const blocks: ContentBlock[] = [
        createTextBlock('keep'), // index 0, should be kept
        createTextBlock('skip'), // index 1, should be filtered
        createTextBlock('keep'), // index 2, should be kept
        createTextBlock('skip'), // index 3, should be filtered
      ]

      const result = processBlocks(blocks, handlers)

      expect(result).toEqual(['single-0', 'single-2'])
    })

    test('filters null from reasoning groups', () => {
      const handlers: BlockProcessorHandlers = {
        onReasoningGroup: () => null,
        onToolGroup: () => 'tool',
        onImplementorGroup: () => 'impl',
        onAgentGroup: () => 'agent',
        onSingleBlock: () => 'single',
      }

      const blocks: ContentBlock[] = [
        createReasoningBlock('thought'),
        createTextBlock('visible'),
      ]

      const result = processBlocks(blocks, handlers)

      expect(result).toEqual(['single'])
    })

    test('filters null from all handler types', () => {
      const handlers: BlockProcessorHandlers = {
        onReasoningGroup: () => null,
        onImageBlock: () => null,
        onToolGroup: () => null,
        onImplementorGroup: () => null,
        onAgentGroup: () => null,
        onSingleBlock: () => null,
      }

      const blocks: ContentBlock[] = [
        createReasoningBlock('thought'),
        createImageBlock(),
        createToolBlock('str_replace'),
        createImplementorAgent('impl-1'),
        createNonImplementorAgent('fp-1'),
        createTextBlock('text'),
      ]

      const result = processBlocks(blocks, handlers)

      expect(result).toEqual([])
    })
  })

  // ==========================================================================
  // Tests: Mixed Block Combinations
  // ==========================================================================

  describe('mixed block combinations', () => {
    test('processes typical message flow', () => {
      const { handlers, calls } = createMockHandlers()
      const blocks: ContentBlock[] = [
        createReasoningBlock('thinking about the problem'),
        createReasoningBlock('considering options'),
        createTextBlock('I will search for files first'),
        createNonImplementorAgent('fp-1', 'file-picker'),
        createNonImplementorAgent('cs-1', 'code-searcher'),
        createTextBlock('Now I will make changes'),
        createImplementorAgent('impl-1', 'editor-implementor'),
        createImplementorAgent('impl-2', 'editor-implementor-opus'),
        createTextBlock('Changes complete'),
      ]

      const result = processBlocks(blocks, handlers)

      expect(result).toEqual([
        'reasoning-0',
        'single-2',
        'agents-3-5',
        'single-5',
        'implementors-6-8',
        'single-8',
      ])
      expect(calls).toHaveLength(6)
    })

    test('handles interleaved tools and agents', () => {
      const { handlers, calls } = createMockHandlers()
      const blocks: ContentBlock[] = [
        createToolBlock('read_files', 'tool-1'),
        createToolBlock('code_search', 'tool-2'),
        createNonImplementorAgent('fp-1', 'file-picker'),
        createToolBlock('str_replace', 'tool-3'),
        createImplementorAgent('impl-1'),
      ]

      const result = processBlocks(blocks, handlers)

      expect(result).toEqual([
        'tools-0-2',
        'agents-2-3',
        'tools-3-4',
        'implementors-4-5',
      ])
    })

    test('processes complex real-world scenario', () => {
      const { handlers, calls } = createMockHandlers()
      const blocks: ContentBlock[] = [
        // Assistant thinking
        createReasoningBlock('Let me analyze this...'),
        createReasoningBlock('I see the issue'),
        // Assistant response with tool usage
        createTextBlock('I found the issue. Let me fix it.'),
        createToolBlock('str_replace', 'fix-1'),
        createToolBlock('str_replace', 'fix-2'),
        // More thinking
        createReasoningBlock('Checking if more changes needed'),
        // Final response
        createTextBlock('Done! The bug is fixed.'),
        // Image attachment
        createImageBlock('image/png', 'screenshot'),
      ]

      const result = processBlocks(blocks, handlers)

      expect(result).toEqual([
        'reasoning-0',
        'single-2',
        'tools-3-5',
        'reasoning-5',
        'single-6',
        'image-7',
      ])
      expect(calls).toHaveLength(6)
    })
  })

  // ==========================================================================
  // Tests: Index Correctness
  // ==========================================================================

  describe('index correctness', () => {
    test('maintains correct indices after grouping', () => {
      const { handlers, calls } = createMockHandlers()
      const blocks: ContentBlock[] = [
        createTextBlock('text at 0'),
        createToolBlock('tool-1', 't1'), // group starts at 1
        createToolBlock('tool-2', 't2'),
        createToolBlock('tool-3', 't3'), // group ends, nextIndex = 4
        createTextBlock('text at 4'),
        createNonImplementorAgent('a1'), // group starts at 5 (file-picker = small)
        createNonImplementorAgent('a2'), // group ends, nextIndex = 7 (file-picker = small)
        createTextBlock('text at 7'),
      ]

      processBlocks(blocks, handlers)

      // Verify startIndex and nextIndex for each group
      expect(calls[0].args[1]).toBe(0) // single text at 0
      expect(calls[1].args[1]).toBe(1) // tools start at 1
      expect(calls[1].args[2]).toBe(4) // tools next at 4
      expect(calls[2].args[1]).toBe(4) // single text at 4
      expect(calls[3].args[1]).toBe(5) // agents start at 5
      expect(calls[3].args[2]).toBe(7) // agents next at 7
      expect(calls[4].args[1]).toBe(7) // single text at 7
    })

    test('maintains correct indices for mixed-size agent groups', () => {
      const { handlers, calls } = createMockHandlers()
      const blocks: ContentBlock[] = [
        createTextBlock('text at 0'),
        createNonImplementorAgent('fp-1', 'file-picker'),   // index 1
        createNonImplementorAgent('b-1', 'basher'),          // index 2
        createNonImplementorAgent('cr-1', 'code-reviewer'),  // index 3
        createNonImplementorAgent('cs-1', 'code-searcher'),  // index 4
        createTextBlock('text at 5'),
      ]

      processBlocks(blocks, handlers)

      // text at 0
      expect(calls[0].handler).toBe('onSingleBlock')
      expect(calls[0].args[1]).toBe(0)
      // All non-implementor agents grouped together
      expect(calls[1].handler).toBe('onAgentGroup')
      expect(calls[1].args[1]).toBe(1)
      expect(calls[1].args[2]).toBe(5)
      expect((calls[1].args[0] as AgentContentBlock[]).length).toBe(4)
      // text at 5
      expect(calls[2].handler).toBe('onSingleBlock')
      expect(calls[2].args[1]).toBe(5)
    })
  })
})

// ============================================================================
// Tests: splitAgentsBySize
// ============================================================================

describe('splitAgentsBySize', () => {
  test('returns single group for empty array', () => {
    const result = splitAgentsBySize([])
    expect(result).toEqual([[]])
  })

  test('returns single group for one agent', () => {
    const agent = createNonImplementorAgent('cr-1', 'code-reviewer')
    const result = splitAgentsBySize([agent])
    expect(result).toEqual([[agent]])
  })

  test('groups all small agents together', () => {
    const agents = [
      createNonImplementorAgent('fp-1', 'file-picker'),
      createNonImplementorAgent('b-1', 'basher'),
      createNonImplementorAgent('cs-1', 'code-searcher'),
    ]
    const result = splitAgentsBySize(agents)
    expect(result).toEqual([agents])
  })

  test('gives each large agent its own group', () => {
    const agents = [
      createNonImplementorAgent('cr-1', 'code-reviewer'),
      createNonImplementorAgent('ed-1', 'editor'),
    ]
    const result = splitAgentsBySize(agents)
    expect(result).toEqual([[agents[0]], [agents[1]]])
  })

  test('splits small and large agents correctly', () => {
    const agents = [
      createNonImplementorAgent('fp-1', 'file-picker'),
      createNonImplementorAgent('cr-1', 'code-reviewer'),
      createNonImplementorAgent('b-1', 'basher'),
      createNonImplementorAgent('b-2', 'basher'),
      createNonImplementorAgent('ed-1', 'editor'),
      createNonImplementorAgent('rw-1', 'researcher-web'),
    ]
    const result = splitAgentsBySize(agents)
    expect(result).toEqual([
      [agents[0]],          // file-picker (small)
      [agents[1]],          // code-reviewer (large)
      [agents[2], agents[3]], // basher + basher (small)
      [agents[4]],          // editor (large)
      [agents[5]],          // researcher-web (small)
    ])
  })
})
