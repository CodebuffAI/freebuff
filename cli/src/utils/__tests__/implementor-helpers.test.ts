import { describe, expect, test } from 'bun:test'

import {
  extractValueForKey,
  extractFilePath,
  extractDiff,
  parseDiffStats,
  getFileChangeType,
  getFileStatsFromBlocks,
  buildActivityTimeline,
  isImplementorAgent,
  getImplementorDisplayName,
  getImplementorIndex,
  groupConsecutiveBlocks,
  groupConsecutiveImplementors,
  groupConsecutiveNonImplementorAgents,
  groupConsecutiveToolBlocks,
  getMultiPromptProgress,
  getMultiPromptPreview,
  shouldShowEditDiff,
} from '../implementor-helpers'

import type {
  ToolContentBlock,
  ContentBlock,
  AgentContentBlock,
  TextContentBlock,
} from '../../types/chat'

describe('extractValueForKey', () => {
  test('extracts simple key-value pairs', () => {
    const output = 'file: src/utils/helper.ts\nmessage: Updated file'
    expect(extractValueForKey(output, 'file')).toBe('src/utils/helper.ts')
    expect(extractValueForKey(output, 'message')).toBe('Updated file')
  })

  test('handles quoted values', () => {
    const output = 'message: "Created new file"'
    expect(extractValueForKey(output, 'message')).toBe('Created new file')
  })

  test('returns null for missing keys', () => {
    const output = 'file: test.ts'
    expect(extractValueForKey(output, 'nonexistent')).toBeNull()
  })

  test('returns null when key name appears without colon', () => {
    const output = 'This mentions file but has no colon'
    expect(extractValueForKey(output, 'file')).toBeNull()
  })

  test('extracts value from last line without trailing newline', () => {
    const output = 'first: line\nlast: value'
    expect(extractValueForKey(output, 'last')).toBe('value')
  })

  test('handles large outputs efficiently without error', () => {
    const large =
      Array.from({ length: 5000 }, (_, i) => `log_${i}: data`).join('\n') +
      '\nfile: src/target.ts'
    expect(extractValueForKey(large, 'file')).toBe('src/target.ts')
    expect(extractValueForKey(large, 'missing')).toBeNull()
  })

  test('handles empty output', () => {
    expect(extractValueForKey('', 'file')).toBeNull()
  })

  test('handles multi-line values with pipe', () => {
    const output = `unifiedDiff: |
  - old line
  + new line`
    const result = extractValueForKey(output, 'unifiedDiff')
    expect(result).toBe('- old line\n+ new line')
  })
})

describe('extractFilePath', () => {
  test('extracts from output string', () => {
    const block: ToolContentBlock = {
      type: 'tool',
      toolCallId: 'test-1',
      toolName: 'str_replace',
      input: {},
      output: 'file: src/utils/test.ts\nmessage: Updated',
    }
    expect(extractFilePath(block)).toBe('src/utils/test.ts')
  })

  test('extracts from input.path', () => {
    const block: ToolContentBlock = {
      type: 'tool',
      toolCallId: 'test-1',
      toolName: 'str_replace',
      input: { path: 'src/components/Button.tsx' },
      output: '',
    }
    expect(extractFilePath(block)).toBe('src/components/Button.tsx')
  })

  test('prefers output over input', () => {
    const block: ToolContentBlock = {
      type: 'tool',
      toolCallId: 'test-1',
      toolName: 'str_replace',
      input: { path: 'input-path.ts' },
      output: 'file: output-path.ts',
    }
    expect(extractFilePath(block)).toBe('output-path.ts')
  })
})

