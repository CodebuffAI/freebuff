import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  getCurrentChatId,
  getCurrentChatDir,
  getProjectDataDir,
  setCurrentChatId,
  setProjectRoot,
  tryGetProjectRoot,
} from '../project-files'
import { deleteChatSession, getAllChats } from '../utils/chat-history'
import {
  loadMostRecentChatState,
  saveChatState,
} from '../utils/run-state-storage'

import type { ChatMessage } from '../types/chat'
import type { RunState } from '@codebuff/sdk'

describe('project history isolation', () => {
  let tempRoot: string
  let projectA: string
  let projectB: string
  let previousConfigDir: string | undefined
  let previousProjectRoot: string | undefined
  let previousChatId: string

  beforeEach(() => {
    previousConfigDir = process.env.FREEBUFF_CONFIG_DIR
    previousProjectRoot = tryGetProjectRoot()
    previousChatId = getCurrentChatId()
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'project-history-'))
    process.env.FREEBUFF_CONFIG_DIR = path.join(tempRoot, 'config')
    projectA = path.join(tempRoot, 'client-a', 'app')
    projectB = path.join(tempRoot, 'client-b', 'app')
    fs.mkdirSync(projectA, { recursive: true })
    fs.mkdirSync(projectB, { recursive: true })
  })

  afterEach(() => {
    if (previousConfigDir === undefined) delete process.env.FREEBUFF_CONFIG_DIR
    else process.env.FREEBUFF_CONFIG_DIR = previousConfigDir
    setProjectRoot(previousProjectRoot ?? process.cwd())
    setCurrentChatId(previousChatId)
    fs.rmSync(tempRoot, { recursive: true, force: true })
  })

  function saveChat(chatId: string, content: string) {
    setCurrentChatId(chatId)
    const runState = {
      output: { type: 'error', message: content },
    } as RunState
    const messages: ChatMessage[] = [
      {
        id: chatId,
        variant: 'user',
        content,
        timestamp: new Date().toISOString(),
      },
    ]
    saveChatState(runState, messages, getCurrentChatDir())
  }

  test('continuing a same-named project does not restore another project', () => {
    setProjectRoot(projectA)
    saveChat('a-chat', 'client A context')
    const dataDirA = getProjectDataDir()

    setProjectRoot(projectB)
    expect(loadMostRecentChatState()).toBeNull()
    expect(getAllChats()).toEqual([])
    expect(getProjectDataDir()).not.toBe(dataDirA)

    saveChat('b-chat', 'client B context')
    expect(loadMostRecentChatState()?.messages[0]?.content).toBe(
      'client B context',
    )

    setProjectRoot(projectA)
    expect(loadMostRecentChatState()?.chatId).toBe('a-chat')
    expect(loadMostRecentChatState()?.runState.output).toEqual({
      type: 'error',
      message: 'client A context',
    })
    expect(getAllChats().map((chat) => chat.chatId)).toEqual(['a-chat'])
  })

  test('matching chat IDs cannot overwrite or delete another project history', () => {
    setProjectRoot(projectA)
    saveChat('same-chat', 'client A context')
    setProjectRoot(projectB)
    saveChat('same-chat', 'client B context')
    setProjectRoot(projectA)
    expect(loadMostRecentChatState()?.messages[0]?.content).toBe(
      'client A context',
    )
    setProjectRoot(projectB)
    expect(deleteChatSession('same-chat')).toBe(true)
    setProjectRoot(projectA)
    expect(loadMostRecentChatState()?.messages[0]?.content).toBe(
      'client A context',
    )
  })

  test('equivalent absolute paths retain the same history', () => {
    setProjectRoot(projectA)
    saveChat('a-chat', 'client A context')
    const dataDir = getProjectDataDir()
    setProjectRoot(path.join(projectA, '..', 'app'))
    expect(getProjectDataDir()).toBe(dataDir)
    expect(loadMostRecentChatState()?.chatId).toBe('a-chat')
  })

  test('unowned legacy history is preserved without automatic restoration', () => {
    const legacyDir = path.join(
      process.env.FREEBUFF_CONFIG_DIR!,
      'projects',
      'app',
      'chats',
      'legacy-chat',
    )
    fs.mkdirSync(legacyDir, { recursive: true })
    fs.writeFileSync(
      path.join(legacyDir, 'chat-messages.json'),
      JSON.stringify([
        { id: 'legacy', variant: 'user', content: 'unknown project context' },
      ]),
    )
    const original = fs.readFileSync(
      path.join(legacyDir, 'chat-messages.json'),
      'utf8',
    )
    for (const project of [projectA, projectB]) {
      setProjectRoot(project)
      expect(loadMostRecentChatState()).toBeNull()
      expect(loadMostRecentChatState('legacy-chat')).toBeNull()
      saveChat('new-chat', 'new context')
    }
    expect(
      fs.readFileSync(path.join(legacyDir, 'chat-messages.json'), 'utf8'),
    ).toBe(original)
  })

  test('a user-selected legacy chat can be copied into its project history', () => {
    setProjectRoot(projectA)
    saveChat('verified-chat', 'client A context')
    const legacyDir = path.join(
      process.env.FREEBUFF_CONFIG_DIR!,
      'projects',
      'app',
      'chats',
      'verified-chat',
    )
    fs.mkdirSync(path.dirname(legacyDir), { recursive: true })
    fs.renameSync(getCurrentChatDir(), legacyDir)
    expect(loadMostRecentChatState()).toBeNull()

    fs.cpSync(legacyDir, getCurrentChatDir(), {
      recursive: true,
      force: false,
      errorOnExist: true,
    })
    expect(loadMostRecentChatState()?.messages[0]?.content).toBe(
      'client A context',
    )
    setProjectRoot(projectB)
    expect(loadMostRecentChatState()).toBeNull()
    expect(fs.existsSync(legacyDir)).toBe(true)
  })
})
