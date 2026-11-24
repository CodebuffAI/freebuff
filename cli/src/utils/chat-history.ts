import * as fs from 'fs'
import path from 'path'

import {
  CHAT_MESSAGES_FILENAME,
  getFirstUserPrompt,
  readChatMeta,
} from './chat-meta'
import { readChatTitle } from './chat-title'
import { CHAT_LOG_FILENAME, logger } from './logger'
import { getProjectDataDir } from '../project-files'

import type { ChatMessage } from '../types/chat'

export interface ChatHistoryEntry {
  chatId: string
  lastPrompt: string
  /** The chat's generated title, when one was saved. */
  title?: string
  timestamp: Date
  messageCount: number
  /** True when chat-messages.json exists but can't be parsed (e.g. truncated
   * by a crash mid-write). Shown in /history so the chat doesn't silently
   * vanish; can be deleted but not resumed. */
  unreadable?: boolean
}

function getChatsDir(dataDir: string = getProjectDataDir()): string {
  return path.join(dataDir, 'chats')
}

interface ChatDirInfo {
  chatId: string
  chatPath: string
  messagesPath: string
  mtime: Date
}

/**
 * List all available chats sorted by most recent first
 * @param maxChats - Maximum number of chats to load (default: 500)
 */
export function getAllChats(
  maxChats: number = 500,
  dataDir?: string,
): ChatHistoryEntry[] {
  try {
    const chatsDir = getChatsDir(dataDir)

    if (!fs.existsSync(chatsDir)) {
      return []
    }

    const chatDirs = fs.readdirSync(chatsDir)

    // First pass: get mtime for all chat directories (fast, no file reading)
    const chatDirInfos: ChatDirInfo[] = []
    for (const chatId of chatDirs) {
      const chatPath = path.join(chatsDir, chatId)
      try {
        const stat = fs.statSync(chatPath)
        if (!stat.isDirectory()) continue

        chatDirInfos.push({
          chatId,
          chatPath,
          messagesPath: path.join(chatPath, CHAT_MESSAGES_FILENAME),
          mtime: stat.mtime,
        })
      } catch {
        // Skip directories we can't stat
      }
    }

    // Sort by mtime first (most recent first)
    chatDirInfos.sort((a, b) => b.mtime.getTime() - a.mtime.getTime())

    // Second pass: only read message content for the top N chats
    const chats: ChatHistoryEntry[] = []
    const chatsToLoad = chatDirInfos.slice(0, maxChats)

    for (const info of chatsToLoad) {
      try {
        let messageCount = 0
        let lastPrompt = '(empty chat)'

        if (fs.existsSync(info.messagesPath)) {
          // Prefer the sidecar summary: transcripts are unbounded, so parsing
          // every full chat-messages.json here can make /history slow.
          const meta = readChatMeta(info.chatPath)
          if (meta) {
            messageCount = meta.messageCount
            lastPrompt = meta.firstPrompt
          } else {
            // Pre-sidecar chats, or a sidecar that no longer matches the
            // messages file (rewritten by an older CLI, crash between the
            // two writes): parse the full file.
            const content = fs.readFileSync(info.messagesPath, 'utf8')
            const messages = JSON.parse(content) as ChatMessage[]
            if (!Array.isArray(messages)) {
              throw new Error('chat-messages.json is not an array')
            }
            messageCount = messages.length
            lastPrompt = getFirstUserPrompt(messages)
          }
        }

        // Skip empty chats (no messages)
        if (messageCount > 0) {
          chats.push({
            chatId: info.chatId,
            lastPrompt,
            title: readChatTitle(info.chatPath) ?? undefined,
            timestamp: info.mtime,
            messageCount,
          })
        }
      } catch (error) {
        logger.debug(
          {
            chatId: info.chatId,
            error: error instanceof Error ? error.message : String(error),
          },
          'Failed to read chat messages',
        )
        // Don't silently hide the chat: list it as unreadable so the user
        // knows it exists (and can delete it) instead of thinking it was lost
        chats.push({
          chatId: info.chatId,
          lastPrompt: '(unreadable chat)',
          timestamp: info.mtime,
          messageCount: 0,
          unreadable: true,
        })
      }
    }

    return chats
  } catch (error) {
    logger.error(
      { error: error instanceof Error ? error.message : String(error) },
      'Failed to list chats',
    )
    return []
  }
}

// Older CLI versions logged the full conversation (including attachments) to
// log.jsonl on every step, leaving multi-GB files in chat directories. Delete
// any log file over this cap; with summary-only logging, healthy logs stay
// far below it.
const MAX_LOG_FILE_BYTES = 10 * 1024 * 1024
// Only delete logs from chats untouched for this long, so debug logs for
// recent chats stay available.
const MIN_LOG_AGE_MS = 14 * 24 * 60 * 60 * 1000

/**
 * Delete oversized log.jsonl files from chat directories that haven't been
 * touched in 14+ days. Only debug logs are removed — chat history files are
 * untouched.
 */
export function trimOversizedChatLogs(dataDir?: string): void {
  let chatsDir: string
  let chatIds: string[]
  try {
    chatsDir = getChatsDir(dataDir)
    chatIds = fs.readdirSync(chatsDir)
  } catch {
    return // No project root set or no chats directory yet
  }

  const deleteBefore = Date.now() - MIN_LOG_AGE_MS
  for (const chatId of chatIds) {
    const logFile = path.join(chatsDir, chatId, CHAT_LOG_FILENAME)
    try {
      const stats = fs.statSync(logFile, { throwIfNoEntry: false })
      if (
        stats &&
        stats.size > MAX_LOG_FILE_BYTES &&
        stats.mtimeMs < deleteBefore
      ) {
        fs.unlinkSync(logFile)
      }
    } catch {
      // Ignore errors for individual files
    }
  }
}

/**
 * Delete a saved chat session from local history.
 */
export function deleteChatSession(chatId: string, dataDir?: string): boolean {
  try {
    const safeChatId = chatId.trim()
    if (
      !safeChatId ||
      safeChatId === '.' ||
      safeChatId === '..' ||
      path.basename(safeChatId) !== safeChatId
    ) {
      logger.warn({ chatId }, 'Refusing to delete invalid chat id')
      return false
    }

    const chatsDir = getChatsDir(dataDir)
    const chatPath = path.join(chatsDir, safeChatId)

    if (!fs.existsSync(chatPath)) {
      return false
    }

    const stat = fs.statSync(chatPath)
    if (!stat.isDirectory()) {
      logger.warn(
        { chatId, chatPath },
        'Refusing to delete non-directory chat path',
      )
      return false
    }

    fs.rmSync(chatPath, { recursive: true, force: false })
    return true
  } catch (error) {
    logger.error(
      { chatId, error: error instanceof Error ? error.message : String(error) },
      'Failed to delete chat session',
    )
    return false
  }
}

/**
 * Format a timestamp relative to now (e.g., "2 hours ago", "yesterday")
 */
export function formatRelativeTime(date: Date): string {
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffSecs = Math.floor(diffMs / 1000)
  const diffMins = Math.floor(diffSecs / 60)
  const diffHours = Math.floor(diffMins / 60)
  const diffDays = Math.floor(diffHours / 24)

  if (diffSecs < 60) {
    return 'just now'
  } else if (diffMins < 60) {
    return `${diffMins}m ago`
  } else if (diffHours < 24) {
    return `${diffHours}h ago`
  } else if (diffDays === 1) {
    return 'yesterday'
  } else if (diffDays < 7) {
    return `${diffDays}d ago`
  } else {
    return date.toLocaleDateString()
  }
}