describe('extractDiff', () => {
  test('extracts from outputRaw array format', () => {
    const block: ToolContentBlock = {
      type: 'tool',
      toolCallId: 'test-1',
      toolName: 'str_replace',
      input: {},
      outputRaw: [{ type: 'json', value: { unifiedDiff: '- old\n+ new' } }],
    }
    expect(extractDiff(block)).toBe('- old\n+ new')
  })

  test('constructs diff from str_replace input', () => {
    const block: ToolContentBlock = {
      type: 'tool',
      toolCallId: 'test-1',
      toolName: 'str_replace',
      input: {
        replacements: [{ oldString: 'const x = 1', newString: 'const x = 2' }],
      },
    }
    const diff = extractDiff(block)
    expect(diff).toContain('- const x = 1')
    expect(diff).toContain('+ const x = 2')
  })

  test('constructs diff from successful str_replace input when output omits diff', () => {
    const block: ToolContentBlock = {
      type: 'tool',
      toolCallId: 'test-1',
      toolName: 'str_replace',
      input: {
        replacements: [{ oldString: 'const x = 1', newString: 'const x = 2' }],
      },
      output: 'message: String replace applied successfully.',
    }
    const diff = extractDiff(block)
    expect(diff).toContain('- const x = 1')
    expect(diff).toContain('+ const x = 2')
  })

  test('constructs diff from successful str_replace input with warning output', () => {
    const block: ToolContentBlock = {
      type: 'tool',
      toolCallId: 'test-1',
      toolName: 'str_replace',
      input: {
        replacements: [{ oldString: 'const x = 1', newString: 'const x = 2' }],
      },
      output: `message: |
  Matched with indentation modification

  String replace applied successfully.`,
    }
    const diff = extractDiff(block)
    expect(diff).toContain('- const x = 1')
    expect(diff).toContain('+ const x = 2')
  })

  test('uses patch content from successful str_replace input when output omits diff', () => {
    const block: ToolContentBlock = {
      type: 'tool',
      toolCallId: 'test-1',
      toolName: 'str_replace',
      input: { type: 'patch', content: '- const x = 1\n+ const x = 2' },
      output: 'message: String replace applied successfully.',
    }
    expect(extractDiff(block)).toBe('- const x = 1\n+ const x = 2')
  })

  test('returns null for failed str_replace output without a diff', () => {
    const block: ToolContentBlock = {
      type: 'tool',
      toolCallId: 'test-1',
      toolName: 'str_replace',
      input: {
        replacements: [{ oldString: 'const x = 1', newString: 'const x = 2' }],
      },
      output: 'No change to the file',
    }
    expect(extractDiff(block)).toBeNull()
  })

  test('returns null for failed str_replace output even when it includes patch input', () => {
    const block: ToolContentBlock = {
      type: 'tool',
      toolCallId: 'test-1',
      toolName: 'str_replace',
      input: { type: 'patch', content: '- const x = 1\n+ const x = 2' },
      outputRaw: [
        {
          type: 'json',
          value: {
            errorMessage: 'Failed to apply patch.',
            patch: '- const x = 1\n+ const x = 2',
          },
        },
      ],
    }
    expect(extractDiff(block)).toBeNull()
  })

  test('constructs diff from write_file input', () => {
    const block: ToolContentBlock = {
      type: 'tool',
      toolCallId: 'test-1',
      toolName: 'write_file',
      input: { content: 'line1\nline2' },
    }
    const diff = extractDiff(block)
    expect(diff).toBe('+ line1\n+ line2')
  })

  test('constructs diff from successful write_file input when output omits diff', () => {
    const block: ToolContentBlock = {
      type: 'tool',
      toolCallId: 'test-1',
      toolName: 'write_file',
      input: { content: 'line1\nline2' },
      output: 'message: Overwrote file successfully.',
    }
    const diff = extractDiff(block)
    expect(diff).toBe('+ line1\n+ line2')
  })

  test('returns null for failed write_file output without a diff', () => {
    const block: ToolContentBlock = {
      type: 'tool',
      toolCallId: 'test-1',
      toolName: 'write_file',
      input: { content: 'line1\nline2' },
      output: 'Failed to write to file',
    }
    expect(extractDiff(block)).toBeNull()
  })

  test('constructs diff from propose_str_replace input', () => {
    const block: ToolContentBlock = {
      type: 'tool',
      toolCallId: 'test-1',
      toolName: 'propose_str_replace',
      input: {
        replacements: [{ oldString: 'const x = 1', newString: 'const x = 2' }],
      },
    }
    const diff = extractDiff(block)
    expect(diff).toContain('- const x = 1')
    expect(diff).toContain('+ const x = 2')
  })

  test('constructs diff from propose_write_file input', () => {
    const block: ToolContentBlock = {
      type: 'tool',
      toolCallId: 'test-1',
      toolName: 'propose_write_file',
      input: { content: 'line1\nline2' },
    }
    const diff = extractDiff(block)
    expect(diff).toBe('+ line1\n+ line2')
  })
})

describe('parseDiffStats', () => {
  test('counts additions and deletions', () => {
    const diff = `@@ -1,3 +1,4 @@
 unchanged
-removed line
+added line 1
+added line 2`
    const stats = parseDiffStats(diff)
    expect(stats.linesAdded).toBe(2)
    expect(stats.linesRemoved).toBe(1)
    expect(stats.hunks).toBe(1)
  })

  test('counts multiple hunks', () => {
    const diff = `@@ -1,3 +1,3 @@
-old1
+new1
@@ -10,3 +10,3 @@
-old2
+new2`
    const stats = parseDiffStats(diff)
    expect(stats.hunks).toBe(2)
  })

  test('handles empty diff', () => {
    expect(parseDiffStats(undefined)).toEqual({
      linesAdded: 0,
      linesRemoved: 0,
      hunks: 0,
    })
    expect(parseDiffStats('')).toEqual({
      linesAdded: 0,
      linesRemoved: 0,
      hunks: 0,
    })
  })

  test('ignores +++ and --- headers', () => {
    const diff = `--- a/file.ts
+++ b/file.ts
@@ -1 +1 @@
-old
+new`
    const stats = parseDiffStats(diff)
    expect(stats.linesAdded).toBe(1)
    expect(stats.linesRemoved).toBe(1)
  })
})

describe('getFileChangeType', () => {
  test('returns A for new file creation', () => {
    const block: ToolContentBlock = {
      type: 'tool',
      toolCallId: 'test-1',
      toolName: 'write_file',
      input: {},
      output: 'message: Created new file',
    }
    expect(getFileChangeType(block)).toBe('A')
  })

  test('returns A for successful file creation', () => {
    const block: ToolContentBlock = {
      type: 'tool',
      toolCallId: 'test-1',
      toolName: 'write_file',
      input: {},
      output: 'message: Created file successfully.',
    }
    expect(getFileChangeType(block)).toBe('A')
  })

  test('returns M for write_file modification', () => {
    const block: ToolContentBlock = {
      type: 'tool',
      toolCallId: 'test-1',
      toolName: 'write_file',
      input: {},
      output: 'message: Updated file',
    }
    expect(getFileChangeType(block)).toBe('M')
  })

  test('returns M for str_replace', () => {
    const block: ToolContentBlock = {
      type: 'tool',
      toolCallId: 'test-1',
      toolName: 'str_replace',
      input: {},
    }
    expect(getFileChangeType(block)).toBe('M')
  })

  test('returns A for propose_write_file new file', () => {
    const block: ToolContentBlock = {
      type: 'tool',
      toolCallId: 'test-1',
      toolName: 'propose_write_file',
      input: {},
      output: 'message: Proposed new file src/new.ts',
    }
    expect(getFileChangeType(block)).toBe('A')
  })

  test('returns M for propose_str_replace', () => {
    const block: ToolContentBlock = {
      type: 'tool',
      toolCallId: 'test-1',
      toolName: 'propose_str_replace',
      input: {},
    }
    expect(getFileChangeType(block)).toBe('M')
  })
})

