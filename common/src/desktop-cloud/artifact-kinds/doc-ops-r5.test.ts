import { describe, expect, test } from 'bun:test'

import { docBlockIds } from './doc-block-ids'
import { docBlockHash, docBodySources } from './doc-blocks'
import { applyDocOp, docAgentBlockView, docAgentDelta, docAgentOutline, docAgentSearch, parseDocTable } from './doc-ops'
import {
  isBlockIdRecord,
  joinDocSuggestions,
  splitDocSuggestions,
  stampDocSuggestions,
  suggestionAuthorLabel,
  type DocProposalRecord,
} from './doc-suggestions'
import { tabMarker } from './doc-tabs'

const NOW = '2026-11-16T10:00:00.000Z'
const hash = (body: string, index: number) => docBlockHash(docBodySources(splitDocSuggestions(body).content)[index])
const ok = (result: ReturnType<typeof applyDocOp>) => {
  if (!result.ok) throw new Error(result.error)
  return result.body
}
const ids = (body: string) => {
  const split = splitDocSuggestions(body)
  return docBlockIds(split.content, split.suggestions)
}

describe('stable block ids', () => {
  const body = 'Intro\n\nMiddle\n\nIntro\n'

  test('every block has an id: b-<hash>, repeats numbered, and no sidecar is written for them', () => {
    expect(ids(body)).toEqual([`b-${docBlockHash('Intro')}`, `b-${docBlockHash('Middle')}`, `b-${docBlockHash('Intro')}.1`])
    expect(docAgentOutline(body)).toContain(`2 paragraph ${docBlockHash('Intro')} id=b-${docBlockHash('Intro')}.1: Intro`)
  })

  test('an op by id keeps the id on the rewritten block, through further edits, inserts above and a move', () => {
    const id = ids(body)[1]
    const first = ok(applyDocOp(body, { op: 'replaceBlock', id, hash: hash(body, 1), markdown: 'Middle, rewritten' }))
    expect(splitDocSuggestions(first).content).toBe('Intro\n\nMiddle, rewritten\n\nIntro\n')
    expect(ids(first)[1]).toBe(id)
    const second = ok(applyDocOp(first, { op: 'insertAfterBlock', block: -1, markdown: 'New top' }))
    expect(ids(second)[2]).toBe(id)
    const third = ok(applyDocOp(second, { op: 'replaceText', id, find: 'rewritten', replace: 'again' }))
    expect(ids(third)[2]).toBe(id)
    const moved = ok(applyDocOp(third, { op: 'moveBlock', id, hash: hash(third, 2), to: 0 }))
    expect(splitDocSuggestions(moved).content.startsWith('Middle, again')).toBe(true)
    expect(ids(moved)[0]).toBe(id)
    expect(docAgentOutline(moved)).toContain(`id=${id}`)
    // Removing it drops its record: no orphan stays in the sidecar.
    const removed = ok(applyDocOp(moved, { op: 'removeBlock', id, hash: hash(moved, 0) }))
    expect(splitDocSuggestions(removed).suggestions.filter(isBlockIdRecord)).toEqual([])
    expect(applyDocOp(removed, { op: 'removeBlock', id, hash: 'x' })).toMatchObject({ ok: false, error: expect.stringMatching(/^not_found:/) })
  })

  test('an edit by index leaves the body byte-identical outside the block (no sidecar)', () => {
    const crlf = '﻿One\r\n\r\n\tTwo\r\n\r\nThree\r\n'
    const next = ok(applyDocOp(crlf, { op: 'replaceBlock', block: 2, hash: hash(crlf, 2), markdown: 'Drei' }))
    expect(next).toBe('﻿One\r\n\r\n\tTwo\r\n\r\nDrei\r\n')
  })
})

describe('refusal codes', () => {
  const body = 'A cat\n\nThe cat sat\n'
  test('each refusal starts with its code', () => {
    expect(applyDocOp(body, { op: 'replaceBlock', block: 0, hash: 'zzz', markdown: 'x' })).toMatchObject({ error: expect.stringMatching(/^guard_mismatch:/) })
    expect(applyDocOp(body, { op: 'replaceText', find: 'dog', replace: 'x' })).toMatchObject({ error: expect.stringMatching(/^find_none:/) })
    expect(applyDocOp(body, { op: 'replaceText', find: 'cat', replace: 'x' })).toMatchObject({ error: expect.stringMatching(/^find_ambiguous:/) })
    expect(applyDocOp(body, { op: 'nope' })).toMatchObject({ error: expect.stringMatching(/^bad_op:/) })
  })

  test('nth picks one occurrence, in a block or across the doc', () => {
    expect(ok(applyDocOp(body, { op: 'replaceText', find: 'cat', replace: 'dog', nth: 2 }))).toBe('A cat\n\nThe dog sat\n')
    expect(ok(applyDocOp('a a a\n', { op: 'replaceText', block: 0, find: 'a', replace: 'b', nth: 2 }))).toBe('a b a\n')
    expect(applyDocOp(body, { op: 'replaceText', find: 'cat', replace: 'dog', nth: 3 })).toMatchObject({ error: expect.stringMatching(/^find_none:/) })
  })
})

