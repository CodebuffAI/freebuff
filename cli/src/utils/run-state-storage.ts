import * as fs from 'fs'
import path from 'path'
import { randomUUID } from 'node:crypto'

import {
  getCurrentChatDir,
  getMostRecentChatDir,
  getProjectDataDir,
} from '../project-files'
import {
  CHAT_MESSAGES_FILENAME,
  CHAT_META_FILENAME,
  writeChatMeta,
} from './chat-meta'
import { logger } from './logger'
import { classifyStringifyError, serializeForPersistence } from './safe-json'
import { writeFileAtomic, writeFileAtomicAsync } from './write-file-atomic'

import type { ChatMessage, ContentBlock } from '../types/chat'
import type { RunState } from '@codebuff/sdk'

const RUN_STATE_FILENAME = 'run-state.json'

type SavedChatState = {
  runState: RunState
  messages: ChatMessage[]
  chatId?: string
  /** False only when run-state.json was unreadable AND nothing could be
   *  recovered from the backup or checkpoint temps, so the restored RunState
   *  is a placeholder without agent context — the model starts amnesiac next
   *  turn. The UI surfaces this so the loss is not silent. */
  runStateRestored: boolean
}

type LiveChatState = {
  runState: RunState
  messages: ChatMessage[]
}

let liveChatStateProvider: {
  ownerId: string
  chatDir: string
  provide: () => LiveChatState | null
} | null = null

/**
 * Register a provider for the in-flight chat state. While a run is active,
 * exit paths call flushLiveChatState() to persist the latest checkpoint so a
 * quit/crash doesn't lose the turn. ownerId ties the provider to a specific
 * run so a stale run can't clear a newer run's provider. The chat directory
 * is captured at registration time so a later chat switch can't redirect the
 * flush into a different chat's directory.
 */
export function setLiveChatStateProvider(
  ownerId: string,
  provide: () => LiveChatState | null,
): void {
  liveChatStateProvider = { ownerId, chatDir: resolveCurrentChatDir(), provide }
}

export function clearLiveChatStateProvider(ownerId: string): void {
  if (liveChatStateProvider?.ownerId === ownerId) {
    liveChatStateProvider = null
  }
}

/**
 * Synchronously persist the in-flight chat state, if any. Safe to call from
 * process exit/signal handlers (saveChatState uses writeFileSync).
 */
export function flushLiveChatState(): void {
  try {
    // The process is exiting, so the async drain will never get to run:
    // write any queued checkpoints synchronously first. Each is bound to the
    // chat dir captured when it was scheduled. The live provider below may
    // overwrite one of these with strictly newer state — that order is
    // intentional.
    for (const [chatDir, state] of pendingCheckpoints) {
      saveChatState(state.runState, state.messages, chatDir)
    }
    pendingCheckpoints.clear()

    const provider = liveChatStateProvider
    if (!provider) {
      return
    }
    // The provider reads live store state. Once the user has switched to a
    // different chat (/new, resuming from /history), that state no longer
    // matches the provider's chat directory — flushing would overwrite the
    // run's chat with another conversation's messages. Skip instead; the
    // run's last checkpoint was flushed from the queue above.
    if (provider.chatDir !== resolveCurrentChatDir()) {
      return
    }
    const state = provider.provide()
    if (state) {
      saveChatState(state.runState, state.messages, provider.chatDir)
    }
  } catch {
    // Best-effort - never block process exit.
  }
}

/**
 * Recursively extract all agent IDs and tool call IDs from content blocks
 */
function extractToggleIds(blocks: ContentBlock[] | undefined): string[] {
  if (!blocks) return []

  const ids: string[] = []

  for (const block of blocks) {
    if (block.type === 'agent') {
      ids.push(block.agentId)
      // Recursively extract from nested blocks
      ids.push(...extractToggleIds(block.blocks))
    } else if (block.type === 'tool') {
      ids.push(block.toolCallId)
    }
  }

  return ids
}

/**
 * Get all toggle IDs (agent IDs and tool call IDs) from chat messages
 */
