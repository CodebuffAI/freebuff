/**
 * The files a mechanical compaction carries forward, so the model does not
 * have to read them again.
 *
 * The summary keeps a one-line record of every tool call, but no tool output:
 * a file the model read becomes `inspected files: a.ts`. With the contents
 * gone the model's next move is to read the file again, and on a small window
 * those reads refill the context until it compacts again (prod, 2026-10-05:
 * after a mechanical pass the same run compacted again within ten minutes
 * twice as often as after a model handoff, almost all of it on budgets under
 * 150k tokens).
 *
 * So the pass re-provides the newest read of each file it can afford, as one
 * `read_files` exchange placed after the live prompt — the shape the model
 * already trusts for file contents. A file that was edited after its last
 * read is never re-provided: those contents are stale. Nor is any file read
 * before a `spawn_agents` call: the spawned agents' edits never appear in this
 * history (the fast-mode root delegates its edits that way), so the read may
 * be stale too. Every other file read
 * earlier gets a stub in the same result instead: its size when read and an
 * outline of its top-level declarations with line numbers, so the model can
 * read one section rather than the whole file.
 *
 * The exchange is tagged, so the next compaction reads it back as reads
 * (stubs included, which keeps one entry per path however many times a
 * history is compacted) and keeps it out of the summary's own tool log.
 */

import { countTokensJson, countTokensMessages } from './util/token-counter'

import type { Message } from '@codebuff/common/types/messages/codebuff-message'

export const WORKING_SET_TAG = 'COMPACTION_WORKING_SET'

/** Starts the content of a file the compaction did not carry. */
export const COMPACTED_READ_MARKER =
  '[read_files: contents dropped at compaction'

/** The most file content one compaction carries, in estimated tokens. At
 * the default `MECHANICAL_HISTORY_TOKENS` (12k) the share below binds first
 * (under 5k); this caps a caller that passes a larger `historyTokens`. */
export const WORKING_SET_TOKEN_LIMIT = 40_000

/** Share of the room left after the live request and fresh results. The rest
 * goes to the summary, whose user messages matter more than any one file. */
export const WORKING_SET_SHARE = 0.4

/** Stubs are cheap, but a long session reads hundreds of files. */
const STUB_TOKEN_LIMIT = 3_000
const OUTLINE_MAX_ENTRIES = 20
const OUTLINE_LINE_CHARS = 80

const EDIT_TOOLS = new Set([
  'str_replace',
  'write_file',
  'propose_str_replace',
  'propose_write_file',
])

/** Runs agents whose edits stay out of this history. A shell command can
 * change files too, but it is not counted: most commands change nothing. */
const DELEGATING_TOOLS = new Set(['spawn_agents'])

/** Status results (missing, blocked, too large, error) are not contents. */
const STATUS_PREFIXES = [
  '[FILE_DOES_NOT_EXIST]',
  '[BLOCKED]',
  '[FILE_OUTSIDE_PROJECT]',
  '[FILE_READ_ERROR]',
  '[IMAGE]',
]

export function isWorkingSetMessage(message: Message): boolean {
  return message.tags?.includes(WORKING_SET_TAG) ?? false
}

type Read = {
  path: string
  content: string
  /** Position in the history; later reads and edits compare against it. */
  order: number
}

function pathOf(input: unknown): string | undefined {
  const path = (input as { path?: unknown } | undefined)?.path
  return typeof path === 'string' && path ? path : undefined
}

/** Every read_files result and every edit, in history order. */
function collectReadsAndEdits(messages: Message[]): {
  reads: Read[]
  lastEdit: Map<string, number>
  /** The newest delegation, which may have edited any file; -1 for none. */
  lastDelegation: number
} {
  const reads: Read[] = []
  const lastEdit = new Map<string, number>()
  let lastDelegation = -1
  messages.forEach((message, order) => {
    if (message.role === 'assistant') {
      for (const part of message.content) {
        if (part.type !== 'tool-call') continue
        if (DELEGATING_TOOLS.has(part.toolName)) lastDelegation = order
        if (!EDIT_TOOLS.has(part.toolName)) continue
        const path = pathOf(part.input)
        if (path) lastEdit.set(path, order)
      }
      return
    }
    if (message.role !== 'tool' || message.toolName !== 'read_files') return
    for (const part of message.content) {
      if (part.type !== 'json' || !Array.isArray(part.value)) continue
      for (const file of part.value) {
        if (!file || typeof file !== 'object' || Array.isArray(file)) continue
        const { path, content } = file as { path?: unknown; content?: unknown }
        if (typeof path !== 'string' || typeof content !== 'string') continue
        reads.push({ path, content, order })
      }
    }
  })
  return { reads, lastEdit, lastDelegation }
}

const DECLARATION_PATTERNS = [
  // TypeScript / JavaScript
  /^(export\s+)?(default\s+)?(declare\s+)?(abstract\s+)?(async\s+)?(function\b|class\b|interface\b|type\s+\w|enum\b|namespace\b)/,
  /^export\s+(const|let|var)\b/,
  // Python
  /^(async\s+)?def\s+\w/,
  /^class\s+\w/,
  // Go
  /^func\s/,
  /^type\s+\w+\s+(struct|interface)\b/,
  // Rust
  /^(pub(\([^)]*\))?\s+)?(async\s+)?(fn|struct|enum|trait|impl|mod)\b/,
  // Markdown
  /^#{1,3}\s+\S/,
]

