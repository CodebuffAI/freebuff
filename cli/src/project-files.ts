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
 * The most recently saved chat, for `--continue` without an id. Ranked by the
 * saved chat files, not the directory: each launch's logger creates its own
 * chat directory before the resume runs, and that empty one was always newest.
 */
export function getMostRecentChatDir(): string | null {
  try {
    const chatsDir = path.join(getProjectDataDir(), 'chats')
    let best: { dir: string; savedAt: number } | null = null
    for (const entry of readdirSync(chatsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const dir = path.join(chatsDir, entry.name)
      const savedAt = Math.max(
        ...['run-state.json', 'chat-messages.json'].map(
          (file) =>
            statSync(path.join(dir, file), { throwIfNoEntry: false })
              ?.mtimeMs ?? 0,
        ),
      )
      if (savedAt > (best?.savedAt ?? 0)) best = { dir, savedAt }
    }
    return best?.dir ?? null
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