describe('shouldShowEditDiff', () => {
  test('does not show pending str_replace diffs before the result arrives', () => {
    const block: ToolContentBlock = {
      type: 'tool',
      toolCallId: 'test-1',
      toolName: 'str_replace',
      input: {
        replacements: [{ oldString: 'const x = 1', newString: 'const x = 2' }],
      },
    }

    expect(shouldShowEditDiff(block)).toBe(false)
  })

  test('shows str_replace diffs after a successful result', () => {
    const block: ToolContentBlock = {
      type: 'tool',
      toolCallId: 'test-1',
      toolName: 'str_replace',
      input: {
        replacements: [{ oldString: 'const x = 1', newString: 'const x = 2' }],
      },
      output: 'file: src/existing.ts\nmessage: String replace applied successfully.',
    }

    expect(shouldShowEditDiff(block)).toBe(true)
  })

  test('does not show pending write_file diffs before the result arrives', () => {
    const block: ToolContentBlock = {
      type: 'tool',
      toolCallId: 'test-1',
      toolName: 'write_file',
      input: { path: 'src/new.ts', content: 'const x = 1\n' },
    }

    expect(extractDiff(block)).toBe('+ const x = 1\n+ ')
    expect(shouldShowEditDiff(block)).toBe(false)
  })

  test('shows write_file diffs after an overwrite result', () => {
    const block: ToolContentBlock = {
      type: 'tool',
      toolCallId: 'test-1',
      toolName: 'write_file',
      input: { path: 'src/existing.ts', content: 'const x = 2\n' },
      output: 'file: src/existing.ts\nmessage: Overwrote file successfully.',
    }

    expect(shouldShowEditDiff(block)).toBe(true)
  })

  test('does not show write_file diffs after a create result', () => {
    const block: ToolContentBlock = {
      type: 'tool',
      toolCallId: 'test-1',
      toolName: 'write_file',
      input: { path: 'src/new.ts', content: 'const x = 1\n' },
      output: 'file: src/new.ts\nmessage: Created file successfully.',
    }

    expect(shouldShowEditDiff(block)).toBe(false)
  })

  test('continues to show pending proposed write_file diffs', () => {
    const block: ToolContentBlock = {
      type: 'tool',
      toolCallId: 'test-1',
      toolName: 'propose_write_file',
      input: { path: 'src/new.ts', content: 'const x = 1\n' },
    }

    expect(shouldShowEditDiff(block)).toBe(true)
  })
})

describe('getFileStatsFromBlocks', () => {
  test('aggregates stats for same file', () => {
    const blocks: ContentBlock[] = [
      {
        type: 'tool',
        toolCallId: 'test-1',
        toolName: 'str_replace',
        input: { path: 'file.ts' },
        outputRaw: [{ type: 'json', value: { unifiedDiff: '+line1\n+line2' } }],
      },
      {
        type: 'tool',
        toolCallId: 'test-2',
        toolName: 'str_replace',
        input: { path: 'file.ts' },
        outputRaw: [
          { type: 'json', value: { unifiedDiff: '+line3\n-removed' } },
        ],
      },
    ]
    const stats = getFileStatsFromBlocks(blocks)
    expect(stats).toHaveLength(1)
    expect(stats[0].path).toBe('file.ts')
    expect(stats[0].stats.linesAdded).toBe(3)
    expect(stats[0].stats.linesRemoved).toBe(1)
  })

  test('separates different files', () => {
    const blocks: ContentBlock[] = [
      {
        type: 'tool',
        toolCallId: 'test-1',
        toolName: 'str_replace',
        input: { path: 'file1.ts' },
        outputRaw: [{ type: 'json', value: { unifiedDiff: '+added' } }],
      },
      {
        type: 'tool',
        toolCallId: 'test-2',
        toolName: 'str_replace',
        input: { path: 'file2.ts' },
        outputRaw: [{ type: 'json', value: { unifiedDiff: '-removed' } }],
      },
    ]
    const stats = getFileStatsFromBlocks(blocks)
    expect(stats).toHaveLength(2)
  })

  test('ignores non-edit tools', () => {
    const blocks: ContentBlock[] = [
      {
        type: 'tool',
        toolCallId: 'test-1',
        toolName: 'read_files',
        input: { paths: ['file.ts'] },
      },
    ]
    const stats = getFileStatsFromBlocks(blocks)
    expect(stats).toHaveLength(0)
  })

  test('ignores non-tool blocks', () => {
    const blocks: ContentBlock[] = [
      {
        type: 'text',
        content: 'some commentary',
      } as TextContentBlock,
    ]
    const stats = getFileStatsFromBlocks(blocks)
    expect(stats).toHaveLength(0)
  })

  test('ignores failed edit tools', () => {
    const blocks: ContentBlock[] = [
      {
        type: 'tool',
        toolCallId: 'test-1',
        toolName: 'str_replace',
        input: {
          path: 'file.ts',
          replacements: [
            { oldString: 'const x = 1', newString: 'const x = 2' },
          ],
        },
        output: 'No change to the file',
      },
    ]
    const stats = getFileStatsFromBlocks(blocks)
    expect(stats).toHaveLength(0)
  })
})

describe('buildActivityTimeline', () => {
  test('builds timeline from mixed blocks', () => {
    const blocks: ContentBlock[] = [
      {
        type: 'text',
        content: 'Making changes to the file',
      } as TextContentBlock,
      {
        type: 'tool',
        toolCallId: 'test-1',
        toolName: 'str_replace',
        input: { path: 'file.ts' },
        outputRaw: [{ type: 'json', value: { unifiedDiff: '+new line' } }],
      },
      {
        type: 'text',
        content: 'Done with changes',
      } as TextContentBlock,
    ]
    const timeline = buildActivityTimeline(blocks)
    expect(timeline).toHaveLength(3)
    expect(timeline[0].type).toBe('commentary')
    expect(timeline[0].content).toBe('Making changes to the file')
    expect(timeline[1].type).toBe('edit')
    expect(timeline[1].content).toBe('file.ts')
    expect(timeline[1].diff).toBe('+new line')
    expect(timeline[2].type).toBe('commentary')
  })

  test('skips reasoning blocks', () => {
    const blocks: ContentBlock[] = [
      {
        type: 'text',
        content: 'Some reasoning',
        textType: 'reasoning',
      } as TextContentBlock,
      {
        type: 'text',
        content: 'Normal text',
      } as TextContentBlock,
    ]
    const timeline = buildActivityTimeline(blocks)
    expect(timeline).toHaveLength(1)
    expect(timeline[0].content).toBe('Normal text')
  })

  test('skips failed edit tools', () => {
    const blocks: ContentBlock[] = [
      {
        type: 'text',
        content: 'Trying an edit',
      } as TextContentBlock,
      {
        type: 'tool',
        toolCallId: 'test-1',
        toolName: 'write_file',
        input: { path: 'file.ts', content: 'new content' },
        output: 'Failed to write to file',
      },
    ]
    const timeline = buildActivityTimeline(blocks)
    expect(timeline).toHaveLength(1)
    expect(timeline[0].type).toBe('commentary')
  })
})

