import { describe, expect, spyOn, test } from 'bun:test'
import { generateText } from 'ai'

import { installAiSdkWarningLogger } from '../ai-sdk-warnings'

import type { LogWarningsFunction } from 'ai'

describe('AI SDK warnings in the TUI', () => {
  test('routes real v2 compatibility warnings to diagnostics without terminal output', async () => {
    const records: Parameters<LogWarningsFunction>[0][] = []
    const previous = globalThis.AI_SDK_LOG_WARNINGS
    const restore = installAiSdkWarningLogger((record) => records.push(record))
    const emitWarning = spyOn(process, 'emitWarning').mockImplementation(() => {})
    const consoleWarn = spyOn(console, 'warn').mockImplementation(() => {})
    const stop = async (): Promise<never> => {
      throw new Error('No network in this test')
    }

    try {
      await expect(
        generateText({
          model: {
            specificationVersion: 'v2',
            provider: 'codebuff',
            modelId: 'test-model',
            supportedUrls: {},
            doGenerate: stop,
            doStream: stop,
          },
          prompt: 'hello',
          maxRetries: 0,
        }),
      ).rejects.toThrow('No network in this test')

      expect(records).toContainEqual(
        expect.objectContaining({
          provider: 'codebuff',
          model: 'test-model',
          warnings: expect.arrayContaining([
            expect.objectContaining({ feature: 'specificationVersion' }),
          ]),
        }),
      )
      expect(emitWarning).not.toHaveBeenCalled()
      expect(consoleWarn).not.toHaveBeenCalled()
    } finally {
      restore()
      emitWarning.mockRestore()
      consoleWarn.mockRestore()
    }
    expect(globalThis.AI_SDK_LOG_WARNINGS).toBe(previous)
  })
})
