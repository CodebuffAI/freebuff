/**
 * Suggested edits in a stored doc, kept in the body itself so no other store is needed.
 *
 * A suggestion is a proposed change to one block that the doc's reader accepts or rejects. They
 * live in one sidecar block at the very end of the body, one invisible line each:
 *
 *   [//]: # "fb-suggestion: <base64url of the JSON record>"
 *
 * the same link-reference-definition comment the tab markers use (doc-tabs.ts), so GitHub,
 * CommonMark renderers and react-markdown draw nothing for it, and a plain Markdown reader sees
 * the doc as it stands, without the proposals. Being last, the sidecar never shifts the index of
 * a content block. Everything outside it keeps its bytes: `splitDocSuggestions` takes the sidecar
 * out and `joinDocSuggestions` puts it back, a round trip of the content exactly.
 */

import { applyDocBodyEdit, docBodyLayout } from './doc-blocks'
import { carryDocBlockIds } from './doc-block-ids'

/**
 * A sidecar record is a suggestion (`replace` / `insert`) or a block id (`id`, doc-block-ids.ts):
 * the id a block keeps through edits, by the block's current hash. Both ride in the one sidecar,
 * merged by `id`, so a merge keeps them like any record.
 */
export type DocSuggestionRecord = DocProposalRecord | DocBlockIdRecord
/** Alias: what one sidecar line holds. */
export type DocSidecarRecord = DocSuggestionRecord

/** A stable id (`b-…`), bound to a source hash and optional zero-based duplicate occurrence. */
export type DocBlockIdRecord = { id: string; kind: 'id'; hash: string; occurrence?: number }

export const isBlockIdRecord = (record: DocSidecarRecord): record is DocBlockIdRecord => record.kind === 'id'
export const isProposal = (record: DocSidecarRecord): record is DocProposalRecord => record.kind !== 'id'

function parseBlockIdRecord(record: Record<string, unknown>): DocBlockIdRecord | null {
  if (!isString(record.id) || !/^b-[A-Za-z0-9._-]{1,40}$/.test(record.id)) return null
  if (!isString(record.hash) || !/^[0-9a-z]{1,12}$/.test(record.hash)) return null
  if (record.occurrence !== undefined && (typeof record.occurrence !== 'number' || !Number.isSafeInteger(record.occurrence) || record.occurrence < 0)) return null
  return { id: record.id, kind: 'id', hash: record.hash, ...(record.occurrence !== undefined ? { occurrence: record.occurrence as number } : {}) }
}

/** A suggested edit, as stored. */
export type DocProposalRecord = {
  id: string
  /**
   * `replace`: `before` is the exact source of one block and `after` takes its place (empty
   * deletes it). `insert`: `after` goes in after the block whose source is `anchor` (empty anchor:
   * at the top of the doc).
   */
  kind: 'replace' | 'insert'
  before?: string
  anchor?: string
  after: string
  /** The block index when it was proposed: which of several identical blocks it means. */
  hint?: number
  /** One line on why, shown on the card. */
  note?: string
  /** Who proposed it (`Freebuff` for the agent): a display name, never trusted on its own. */
  by?: string
  /**
   * What kind of writer proposed it, stamped by the store on every write (`stampDocSuggestions`):
   * a record a write adds or changes is re-attributed to that write's author, so a person cannot
   * plant a suggestion "from Freebuff". Absent on a record no stamped write has seen.
   */
  byKind?: 'agent' | 'user'
  /** Account that authorized the write, stamped by the server. */
  byUserId?: string
  /** ISO time it was proposed. */
  at?: string
}

export const DOC_SUGGESTION_LIMITS = { count: 100, chars: 20_000, note: 200 } as const

