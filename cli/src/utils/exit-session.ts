import * as fs from 'fs'
import path from 'path'

import {
  CHAT_MESSAGES_FILENAME,
  EMPTY_CHAT_PROMPT,
  readChatMeta,
} from './chat-meta'

/** `[]` — what chat-messages.json holds once a chat has been saved empty. */
const EMPTY_TRANSCRIPT_BYTES = 2

/**
 * The conversation an exit may offer to come back to, and the label to print
 * beside it, or null when a resume would restore nothing.
 */
export type ExitSession = {
  chatId: string
  sessionLabel?: string | undefined
}

/**
 * Decide whether this chat is worth a resume hint.
 *
 * The id alone is never a reason to print anything: `getCurrentChatId()` mints
 * one on first read, so it exists even for a session the user opened and left
 * without typing a prompt. What a resume actually replays is the transcript,
 * so that is what this asks about — through the sidecar when there is one,
 * and through the transcript's own size when there is not.
 *
 * The chat directory arrives as an argument rather than being resolved here, so
 * the decision stays a function of the filesystem and can be tested without a
 * project root or a config dir.
 */
export function sessionForExit({
  chatId,
  chatDir,
}: {
  chatId: string
  chatDir: string
}): ExitSession | null {
  if (!chatId) return null

  const meta = readChatMeta(chatDir)
  if (!meta) {
    // No usable sidecar: fall back to the transcript itself, and stay silent
    // when a resume would restore nothing. The check is on size because the
    // transcript is unbounded and this runs while the process tears down; any
    // document holding a turn is longer than the empty array, so nothing above
    // those two bytes needs parsing to be counted.
    try {
      const { size } = fs.statSync(path.join(chatDir, CHAT_MESSAGES_FILENAME))
      return size > EMPTY_TRANSCRIPT_BYTES ? { chatId } : null
    } catch {
      return null
    }
  }

  if (meta.firstPrompt === EMPTY_CHAT_PROMPT) return null
  return { chatId, sessionLabel: meta.firstPrompt }
}
