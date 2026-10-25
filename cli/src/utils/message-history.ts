import { randomUUID } from 'crypto'
import fs from 'fs'
import path from 'path'

import { getConfigDir } from './auth'
import { formatTimestamp } from './helpers'
import { logger } from './logger'

import type {
  ChatMessage,
  ContentBlock,
  FileAttachment,
  ImageAttachment,
  TextAttachment,
} from '../types/chat'

const MAX_HISTORY_SIZE = 1000

export function getUserMessage(
  message: string | ContentBlock[],
  attachments?: ImageAttachment[],
  textAttachments?: TextAttachment[],
  fileAttachments?: FileAttachment[],
): ChatMessage {
  return {
    id: `user-${Date.now()}`,
    variant: 'user',
    ...(typeof message === 'string'
      ? {
          content: message,
        }
      : {
          content: '',
          blocks: message,
        }),
    timestamp: formatTimestamp(),
    ...(attachments && attachments.length > 0 ? { attachments } : {}),
    ...(textAttachments && textAttachments.length > 0
      ? { textAttachments }
      : {}),
    ...(fileAttachments && fileAttachments.length > 0
      ? { fileAttachments }
      : {}),
  }
}

export function getSystemMessage(
  content: string | ContentBlock[],
): ChatMessage {
  return {
    id: `sys-${Date.now()}`,
    variant: 'ai' as const,
    ...(typeof content === 'string'
      ? {
          content,
        }
      : {
          content: '',
          blocks: content,
        }),
    timestamp: formatTimestamp(),
  }
}

/**
 * Get the message history file path
 */
export const getMessageHistoryPath = (): string => {
  return path.join(getConfigDir(), 'message-history.json')
}

/**
 * Load message history from file system
 * @returns Array of previous messages, most recent last
 */
export const loadMessageHistory = (): string[] => {
  const historyPath = getMessageHistoryPath()

  if (!fs.existsSync(historyPath)) {
    return []
  }

  try {
    const historyFile = fs.readFileSync(historyPath, 'utf8')
    const history = JSON.parse(historyFile)

    if (!Array.isArray(history)) {
      logger.warn('Message history file has invalid format, resetting')
      return []
    }

    return history.filter((item) => typeof item === 'string')
  } catch (error) {
    logger.error(
      {
        error: error instanceof Error ? error.message : String(error),
      },
      'Error reading message history',
    )
    return []
  }
}

/**
 * Save message history to file system
 */
export const saveMessageHistory = (
  history: string[],
  fileSystem: Pick<
    typeof fs,
    'existsSync' | 'mkdirSync' | 'writeFileSync' | 'renameSync' | 'rmSync'
  > = fs,
): void => {
  const configDir = getConfigDir()
  const historyPath = getMessageHistoryPath()
  const tempPath = `${historyPath}.${process.pid}.${randomUUID()}.tmp`

  try {
    // Ensure config directory exists
    if (!fileSystem.existsSync(configDir)) {
      fileSystem.mkdirSync(configDir, { recursive: true })
    }

    // Limit history size to prevent file from growing too large
    const limitedHistory =
      history.length > MAX_HISTORY_SIZE
        ? history.slice(history.length - MAX_HISTORY_SIZE)
        : history

    // Save history
    fileSystem.writeFileSync(
      tempPath,
      JSON.stringify(limitedHistory, null, 2),
      {
        flag: 'wx',
      },
    )
    fileSystem.renameSync(tempPath, historyPath)
  } catch (error) {
    try {
      fileSystem.rmSync(tempPath, { force: true })
    } catch {}
    logger.error(
      {
        error: error instanceof Error ? error.message : String(error),
      },
      'Error saving message history',
    )
    // Don't throw - history persistence is not critical
  }
}
