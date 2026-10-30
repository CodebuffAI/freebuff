import { mkdirSync, readdirSync, statSync } from 'fs'
import path from 'path'

import { getConfigDir } from './utils/auth'
import { IS_FREEBUFF } from './utils/constants'
import { ensureSponsoredProjectIdentity } from './utils/sponsored-project-identity'

let projectRoot: string | undefined
let currentChatId: string | undefined

function ensureChatDirectory(dir: string) {
  // Owner-only: chat directories hold transcripts and run state.
  mkdirSync(dir, { recursive: true, mode: 0o700 })
}

export function setProjectRoot(dir: string) {
  projectRoot = dir
  // Project selection is the normal lifecycle owner for the workspace
  // identity. Sponsored polling only ever reads this marker. Freebuff writes
  // it in every Git project, because an in-place sponsored offer is keyed to
  // the folder rather than to `owner/repo` (#3989).
  ensureSponsoredProjectIdentity(dir, { everyRepository: IS_FREEBUFF })
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

    // Single pass with dirents: the previous shape statted every entry twice
    // (once for the mtime, again inside the filter's type guard to test
    // isDirectory), which doubled the syscall count of this scan on the
    // --continue resume path. The dirent answers isDirectory() from the
    // directory record itself, so each entry is now statted exactly once, for
    // the mtime; a failed stat skips the entry, same as before. (The missing
    // chats dir falls into the catch and returns null, as it did via the
    // throwIfNoEntry probe.)
    const chatDirs = readdirSync(chatsDir, { withFileTypes: true })
      .map((entry) => {
        if (!entry.isDirectory()) {
          return null
        }
        try {
          const fullPath = path.join(chatsDir, entry.name)
          return { name: entry.name, fullPath, mtime: statSync(fullPath).mtime }
        } catch {
          return null
        }
      })
      .filter(
        (item): item is { name: string; fullPath: string; mtime: Date } =>
          item !== null,
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