export function getAllToggleIdsFromMessages(messages: ChatMessage[]): string[] {
  const ids: string[] = []

  for (const message of messages) {
    ids.push(...extractToggleIds(message.blocks))
  }

  return ids
}

// Test-only escape hatch: persistence normally resolves the chat directory
// through project-files (under the user's real config dir). Tests point it at
// a temp directory instead of mocking module internals — mock.module leaks
// across bun test files and os.homedir() ignores $HOME on macOS, so both of
// those seams are unreliable (see docs/testing.md: DI over module mocking).
let chatDirOverride: string | undefined

export function setChatDirOverrideForTesting(dir: string | undefined): void {
  chatDirOverride = dir
}

/**
 * Resolve the directory of the currently active chat. Persistence callers
 * must capture this at the moment the state is captured (run start, snapshot
 * time) and pass it through to the save — resolving it again at write time
 * races with chat switches (/new, resuming from /history) and would write one
 * chat's transcript into another chat's directory.
 */
export function resolveCurrentChatDir(): string {
  if (chatDirOverride) {
    fs.mkdirSync(chatDirOverride, { recursive: true })
    return chatDirOverride
  }
  return getCurrentChatDir()
}

/**
 * Get the path to the run state file for the current chat
 */
export function getRunStatePath(): string {
  const chatDir = resolveCurrentChatDir()
  return path.join(chatDir, RUN_STATE_FILENAME)
}

/**
 * Get the path to the chat messages file for the current chat
 */
export function getChatMessagesPath(): string {
  const chatDir = resolveCurrentChatDir()
  return path.join(chatDir, CHAT_MESSAGES_FILENAME)
}

// Chat-state saves fail in prod for reasons that are chronic, not transient:
// a transcript with a cyclic or over-string-limit payload fails identically on
// every 5s checkpoint, and a full disk stays full. Logging each attempt at
// error level made this a top-3 error by volume (~19k/day). Instead, each
// distinct issue per chat dir is logged at most once per interval, and
// environment/payload failures log as warnings — only genuinely unexpected
// errors keep the error level.
const SAVE_LOG_INTERVAL_MS = 5 * 60 * 1000
const saveIssueLastLoggedAt = new Map<string, number>()

function shouldLogSaveIssue(key: string): boolean {
  const now = Date.now()
  const last = saveIssueLastLoggedAt.get(key)
  if (last !== undefined && now - last < SAVE_LOG_INTERVAL_MS) {
    return false
  }
  saveIssueLastLoggedAt.set(key, now)
  return true
}

/**
 * Logging must never break persistence: these paths run inside checkpoint
 * drains and exit flushes, where a throwing logger (e.g. analytics transport
 * not initialized) would otherwise lose the save or reject the drain.
 */
function bestEffortLog(
  level: 'warn' | 'error',
  payload: Record<string, unknown>,
  message: string,
): void {
  try {
    logger[level](payload, message)
  } catch {
    // Best-effort only.
  }
}

type SaveErrorClass = 'cyclic' | 'oom' | 'disk' | 'other'

function classifySaveError(error: unknown): SaveErrorClass {
  const fromStringify = classifyStringifyError(error)
  if (fromStringify) return fromStringify
  const msg = error instanceof Error ? error.message : String(error)
  // Environmental filesystem failures: retrying won't help and there is
  // nothing to fix server-side (full disk, AV holding a rename lock, etc.).
  if (/ENOSPC|EDQUOT|EROFS|EPERM|EACCES|EBUSY|EMFILE|ENFILE/.test(msg)) {
    return 'disk'
  }
  return 'other'
}

/** Cheap shape summary so a failure log says what the payload looked like. */
function chatShapeSummary(runState: RunState, messages: ChatMessage[]) {
  let blockCount = 0
  for (const message of messages) {
    blockCount += message.blocks?.length ?? 0
  }
  return {
    messageCount: messages.length,
    blockCount,
    runStateKeys:
      runState && typeof runState === 'object'
        ? Object.keys(runState as object).slice(0, 20)
        : [],
  }
}