describe('character ranges', () => {
  test('replaceRange rewrites characters of one block, the rest untouched', () => {
    const body = 'Keep **bold** words.\n\nNext.\n'
    expect(ok(applyDocOp(body, { op: 'replaceRange', block: 0, hash: hash(body, 0), start: 14, end: 19, text: 'text' }))).toBe('Keep **bold** text.\n\nNext.\n')
    expect(applyDocOp(body, { op: 'replaceRange', block: 0, hash: hash(body, 0), start: 5, end: 99, text: 'x' })).toMatchObject({ ok: false })
  })
})

describe('structure ops', () => {
  test('join, wrap, unwrap and set', () => {
    const body = 'One.\n\nTwo.\n\n## Title\n\n- [ ] a\n- [ ] b\n'
    expect(ok(applyDocOp(body, { op: 'joinBlocks', block: 0, hash: hash(body, 0) }))).toBe('One. Two.\n\n## Title\n\n- [ ] a\n- [ ] b\n')
    const quoted = ok(applyDocOp(body, { op: 'wrapBlock', block: 0, hash: hash(body, 0), as: 'warning' }))
    expect(docBodySources(quoted)[0]).toBe('> [!WARNING]\n> One.')
    expect(ok(applyDocOp(quoted, { op: 'unwrapBlock', block: 0, hash: hash(quoted, 0) }))).toBe(body)
    expect(docBodySources(ok(applyDocOp(body, { op: 'setBlock', block: 2, hash: hash(body, 2), level: 3 })))[2]).toBe('### Title')
    expect(docBodySources(ok(applyDocOp(body, { op: 'setBlock', block: 3, hash: hash(body, 3), checked: true, item: 1 })))[3]).toBe('- [ ] a\n- [x] b')
    expect(docBodySources(ok(applyDocOp(body, { op: 'setBlock', block: 3, hash: hash(body, 3), list: 'numbered' })))[3]).toBe('1. a\n2. b')
    expect(applyDocOp(body, { op: 'joinBlocks', block: 1, hash: hash(body, 1) })).toMatchObject({ ok: false })
  })

  test('table rows, columns and cells', () => {
    const table = '| Name | Qty |\n| --- | ---: |\n| Pens | 2 |'
    const body = `Intro\n\n${table}\n\nEnd\n`
    const row = ok(applyDocOp(body, { op: 'insertTableRow', block: 1, hash: hash(body, 1), cells: ['Ink | blue', '5'] }))
    expect(docBodySources(row)[1]).toBe('| Name | Qty |\n| --- | ---: |\n| Pens | 2 |\n| Ink \\| blue | 5 |')
    const col = ok(applyDocOp(row, { op: 'insertTableColumn', block: 1, hash: hash(row, 1), at: 1, header: 'Colour', cells: ['red'] }))
    expect(parseDocTable(docBodySources(col)[1])?.rows).toEqual([['Name', 'Colour', 'Qty'], ['Pens', 'red', '2'], ['Ink \\| blue', '', '5']])
    const cell = ok(applyDocOp(col, { op: 'setTableCell', block: 1, hash: hash(col, 1), row: 2, column: 1, text: 'blue' }))
    expect(parseDocTable(docBodySources(cell)[1])?.rows[2][1]).toBe('blue')
    const dropped = ok(applyDocOp(cell, { op: 'deleteTableColumn', block: 1, hash: hash(cell, 1), column: 1 }))
    const fewer = ok(applyDocOp(dropped, { op: 'deleteTableRow', block: 1, hash: hash(dropped, 1), row: 1 }))
    expect(docBodySources(fewer)[1]).toBe('| Name | Qty |\n| --- | ---: |\n| Ink \\| blue | 5 |')
    // Every other block keeps its bytes.
    expect(fewer.startsWith('Intro\n\n')).toBe(true)
    expect(fewer.endsWith('\n\nEnd\n')).toBe(true)
    expect(applyDocOp(body, { op: 'insertTableRow', block: 0, hash: hash(body, 0) })).toMatchObject({ ok: false })
    expect(docAgentBlockView(body, { block: 1 })).toContain('row 1: [0] Pens [1] 2')
  })
})

