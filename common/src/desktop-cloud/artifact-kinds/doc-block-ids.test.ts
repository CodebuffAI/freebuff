import { expect, test } from 'bun:test'
import { carryDocBlockIds, docBlockIds, docBlockIdWriteRefusal, pruneBlockIds } from './doc-block-ids'
import { applyDocBodyEdit, docBlockHash, docBodyLayout } from './doc-blocks'
import { mergeArtifactBodies } from '../artifact-merge'
import { applyDocOp } from './doc-ops'
import { joinDocSuggestions, parseSuggestionLine, resolveDocSuggestions, splitDocSuggestions, suggestionLine } from './doc-suggestions'

const ids = (body: string) => {
  const split = splitDocSuggestions(body)
  return docBlockIds(split.content, split.suggestions)
}
const apply = (body: string, op: Record<string, unknown>) => {
  const result = applyDocOp(body, op)
  if (!result.ok) throw new Error(result.error)
  return result.body
}

// Rewriting to identical text must never move a later edit onto the other paragraph.
test('an id follows its paragraph when a rewrite duplicates another paragraph', () => {
  const original = 'Alpha\n\nBeta\n'
  const [alpha, beta] = ids(original)
  const duplicate = apply(original, { op: 'replaceBlock', id: beta, hash: docBlockHash('Beta'), markdown: 'Alpha' })
  expect(ids(duplicate)).toEqual([alpha, beta])
  const changed = apply(duplicate, { op: 'replaceBlock', id: beta, hash: docBlockHash('Alpha'), markdown: 'Changed' })
  expect(splitDocSuggestions(changed).content).toBe('Alpha\n\nChanged\n')
  expect(ids(changed)).toEqual([alpha, beta])
})

test('inserting and moving identical paragraphs preserves the old identities', () => {
  const original = 'Alpha\n\nAlpha\n\nBeta\n'
  const originalIds = ids(original)
  const inserted = apply(original, { op: 'insertAfterBlock', block: -1, markdown: 'Alpha' })
  expect(ids(inserted).slice(1)).toEqual(originalIds)
  expect(new Set(ids(inserted)).size).toBe(4)
  const moved = apply(inserted, { op: 'moveBlock', id: originalIds[1], hash: docBlockHash('Alpha'), to: 0 })
  expect(ids(moved)[0]).toBe(originalIds[1])
  const changed = apply(moved, { op: 'replaceBlock', id: originalIds[0], hash: docBlockHash('Alpha'), markdown: 'First original' })
  expect(splitDocSuggestions(changed).content).toBe('Alpha\n\nAlpha\n\nFirst original\n\nBeta\n')
  const removed = apply(changed, { op: 'removeBlock', id: originalIds[1], hash: docBlockHash('Alpha') })
  expect(ids(removed)).not.toContain(originalIds[1])
  expect(ids(removed)).toContain(originalIds[0])
})

test('the editor and suggestion acceptance carry a kept id into a duplicate', () => {
  const original = 'Alpha\n\nBeta\n'
  const beta = ids(original)[1]
  const kept = apply(original, { op: 'replaceBlock', id: beta, hash: docBlockHash('Beta'), markdown: 'Gamma' })
  const split = splitDocSuggestions(kept)
  const edit = { index: 1, before: 'Gamma', after: 'Alpha' }
  const next = applyDocBodyEdit(split.content, edit)!
  expect(docBlockIds(next, carryDocBlockIds(split.content, split.suggestions, edit, next)!)[1]).toBe(beta)
  const proposed = joinDocSuggestions(split.content, [...split.suggestions, { id: 'sg-test', kind: 'replace', before: 'Gamma', after: 'Alpha', hint: 1 }])
  const accepted = resolveDocSuggestions(proposed, ['sg-test'], 'accept')
  expect(ids(accepted.body)[1]).toBe(beta)
  expect(splitDocSuggestions(accepted.body).content).toBe('Alpha\n\nAlpha\n')
})