type SerializedChatState = {
  runStateJson?: string
  messagesJson?: string
}

/** The previous generation of run-state.json, rotated aside by saveChatState.
 *  loadMostRecentChatState recovers from it when the primary is torn. */
const RUN_STATE_BACKUP_SUFFIX = '.bak'

function tryReadRunState(filePath: string): RunState | undefined {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as RunState
  } catch {
    return undefined
  }
}

/**
 * Read run-state.json with best-effort recovery when it is torn.
 *
 * The atomic write makes the rename indivisible, but without an fsync a power
 * loss can still land the rename while the file's data blocks were never
 * written — leaving a truncated or empty primary (and even with the fsync,
 * external corruption exists). Two older complete generations can be lying in
 * the chat directory when that happens:
 *
 *  - `run-state.json.bak` — the state the primary replaced at the last
 *    synchronous save (saveChatState rotates the previous file aside).
 *  - `run-state.json.<pid>.<uuid>.tmp` — a write that was killed in the
 *    window between its write and its rename (writeFileAtomic unlinks its own
 *    temp on error, but a SIGKILL cannot).
 *
 * Try the primary, then every fallback candidate — the .bak and each leftover
 * checkpoint .tmp — ordered newest-first by mtime (path comparison breaks
 * ties on coarse-mtime filesystems), and self-heal the primary from whichever
 * recovered. `fromPrimary` is false when
 * recovery had to fall back, so the caller can warn that some agent context
 * is missing instead of losing it silently.
 */
function readRunStateWithRecovery(chatDir: string): {
  runState: RunState
  fromPrimary: boolean
} | null {
  const runStatePath = path.join(chatDir, RUN_STATE_FILENAME)
  let primaryError: unknown
  try {
    return {
      runState: JSON.parse(fs.readFileSync(runStatePath, 'utf8')) as RunState,
      fromPrimary: true,
    }
  } catch (error) {
    primaryError = error
  }

  // Candidates in recency order, newest first. Each .tmp is a complete write
  // that never got renamed; the .bak is the previous completed generation.
  // mtimeMs alone can be coarse (FAT, some CI filesystems quantize it), so
  // ties fall back to path comparison, and the recency probe is best-effort —
  // an unreadable candidate is skipped by the loop below, not fatal.
  const bakPath = runStatePath + RUN_STATE_BACKUP_SUFFIX
  const candidates = [bakPath]
  try {
    candidates.push(
      ...fs
        .readdirSync(chatDir)
        .filter(
          (file) =>
            file.startsWith(RUN_STATE_FILENAME + '.') && file.endsWith('.tmp'),
        )
        .map((file) => path.join(chatDir, file)),
    )
  } catch {
    // Directory vanished mid-load; the loop below just finds nothing extra.
  }
  const candidatesWithMtime = candidates.map((filePath) => {
    let mtimeMs = 0
    try {
      mtimeMs = fs.statSync(filePath).mtimeMs
    } catch {
      // Candidate vanished between readdir and stat: try it last.
    }
    return { filePath, mtimeMs }
  })
  candidatesWithMtime.sort(
    (a, b) => b.mtimeMs - a.mtimeMs || b.filePath.localeCompare(a.filePath),
  )
  for (const { filePath: candidatePath } of candidatesWithMtime) {
    const recovered = tryReadRunState(candidatePath)
    if (recovered !== undefined) {
      bestEffortLog(
        'warn',
        { runStatePath, recoveredFrom: candidatePath },
        'run-state.json was unreadable; restored agent context from a backup generation',
      )
      // Self-heal: make the recovered generation the primary again.
      try {
        writeFileAtomic(runStatePath, JSON.stringify(recovered))
      } catch {
        // Best-effort; the candidate file still exists for the next load.
      }
      return { runState: recovered, fromPrimary: false }
    }
  }

  bestEffortLog(
    'warn',
    {
      runStatePath,
      primaryError:
        primaryError instanceof Error
          ? primaryError.message
          : String(primaryError),
      candidatesTried: candidatesWithMtime.length,
    },
    'Could not read run state; restoring transcript without agent context',
  )
  return null
}