describe('isImplementorAgent', () => {
  test('identifies implementor agents', () => {
    expect(
      isImplementorAgent({ agentType: 'editor-implementor', blocks: [] }),
    ).toBe(true)
    expect(
      isImplementorAgent({ agentType: 'editor-implementor-opus', blocks: [] }),
    ).toBe(true)
    expect(
      isImplementorAgent({ agentType: 'editor-implementor-gpt-5', blocks: [] }),
    ).toBe(true)
    expect(
      isImplementorAgent({ agentType: 'editor-implementor2', blocks: [] }),
    ).toBe(true)
  })

  test('rejects non-implementor agents', () => {
    expect(isImplementorAgent({ agentType: 'file-picker', blocks: [] })).toBe(
      false,
    )
    expect(isImplementorAgent({ agentType: 'commander', blocks: [] })).toBe(
      false,
    )
    expect(
      isImplementorAgent({ agentType: 'best-of-n-selector', blocks: [] }),
    ).toBe(false)
  })
})

describe('getImplementorDisplayName', () => {
  test('returns model names', () => {
    expect(getImplementorDisplayName('editor-implementor')).toBe('Sonnet')
    expect(getImplementorDisplayName('editor-implementor-opus')).toBe('Opus')
    expect(getImplementorDisplayName('editor-implementor-gpt-5')).toBe('GPT-5')
    expect(getImplementorDisplayName('editor-implementor-gemini')).toBe(
      'Gemini',
    )
  })

  test('adds index when provided', () => {
    expect(getImplementorDisplayName('editor-implementor', 0)).toBe('Sonnet #1')
    expect(getImplementorDisplayName('editor-implementor-opus', 2)).toBe(
      'Opus #3',
    )
  })
})

describe('getImplementorIndex', () => {
  test('returns index among same-type siblings', () => {
    const agent1 = {
      type: 'agent',
      agentId: 'a1',
      agentName: 'Impl 1',
      agentType: 'editor-implementor',
      content: '',
      status: 'complete',
      blocks: [],
    } as AgentContentBlock
    const agent2 = {
      type: 'agent',
      agentId: 'a2',
      agentName: 'Impl 2',
      agentType: 'editor-implementor',
      content: '',
      status: 'complete',
      blocks: [],
    } as AgentContentBlock
    const agent3 = {
      type: 'agent',
      agentId: 'a3',
      agentName: 'Impl 3',
      agentType: 'editor-implementor-opus',
      content: '',
      status: 'complete',
      blocks: [],
    } as AgentContentBlock
    const siblings: ContentBlock[] = [agent1, agent2, agent3]

    expect(getImplementorIndex(agent1, siblings)).toBe(0)
    expect(getImplementorIndex(agent2, siblings)).toBe(1)
    expect(getImplementorIndex(agent3, siblings)).toBeUndefined()
  })

  test('returns undefined for non-implementor', () => {
    const filePicker = {
      type: 'agent',
      agentId: 'fp1',
      agentName: 'File Picker',
      agentType: 'file-picker',
      content: '',
      status: 'complete',
      blocks: [],
    } as AgentContentBlock
    const siblings: ContentBlock[] = [filePicker]

    expect(getImplementorIndex(filePicker, siblings)).toBeUndefined()
  })
})