test('legacy id records remain deterministic and invalid occurrences never retarget', () => {
  const hash = docBlockHash('Alpha')
  expect(docBlockIds('Alpha\n\nAlpha', [{ id: 'b-legacy', kind: 'id', hash }])).toEqual(['b-legacy', `b-${hash}`])
  const invalid = { id: `b-${hash}`, kind: 'id' as const, hash, occurrence: 3 }
  expect(docBlockIds('Alpha', [invalid])).not.toContain(invalid.id)
  expect(pruneBlockIds('Alpha', [invalid])).toEqual([])
  expect(parseSuggestionLine(suggestionLine({ ...invalid, occurrence: -1 }))).toBeNull()
  const explicit = { id: 'b-later', kind: 'id' as const, hash, occurrence: 1 }
  expect(parseSuggestionLine(suggestionLine(explicit))).toEqual(explicit)
})

test('concurrent duplicate insertions require a decision before an id can be retargeted', () => {
  const initial = 'Alpha\n\nBeta\n\nEnd\n'
  const beta = ids(initial)[1]
  const base = apply(initial, { op: 'replaceBlock', id: beta, hash: docBlockHash('Beta'), markdown: 'Alpha' })
  const mine = apply(base, { op: 'replaceBlock', block: 2, hash: docBlockHash('End'), markdown: 'Finished' })
  const theirs = 'Alpha\n\n' + base
  expect(mergeArtifactBodies('doc', base, mine, theirs)).toMatchObject({ ok: false })
  const deletedDuplicate = base.replace('Alpha\n\n', '')
  expect(mergeArtifactBodies('doc', base, mine, deletedDuplicate)).toMatchObject({ ok: false })
})

test('raw writes refuse uncertain retained duplicate identities, while unrelated edits remain valid', () => {
  const initial = 'Alpha\n\nBeta\n\nEnd\n'
  const tracked = apply(initial, { op: 'replaceBlock', id: ids(initial)[1], hash: docBlockHash('Beta'), markdown: 'Alpha' })
  expect(docBlockIdWriteRefusal(tracked, 'Alpha\n\n' + tracked)).toContain('duplicate paragraphs')
  expect(docBlockIdWriteRefusal(tracked, tracked.replace('End', 'Finished'))).toBeNull()
})

test('an unclosed fence cannot consume a surrounding block and retarget its id', () => {
  const body = 'Alpha\n\nBeta\n\nEnd\n'
  const edit = { index: 0, before: 'Alpha', after: '```' }
  const next = applyDocBodyEdit(body, edit)!
  expect(carryDocBlockIds(body, [], edit, next)).toBeNull()
  expect(applyDocOp(body, { op: 'replaceBlock', block: 0, hash: docBlockHash('Alpha'), markdown: '```' }))
    .toMatchObject({ ok: false, error: expect.stringContaining('guard_mismatch:') })
})

test('a fence edit cannot reassign surrounding identities when the block count stays equal', () => {
  const body = ['Alpha', '```js\none\n\ntwo\n\nthree\n```', 'End'].join('\n\n')
  const edit = { index: 0, before: 'Alpha', after: '```' }
  const next = applyDocBodyEdit(body, edit)!
  expect(docBodyLayout(next).length).toBe(docBodyLayout(body).length)
  expect(carryDocBlockIds(body, [], edit, next)).toBeNull()
  expect(applyDocOp(body, { op: 'replaceBlock', block: 0, hash: docBlockHash('Alpha'), markdown: '```' }))
    .toMatchObject({ ok: false, error: expect.stringContaining('guard_mismatch:') })
})

// Removing a moved duplicate's records must not reassign its ID to the other copy.
test('raw writes cannot drop retained records and reuse duplicate identities', () => {
  const initial = 'Alpha\n\nAlpha\n'
  const moved = apply(initial, { op: 'moveBlock', id: ids(initial)[1], hash: docBlockHash('Alpha'), to: 0 })
  expect(docBlockIdWriteRefusal(moved, splitDocSuggestions(moved).content)).toContain('reuse a paragraph identity')
})