/**
 * Top-level declarations with their line numbers. A windowed read starts its
 * numbering at the window's first line, which the read's own notice states.
 */
export function outlineOf(content: string): { lines: number; outline: string } {
  const window = content.match(
    /\[read_files: showing lines (\d+)-\d+ of (\d+)\./,
  )
  const firstLine = window ? Number(window[1]) : 1
  const body = content.split('\n')
  const lines = window ? Number(window[2]) : body.length
  const entries: string[] = []
  let more = 0
  for (let i = 0; i < body.length; i++) {
    const line = body[i]
    if (!DECLARATION_PATTERNS.some((pattern) => pattern.test(line))) continue
    if (entries.length >= OUTLINE_MAX_ENTRIES) {
      more++
      continue
    }
    const text = line.trim().replace(/\s*\{$/, '')
    entries.push(
      `L${firstLine + i} ${text.length > OUTLINE_LINE_CHARS ? text.slice(0, OUTLINE_LINE_CHARS) + '…' : text}`,
    )
  }
  if (more > 0) entries.push(`… ${more} more`)
  return { lines, outline: entries.join('\n') }
}

type StubReason = 'budget' | 'edited' | 'delegated'

function stubFor(read: Read, reason: StubReason): string {
  if (read.content.startsWith(COMPACTED_READ_MARKER)) return read.content
  const { lines, outline } = outlineOf(read.content)
  const why =
    reason === 'edited'
      ? 'You edited it after this read, so read it again before relying on it.'
      : reason === 'delegated'
        ? 'Agents you spawned after this read may have edited it, so read it again before relying on it.'
        : 'Read it again (a section with offset/limit is enough) if you need it.'
  return `${COMPACTED_READ_MARKER}. ${lines} lines when read. ${why}]${outline ? `\nOutline:\n${outline}` : ''}`
}

/**
 * The working-set exchange for `older` (the history being summarized), or
 * null when there is nothing to carry. `fresh` is kept verbatim by the caller:
 * its reads are already present, and its edits make older reads stale.
 */
export function buildWorkingSet(params: {
  older: Message[]
  fresh: Message[]
  tokenBudget: number
  noteBudget?: number
  now: number
}): { messages: Message[]; files: number; stubs: number } | null {
  const { reads, lastEdit, lastDelegation } = collectReadsAndEdits([
    ...params.older,
    ...params.fresh,
  ])
  const freshStart = params.older.length
  const latest = new Map<string, Read>()
  for (const read of reads) {
    if (read.order >= freshStart) continue
    if (STATUS_PREFIXES.some((prefix) => read.content.startsWith(prefix)))
      continue
    latest.set(read.path, read)
  }
  const freshPaths = new Set(
    reads.filter((read) => read.order >= freshStart).map((read) => read.path),
  )
  // Newest first: the files the model was working with most recently.
  const candidates = [...latest.values()]
    .filter((read) => !freshPaths.has(read.path))
    .sort((a, b) => b.order - a.order)
  if (candidates.length === 0) return null

  const exchange = (files: { path: string; content: string }[]): Message[] => {
    const toolCallId = `compacted-read-${params.now.toString(36)}`
    return [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId,
            toolName: 'read_files',
            input: { paths: files.map((file) => file.path) },
          },
        ],
        tags: [WORKING_SET_TAG],
        sentAt: params.now,
      },
      {
        role: 'tool',
        toolCallId,
        toolName: 'read_files',
        content: [{ type: 'json', value: files }],
        tags: [WORKING_SET_TAG],
      },
    ]
  }
  // Counted per file, once: the result entry plus the path in the call.
  const cost = (file: { path: string; content: string }) =>
    countTokensJson(file) + countTokensJson(file.path) + 1
  let used = countTokensMessages(exchange([]))

  const carried: { path: string; content: string }[] = []
  const left: { read: Read; reason: StubReason }[] = []
  for (const read of candidates) {
    const stale: StubReason | undefined =
      (lastEdit.get(read.path) ?? -1) > read.order
        ? 'edited'
        : lastDelegation > read.order
          ? 'delegated'
          : undefined
    const file = { path: read.path, content: read.content }
    if (
      !stale &&
      !read.content.startsWith(COMPACTED_READ_MARKER) &&
      used + cost(file) <= params.tokenBudget
    ) {
      carried.push(file)
      used += cost(file)
    } else {
      left.push({ read, reason: stale ?? 'budget' })
    }
  }

  let stubRoom = Math.min(STUB_TOKEN_LIMIT, params.tokenBudget - used)
  let noteRoom = (params.noteBudget ?? params.tokenBudget) - used
  const stubs: { path: string; content: string }[] = []
  for (const { read, reason } of left) {
    const stub = { path: read.path, content: stubFor(read, reason) }
    if (cost(stub) <= Math.min(stubRoom, noteRoom)) {
      stubs.push(stub)
      stubRoom -= cost(stub)
      noteRoom -= cost(stub)
      continue
    }
    const note = { path: read.path, content: stub.content.split('\n')[0] }
    if (cost(note) > noteRoom) continue
    stubs.push(note)
    noteRoom -= cost(note)
  }

  const files = [...carried, ...stubs]
  if (files.length === 0) return null
  return {
    messages: exchange(files),
    files: carried.length,
    stubs: stubs.length,
  }
}