/**
 * Serialize the two chat-state files independently, so a poisoned run state
 * cannot block persisting the transcript (and vice versa). Cyclic and
 * over-limit payloads are rescued by serializeForPersistence's fallback pass;
 * the fallback diagnostics (cycle paths, truncation counts) are logged so the
 * source of a bad payload can be found from prod logs.
 */
function serializeChatState(
  runState: RunState,
  messages: ChatMessage[],
  chatDir: string,
): SerializedChatState {
  const result: SerializedChatState = {}
  for (const part of ['runState', 'messages'] as const) {
    const value = part === 'runState' ? runState : messages
    try {
      const { json, fallback } = serializeForPersistence(value)
      if (part === 'runState') {
        result.runStateJson = json
      } else {
        result.messagesJson = json
      }
      if (fallback && shouldLogSaveIssue(`${chatDir}|fallback|${part}`)) {
        bestEffortLog(
          'warn',
          {
            part,
            reason: fallback.reason,
            cyclePaths: fallback.cyclePaths,
            truncatedStrings: fallback.truncatedStrings,
            jsonBytes: json.length,
            ...chatShapeSummary(runState, messages),
          },
          'Chat state serialized via fallback (broke cycles or truncated oversized strings)',
        )
      }
    } catch (error) {
      const errorClass = classifySaveError(error)
      if (shouldLogSaveIssue(`${chatDir}|serialize|${part}|${errorClass}`)) {
        bestEffortLog(
          errorClass === 'other' ? 'error' : 'warn',
          {
            part,
            errorClass,
            error: error instanceof Error ? error.message : String(error),
            ...chatShapeSummary(runState, messages),
          },
          'Failed to serialize chat state',
        )
      }
    }
  }
  return result
}

function logSaveWriteFailure(
  error: unknown,
  chatDir: string,
  message: string,
): void {
  const errorClass = classifySaveError(error)
  if (!shouldLogSaveIssue(`${chatDir}|write|${errorClass}`)) {
    return
  }
  bestEffortLog(
    errorClass === 'other' ? 'error' : 'warn',
    {
      errorClass,
      error: error instanceof Error ? error.message : String(error),
    },
    message,
  )
}

/**
 * Save both the RunState and ChatMessage[] to disk.
 *
 * `chatDir` should be captured when the state itself is captured (e.g. at run
 * start) and passed through. Defaulting to the current chat dir is only safe
 * when the caller knows no chat switch can have happened in between.
 */
export function saveChatState(
  runState: RunState,
  messages: ChatMessage[],
  chatDir: string = resolveCurrentChatDir(),
): void {
  // Compact JSON: these files are rewritten on every checkpoint and grow to
  // multiple MB; pretty-printing roughly doubles the write.
  const serialized = serializeChatState(runState, messages, chatDir)
  if (!serialized.runStateJson && !serialized.messagesJson) {
    return
  }
  try {
    // The dir existed when the save was captured, but may have been removed
    // since (e.g. the chat deleted from /history mid-run).
    fs.mkdirSync(chatDir, { recursive: true })
    if (serialized.runStateJson) {
      const runStatePath = path.join(chatDir, RUN_STATE_FILENAME)
      // Rotate the previous generation aside before overwriting: it is the
      // newest complete state readRunStateWithRecovery can fall back to if
      // this write's rename lands but its data is later found torn.
      try {
        if (fs.existsSync(runStatePath)) {
          fs.renameSync(runStatePath, runStatePath + RUN_STATE_BACKUP_SUFFIX)
        }
      } catch {
        // Rotation is best-effort; the overwrite below still proceeds.
      }
      writeFileAtomic(runStatePath, serialized.runStateJson)
    }
    if (serialized.messagesJson) {
      writeFileAtomic(
        path.join(chatDir, CHAT_MESSAGES_FILENAME),
        serialized.messagesJson,
      )
      // Sidecar summary so /history can list this chat without parsing the
      // (unbounded) chat-messages.json. Must be written after the messages
      // file: it records the file's size/mtime to detect staleness.
      writeChatMeta(chatDir, messages)
    }
  } catch (error) {
    logSaveWriteFailure(error, chatDir, 'Failed to save chat state')
  }
}

