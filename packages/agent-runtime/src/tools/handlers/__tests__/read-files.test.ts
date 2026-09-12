import { describe, expect, it } from 'bun:test'

import { handleReadFiles } from '../tool/read-files'

import type { CodebuffToolCall } from '@codebuff/common/tools/list'
import type { AgentTemplate } from '@codebuff/common/types/agent-template'
import type { FileReadWindow } from '@codebuff/common/types/contracts/client'

const agentTemplate = (windowedFileReads: boolean): AgentTemplate => ({
  id: 'test-agent',
  displayName: 'Test Agent',
  spawnerPrompt: 'Test agent',
  model: 'claude-3-5-sonnet-20241022',
  inputSchema: {},
  outputMode: 'structured_output',
  includeMessageHistory: true,
  inheritParentSystemPrompt: false,
  mcpServers: {},
  toolNames: ['read_files'],
  spawnableAgents: [],
  systemPrompt: 'Test system prompt',
  instructionsPrompt: 'Test instructions',
  stepPrompt: 'Test step prompt',
  windowedFileReads,
})

async function runHandler(params: {
  paths: CodebuffToolCall<'read_files'>['input']['paths']
  windowed: boolean
}) {
  let seenFilePaths: string[] = []
  let seenFileWindows: Record<string, FileReadWindow[]> | undefined
  await handleReadFiles({
    previousToolCallFinished: Promise.resolve(),
    toolCall: {
      toolName: 'read_files',
      toolCallId: 'tc-1',
      input: { paths: params.paths },
    },
    agentTemplate: agentTemplate(params.windowed),
    fileContext: { tokenCallers: {} } as any,
    requestFiles: async ({ filePaths, fileWindows }) => {
      seenFilePaths = filePaths
      seenFileWindows = fileWindows
      return Object.fromEntries(filePaths.map((path) => [path, 'content']))
    },
  })
  return { seenFilePaths, seenFileWindows }
}

describe('handleReadFiles', () => {
  it('sends no windows for agents without windowedFileReads', async () => {
    const { seenFileWindows } = await runHandler({
      paths: ['a.ts', { path: 'b.ts', offset: 5, limit: 10 }],
      windowed: false,
    })

    expect(seenFileWindows).toBeUndefined()
  })

  it('collapses duplicate whole-file entries into one window', async () => {
    const { seenFilePaths, seenFileWindows } = await runHandler({
      paths: ['a.ts', 'a.ts'],
      windowed: true,
    })

    expect(seenFilePaths).toEqual(['a.ts'])
    expect(seenFileWindows).toEqual({ 'a.ts': [{}] })
  })

  it('drops narrower windows when a whole-file entry exists', async () => {
    const before = await runHandler({
      paths: [{ path: 'a.ts', offset: 2, limit: 1 }, 'a.ts'],
      windowed: true,
    })
    expect(before.seenFileWindows).toEqual({ 'a.ts': [{}] })

    const after = await runHandler({
      paths: ['a.ts', { path: 'a.ts', offset: 2, limit: 1 }],
      windowed: true,
    })
    expect(after.seenFileWindows).toEqual({ 'a.ts': [{}] })
  })

  it('keeps distinct windows and drops exact repeats', async () => {
    const { seenFileWindows } = await runHandler({
      paths: [
        { path: 'a.ts', offset: 1, limit: 100 },
        { path: 'a.ts', offset: 1, limit: 100 },
        { path: 'a.ts', offset: 800, limit: 100 },
      ],
      windowed: true,
    })

    expect(seenFileWindows).toEqual({
      'a.ts': [
        { offset: 1, limit: 100 },
        { offset: 800, limit: 100 },
      ],
    })
  })
})

describe('handleReadFiles with prototype-member paths', () => {
  // Both dedupe maps are keyed by a model-supplied path. On a plain object
  // every one of these resolves to an inherited Object.prototype member, which
  // is truthy, so `??=` leaves it in place and the following .has()/.push()
  // throws — taking down the whole tool call.
  const PROTOTYPE_KEYS = [
    '__proto__',
    'constructor',
    'toString',
    'valueOf',
    'hasOwnProperty',
  ]

  it('reads a file named after a prototype member without crashing', async () => {
    for (const path of PROTOTYPE_KEYS) {
      const { seenFilePaths, seenFileWindows } = await runHandler({
        paths: [{ path, offset: 0, limit: 10 }],
        windowed: true,
      })
      expect(seenFilePaths).toEqual([path])
      expect(seenFileWindows?.[path]).toEqual([{ offset: 0, limit: 10 }])
    }
  })

  it('still dedupes windows for such a path', async () => {
    const { seenFileWindows } = await runHandler({
      paths: [
        { path: '__proto__', offset: 0, limit: 10 },
        { path: '__proto__', offset: 0, limit: 10 },
        { path: '__proto__', offset: 50, limit: 10 },
      ],
      windowed: true,
    })

    expect(seenFileWindows?.['__proto__']).toEqual([
      { offset: 0, limit: 10 },
      { offset: 50, limit: 10 },
    ])
  })

  it('does not leak a window map onto Object.prototype', async () => {
    await runHandler({
      paths: [{ path: '__proto__', offset: 0, limit: 10 }],
      windowed: true,
    })

    expect(({} as Record<string, unknown>).offset).toBeUndefined()
    expect(Object.prototype).not.toHaveProperty('offset')
  })

  it('attaches images as media instead of reading their bytes as text', async () => {
    const seenFilePaths: string[][] = []
    const { output } = await handleReadFiles({
      previousToolCallFinished: Promise.resolve(),
      toolCall: {
        toolName: 'read_files',
        toolCallId: 'tc-1',
        input: { paths: ['a.ts', 'shot.PNG', 'missing.jpg', 'shot.PNG'] },
      },
      agentTemplate: agentTemplate(false),
      fileContext: { tokenCallers: {} } as any,
      requestFiles: async ({ filePaths }) => {
        seenFilePaths.push(filePaths)
        return Object.fromEntries(filePaths.map((path) => [path, 'content']))
      },
      requestImageFile: async ({ filePath }) =>
        filePath === 'shot.PNG'
          ? {
              path: filePath,
              data: 'iVBORw0KGgo=',
              mediaType: 'image/png',
              bytes: 2048,
            }
          : { path: filePath, error: '[FILE_DOES_NOT_EXIST]' },
    })

    expect(seenFilePaths).toEqual([['a.ts']])
    expect(output).toEqual([
      {
        type: 'json',
        value: [
          { path: 'a.ts', content: 'content', referencedBy: {} },
          {
            path: 'shot.PNG',
            content:
              '[IMAGE] image/png, 2 KB. The image is attached after this result.',
            referencedBy: {},
          },
          {
            path: 'missing.jpg',
            content: '[FILE_DOES_NOT_EXIST]',
            referencedBy: {},
          },
        ],
      },
      { type: 'media', data: 'iVBORw0KGgo=', mediaType: 'image/png' },
    ])
  })

  it('reads images as ordinary files when the host cannot read binary', async () => {
    const { seenFilePaths } = await runHandler({
      paths: ['shot.png'],
      windowed: false,
    })

    expect(seenFilePaths).toEqual(['shot.png'])
  })
})