describe('groupConsecutiveBlocks', () => {
  const createTextBlock = (content: string): TextContentBlock =>
    ({
      type: 'text',
      content,
    }) as TextContentBlock

  const createToolBlock = (toolName: string): ToolContentBlock => ({
    type: 'tool',
    toolCallId: `tool-${toolName}`,
    toolName: toolName as ToolContentBlock['toolName'],
    input: {},
  })

  const createAgentBlock = (
    agentType: string,
    agentId: string,
  ): AgentContentBlock =>
    ({
      type: 'agent',
      agentId,
      agentName: agentType,
      agentType,
      content: '',
      status: 'complete',
      blocks: [],
    }) as AgentContentBlock

  test('groups consecutive matching blocks from start', () => {
    const blocks: ContentBlock[] = [
      createTextBlock('text1'),
      createTextBlock('text2'),
      createToolBlock('str_replace'),
    ]
    const isText = (b: ContentBlock): b is TextContentBlock => b.type === 'text'
    const result = groupConsecutiveBlocks(blocks, 0, isText)

    expect(result.group).toHaveLength(2)
    expect(result.group[0].content).toBe('text1')
    expect(result.group[1].content).toBe('text2')
    expect(result.nextIndex).toBe(2)
  })

  test('groups from middle of array', () => {
    const blocks: ContentBlock[] = [
      createToolBlock('read_files'),
      createTextBlock('text1'),
      createTextBlock('text2'),
      createTextBlock('text3'),
      createToolBlock('write_file'),
    ]
    const isText = (b: ContentBlock): b is TextContentBlock => b.type === 'text'
    const result = groupConsecutiveBlocks(blocks, 1, isText)

    expect(result.group).toHaveLength(3)
    expect(result.nextIndex).toBe(4)
  })

  test('returns empty group when first block does not match', () => {
    const blocks: ContentBlock[] = [
      createToolBlock('str_replace'),
      createTextBlock('text1'),
    ]
    const isText = (b: ContentBlock): b is TextContentBlock => b.type === 'text'
    const result = groupConsecutiveBlocks(blocks, 0, isText)

    expect(result.group).toHaveLength(0)
    expect(result.nextIndex).toBe(0)
  })

  test('handles empty blocks array', () => {
    const blocks: ContentBlock[] = []
    const isText = (b: ContentBlock): b is TextContentBlock => b.type === 'text'
    const result = groupConsecutiveBlocks(blocks, 0, isText)

    expect(result.group).toHaveLength(0)
    expect(result.nextIndex).toBe(0)
  })

  test('handles startIndex at end of array', () => {
    const blocks: ContentBlock[] = [createTextBlock('text1')]
    const isText = (b: ContentBlock): b is TextContentBlock => b.type === 'text'
    const result = groupConsecutiveBlocks(blocks, 1, isText)

    expect(result.group).toHaveLength(0)
    expect(result.nextIndex).toBe(1)
  })

  test('handles startIndex beyond array length', () => {
    const blocks: ContentBlock[] = [createTextBlock('text1')]
    const isText = (b: ContentBlock): b is TextContentBlock => b.type === 'text'
    const result = groupConsecutiveBlocks(blocks, 10, isText)

    expect(result.group).toHaveLength(0)
    expect(result.nextIndex).toBe(10)
  })

  test('groups all blocks when all match', () => {
    const blocks: ContentBlock[] = [
      createTextBlock('text1'),
      createTextBlock('text2'),
      createTextBlock('text3'),
    ]
    const isText = (b: ContentBlock): b is TextContentBlock => b.type === 'text'
    const result = groupConsecutiveBlocks(blocks, 0, isText)

    expect(result.group).toHaveLength(3)
    expect(result.nextIndex).toBe(3)
  })

  test('groups single matching block', () => {
    const blocks: ContentBlock[] = [
      createTextBlock('text1'),
      createToolBlock('str_replace'),
    ]
    const isText = (b: ContentBlock): b is TextContentBlock => b.type === 'text'
    const result = groupConsecutiveBlocks(blocks, 0, isText)

    expect(result.group).toHaveLength(1)
    expect(result.nextIndex).toBe(1)
  })

  test('works with complex predicates', () => {
    const blocks: ContentBlock[] = [
      createToolBlock('str_replace'),
      createToolBlock('write_file'),
      createToolBlock('read_files'),
      createTextBlock('done'),
    ]
    const isEditTool = (b: ContentBlock): b is ToolContentBlock =>
      b.type === 'tool' &&
      ['str_replace', 'write_file'].includes(b.toolName as string)
    const result = groupConsecutiveBlocks(blocks, 0, isEditTool)

    expect(result.group).toHaveLength(2)
    expect(result.group[0].toolName).toBe('str_replace')
    expect(result.group[1].toolName).toBe('write_file')
    expect(result.nextIndex).toBe(2)
  })
})

describe('groupConsecutiveImplementors', () => {
  const createImplementorAgent = (
    id: string,
    agentType = 'editor-implementor',
  ): AgentContentBlock =>
    ({
      type: 'agent',
      agentId: id,
      agentName: 'Implementor',
      agentType,
      content: '',
      status: 'complete',
      blocks: [],
    }) as AgentContentBlock

  const createNonImplementorAgent = (
    id: string,
    agentType: string,
  ): AgentContentBlock =>
    ({
      type: 'agent',
      agentId: id,
      agentName: agentType,
      agentType,
      content: '',
      status: 'complete',
      blocks: [],
    }) as AgentContentBlock

  const createTextBlock = (content: string): TextContentBlock =>
    ({
      type: 'text',
      content,
    }) as TextContentBlock

  test('groups consecutive implementor agents', () => {
    const blocks: ContentBlock[] = [
      createImplementorAgent('impl-1'),
      createImplementorAgent('impl-2', 'editor-implementor-opus'),
      createImplementorAgent('impl-3', 'editor-implementor-gpt-5'),
      createNonImplementorAgent('fp-1', 'file-picker'),
    ]
    const result = groupConsecutiveImplementors(blocks, 0)

    expect(result.group).toHaveLength(3)
    expect(result.group[0].agentId).toBe('impl-1')
    expect(result.group[1].agentId).toBe('impl-2')
    expect(result.group[2].agentId).toBe('impl-3')
    expect(result.nextIndex).toBe(3)
  })

  test('stops at non-implementor agent', () => {
    const blocks: ContentBlock[] = [
      createImplementorAgent('impl-1'),
      createNonImplementorAgent('cmd-1', 'commander'),
      createImplementorAgent('impl-2'),
    ]
    const result = groupConsecutiveImplementors(blocks, 0)

    expect(result.group).toHaveLength(1)
    expect(result.nextIndex).toBe(1)
  })

  test('stops at non-agent block', () => {
    const blocks: ContentBlock[] = [
      createImplementorAgent('impl-1'),
      createTextBlock('some text'),
      createImplementorAgent('impl-2'),
    ]
    const result = groupConsecutiveImplementors(blocks, 0)

    expect(result.group).toHaveLength(1)
    expect(result.nextIndex).toBe(1)
  })

  test('returns empty group when starting at non-implementor', () => {
    const blocks: ContentBlock[] = [
      createNonImplementorAgent('fp-1', 'file-picker'),
      createImplementorAgent('impl-1'),
    ]
    const result = groupConsecutiveImplementors(blocks, 0)

    expect(result.group).toHaveLength(0)
    expect(result.nextIndex).toBe(0)
  })

  test('handles agents with proposed tools as implementors', () => {
    const agentWithProposedTools: AgentContentBlock = {
      type: 'agent',
      agentId: 'custom-1',
      agentName: 'Custom Agent',
      agentType: 'custom-agent',
      content: '',
      status: 'complete',
      blocks: [
        {
          type: 'tool',
          toolCallId: 'tool-1',
          toolName: 'propose_str_replace',
          input: {},
        },
      ],
    } as AgentContentBlock

    const blocks: ContentBlock[] = [
      agentWithProposedTools,
      createImplementorAgent('impl-1'),
    ]
    const result = groupConsecutiveImplementors(blocks, 0)

    expect(result.group).toHaveLength(2)
    expect(result.group[0].agentId).toBe('custom-1')
    expect(result.group[1].agentId).toBe('impl-1')
  })

  test('handles empty blocks array', () => {
    const result = groupConsecutiveImplementors([], 0)
    expect(result.group).toHaveLength(0)
    expect(result.nextIndex).toBe(0)
  })
})

