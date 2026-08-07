import { mkdirSync, readdirSync, statSync } from 'fs'
import path from 'path'

import { getConfigDir } from './utils/config-dir'

let projectRoot: string | undefined
let currentChatId: string | undefined

function ensureChatDirectory(dir: string) {
  mkdirSync(dir, { recursive: true })
}

export function setProjectRoot(dir: string) {
  projectRoot = dir
  return projectRoot
}

export function getProjectRoot() {
  if (!projectRoot) {
    throw new Error('Project root not set')
  }
  return projectRoot
}

export function tryGetProjectRoot() {
  return projectRoot
}

export function getCurrentChatId() {
  if (!currentChatId) {
    currentChatId = new Date().toISOString().replace(/:/g, '-')
  }
  return currentChatId
}

export function setCurrentChatId(chatId: string) {
  currentChatId = chatId
  return currentChatId
}

export function startNewChat() {
  currentChatId = new Date().toISOString().replace(/:/g, '-')
  return currentChatId
}

// Get the project-specific data directory
export function getProjectDataDir(): string {
  const root = getProjectRoot()
  if (!root) {
    throw new Error('Project root not set')
  }

  const baseName = path.basename(root)
  const baseDir = path.join(getConfigDir(), 'projects', baseName)

  return baseDir
}

/**
 * Find the most recent chat directory based on modification time
 * Returns null if no chat directories exist
 */
export function getMostRecentChatDir(): string | null {
  try {
    const chatsDir = path.join(getProjectDataDir(), 'chats')
    if (!statSync(chatsDir, { throwIfNoEntry: false })) {
      return null
    }

    const chatDirs = readdirSync(chatsDir)
      .map((name) => {
        const fullPath = path.join(chatsDir, name)
        try {
          const stat = statSync(fullPath)
          return { name, fullPath, mtime: stat.mtime }
        } catch {
          return null
        }
      })
      .filter(
        (item): item is { name: string; fullPath: string; mtime: Date } =>
          item !== null && statSync(item.fullPath).isDirectory(),
      )

    if (chatDirs.length === 0) {
      return null
    }

    // Sort by modification time, most recent first
    chatDirs.sort((a, b) => b.mtime.getTime() - a.mtime.getTime())
    return chatDirs[0].fullPath
  } catch {
    return null
  }
}

export function getCurrentChatDir(): string {
  const chatId = getCurrentChatId()
  const dir = path.join(getProjectDataDir(), 'chats', chatId)
  ensureChatDirectory(dir)
  return dir
}
