import { describe, expect, it } from 'bun:test'

import { FILE_READ_STATUS } from '@codebuff/common/constants/paths'

import { MAX_IMAGES_PER_READ_FILES_CALL, handleReadFiles } from '../tool/read-files'

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
          { path: 'a.ts', content: 'content' },
          {
            path: 'shot.PNG',
            content:
              '[IMAGE] image/png, 2 KB. The image is attached after this result.',
          },
          {
            path: 'missing.jpg',
            content: '[FILE_DOES_NOT_EXIST]',
          },
        ],
      },
      { type: 'media', data: 'iVBORw0KGgo=', mediaType: 'image/png' },
    ])
  })

  it('attaches at most the capped images, in path order, and leaves other paths alone', async () => {
    const images = Array.from(
      { length: MAX_IMAGES_PER_READ_FILES_CALL + 2 },
      (_, i) => `shot-${i}.png`,
    )
    const seenFilePaths: string[][] = []
    const opened: string[] = []
    const { output } = await handleReadFiles({
      previousToolCallFinished: Promise.resolve(),
      toolCall: {
        toolName: 'read_files',
        toolCallId: 'tc-1',
        input: { paths: ['a.ts', ...images, 'b.ts'] },
      },
      agentTemplate: agentTemplate(false),
      fileContext: { tokenCallers: {} } as any,
      requestFiles: async ({ filePaths }) => {
        seenFilePaths.push(filePaths)
        return Object.fromEntries(filePaths.map((path) => [path, 'content']))
      },
      requestImageFile: async ({ filePath }) => {
        opened.push(filePath)
        return {
          path: filePath,
          data: filePath,
          mediaType: 'image/png',
          bytes: 2048,
        }
      },
    })

    expect(MAX_IMAGES_PER_READ_FILES_CALL).toBe(4)
    const attached = images.slice(0, MAX_IMAGES_PER_READ_FILES_CALL)
    const deferred = images.slice(MAX_IMAGES_PER_READ_FILES_CALL)
    // Past the cap the host is never asked: no VM read, no bytes.
    expect(opened).toEqual(attached)
    expect(seenFilePaths).toEqual([['a.ts', 'b.ts']])
    expect(output.slice(1)).toEqual(
      attached.map((data) => ({
        type: 'media',
        data,
        mediaType: 'image/png',
      })),
    )
    const results = output[0].value as Array<{ path: string; content: string }>
    expect(results.map((file) => file.path)).toEqual([
      'a.ts',
      'b.ts',
      ...images,
    ])
    expect(results.slice(0, 2).map((file) => file.content)).toEqual([
      'content',
      'content',
    ])
    for (const file of results.slice(-deferred.length)) {
      expect(file.content).toStartWith(FILE_READ_STATUS.ERROR)
      expect(file.content).toContain('at most 4 images per call')
      expect(file.content).toContain('in a later call')
    }
  })

  it('counts a repeated image once toward the cap', async () => {
    const opened: string[] = []
    const paths = ['a.png', 'a.png', 'b.png', 'c.png', 'd.png']
    const { output } = await handleReadFiles({
      previousToolCallFinished: Promise.resolve(),
      toolCall: {
        toolName: 'read_files',
        toolCallId: 'tc-1',
        input: { paths },
      },
      agentTemplate: agentTemplate(false),
      fileContext: { tokenCallers: {} } as any,
      requestFiles: async () => ({}),
      requestImageFile: async ({ filePath }) => {
        opened.push(filePath)
        return {
          path: filePath,
          data: filePath,
          mediaType: 'image/png',
          bytes: 2048,
        }
      },
    })

    expect(opened).toEqual(['a.png', 'b.png', 'c.png', 'd.png'])
    expect(output).toHaveLength(5)
  })

  it('reads images as ordinary files when the host cannot read binary', async () => {
    const { seenFilePaths } = await runHandler({
      paths: ['shot.png'],
      windowed: false,
    })

    expect(seenFilePaths).toEqual(['shot.png'])
  })
})
