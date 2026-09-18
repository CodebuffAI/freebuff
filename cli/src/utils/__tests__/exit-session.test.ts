import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import {
  CHAT_MESSAGES_FILENAME,
  EMPTY_CHAT_PROMPT,
  writeChatMeta,
} from '../chat-meta'
import { sessionForExit } from '../exit-session'

import type { ChatMessage } from '../../types/chat'

/**
 * Tests for the gate the exit banner stands on.
 *
 * `getCurrentChatId()` mints an id on first read, so the id alone can never be
 * the reason a resume hint is printed — the transcript is. These pin which
 * transcripts count, so the hint cannot start promising a session that would
 * come back empty.
 */

const CHAT_ID = '2026-09-15T10-53-36.839Z'
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

beforeEach(() => {
  chatDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exit-session-'))
})

afterEach(() => {
  fs.rmSync(chatDir, { recursive: true, force: true })
})

describe('sessionForExit', () => {
  test('no chat id is never a session', () => {
    expect(sessionForExit({ chatId: '', chatDir })).toBeNull()
  })

  test('a sidecar with a first prompt is the session and its label', () => {
    const messages = [userMessage('Fix the status bar lanes')]
    writeMessagesFile(messages)
    writeChatMeta(chatDir, messages)

    expect(sessionForExit({ chatId: CHAT_ID, chatDir })).toEqual({
      chatId: CHAT_ID,
      sessionLabel: 'Fix the status bar lanes',
    })
  })

  test('a chat the user never typed into is not offered', () => {
    // The sidecar is what says so: the transcript exists and is non-empty, so
    // the size fallback below would have offered it.
    const messages = [userMessage('')]
    writeMessagesFile(messages)
    writeChatMeta(chatDir, messages)

    expect(sessionForExit({ chatId: CHAT_ID, chatDir })).toBeNull()
  })

  test('with no sidecar a written transcript still counts, unlabelled', () => {
    writeMessagesFile([userMessage('hello')])

    expect(sessionForExit({ chatId: CHAT_ID, chatDir })).toEqual({
      chatId: CHAT_ID,
    })
  })

  test('with no sidecar an empty transcript is not offered', () => {
    // `[]` is two bytes, so a size test that only asks "is this file empty"
    // would offer a resume for a chat that has nothing to replay.
    writeMessagesFile([])

    expect(sessionForExit({ chatId: CHAT_ID, chatDir })).toBeNull()
  })

  test('with no sidecar a zero-byte transcript is not offered', () => {
    fs.writeFileSync(path.join(chatDir, CHAT_MESSAGES_FILENAME), '')

    expect(sessionForExit({ chatId: CHAT_ID, chatDir })).toBeNull()
  })

  test('with neither file there is nothing to come back to', () => {
    expect(sessionForExit({ chatId: CHAT_ID, chatDir })).toBeNull()
  })

  test('a stale sidecar falls back to the transcript', () => {
    const messages = [userMessage('first prompt')]
    writeMessagesFile(messages)
    writeChatMeta(chatDir, messages)
    // Rewrite the transcript behind the sidecar's back, the way an older CLI
    // or an interrupted write would: the label is gone, the session is not.
    writeMessagesFile([...messages, userMessage('second prompt')])

    expect(sessionForExit({ chatId: CHAT_ID, chatDir })).toEqual({
      chatId: CHAT_ID,
    })
  })

  test('a stale sidecar over an empty transcript is not offered', () => {
    const messages = [userMessage('first prompt')]
    writeMessagesFile(messages)
    writeChatMeta(chatDir, messages)
    writeMessagesFile([])

    expect(sessionForExit({ chatId: CHAT_ID, chatDir })).toBeNull()
  })

  test('only the marker itself is an empty chat', () => {
    // The comparison is the whole marker, so a prompt that merely mentions it
    // is still a conversation.
    const prompt = `${EMPTY_CHAT_PROMPT} but with words`
    const messages = [userMessage(prompt)]
    writeMessagesFile(messages)
    writeChatMeta(chatDir, messages)

    expect(sessionForExit({ chatId: CHAT_ID, chatDir })).toEqual({
      chatId: CHAT_ID,
      sessionLabel: prompt,
    })
  })
})
