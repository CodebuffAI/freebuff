import { EventEmitter } from 'events'
import type { ChildProcess, spawn } from 'child_process'

import { describe, expect, mock, test } from 'bun:test'

import {
  getWindowsOpenUrlCommand,
  openUrlWithWindowsHandler,
} from '../open-url'

function createMockChildProcess(): ChildProcess {
  const child = new EventEmitter() as ChildProcess
  child.unref = mock(() => {}) as unknown as ChildProcess['unref']
  return child
}

describe('Windows URL opener', () => {
  test('builds the rundll32 URL handler command', () => {
    expect(getWindowsOpenUrlCommand('https://example.com')).toEqual({
      command: 'rundll32.exe',
      args: ['url.dll,FileProtocolHandler', 'https://example.com'],
    })
  })

  test('returns false when spawn emits an async error', async () => {
    const child = createMockChildProcess()
    const spawnUrlHandler = mock(() => child) as unknown as typeof spawn

    const result = openUrlWithWindowsHandler(
      'https://example.com',
      spawnUrlHandler,
    )
    child.emit('error', new Error('ENOENT'))

    await expect(result).resolves.toBe(false)
    expect(child.unref).not.toHaveBeenCalled()
  })

  test('returns true and unrefs the process after spawn succeeds', async () => {
    const child = createMockChildProcess()
    const spawnUrlHandler = mock(() => child) as unknown as typeof spawn

    const result = openUrlWithWindowsHandler(
      'https://example.com',
      spawnUrlHandler,
    )
    child.emit('spawn')

    await expect(result).resolves.toBe(true)
    expect(child.unref).toHaveBeenCalledTimes(1)
  })
})
