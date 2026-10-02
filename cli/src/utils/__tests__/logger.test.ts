import { describe, expect, test } from 'bun:test'

import path from 'path'

import { CHAT_LOG_FILENAME, resolveLogTarget } from '../logger'

describe('resolveLogTarget', () => {
  test('uses the project debug log in development', () => {
    let currentChatDirCalls = 0

    const target = resolveLogTarget({
      projectRoot: '/project',
      isDev: true,
      getCurrentChatDir: () => {
        currentChatDirCalls += 1
        return '/chat'
      },
    })

    expect(target).toBe(path.join('/project', 'debug', 'cli.jsonl'))
    expect(currentChatDirCalls).toBe(0)
  })

  test('uses the current chat log in production', () => {
    const target = resolveLogTarget({
      projectRoot: '/project',
      isDev: false,
      getCurrentChatDir: () => '/chat/2026-01-01T00-00-00.000Z',
    })

    expect(target).toBe(
      path.join('/chat/2026-01-01T00-00-00.000Z', CHAT_LOG_FILENAME),
    )
  })

  test('skips file logging when the chat directory cannot be created', () => {
    const target = resolveLogTarget({
      projectRoot: '/project',
      isDev: false,
      getCurrentChatDir: () => {
        throw new Error('EACCES')
      },
    })

    expect(target).toBeUndefined()
  })
})
