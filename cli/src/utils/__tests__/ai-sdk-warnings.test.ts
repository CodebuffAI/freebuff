import { describe, expect, spyOn, test } from 'bun:test'
import { generateText } from 'ai'

import {
  createAiSdkWarningFilter,
  installAiSdkWarningLogger,
} from '../ai-sdk-warnings'

import type { LogWarningsFunction } from 'ai'

type WarningLog = Parameters<LogWarningsFunction>[0]

describe('AI SDK warnings in the TUI', () => {
  test('keeps real v2 calls off the terminal and out of the logs', async () => {
    const records: WarningLog[] = []
    const previous = globalThis.AI_SDK_LOG_WARNINGS
    const restore = installAiSdkWarningLogger((record) => records.push(record))
    const emitWarning = spyOn(process, 'emitWarning').mockImplementation(() => {})
    const consoleWarn = spyOn(console, 'warn').mockImplementation(() => {})
    const stop = async (): Promise<never> => {
      throw new Error('No network in this test')
    }
    const call = () =>
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
      })

    try {
      // Every call to a v2 model raises the compatibility notice. It is
      // expected for our providers, so it must not become a log row per step.
      await expect(call()).rejects.toThrow('No network in this test')
      await expect(call()).rejects.toThrow('No network in this test')

      expect(records).toEqual([])
      expect(emitWarning).not.toHaveBeenCalled()
      expect(consoleWarn).not.toHaveBeenCalled()
    } finally {
      restore()
      emitWarning.mockRestore()
      consoleWarn.mockRestore()
    }
    expect(globalThis.AI_SDK_LOG_WARNINGS).toBe(previous)
  })

  test('logs any other warning once per provider and model', () => {
    const records: WarningLog[] = []
    const log = createAiSdkWarningFilter((record) => records.push(record))
    const topK = { type: 'unsupported' as const, feature: 'topK' }
    const compat = {
      type: 'compatibility' as const,
      feature: 'specificationVersion',
    }

    log({ warnings: [compat, topK], provider: 'codebuff', model: 'a' })
    log({ warnings: [topK], provider: 'codebuff', model: 'a' })
    log({ warnings: [compat], provider: 'codebuff', model: 'a' })
    log({ warnings: [topK], provider: 'codebuff', model: 'b' })

    expect(records).toEqual([
      { warnings: [topK], provider: 'codebuff', model: 'a' },
      { warnings: [topK], provider: 'codebuff', model: 'b' },
    ])
  })
})
