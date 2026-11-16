/** Stable IDs for doc blocks, including repeated paragraphs with identical source. */

import { docBlockHash, docBodyLayout } from './doc-blocks'
import type { DocBlockEdit } from './doc-tabs'
import { splitDocSuggestions, type DocBlockIdRecord, type DocSuggestionRecord } from './doc-suggestions'

/** Which blocks the kept records actually claim, without assigning new derived ids. */
function keptIds(hashes: string[], records: readonly DocSuggestionRecord[]): Map<number, string> {
  const kept = records.filter((record): record is DocBlockIdRecord => record.kind === 'id')
  const assigned = new Map<number, string>()
  const used = new Set<string>()
  const positions = new Map<string, number[]>()
  hashes.forEach((hash, index) => {
    const matches = positions.get(hash) ?? []
    matches.push(index)
    positions.set(hash, matches)
  })
  // Explicit occurrences claim their slot before legacy records or derived ids do.
  for (const record of kept) {
    if (record.occurrence === undefined) continue
    const index = positions.get(record.hash)?.[record.occurrence]
    if (index === undefined || assigned.has(index) || used.has(record.id)) continue
    assigned.set(index, record.id)
    used.add(record.id)
  }
  for (const record of kept) {
    if (record.occurrence !== undefined || used.has(record.id)) continue
    const index = positions.get(record.hash)?.find((candidate) => !assigned.has(candidate))
    if (index === undefined) continue
    assigned.set(index, record.id)
    used.add(record.id)
  }
  return assigned
}

/** The id of each block of `content`, in order. Legacy hash-only records claim matches in order. */
export function docBlockIds(content: string, records: readonly DocSuggestionRecord[]): string[] {
  const hashes = docBodyLayout(content).map((block) => docBlockHash(block.source))
  const assigned = keptIds(hashes, records)
  // Reserve even an invalid claim, so its id cannot silently become a derived id elsewhere.
  const used = new Set(records.filter((record) => record.kind === 'id').map((record) => record.id))
  const counts = new Map<string, number>()
  return hashes.map((hash, index) => {
    const keptId = assigned.get(index)
    if (keptId) return keptId
    for (let n = counts.get(hash) ?? 0; ; n++) {
      const id = n === 0 ? `b-${hash}` : `b-${hash}.${n}`
      if (used.has(id)) continue
      counts.set(hash, n + 1)
      used.add(id)
      return id
    }
  })
}

export function docBlockIndexOfId(content: string, records: readonly DocSuggestionRecord[], id: string): number {
  return docBlockIds(content, records).indexOf(id)
}

/** Carry identities through a known edit, or refuse when it unexpectedly reparses other blocks. */
export function carryDocBlockIds(
  content: string,
  records: readonly DocSuggestionRecord[],
  edit: DocBlockEdit,
  next: string,
  keepId?: string,
): DocSuggestionRecord[] | null {
  const before = docBlockIds(content, records)
  const kept = new Set(records.filter((record) => record.kind === 'id').map((record) => record.id))
  const span = edit.span ?? 1
  const desired: Array<string | undefined> = [...before]
  const expectedSources = docBodyLayout(content).map((block) => block.source)
  if (edit.moveTo !== undefined) {
    const moving = desired.splice(edit.index, span)
    const movingSources = expectedSources.splice(edit.index, span)
    const destination = Math.max(0, Math.min(desired.length, edit.moveTo))
    desired.splice(destination, 0, ...moving)
    expectedSources.splice(destination, 0, ...movingSources)
  } else {
    const replacementSources = docBodyLayout(edit.after).map((block) => block.source)
    const count = replacementSources.length
    const replacements: Array<string | undefined> = Array(count).fill(undefined)
    const first = before[edit.index]
    if (count > 0 && span > 0 && (keepId || (span === 1 && kept.has(first)))) replacements[0] = keepId ?? first
    desired.splice(edit.index, span, ...replacements)
    expectedSources.splice(edit.index, span, ...replacementSources)
  }
  const blocks = docBodyLayout(next)
  if (blocks.length !== desired.length || blocks.some((block, index) => block.source !== expectedSources[index])) return null
  const reserved = new Set(desired.filter((id): id is string => id !== undefined))
  const natural = docBlockIds(next, [])
  const totals = new Map<string, number>()
  for (const block of blocks) {
    const hash = docBlockHash(block.source)
    totals.set(hash, (totals.get(hash) ?? 0) + 1)
  }
  const occurrences = new Map<string, number>()
  const updated: DocSuggestionRecord[] = records.filter((record) => record.kind !== 'id')
  blocks.forEach((block, index) => {
    const hash = docBlockHash(block.source)
    const occurrence = occurrences.get(hash) ?? 0
    occurrences.set(hash, occurrence + 1)
    let id = desired[index]
    if (!id) {
      for (let suffix = 0; ; suffix++) {
        const candidate = suffix === 0 ? `b-${hash}` : `b-${hash}.${suffix}`
        if (reserved.has(candidate)) continue
        id = candidate
        reserved.add(id)
        break
      }
    }
    if (kept.has(id) || id === keepId || id !== natural[index]) updated.push({ id, kind: 'id', hash, ...(totals.get(hash)! > 1 ? { occurrence } : {}) })
  })
  return updated
}

