import * as fs from 'fs'
import path from 'path'

import {
  sanitizeThreadTitle,
  THREAD_TITLE_INPUT_MAX_CHARS,
} from '@codebuff/common/util/thread-title'
import { WEBSITE_URL } from '@codebuff/sdk'

import { getAuthToken } from './auth'
import { logger } from './logger'
import { writeFileAtomic } from './write-file-atomic'

/** Written once beside chat-messages.json when the title arrives. */
export const CHAT_TITLE_FILENAME = 'chat-title.txt'

/** A title that arrives after this has lost its race with the user reading
 *  the footer; the prompt stays. */
const TITLE_TIMEOUT_MS = 25_000

export function readChatTitle(chatDir: string): string | null {
  try {
    return sanitizeThreadTitle(
      fs.readFileSync(path.join(chatDir, CHAT_TITLE_FILENAME), 'utf8'),
    )
  } catch {
    return null
  }
}

/**
 * Titles a chat from its first message with the free endpoint Desktop uses
 * (one short completion under the Freebuff service account, so a zero balance
 * still gets a title) and saves it in `chatDir`. Any failure (offline, signed
 * out, rate limited) returns null and the chat keeps its prompt as its name.
 */
export async function titleChat(params: {
  chatDir: string
  prompt: string
}): Promise<string | null> {
  const { chatDir, prompt } = params
  const authToken = getAuthToken()
  if (!authToken || !prompt.trim()) return null
  try {
    const res = await fetch(`${WEBSITE_URL}/api/v1/freebuff/title`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({
        prompt: prompt.slice(0, THREAD_TITLE_INPUT_MAX_CHARS),
        surface: 'cli',
      }),
      signal: AbortSignal.timeout(TITLE_TIMEOUT_MS),
    })
    if (!res.ok) return null
    const data = (await res.json()) as { title?: unknown }
    const title =
      typeof data.title === 'string' ? sanitizeThreadTitle(data.title) : null
    if (title) writeFileAtomic(path.join(chatDir, CHAT_TITLE_FILENAME), title)
    return title
  } catch (error) {
    logger.debug(
      { error: error instanceof Error ? error.message : String(error) },
      'Chat title failed',
    )
    return null
  }
}
