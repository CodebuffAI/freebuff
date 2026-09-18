import * as fs from 'fs'
import path from 'path'

import { z } from 'zod'

import { writeFileAtomic } from './write-file-atomic'

import type { ChatMessage } from '../types/chat'

export const CHAT_MESSAGES_FILENAME = 'chat-messages.json'
export const CHAT_META_FILENAME = 'chat-meta.json'

/**
 * Small sidecar summary of a chat written alongside chat-messages.json.
 * Transcripts are unbounded and can grow to many MB, so /history reads this
 * instead of parsing every full chat-messages.json.
 *
 * messagesSize/messagesMtimeMs bind the sidecar to the exact messages file it
 * summarizes: if the transcript is later rewritten by anything that doesn't
 * refresh the sidecar (an older CLI version, a crash between the two writes),
 * readChatMeta rejects the stale sidecar and callers fall back to the full
 * parse instead of showing outdated data or hiding corruption.
 */
const chatMetaSchema = z.object({
  messageCount: z.number(),
  firstPrompt: z.string(),
  messagesSize: z.number(),
  messagesMtimeMs: z.number(),
})

export type ChatMeta = z.infer<typeof chatMetaSchema>

/**
 * Standing label for a chat whose transcript holds no user turn yet. Callers
 * that offer to come back to a chat use it to tell "a conversation" from "a
 * session the user never typed into".
 */
export const EMPTY_CHAT_PROMPT = '(empty chat)'

/**
 * Get the first user message from a list of chat messages
 */
export function getFirstUserPrompt(messages: ChatMessage[]): string {
  for (const msg of messages) {
    if (msg?.variant === 'user' && msg.content) {
      // Truncate long prompts
      const content = msg.content.trim()
      if (content.length > 100) {
        return content.slice(0, 97) + '...'
      }
      return content
    }
  }
  return EMPTY_CHAT_PROMPT
}

/**
 * Write the sidecar for the given chat directory. The chat-messages.json in
 * that directory must already contain exactly `messages` (its stats are
 * recorded to bind the sidecar to it).
 */
export function writeChatMeta(chatDir: string, messages: ChatMessage[]): void {
  const stats = fs.statSync(path.join(chatDir, CHAT_MESSAGES_FILENAME))
  const meta: ChatMeta = {
    messageCount: messages.length,
    firstPrompt: getFirstUserPrompt(messages),
    messagesSize: stats.size,
    messagesMtimeMs: stats.mtimeMs,
  }
  writeFileAtomic(path.join(chatDir, CHAT_META_FILENAME), JSON.stringify(meta))
}

/**
 * Read the sidecar for a chat directory. Returns null when it is missing,
 * unparsable, or stale (chat-messages.json no longer matches the recorded
 * size/mtime) — callers should fall back to parsing chat-messages.json.
 */
export function readChatMeta(chatDir: string): ChatMeta | null {
  try {
    const raw = fs.readFileSync(path.join(chatDir, CHAT_META_FILENAME), 'utf8')
    const parsed = chatMetaSchema.safeParse(JSON.parse(raw))
    if (!parsed.success) {
      return null
    }
    const meta = parsed.data
    const stats = fs.statSync(path.join(chatDir, CHAT_MESSAGES_FILENAME))
    if (
      stats.size !== meta.messagesSize ||
      stats.mtimeMs !== meta.messagesMtimeMs
    ) {
      return null
    }
    return meta
  } catch {
    return null
  }
}