/**
 * Async counterpart to saveChatState. Serializes and writes off the caller's
 * tick so a multi-MB transcript doesn't block the CLI's render/input thread.
 */
async function saveChatStateAsync(
  runState: RunState,
  messages: ChatMessage[],
  chatDir: string,
): Promise<void> {
  const serialized = serializeChatState(runState, messages, chatDir)
  if (!serialized.runStateJson && !serialized.messagesJson) {
    return
  }
  try {
    await fs.promises.mkdir(chatDir, { recursive: true })
    if (serialized.runStateJson) {
      await writeFileAtomicAsync(
        path.join(chatDir, RUN_STATE_FILENAME),
        serialized.runStateJson,
      )
    }
    if (serialized.messagesJson) {
      await writeFileAtomicAsync(
        path.join(chatDir, CHAT_MESSAGES_FILENAME),
        serialized.messagesJson,
      )
      // Sidecar summary so /history can list this chat without parsing the
      // (unbounded) chat-messages.json. Written after the messages file: it
      // records that file's size/mtime to detect staleness. The meta write is
      // tiny, so keeping it synchronous here is fine.
      writeChatMeta(chatDir, messages)
    }
  } catch (error) {
    logSaveWriteFailure(error, chatDir, 'Failed to save chat state (async)')
  }
}

// In-flight checkpoint writer. The SDK emits an onStateSnapshot roughly every
// 5s at step boundaries while a run streams; the CLI used to persist each one
// synchronously (cloneDeep in the SDK + two multi-MB JSON.stringify + two
// blocking disk writes on the CLI), all on the render/input thread. In long
// sessions that periodic stall is what users experience as "freezes". Instead,
// schedule the write asynchronously and collapse bursts to a single in-flight
// write, always persisting the latest state.
// Coalesced per chat directory: a burst of checkpoints for the same chat
// collapses to the latest, but a checkpoint for one chat can never displace a
// still-queued checkpoint for another (e.g. the final flush of a chat the
// user just switched away from).
const pendingCheckpoints = new Map<string, LiveChatState>()
let checkpointDrain: Promise<void> | null = null

async function drainCheckpoints(): Promise<void> {
  while (pendingCheckpoints.size > 0) {
    // Yield first so serialization never runs on the same tick that scheduled
    // us (that tick is often mid-render or handling a keystroke). Entries stay
    // in the map while we yield, so the synchronous exit flush can still write
    // them if the process quits before we resume.
    await new Promise<void>((resolve) => setImmediate(resolve))
    const entry = pendingCheckpoints.entries().next()
    if (entry.done) {
      break
    }
    const [chatDir, state] = entry.value
    pendingCheckpoints.delete(chatDir)
    // Write to the chat dir captured at schedule time: the current chat may
    // have rotated (/new, /history resume) while this write sat in the queue,
    // and resolving the dir here would dump this state into the wrong chat.
    await saveChatStateAsync(state.runState, state.messages, chatDir)
  }
}

/**
 * Schedule an asynchronous, coalescing checkpoint save. Safe to call at a high
 * rate: only one write runs at a time and intermediate states are dropped in
 * favor of the latest (per chat). Use this for periodic in-flight checkpoints;
 * use the synchronous saveChatState for one-shot authoritative saves (turn
 * completion, exit flush).
 */
export function scheduleCheckpointSave(
  runState: RunState,
  messages: ChatMessage[],
  chatDir: string = resolveCurrentChatDir(),
): void {
  pendingCheckpoints.set(chatDir, { runState, messages })
  if (!checkpointDrain) {
    checkpointDrain = drainCheckpoints().finally(() => {
      checkpointDrain = null
    })
  }
}

/**
 * Wait until all queued/in-flight checkpoint writes have flushed. Call this
 * before an authoritative synchronous save (turn completion / error) so that a
 * still-running async write can't land after — and clobber — the final state.
 * Relies on the run having stopped scheduling checkpoints (the SDK's snapshot
 * timer stops once the run settles), so the queue reaches idle.
 */