describe('groupConsecutiveNonImplementorAgents', () => {
  const createImplementorAgent = (id: string): AgentContentBlock =>
    ({
      type: 'agent',
      agentId: id,
      agentName: 'Implementor',
      agentType: 'editor-implementor',
      content: '',
      status: 'complete',
      blocks: [],
    }) as AgentContentBlock

  const createNonImplementorAgent = (
    id: string,
    agentType: string,
  ): AgentContentBlock =>
    ({
      type: 'agent',
      agentId: id,
      agentName: agentType,
      agentType,
      content: '',
      status: 'complete',
      blocks: [],
    }) as AgentContentBlock

  const createTextBlock = (content: string): TextContentBlock =>
    ({
      type: 'text',
      content,
    }) as TextContentBlock

  test('groups consecutive non-implementor agents', () => {
    const blocks: ContentBlock[] = [
      createNonImplementorAgent('fp-1', 'file-picker'),
      createNonImplementorAgent('cmd-1', 'commander'),
      createNonImplementorAgent('cs-1', 'code-searcher'),
      createImplementorAgent('impl-1'),
    ]
    const result = groupConsecutiveNonImplementorAgents(blocks, 0)

    expect(result.group).toHaveLength(3)
    expect(result.group[0].agentType).toBe('file-picker')
    expect(result.group[1].agentType).toBe('commander')
    expect(result.group[2].agentType).toBe('code-searcher')
    expect(result.nextIndex).toBe(3)
  })

  test('stops at implementor agent', () => {
    const blocks: ContentBlock[] = [
      createNonImplementorAgent('fp-1', 'file-picker'),
      createImplementorAgent('impl-1'),
      createNonImplementorAgent('cmd-1', 'commander'),
    ]
    const result = groupConsecutiveNonImplementorAgents(blocks, 0)

    expect(result.group).toHaveLength(1)
    expect(result.nextIndex).toBe(1)
  })

  test('stops at non-agent block', () => {
    const blocks: ContentBlock[] = [
      createNonImplementorAgent('fp-1', 'file-picker'),
      createTextBlock('some text'),
      createNonImplementorAgent('cmd-1', 'commander'),
    ]
    const result = groupConsecutiveNonImplementorAgents(blocks, 0)

    expect(result.group).toHaveLength(1)
    expect(result.nextIndex).toBe(1)
  })

  test('returns empty group when starting at implementor', () => {
    const blocks: ContentBlock[] = [
      createImplementorAgent('impl-1'),
      createNonImplementorAgent('fp-1', 'file-picker'),
    ]
    const result = groupConsecutiveNonImplementorAgents(blocks, 0)

    expect(result.group).toHaveLength(0)
    expect(result.nextIndex).toBe(0)
  })

  test('returns empty group when starting at text block', () => {
    const blocks: ContentBlock[] = [
      createTextBlock('some text'),
      createNonImplementorAgent('fp-1', 'file-picker'),
    ]
    const result = groupConsecutiveNonImplementorAgents(blocks, 0)

    expect(result.group).toHaveLength(0)
    expect(result.nextIndex).toBe(0)
  })

  test('groups from middle of array', () => {
    const blocks: ContentBlock[] = [
      createImplementorAgent('impl-1'),
      createNonImplementorAgent('fp-1', 'file-picker'),
      createNonImplementorAgent('cmd-1', 'commander'),
      createTextBlock('done'),
    ]
    const result = groupConsecutiveNonImplementorAgents(blocks, 1)

    expect(result.group).toHaveLength(2)
    expect(result.group[0].agentType).toBe('file-picker')
    expect(result.group[1].agentType).toBe('commander')
    expect(result.nextIndex).toBe(3)
  })

  test('handles mixed agent types', () => {
    const blocks: ContentBlock[] = [
      createNonImplementorAgent('fp-1', 'file-picker'),
      createNonImplementorAgent('think-1', 'thinker'),
      createNonImplementorAgent('rev-1', 'reviewer'),
    ]
    const result = groupConsecutiveNonImplementorAgents(blocks, 0)

    expect(result.group).toHaveLength(3)
    expect(result.nextIndex).toBe(3)
  })

  test('handles empty blocks array', () => {
    const result = groupConsecutiveNonImplementorAgents([], 0)
    expect(result.group).toHaveLength(0)
    expect(result.nextIndex).toBe(0)
  })
})

