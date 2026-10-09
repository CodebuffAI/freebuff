import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import {
  CHAT_MESSAGES_FILENAME,
  CHAT_META_FILENAME,
  getFirstUserPrompt,
  readChatMeta,
  writeChatMeta,
} from '../chat-meta'
import {
  saveChatState,
  setChatDirOverrideForTesting,
} from '../run-state-storage'

import type { ChatMessage } from '../../types/chat'
import type { RunState } from '@codebuff/sdk'

let chatDir = ''

function userMessage(content: string): ChatMessage {
  return {
    id: `msg-${content}`,
    variant: 'user',
    content,
    timestamp: new Date().toISOString(),
    blocks: [],
  }
}

/** Write chat-messages.json so writeChatMeta can stat it. */
function writeMessagesFile(messages: ChatMessage[]): void {
  fs.writeFileSync(
    path.join(chatDir, CHAT_MESSAGES_FILENAME),
    JSON.stringify(messages),
  )
}

describe('chat-meta', () => {
  beforeEach(() => {
    chatDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codebuff-meta-'))
    setChatDirOverrideForTesting(chatDir)
  })

  afterEach(() => {
    setChatDirOverrideForTesting(undefined)
    fs.rmSync(chatDir, { recursive: true, force: true })
  })

  test('getFirstUserPrompt returns first user message, truncated', () => {
    const messages: ChatMessage[] = [
      { ...userMessage(''), variant: 'agent' },
      userMessage('hello there'),
      userMessage('second prompt'),
    ]
    expect(getFirstUserPrompt(messages)).toBe('hello there')

    const long = 'x'.repeat(150)
    expect(getFirstUserPrompt([userMessage(long)])).toBe(
      'x'.repeat(97) + '...',
    )
    expect(getFirstUserPrompt([])).toBe('(empty chat)')
  })

  test('writeChatMeta / readChatMeta round trip', () => {
    const messages = [userMessage('round trip prompt'), userMessage('two')]
    writeMessagesFile(messages)
    writeChatMeta(chatDir, messages)

    expect(readChatMeta(chatDir)).toMatchObject({
      messageCount: 2,
      firstPrompt: 'round trip prompt',
    })
  })

  test('readChatMeta returns null for missing or invalid meta', () => {
    writeMessagesFile([userMessage('hi')])
    expect(readChatMeta(chatDir)).toBeNull()

    const metaPath = path.join(chatDir, CHAT_META_FILENAME)
    fs.writeFileSync(metaPath, '{"messageCount": "not a nu')
    expect(readChatMeta(chatDir)).toBeNull()

    fs.writeFileSync(metaPath, JSON.stringify({ messageCount: 3 }))
    expect(readChatMeta(chatDir)).toBeNull()
  })

  test('readChatMeta returns null when chat-messages.json no longer matches', () => {
    const messages = [userMessage('original prompt')]
    writeMessagesFile(messages)
    writeChatMeta(chatDir, messages)
    expect(readChatMeta(chatDir)).not.toBeNull()

    // Simulate another writer (e.g. an older CLI) rewriting the transcript
    // without refreshing the sidecar
    writeMessagesFile([
      userMessage('original prompt'),
      userMessage('a new message the sidecar does not know about'),
    ])
    expect(readChatMeta(chatDir)).toBeNull()

    // Messages file deleted entirely
    fs.rmSync(path.join(chatDir, CHAT_MESSAGES_FILENAME))
    expect(readChatMeta(chatDir)).toBeNull()
  })

  test('saveChatState writes the meta sidecar', () => {
    const runState = { output: undefined } as unknown as RunState
    const messages = [userMessage('saved prompt')]

    saveChatState(runState, messages)

    const metaPath = path.join(chatDir, CHAT_META_FILENAME)
    expect(fs.existsSync(metaPath)).toBe(true)
    expect(readChatMeta(chatDir)).toMatchObject({
      messageCount: 1,
      firstPrompt: 'saved prompt',
    })
  })
})
