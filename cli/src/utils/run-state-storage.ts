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
  writeChatMeta,
} from './chat-meta'
import { logger } from './logger'
import { classifyStringifyError, serializeForPersistence } from './safe-json'
import { writeFileAtomic, writeFileAtomicAsync } from './write-file-atomic'

import type { ChatMessage } from '../types/chat'
import type { RunState } from '@codebuff/sdk'

const RUN_STATE_FILENAME = 'run-state.json'

type SavedChatState = {
  runState: RunState
  messages: ChatMessage[]
  chatId?: string
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
    fs.mkdirSync(chatDirOverride, { recursive: true, mode: 0o700 })
    return chatDirOverride
  }
  return getCurrentChatDir()
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

/** Cheap shape summary so a failure log says what the payload looked like.
 *  Tolerates a non-array `messages`: this runs only when the state is already
 *  suspect, and a diagnostic that throws on the shape it exists to describe
 *  just replaces the real failure with its own. */
function chatShapeSummary(runState: RunState, messages: ChatMessage[]) {
  const list = Array.isArray(messages) ? messages : []
  let blockCount = 0
  for (const message of list) {
    blockCount += message?.blocks?.length ?? 0
  }
  return {
    messageCount: Array.isArray(messages) ? messages.length : null,
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

/** The one character each file's JSON must start with. */
const CHAT_STATE_JSON_PREFIX = { runState: '{', messages: '[' } as const

/**
 * Refuse to persist anything that is not the document the file is supposed to
 * hold. `JSON.stringify` answers the four-byte string `null` for null, NaN and
 * a value whose toJSON returns nothing, and `undefined` for undefined — and
 * `'null'` is *truthy*, so it sailed through the `if (serialized.messagesJson)`
 * guard below and replaced a user's whole transcript with the literal text
 * `null`, with no crash involved. On the next load that parses to null and
 * reads as "no transcript". Writing nothing leaves the previous good file in
 * place, which is always the better of the two outcomes.
 */
// Returns a plain boolean, not a `json is string` predicate: the caller's
// `json` is already typed `string`, so a predicate narrows the negative branch
// to `never` and the defensive `typeof` checks in the refusal log stop
// compiling. The runtime check stays, because SerializeResult's `string` comes
// from JSON.stringify's lib type, which answers `undefined` for undefined.
function isPersistableJson(
  json: unknown,
  part: 'runState' | 'messages',
): boolean {
  return (
    typeof json === 'string' && json.startsWith(CHAT_STATE_JSON_PREFIX[part])
  )
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
      if (!isPersistableJson(json, part)) {
        // Rate-limited like every other save issue, but logged at error level:
        // this is a bug in whatever handed us the state, and until ticket #180
        // nothing reported it.
        if (shouldLogSaveIssue(`${chatDir}|nonpersistable|${part}`)) {
          bestEffortLog(
            'error',
            {
              part,
              // The first character and the length only. Anything more could
              // be the user's prompt text, and this is a diagnostic.
              jsonType: typeof json,
              jsonPrefix: typeof json === 'string' ? json.slice(0, 1) : null,
              jsonBytes: typeof json === 'string' ? json.length : null,
              ...chatShapeSummary(runState, messages),
            },
            'Refusing to persist non-document chat state (keeping the file on disk)',
          )
        }
        continue
      }
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
    fs.mkdirSync(chatDir, { recursive: true, mode: 0o700 })
    if (serialized.runStateJson) {
      writeFileAtomic(
        path.join(chatDir, RUN_STATE_FILENAME),
        serialized.runStateJson,
      )
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

type PersistedChatFile = {
  /** The parsed document, or null when there was nothing usable to restore. */
  value: unknown
  outcome: 'ok' | 'missing' | 'damaged' | 'unpreserved' | 'unreadable'
}

/**
 * Read one chat-state file, and set its bytes aside before anything can
 * replace them.
 *
 * Substituting an empty transcript for an unreadable one used to be a one-way
 * door: the load returned `messages: []`, the next turn's save wrote that empty
 * array straight back over the file, and a transcript that a human (or a later
 * fix) could still have read was gone. A partial write, a half-flushed file or
 * a shape we simply do not recognise are all recoverable by hand — but only
 * while the bytes exist. So quarantine first, exactly as
 * freebuff-desktop's session journal and state file do, and only then let the
 * caller carry on with a fallback.
 *
 * Quarantining happens on the read, not the write: the writer would have to
 * re-read and re-parse a multi-MB transcript on every 5s checkpoint to notice,
 * and the read is already the moment we know the file is unusable.
 *
 * A file that parses but is not the right kind of document counts as damaged.
 * Four bytes of `null` parse perfectly well into `null`, and that is the exact
 * artifact support ticket #180 reported — it must be preserved too, not nodded
 * through as "no messages".
 */
function readPersistedChatFile(
  filePath: string,
  part: 'runState' | 'messages',
): PersistedChatFile {
  let raw: string
  try {
    raw = fs.readFileSync(filePath, 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      return { value: null, outcome: 'missing' }
    }
    // EACCES, EISDIR, EIO: there may be perfectly good bytes behind this, and
    // we cannot even copy them. Do not touch the file.
    logger.warn({ filePath, part, code }, 'Could not open persisted chat state')
    return { value: null, outcome: 'unreadable' }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return quarantinePersistedChatFile(filePath, part, {
      reason: 'unparseable',
      bytes: raw.length,
      error: error instanceof Error ? error.message : String(error),
    })
  }

  const shapeOk =
    part === 'messages'
      ? Array.isArray(parsed)
      : !!parsed && typeof parsed === 'object' && !Array.isArray(parsed)
  if (!shapeOk) {
    return quarantinePersistedChatFile(filePath, part, {
      reason: 'wrong-shape',
      bytes: raw.length,
      parsedType: parsed === null ? 'null' : typeof parsed,
    })
  }

  return { value: parsed, outcome: 'ok' }
}

function quarantinePersistedChatFile(
  filePath: string,
  part: 'runState' | 'messages',
  detail: Record<string, unknown>,
): PersistedChatFile {
  const quarantine = `${filePath}.corrupt-${randomUUID()}`
  try {
    fs.renameSync(filePath, quarantine)
  } catch (error) {
    logger.error(
      {
        filePath,
        part,
        ...detail,
        error: error instanceof Error ? error.message : String(error),
      },
      'Damaged chat state could not be set aside; leaving it untouched',
    )
    return { value: null, outcome: 'unpreserved' }
  }
  // Kept, not deleted: the user's transcript is in there, and a later fix or a
  // support request can still get it back.
  logger.warn(
    { filePath, part, quarantine, ...detail },
    'Damaged chat state moved aside; restoring what is left',
  )
  return { value: null, outcome: 'damaged' }
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
    const loadedRunState = readPersistedChatFile(runStatePath, 'runState')
    const loadedMessages = readPersistedChatFile(messagesPath, 'messages')

    // Either file holds bytes we could neither read nor move aside. We must
    // not hand back a state whose next save would land on top of them: a
    // rename replaces a file the process cannot read, so "unreadable" is not
    // "unwritable". Refusing the whole chat sends the session to a fresh chat
    // directory, which leaves this one exactly as the user found it.
    const unsafe = (outcome: PersistedChatFile['outcome']) =>
      outcome === 'unpreserved' || outcome === 'unreadable'
    if (unsafe(loadedRunState.outcome) || unsafe(loadedMessages.outcome)) {
      logger.error(
        {
          runStatePath,
          messagesPath,
          runStateOutcome: loadedRunState.outcome,
          messagesOutcome: loadedMessages.outcome,
        },
        'Refusing to resume a chat whose state could not be read or set aside',
      )
      return null
    }

    let runState: RunState | null = loadedRunState.value as RunState | null
    let messages: ChatMessage[] | null = loadedMessages.value as
      | ChatMessage[]
      | null

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

    return { runState, messages, chatId: resolvedChatId }
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