describe('getMultiPromptProgress', () => {
  const createImplementorAgent = (
    id: string,
    status: 'running' | 'complete' | 'failed' | 'cancelled' = 'complete',
  ): AgentContentBlock =>
    ({
      type: 'agent',
      agentId: id,
      agentName: 'Implementor',
      agentType: 'editor-implementor-opus',
      content: '',
      status,
      blocks: [],
    }) as AgentContentBlock

  const createSelectorAgent = (
    status: 'running' | 'complete' = 'running',
  ): AgentContentBlock =>
    ({
      type: 'agent',
      agentId: 'selector-1',
      agentName: 'Selector',
      agentType: 'best-of-n-selector2',
      content: '',
      status,
      blocks: [],
    }) as AgentContentBlock

  test('returns null for empty blocks', () => {
    expect(getMultiPromptProgress([])).toBeNull()
    expect(getMultiPromptProgress(undefined)).toBeNull()
  })

  test('returns null when no implementors present', () => {
    const blocks: ContentBlock[] = [
      { type: 'text', content: 'some text' } as TextContentBlock,
    ]
    expect(getMultiPromptProgress(blocks)).toBeNull()
  })

  test('counts total and completed implementors', () => {
    const blocks: ContentBlock[] = [
      createImplementorAgent('impl-1', 'complete'),
      createImplementorAgent('impl-2', 'running'),
      createImplementorAgent('impl-3', 'complete'),
    ]
    const progress = getMultiPromptProgress(blocks)
    expect(progress).toEqual({
      total: 3,
      completed: 2,
      failed: 0,
      isSelecting: false,
      isSelectorComplete: false,
    })
  })

  test('counts failed implementors separately', () => {
    const blocks: ContentBlock[] = [
      createImplementorAgent('impl-1', 'complete'),
      createImplementorAgent('impl-2', 'failed'),
      createImplementorAgent('impl-3', 'cancelled'),
    ]
    const progress = getMultiPromptProgress(blocks)
    expect(progress).toEqual({
      total: 3,
      completed: 1,
      failed: 2,
      isSelecting: false,
      isSelectorComplete: false,
    })
  })

  test('detects selector running state', () => {
    const blocks: ContentBlock[] = [
      createImplementorAgent('impl-1', 'complete'),
      createImplementorAgent('impl-2', 'complete'),
      createSelectorAgent('running'),
    ]
    const progress = getMultiPromptProgress(blocks)
    expect(progress?.isSelecting).toBe(true)
    expect(progress?.isSelectorComplete).toBe(false)
  })

  test('detects selector complete state', () => {
    const blocks: ContentBlock[] = [
      createImplementorAgent('impl-1', 'complete'),
      createImplementorAgent('impl-2', 'complete'),
      createSelectorAgent('complete'),
    ]
    const progress = getMultiPromptProgress(blocks)
    expect(progress?.isSelecting).toBe(false)
    expect(progress?.isSelectorComplete).toBe(true)
  })

  test('treats failed as finished for progress calculation', () => {
    const blocks: ContentBlock[] = [
      createImplementorAgent('impl-1', 'complete'),
      createImplementorAgent('impl-2', 'failed'),
      createImplementorAgent('impl-3', 'running'),
    ]
    const progress = getMultiPromptProgress(blocks)
    // 1 complete + 1 failed = 2 finished out of 3
    expect(progress?.completed).toBe(1)
    expect(progress?.failed).toBe(1)
    expect(progress?.total).toBe(3)
  })
})

describe('getMultiPromptPreview', () => {
  const createImplementorAgent = (
    id: string,
    status: 'running' | 'complete' | 'failed' | 'cancelled' = 'complete',
  ): AgentContentBlock =>
    ({
      type: 'agent',
      agentId: id,
      agentName: 'Implementor',
      agentType: 'editor-implementor-opus',
      content: '',
      status,
      blocks: [],
    }) as AgentContentBlock

  const createSelectorAgent = (
    status: 'running' | 'complete' = 'running',
  ): AgentContentBlock =>
    ({
      type: 'agent',
      agentId: 'selector-1',
      agentName: 'Selector',
      agentType: 'best-of-n-selector2',
      content: '',
      status,
      blocks: [],
    }) as AgentContentBlock

  const createSetOutputBlock = (reason?: string): ToolContentBlock => ({
    type: 'tool',
    toolCallId: 'set-output-1',
    toolName: 'set_output',
    input: reason
      ? { data: { chosenStrategy: 'strategy A', reason } }
      : { data: { chosenStrategy: 'strategy A' } },
  })

  test('returns null for empty blocks', () => {
    expect(getMultiPromptPreview([])).toBeNull()
    expect(getMultiPromptPreview(undefined)).toBeNull()
  })

  test('shows generating message when no implementors complete', () => {
    const blocks: ContentBlock[] = [
      createImplementorAgent('impl-1', 'running'),
      createImplementorAgent('impl-2', 'running'),
      createImplementorAgent('impl-3', 'running'),
    ]
    expect(getMultiPromptPreview(blocks)).toBe('Generating 3 proposals...')
  })

  test('shows progress when some implementors complete', () => {
    const blocks: ContentBlock[] = [
      createImplementorAgent('impl-1', 'complete'),
      createImplementorAgent('impl-2', 'running'),
      createImplementorAgent('impl-3', 'complete'),
    ]
    expect(getMultiPromptPreview(blocks)).toBe('2/3 proposals complete...')
  })

  test('shows selecting message when selector is running', () => {
    const blocks: ContentBlock[] = [
      createImplementorAgent('impl-1', 'complete'),
      createImplementorAgent('impl-2', 'complete'),
      createImplementorAgent('impl-3', 'complete'),
      createSelectorAgent('running'),
    ]
    expect(getMultiPromptPreview(blocks)).toBe(
      '3 proposals complete • Selecting best...',
    )
  })

  test('shows applying message when selector is complete but agent not done', () => {
    const blocks: ContentBlock[] = [
      createImplementorAgent('impl-1', 'complete'),
      createImplementorAgent('impl-2', 'complete'),
      createSelectorAgent('complete'),
    ]
    expect(getMultiPromptPreview(blocks, false)).toBe(
      'Applying selected changes...',
    )
  })

  test('shows evaluation count when agent is complete without reason', () => {
    const blocks: ContentBlock[] = [
      createImplementorAgent('impl-1', 'complete'),
      createImplementorAgent('impl-2', 'complete'),
      createImplementorAgent('impl-3', 'complete'),
    ]
    expect(getMultiPromptPreview(blocks, true)).toBe('3 proposals evaluated')
  })

  test('shows evaluation count with reason when agent is complete', () => {
    const blocks: ContentBlock[] = [
      createImplementorAgent('impl-1', 'complete'),
      createImplementorAgent('impl-2', 'complete'),
      createSetOutputBlock('best implementation with proper error handling'),
    ]
    const preview = getMultiPromptPreview(blocks, true)
    expect(preview).toBe(
      '2 proposals evaluated\nBest implementation with proper error handling',
    )
  })

  test('capitalizes first letter of reason', () => {
    const blocks: ContentBlock[] = [
      createImplementorAgent('impl-1', 'complete'),
      createSetOutputBlock('simple and clean'),
    ]
    const preview = getMultiPromptPreview(blocks, true)
    expect(preview).toContain('Simple and clean')
  })

  test('shows failure count when some implementors fail', () => {
    const blocks: ContentBlock[] = [
      createImplementorAgent('impl-1', 'complete'),
      createImplementorAgent('impl-2', 'failed'),
      createImplementorAgent('impl-3', 'running'),
    ]
    expect(getMultiPromptPreview(blocks)).toBe('1/3 complete, 1 failed...')
  })

  test('shows all finished with failures when all done but some failed', () => {
    const blocks: ContentBlock[] = [
      createImplementorAgent('impl-1', 'complete'),
      createImplementorAgent('impl-2', 'complete'),
      createImplementorAgent('impl-3', 'failed'),
    ]
    expect(getMultiPromptPreview(blocks)).toBe(
      '2/3 proposals complete (1 failed)',
    )
  })

  test('treats failed implementors as finished for progress', () => {
    const blocks: ContentBlock[] = [
      createImplementorAgent('impl-1', 'cancelled'),
      createImplementorAgent('impl-2', 'failed'),
      createImplementorAgent('impl-3', 'complete'),
    ]
    // All 3 are finished (1 complete + 2 failed/cancelled), so should show completion message
    expect(getMultiPromptPreview(blocks)).toBe(
      '1/3 proposals complete (2 failed)',
    )
  })
})