export async function settleCheckpointSave(): Promise<void> {
  await checkpointDrain
}

/**
 * Load both RunState and ChatMessage[] from a specific chat directory or the most recent one.
 * When chatId is provided, it is used to locate the chat directory; otherwise the most
 * recently modified chat directory is used.
 * Returns null if no previous chat exists or files can't be parsed.
 */
export function loadMostRecentChatState(
  chatId?: string,
): SavedChatState | null {
  try {
    let chatDir: string | null = chatDirOverride ?? null

    if (!chatDir && chatId && chatId.trim().length > 0) {
      const baseDir = path.join(getProjectDataDir(), 'chats')
      const candidateDir = path.join(baseDir, chatId.trim())
      if (
        fs.existsSync(candidateDir) &&
        fs.statSync(candidateDir).isDirectory()
      ) {
        chatDir = candidateDir
      } else {
        logger.debug(
          { candidateDir, chatId },
          'Requested chatId directory not found, falling back to most recent chat directory',
        )
      }
    }

    if (!chatDir) {
      chatDir = getMostRecentChatDir()
    }

    if (!chatDir) {
      logger.debug('No previous chat directory found')
      return null
    }

    const runStatePath = path.join(chatDir, RUN_STATE_FILENAME)
    const messagesPath = path.join(chatDir, CHAT_MESSAGES_FILENAME)

    // Parse the two files independently: a missing or torn run-state.json
    // must not lose the transcript, and vice versa. Restore whatever is
    // readable and fall back for the rest.
    let runState: RunState | null = null
    let runStateRestored = false
    const recovered = readRunStateWithRecovery(chatDir)
    if (recovered) {
      // Agent context is present — whether straight from the primary or
      // recovered from a backup/temp (both carry a real sessionState).
      runState = recovered.runState
      runStateRestored = true
    } else {
      logger.warn(
        { runStatePath },
        'Could not read run state; restoring transcript without agent context',
      )
    }

    let messages: ChatMessage[] | null = null
    try {
      messages = JSON.parse(
        fs.readFileSync(messagesPath, 'utf8'),
      ) as ChatMessage[]
    } catch (error) {
      logger.warn(
        {
          messagesPath,
          error: error instanceof Error ? error.message : String(error),
        },
        'Could not read chat messages; restoring agent context without transcript',
      )
    }

    if (!runState && !messages) {
      logger.debug(
        { runStatePath, messagesPath },
        'No readable state files in chat directory',
      )
      return null
    }

    runState ??= {
      output: {
        type: 'error',
        message: 'Previous run state could not be restored.',
      },
    } as RunState
    runState.traceSessionId ??= randomUUID()
    messages ??= []

    const resolvedChatId = path.basename(chatDir)

    logger.info(
      {
        runStatePath,
        messagesPath,
        messageCount: messages.length,
        chatId: resolvedChatId,
      },
      'Loaded chat state from chat directory',
    )

    return {
      runState,
      messages,
      chatId: resolvedChatId,
      runStateRestored,
    }
  } catch (error) {
    logger.error(
      {
        error: error instanceof Error ? error.message : String(error),
      },
      'Failed to load chat state',
    )
    return null
  }
}

/**
 * Clear the saved state files
 */
export function clearChatState(): void {
  try {
    const runStatePath = getRunStatePath()
    const messagesPath = getChatMessagesPath()
    const metaPath = path.join(resolveCurrentChatDir(), CHAT_META_FILENAME)
    const backupPath = runStatePath + RUN_STATE_BACKUP_SUFFIX

    for (const filePath of [runStatePath, backupPath, messagesPath, metaPath]) {
      fs.rmSync(filePath, { force: true })
    }

    logger.debug(
      { runStatePath, backupPath, messagesPath, metaPath },
      'Cleared chat state files',
    )
  } catch (error) {
    logger.error(
      {
        error: error instanceof Error ? error.message : String(error),
      },
      'Failed to clear chat state',
    )
  }
}
