import { getErrorObject } from '@codebuff/common/util/error'
import { cloneDeep, isEqual } from 'lodash'

import type {
  CodebuffToolMessage,
  CodebuffToolOutput,
} from '@codebuff/common/tools/list'
import type { Logger } from '@codebuff/common/types/contracts/logger'
import type {
  Message,
  ToolMessage,
} from '@codebuff/common/types/messages/codebuff-message'

export function simplifyReadFileResults(
  messageContent: CodebuffToolOutput<'read_files'>,
): CodebuffToolOutput<'read_files'> {
  return [
    {
      type: 'json',
      value: cloneDeep(messageContent[0]).value.map(({ path }) => {
        return {
          path,
          contentOmittedForLength: true,
        }
      }),
    },
  ]
}

export function simplifyTerminalCommandResults(params: {
  messageContent: CodebuffToolOutput<'run_terminal_command'>
  logger: Logger
}): CodebuffToolOutput<'run_terminal_command'> {
  const { messageContent, logger } = params
  try {
    const clone = cloneDeep(messageContent)
    const content = clone[0].value
    if ('processId' in content || 'errorMessage' in content) {
      return clone
    }
    const { command, message, exitCode } = content
    return [
      {
        type: 'json',
        value: {
          command,
          ...(message && { message }),
          stdoutOmittedForLength: true,
          ...(exitCode !== undefined && { exitCode }),
        },
      },
    ]
  } catch (error) {
    logger.error(
      { error: getErrorObject(error), messageContent },
      'Error simplifying terminal command results',
    )
    return [
      {
        type: 'json',
        value: {
          command: '',
          stdoutOmittedForLength: true,
        },
      },
    ]
  }
}

/**
 * simplifyReadFileResults assumes content[0] is the json file list. Real
 * histories can also carry media parts (images read as files); never feed
 * those to the simplifier.
 */
function readFilesContentSimplifiable(
  content: CodebuffToolOutput<'read_files'>,
): boolean {
  const first = content[0]
  return (
    first?.type === 'json' &&
    Array.isArray((first as { value?: unknown }).value)
  )
}

// Number of terminal command outputs to keep in full form before simplifying.
// Scanned from the newest message backwards; the per-stub baseline matches
// simplifyTerminalHelper in util/messages.ts (background-process and error
// results simplify to themselves and stay outside the keep budget).
const numTerminalCommandsToKeep = 5

// Number of read_files results to keep verbatim, newest first. Matches the
// terminal-command convention (newest K verbatim, rest stubbed), with a
// smaller window: the read-path stub retains every path, and an omitted read
// can be re-read exactly with offset/limit, whereas a stubbed command cannot
// be repeated safely.
const numReadFileResultsToKeep = 3

// Only apply the pass once the past-window results it would stub carry real
// volume. Stubbing trades content for tokens on every later step: worth it
// when a long session would otherwise re-send hundreds of kilobytes, not when
// the savings are one modest result and the model may still want what it read
// a moment ago. On overflow a verbatim result also keeps fitToolResults'
// graded prefix-clip available, while a stub has nothing left to clip.
const minSavingsCharsToSimplify = 20_000

/** Approximate serialized size of a result without copying it. */
function contentChars(content: unknown[]): number {
  return JSON.stringify(content).length
}

/**
 * Replaces read_files and run_terminal_command results older than the newest
 * few with the omit stubs ({ contentOmittedForLength: true } /
 * { stdoutOmittedForLength: true }) that getPreviouslyReadFiles and the
 * re-read hints already understand, so a long session stops re-sending stale
 * multi-kilobyte outputs on every step until compaction.
 *
 * Pure copy-on-write: messages left alone keep reference identity, and the
 * input array itself (same reference) is returned when nothing needed
 * stubbing, so callers that detect history extension by === or
 * every((m, i) => history[i] === m) see exactly the edits made here. Nothing
 * from a caller's in-flight step should be included in `messages`.
 */
export function simplifyOldToolResults(params: {
  messages: Message[]
  numTerminalCommands?: number
  numReadFileResults?: number
  logger: Logger
}): Message[] {
  const { messages, logger } = params
  const numTerminalCommands =
    params.numTerminalCommands ?? numTerminalCommandsToKeep
  const numReadFileResults =
    params.numReadFileResults ?? numReadFileResultsToKeep

  const stub = (
    message: ToolMessage,
  ):
    | { kind: 'run_terminal_command'; stubbed: ToolMessage }
    | { kind: 'read_files'; stubbed: ToolMessage }
    | undefined => {
    if (message.toolName === 'run_terminal_command') {
      const content = (message as CodebuffToolMessage<'run_terminal_command'>)
        .content
      try {
        const stubbed = simplifyTerminalCommandResults({
          messageContent: content,
          logger,
        })
        // Already stubbed, or a background/error result the simplifier keeps
        // verbatim (matching simplifyTerminalHelper in util/messages.ts).
        return isEqual(stubbed, content)
          ? undefined
          : {
              kind: 'run_terminal_command',
              stubbed: { ...message, content: stubbed },
            }
      } catch (error) {
        logger.error(
          { error: getErrorObject(error), message },
          'Error simplifying old tool result; keeping it verbatim',
        )
        return undefined
      }
    }
    if (message.toolName === 'read_files') {
      const content = (message as CodebuffToolMessage<'read_files'>).content
      if (!readFilesContentSimplifiable(content)) return undefined
      try {
        const stubbed = simplifyReadFileResults(content)
        // Already stubbed (nothing carries it either way).
        return isEqual(stubbed, content)
          ? undefined
          : { kind: 'read_files', stubbed: { ...message, content: stubbed } }
      } catch (error) {
        logger.error(
          { error: getErrorObject(error), message },
          'Error simplifying old tool result; keeping it verbatim',
        )
        return undefined
      }
    }
    return undefined
  }

  // The newest few results of each kind stay verbatim; everything older is
  // stubbed. First measure what the pass would save, and bail out whole when
  // the past-window volume is below minSavingsCharsToSimplify (the quality
  // floor above).
  let terminalKept = 0
  let readKept = 0
  let savings = 0
  const candidates = new Map<Message, NonNullable<ReturnType<typeof stub>>>()
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.role !== 'tool') continue
    const candidate = stub(message)
    if (!candidate) continue
    if (candidate.kind === 'run_terminal_command') {
      if (terminalKept < numTerminalCommands) {
        terminalKept++
        continue
      }
    } else if (readKept < numReadFileResults) {
      readKept++
      continue
    }
    candidates.set(message, candidate)
    savings +=
      contentChars(message.content) - contentChars(candidate.stubbed.content)
  }
  if (candidates.size === 0 || savings < minSavingsCharsToSimplify) {
    return messages
  }

  return messages.map((message) => candidates.get(message)?.stubbed ?? message)
}