describe('groupConsecutiveToolBlocks', () => {
  const createToolBlock = (toolName: string, id: string): ToolContentBlock => ({
    type: 'tool',
    toolCallId: id,
    toolName: toolName as ToolContentBlock['toolName'],
    input: {},
  })

  const createTextBlock = (content: string): TextContentBlock =>
    ({
      type: 'text',
      content,
    }) as TextContentBlock

  const createAgentBlock = (id: string): AgentContentBlock =>
    ({
      type: 'agent',
      agentId: id,
      agentName: 'Test Agent',
      agentType: 'file-picker',
      content: '',
      status: 'complete',
      blocks: [],
    }) as AgentContentBlock

  test('groups consecutive tool blocks', () => {
    const blocks: ContentBlock[] = [
      createToolBlock('str_replace', 'tool-1'),
      createToolBlock('write_file', 'tool-2'),
      createToolBlock('read_files', 'tool-3'),
      createTextBlock('done'),
    ]
    const result = groupConsecutiveToolBlocks(blocks, 0)

    expect(result.group).toHaveLength(3)
    expect(result.group[0].toolCallId).toBe('tool-1')
    expect(result.group[1].toolCallId).toBe('tool-2')
    expect(result.group[2].toolCallId).toBe('tool-3')
    expect(result.nextIndex).toBe(3)
  })

  test('stops at non-tool block', () => {
    const blocks: ContentBlock[] = [
      createToolBlock('str_replace', 'tool-1'),
      createTextBlock('some text'),
      createToolBlock('write_file', 'tool-2'),
    ]
    const result = groupConsecutiveToolBlocks(blocks, 0)

    expect(result.group).toHaveLength(1)
    expect(result.nextIndex).toBe(1)
  })

  test('stops at agent block', () => {
    const blocks: ContentBlock[] = [
      createToolBlock('str_replace', 'tool-1'),
      createAgentBlock('agent-1'),
      createToolBlock('write_file', 'tool-2'),
    ]
    const result = groupConsecutiveToolBlocks(blocks, 0)

    expect(result.group).toHaveLength(1)
    expect(result.nextIndex).toBe(1)
  })

  test('returns empty group when starting at non-tool block', () => {
    const blocks: ContentBlock[] = [
      createTextBlock('some text'),
      createToolBlock('str_replace', 'tool-1'),
    ]
    const result = groupConsecutiveToolBlocks(blocks, 0)

    expect(result.group).toHaveLength(0)
    expect(result.nextIndex).toBe(0)
  })

  test('groups from middle of array', () => {
    const blocks: ContentBlock[] = [
      createTextBlock('start'),
      createToolBlock('str_replace', 'tool-1'),
      createToolBlock('write_file', 'tool-2'),
      createTextBlock('end'),
    ]
    const result = groupConsecutiveToolBlocks(blocks, 1)

    expect(result.group).toHaveLength(2)
    expect(result.group[0].toolCallId).toBe('tool-1')
    expect(result.group[1].toolCallId).toBe('tool-2')
    expect(result.nextIndex).toBe(3)
  })

  test('handles empty blocks array', () => {
    const result = groupConsecutiveToolBlocks([], 0)
    expect(result.group).toHaveLength(0)
    expect(result.nextIndex).toBe(0)
  })

  test('groups all tool blocks when all match', () => {
    const blocks: ContentBlock[] = [
      createToolBlock('str_replace', 'tool-1'),
      createToolBlock('write_file', 'tool-2'),
      createToolBlock('read_files', 'tool-3'),
    ]
    const result = groupConsecutiveToolBlocks(blocks, 0)

    expect(result.group).toHaveLength(3)
    expect(result.nextIndex).toBe(3)
  })

  test('handles single tool block', () => {
    const blocks: ContentBlock[] = [
      createToolBlock('str_replace', 'tool-1'),
      createTextBlock('done'),
    ]
    const result = groupConsecutiveToolBlocks(blocks, 0)

    expect(result.group).toHaveLength(1)
    expect(result.nextIndex).toBe(1)
  })
})
