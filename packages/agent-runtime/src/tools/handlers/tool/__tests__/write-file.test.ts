import { describe, expect, it } from 'bun:test'

import { handleWriteFile, getFileProcessingValues, type FileProcessingState } from '../write-file'

describe('handleWriteFile', () => {
  describe('getFileProcessingValues', () => {
    it('should copy file processing state values', () => {
      const state: FileProcessingState = {
        promisesByPath: { 'test.ts': [] },
        allPromises: [],
        fileChangeErrors: [],
        fileChanges: [],
        firstFileProcessed: true,
      }

      const result = getFileProcessingValues(state)
      expect(result.firstFileProcessed).toBe(true)
      expect(result.promisesByPath).toEqual({ 'test.ts': [] })
    })
  })

  describe('read-only mode', () => {
    const callHandler = (agentTemplate: unknown) =>
      handleWriteFile({
        previousToolCallFinished: Promise.resolve(),
        toolCall: {
          toolCallId: 'call-1',
          toolName: 'write_file',
          // `confirmed: true` is what a model would send to talk its way past a
          // naive gate; it must make no difference.
          input: { path: 'a.ts', content: 'x', confirmed: true },
        },
        agentTemplate,
        fileProcessingState: {
          promisesByPath: {},
          allPromises: [],
          fileChangeErrors: [],
          fileChanges: [],
          firstFileProcessed: false,
        },
      } as any)

    it('refuses the write when the agent blocks destructive tools', async () => {
      const result = await callHandler({ blockDestructiveTools: true })
      expect(JSON.stringify(result.output)).toContain('disabled for this agent')
    })
  })
})