/** Bind a known block to an id. Callers applying edits should use carryDocBlockIds. */
export function keepBlockId(
  records: readonly DocSuggestionRecord[],
  id: string,
  source: string,
  content: string,
  blockIndex?: number,
): DocSuggestionRecord[] {
  const hash = docBlockHash(source.replace(/\r\n?/g, '\n'))
  const blocks = docBodyLayout(content)
  const matching = blocks.flatMap((block, index) => docBlockHash(block.source) === hash ? [index] : [])
  const existing = docBlockIndexOfId(content, records, id)
  const index = blockIndex ?? (matching.includes(existing) ? existing : matching.length === 1 ? matching[0] : -1)
  if (index < 0 || docBlockHash(blocks[index]?.source ?? '') !== hash) return pruneBlockIds(content, records)
  const occurrence = blocks.slice(0, index).filter((block) => docBlockHash(block.source) === hash).length
  const record: DocBlockIdRecord = { id, kind: 'id', hash, ...(matching.length > 1 ? { occurrence } : {}) }
  return pruneBlockIds(content, [...records.filter((item) => item.id !== id), record])
}

/** Remove missing or duplicate claims. An explicit occurrence never falls back to another match. */
export function pruneBlockIds(content: string, records: readonly DocSuggestionRecord[]): DocSuggestionRecord[] {
  const hashes = docBodyLayout(content).map((block) => docBlockHash(block.source))
  const ids = new Set(keptIds(hashes, records).values())
  const seen = new Set<string>()
  return records.filter((record) => {
    if (record.kind !== 'id') return true
    if (!ids.has(record.id) || seen.has(record.id)) return false
    seen.add(record.id)
    return true
  })
}

export const hasKeptBlockId = (records: readonly DocSuggestionRecord[], id: string) =>
  records.some((record) => record.kind === 'id' && record.id === id)

/**
 * Raw replacements cannot prove which identical paragraph a copied sidecar meant. Require a
 * guarded block edit when a retained identity's duplicate group changed around it.
 */
export function docBlockIdWriteRefusal(stored: string, next: string): string | null {
  const before = splitDocSuggestions(stored)
  const after = splitDocSuggestions(next)
  const beforeBlocks = docBodyLayout(before.content)
  const afterBlocks = docBodyLayout(after.content)
  const beforeIds = docBlockIds(before.content, before.suggestions)
  const afterIds = docBlockIds(after.content, after.suggestions)
  const retained = new Map(after.suggestions.filter((record) => record.kind === 'id').map((record) => [record.id, record]))
  for (const record of before.suggestions) {
    if (record.kind !== 'id') continue
    const previous = beforeIds.indexOf(record.id)
    if (!retained.has(record.id)) {
      if (afterIds.includes(record.id)) return 'This replacement would reuse a paragraph identity. Keep its block records or use guarded block patch operations.'
      continue
    }
    const current = afterIds.indexOf(record.id)
    if (previous < 0 || current < 0) return 'Block identities no longer match. Read the artifact again and use guarded block patch operations.'
    const hash = docBlockHash(afterBlocks[current].source)
    const beforeCount = beforeBlocks.filter((block) => docBlockHash(block.source) === hash).length
    const afterCount = afterBlocks.filter((block) => docBlockHash(block.source) === hash).length
    if (Math.max(beforeCount, afterCount) > 1 &&
      (beforeCount !== afterCount || previous !== current || beforeBlocks[previous].source !== afterBlocks[current].source))
      return 'A full replacement cannot identify duplicate paragraphs safely. Use guarded block patch operations for this change.'
  }
  return null
}