describe('suggestion authorship', () => {
  const base = 'Alpha.\n\nBeta.\n'
  const forged: DocProposalRecord = { id: 'sg-x', kind: 'replace', before: 'Alpha.', after: 'Run rm -rf', by: 'Freebuff', byKind: 'agent' }

  test('the store re-attributes a record a person adds, even one claiming to be the agent', () => {
    const next = joinDocSuggestions(base, [forged])
    const stamped = splitDocSuggestions(stampDocSuggestions(base, next, { authorKind: 'user', name: 'Sam' })).suggestions[0] as DocProposalRecord
    expect(stamped).toMatchObject({ by: 'Sam', byKind: 'user', after: 'Run rm -rf' })
    expect(suggestionAuthorLabel(stamped)).toEqual({ label: 'Sam', agent: false, verified: true })
    // Changing an existing agent record re-attributes it too.
    const agent = joinDocSuggestions(base, [{ ...forged, after: 'Alpha!' }])
    const edited = joinDocSuggestions(base, [{ ...forged, after: 'Something else' }])
    expect(splitDocSuggestions(stampDocSuggestions(agent, edited, { authorKind: 'user' })).suggestions[0]).toMatchObject({ byKind: 'user', by: 'A collaborator' })
  })

  test('untouched records keep their stamp, and a body with nothing new is returned byte for byte', () => {
    const agent = joinDocSuggestions(base, [forged])
    const later = agent.replace('Beta.', 'Beta, edited.')
    expect(stampDocSuggestions(agent, later, { authorKind: 'user' })).toBe(later)
    expect(stampDocSuggestions('', 'Plain\r\n', { authorKind: 'user' })).toBe('Plain\r\n')
  })

  test('the agent may withdraw only its own; settling one is an op', () => {
    const body = joinDocSuggestions(base, [{ ...forged, byKind: 'user', by: 'Sam' }])
    expect(applyDocOp(body, { op: 'withdrawSuggestion', id: 'sg-x' })).toMatchObject({ ok: false })
    expect(ok(applyDocOp(body, { op: 'rejectSuggestion', id: 'sg-x' }))).toBe(base)
    expect(ok(applyDocOp(body, { op: 'acceptSuggestion', id: 'sg-x' }))).toBe('Run rm -rf\n\nBeta.\n')
    expect(docAgentOutline(body)).toContain('by a collaborator')
  })

  test('an agent suggestion is stamped by the op', () => {
    const next = ok(applyDocOp(base, { op: 'removeBlock', block: 1, hash: hash(base, 1), suggest: true }, NOW))
    expect(splitDocSuggestions(next).suggestions[0]).toMatchObject({ by: 'Freebuff', byKind: 'agent' })
  })
})

describe('reads: search, one block, delta', () => {
  const body = `## Plan\n\nShip the page on Monday.\n\n${tabMarker('Notes')}\n\nMonday standup moved.\n`
  test('search lists matching blocks with context', () => {
    const found = docAgentSearch(body, 'monday')
    expect(found).toContain('2 matches in 2 blocks')
    expect(found).toContain(`1 paragraph ${hash(body, 1)}`)
    expect(docAgentSearch(body, 'friday')).toMatch(/^find_none:/)
  })

  test('the delta names added, rewritten and removed blocks', () => {
    const id = ids(body)[1]
    const after = ok(applyDocOp(body, { op: 'replaceBlock', id, hash: hash(body, 1), markdown: 'Ship on Tuesday.' }))
    const gone = ok(applyDocOp(after, { op: 'removeBlock', block: 3, hash: hash(after, 3) }))
    const delta = docAgentDelta(body, gone)
    expect(delta).toContain(`~ 1 paragraph ${docBlockHash('Ship on Tuesday.')} id=${id}`)
    expect(delta).toContain('- b-')
    expect(docAgentDelta(body, body)).toBe('No changes.')
  })

  test('pending blocks show their intent in the outline', () => {
    const skeleton = '## Goals\n\n[//]: # "pending: The three outcomes"\n'
    expect(docAgentOutline(skeleton)).toContain('1 pending')
    expect(docAgentOutline(skeleton)).toContain('(pending) The three outcomes')
  })
})