const LINE = /^ {0,3}\[\/\/\]:[ \t]*#[ \t]+"fb-suggestion:[ \t]*([A-Za-z0-9_-]+)"[ \t]*$/

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(text: string): string | null {
  try {
    const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'))
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

const isString = (value: unknown): value is string => typeof value === 'string'

/** A record as read from a line, or null when the line is not a well-formed suggestion. */
export function parseSuggestionLine(line: string): DocSidecarRecord | null {
  const match = LINE.exec(line)
  const json = match ? fromBase64Url(match[1]) : null
  if (json === null) return null
  let value: unknown
  try {
    value = JSON.parse(json)
  } catch {
    return null
  }
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (record.kind === 'id') return parseBlockIdRecord(record)
  if (!isString(record.id) || !record.id || !isString(record.after)) return null
  if (record.kind === 'replace' && !isString(record.before)) return null
  if (record.kind === 'insert' && !isString(record.anchor)) return null
  if (record.kind !== 'replace' && record.kind !== 'insert') return null
  return {
    id: record.id.slice(0, 64),
    kind: record.kind,
    ...(record.kind === 'replace' ? { before: record.before as string } : { anchor: record.anchor as string }),
    after: record.after,
    ...(typeof record.hint === 'number' && Number.isInteger(record.hint) && record.hint >= 0 ? { hint: record.hint } : {}),
    ...(isString(record.note) ? { note: record.note.slice(0, DOC_SUGGESTION_LIMITS.note) } : {}),
    ...(isString(record.by) ? { by: record.by.slice(0, 60) } : {}),
    ...(record.byKind === 'agent' || record.byKind === 'user' ? { byKind: record.byKind } : {}),
    ...(isString(record.byUserId) && record.byUserId.length <= 256 ? { byUserId: record.byUserId } : {}),
    ...(isString(record.at) ? { at: record.at.slice(0, 40) } : {}),
  }
}

/** The sidecar line for a record. */
export function suggestionLine(record: DocSidecarRecord): string {
  return `[//]: # "fb-suggestion: ${toBase64Url(JSON.stringify(record))}"`
}

/** Whether a block is (only) suggestion lines: a sidecar, never drawn. */
export function isSuggestionBlock(source: string): boolean {
  const lines = source.split('\n')
  return lines.length > 0 && lines.every((line) => LINE.test(line))
}

/** Whether a line looks like a sidecar line at all (even a malformed one). */
export const looksLikeSuggestionLine = (line: string) => /\[\/\/\]:[ \t]*#[ \t]+"fb-suggestion:/.test(line)

/**
 * The body without its sidecar block(s), and the suggestions they held, in order. A sidecar
 * moved out of last place (an insert below it) is still found; the content keeps every other
 * byte. Malformed lines are dropped.
 */
export function splitDocSuggestions(body: string): { content: string; suggestions: DocSidecarRecord[] } {
  const blocks = docBodyLayout(body)
  const found = blocks.map((block, index) => (isSuggestionBlock(block.source) ? index : -1)).filter((index) => index >= 0)
  if (found.length === 0) return { content: body, suggestions: [] }
  const suggestions: DocSidecarRecord[] = []
  const seen = new Set<string>()
  let content = body
  for (const index of [...found].reverse()) {
    const block = blocks[index]
    const records = block.source.split('\n').map(parseSuggestionLine)
    for (const record of records.reverse())
      if (record && !seen.has(record.id)) {
        seen.add(record.id)
        suggestions.unshift(record)
      }
    // Cut the block and the blank line before it (or after it, when it is first).
    const previous = blocks[index - 1]
    const next = blocks[index + 1]
    if (previous) content = content.slice(0, previous.end) + content.slice(block.end)
    else if (next) content = content.slice(0, block.start) + content.slice(next.start)
    else content = content.slice(0, block.start) + content.slice(block.end)
  }
  return { content, suggestions }
}

/** The body for `content` with `suggestions` as its sidecar block (none: the content as is). */
export function joinDocSuggestions(content: string, suggestions: readonly DocSidecarRecord[]): string {
  if (suggestions.length === 0) return content
  const crlf = content.includes('\r\n')
  const newline = crlf ? '\r\n' : '\n'
  const trimmed = content.replace(/\s+$/, '')
  const trailing = content.slice(trimmed.length)
  const sidecar = suggestions.map(suggestionLine).join(newline)
  return `${trimmed}${trimmed ? newline + newline : ''}${sidecar}${trailing}`
}

/** The block index a suggestion lands on in `content`, or null when it no longer applies. */
export function suggestionTarget(content: string, record: DocProposalRecord): number | null {
  const sources = docBodyLayout(content).map((block) => block.source)
  const wanted = record.kind === 'replace' ? record.before ?? '' : record.anchor ?? ''
  if (record.kind === 'insert' && wanted === '') return -1
  const matches = sources.flatMap((source, index) => (source === wanted ? [index] : []))
  if (matches.length === 0) return null
  const hint = record.hint ?? 0
  return matches.reduce((best, index) => (Math.abs(index - hint) < Math.abs(best - hint) ? index : best))
}

/** `content` with one suggestion applied, or null when its block changed or went. */
export function applySuggestionRecord(content: string, record: DocProposalRecord): string | null {
  const index = suggestionTarget(content, record)
  if (index === null) return null
  if (record.kind === 'insert')
    return applyDocBodyEdit(content, { index: index + 1, span: 0, before: '', after: record.after })
  return applyDocBodyEdit(content, { index, before: record.before ?? '', after: record.after })
}

export type SuggestionResolution = {
  body: string
  /** Accepted and applied. */
  applied: string[]
  /** Accepted, but their block changed or went, so they were dropped unapplied. */
  stale: string[]
}

/**
 * Accepts (applies, in sidecar order) or rejects the suggestions `ids` in one new body: each
 * leaves the sidecar either way. A stale one is dropped and reported.
 */
export function resolveDocSuggestions(
  body: string,
  ids: readonly string[],
  decision: 'accept' | 'reject',
): SuggestionResolution {
  const { content, suggestions } = splitDocSuggestions(body)
  const chosen = new Set(ids)
  let next = content
  let records = suggestions
  const applied: string[] = []
  const stale: string[] = []
  if (decision === 'accept')
    for (const record of suggestions) {
      if (!chosen.has(record.id) || !isProposal(record)) continue
      const result = applySuggestionRecord(next, record)
      if (result === null) stale.push(record.id)
      else {
        const index = suggestionTarget(next, record)!
        const edit = record.kind === 'insert'
          ? { index: index + 1, span: 0, before: '', after: record.after }
          : { index, before: record.before ?? '', after: record.after }
        const carried = carryDocBlockIds(next, records, edit, result)
        if (carried === null) {
          stale.push(record.id)
          continue
        }
        records = carried
        next = result
        applied.push(record.id)
      }
    }
  // A block id is never resolved, only a proposal.
  const rest = records.filter((record) => !chosen.has(record.id) || !isProposal(record))
  return { body: joinDocSuggestions(next, rest), applied, stale }
}

/** A new suggestion id, unused in `taken`. */
export function freshSuggestionId(taken: Iterable<string>, seed = Date.now()): string {
  const used = new Set(taken)
  for (let n = 0; ; n++) {
    const id = `sg-${(seed + n).toString(36).slice(-6)}`
    if (!used.has(id)) return id
  }
}

/** Who a write is from, as the store knows it (never as the body claims). */
export type DocWriter = { authorKind: 'agent' | 'user'; name?: string; userId?: string }

/** The display name the store gives the agent's suggestions. */
export const AGENT_SUGGESTION_BY = 'Freebuff'

/**
 * The `by` the store stamps on a person's suggestion: their display name, or "A collaborator".
 * A client that writes the same (`DocArtifact`) gets its body back unchanged, so its undo steps
 * still match the stored body.
 */
export const personSuggestionBy = (name: string | null | undefined) => name?.trim().slice(0, 60) || 'A collaborator'

/**
 * `next` as the store keeps it, given the `stored` body it replaces and who wrote it: every
 * suggestion `next` adds or changes (by id, compared with `stored`) is attributed to `writer`
 * (`byKind`, and `by` for the agent; a person's `by` is their name or "A collaborator"), so no
 * writer can plant one that claims to be someone else's. Records `stored` already held keep their
 * attribution. When nothing needs stamping, `next` comes back as it is, byte for byte.
 */
export function stampDocSuggestions(stored: string, next: string, writer: DocWriter): string {
  const after = splitDocSuggestions(next)
  if (!after.suggestions.some(isProposal)) return next
  const before = new Map(splitDocSuggestions(stored).suggestions.map((record) => [record.id, JSON.stringify(record)]))
  let changed = false
  const records = after.suggestions.map((record) => {
    if (!isProposal(record) || before.get(record.id) === JSON.stringify(record)) return record
    const by = writer.authorKind === 'agent' ? AGENT_SUGGESTION_BY : personSuggestionBy(writer.name)
    if (record.byKind === writer.authorKind && record.by === by && record.byUserId === writer.userId) return record
    changed = true
    const { byUserId: _untrusted, ...rest } = record
    return { ...rest, by, byKind: writer.authorKind, ...(writer.userId ? { byUserId: writer.userId } : {}) }
  })
  return changed ? joinDocSuggestions(after.content, records) : next
}

/** Who a record says proposed it, for its card: only `byKind` is trusted (the store stamps it). */
export function suggestionAuthorLabel(record: Pick<DocProposalRecord, 'by' | 'byKind'>): { label: string; agent: boolean; verified: boolean } {
  if (record.byKind === 'agent') return { label: AGENT_SUGGESTION_BY, agent: true, verified: true }
  if (record.byKind === 'user') return { label: record.by || 'A collaborator', agent: false, verified: true }
  return { label: 'Unattributed', agent: false, verified: false }
}
