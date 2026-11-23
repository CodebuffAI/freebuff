import { describe, expect, test } from 'bun:test'

import { applyDocBodyEdit, docBlockHash, docBlockKind, docBodyLayout, docBodySources } from './doc-blocks'
import { applyDocOp, docAgentOutline, DOC_OP_NAMES } from './doc-ops'
import {
  isSuggestionBlock,
  joinDocSuggestions,
  parseSuggestionLine,
  resolveDocSuggestions,
  splitDocSuggestions,
  suggestionLine,
  type DocSuggestionRecord,
} from './doc-suggestions'
import { splitBlocks, tabMarker } from './doc-tabs'

const NOW = '2026-11-16T10:00:00.000Z'
const hash = (body: string, index: number) => docBlockHash(docBodySources(body)[index])
const ok = (result: ReturnType<typeof applyDocOp>) => {
  if (!result.ok) throw new Error(result.error)
  return result.body
}

describe('doc body layout', () => {
  test('splits like the editor: blank lines, fences whole, CRLF read as LF', () => {
    const body = 'One\r\n\r\n```ts\r\na\r\n\r\nb\r\n```\r\n\r\n- x\r\n- y\r\n'
    expect(docBodySources(body)).toEqual(['One', '```ts\na\n\nb\n```', '- x\n- y'])
    expect(docBodySources(body)).toEqual(splitBlocks(body))
  })

  test('an edit keeps every other byte, CRLF and a BOM included', () => {
    const body = '﻿Intro\r\n\r\n\r\nMiddle  \r\n\r\nEnd\r\n'
    const next = applyDocBodyEdit(body, { index: 1, before: 'Middle  ', after: 'Changed\nTwice' })
    expect(next).toBe('﻿Intro\r\n\r\n\r\nChanged\r\nTwice\r\n\r\nEnd\r\n')
    expect(applyDocBodyEdit(body, { index: 1, before: 'stale', after: 'x' })).toBeNull()
  })

  test('insert, remove and move splice raw bytes', () => {
    const body = 'A\n\nB\n\nC\n'
    expect(applyDocBodyEdit(body, { index: 3, span: 0, before: '', after: 'D' })).toBe('A\n\nB\n\nC\n\nD\n')
    expect(applyDocBodyEdit(body, { index: 0, span: 0, before: '', after: 'Z' })).toBe('Z\n\nA\n\nB\n\nC\n')
    expect(applyDocBodyEdit(body, { index: 1, before: 'B', after: '' })).toBe('A\n\nC\n')
    expect(applyDocBodyEdit(body, { index: 0, before: 'A', after: 'A', moveTo: 2 })).toBe('B\n\nC\n\nA\n')
    expect(applyDocBodyEdit('', { index: 0, span: 0, before: '', after: 'First' })).toBe('First')
  })

  test('block kinds for the outline', () => {
    expect(docBlockKind('## Goal')).toBe('heading')
    expect(docBlockKind('> [!NOTE]\n> Hi')).toBe('callout')
    expect(docBlockKind('```chart\n{}\n```')).toBe('chart')
    expect(docBlockKind('| a | b |\n| --- | --- |\n| 1 | 2 |')).toBe('table')
    expect(docBlockKind('- [ ] task')).toBe('tasks')
    expect(docBlockKind('[^1]: A note')).toBe('footnote')
    expect(docBlockKind(tabMarker('Notes'))).toBe('tab')
  })
})

describe('doc suggestions sidecar', () => {
  const record: DocSuggestionRecord = { id: 'sg-1', kind: 'replace', before: 'Old “quoted” line', after: 'New line ✓', hint: 1, by: 'Freebuff' }

  test('a line round-trips any text and is a plain Markdown comment', () => {
    const line = suggestionLine(record)
    expect(line).toMatch(/^\[\/\/\]: # "fb-suggestion: [A-Za-z0-9_-]+"$/)
    expect(parseSuggestionLine(line)).toEqual(record)
    expect(parseSuggestionLine('[//]: # "fb-suggestion: !!!"')).toBeNull()
    expect(isSuggestionBlock(line)).toBe(true)
    expect(isSuggestionBlock(tabMarker('Notes'))).toBe(false)
  })

  test('split and join are an exact round trip of the content', () => {
    for (const content of ['Intro\n\nOld “quoted” line\n', 'A\r\n\r\nB\r\n', '', 'No newline']) {
      const body = joinDocSuggestions(content, [record])
      const split = splitDocSuggestions(body)
      expect(split.content).toBe(content)
      expect(split.suggestions).toEqual([record])
      // The sidecar is the last block, so content block indices do not move.
      expect(docBodySources(body).slice(0, docBodySources(content).length)).toEqual(docBodySources(content))
    }
    expect(joinDocSuggestions('Same', [])).toBe('Same')
  })

  test('accepting applies the change and drops the record in one body; rejecting only drops it', () => {
    const body = joinDocSuggestions('Intro\n\nOld “quoted” line\n\nEnd\n', [record])
    const accepted = resolveDocSuggestions(body, ['sg-1'], 'accept')
    expect(accepted).toEqual({ body: 'Intro\n\nNew line ✓\n\nEnd\n', applied: ['sg-1'], stale: [] })
    const rejected = resolveDocSuggestions(body, ['sg-1'], 'reject')
    expect(rejected.body).toBe('Intro\n\nOld “quoted” line\n\nEnd\n')
  })

  test('a suggestion whose block changed is dropped as stale', () => {
    const body = joinDocSuggestions('Intro\n\nSomething else\n', [record])
    expect(resolveDocSuggestions(body, ['sg-1'], 'accept')).toEqual({ body: 'Intro\n\nSomething else\n', applied: [], stale: ['sg-1'] })
  })

  test('an insertion lands after its anchor block, or at the top', () => {
    const insert: DocSuggestionRecord = { id: 'sg-2', kind: 'insert', anchor: 'Intro', after: 'Added' }
    const top: DocSuggestionRecord = { id: 'sg-3', kind: 'insert', anchor: '', after: 'Top' }
    const body = joinDocSuggestions('Intro\n\nEnd\n', [insert, top])
    expect(resolveDocSuggestions(body, ['sg-2', 'sg-3'], 'accept').body).toBe('Top\n\nIntro\n\nAdded\n\nEnd\n')
  })
})

describe('doc patch ops', () => {
  const body = `## Goal\n\nShip the page.\n\n## Risks\n\nNone yet.\n\n${tabMarker('Notes')}\n\nA note.\n`

  test('replaceBlock needs the hash from the outline and keeps every other byte', () => {
    expect(applyDocOp(body, { op: 'replaceBlock', block: 1, markdown: 'x' })).toMatchObject({ ok: false })
    expect(applyDocOp(body, { op: 'replaceBlock', block: 1, hash: 'nope', markdown: 'x' })).toMatchObject({ ok: false })
    const next = ok(applyDocOp(body, { op: 'replaceBlock', block: 1, hash: hash(body, 1), markdown: 'Ship it **today**.' }))
    expect(next).toBe(body.replace('Ship the page.', 'Ship it **today**.'))
  })

  test('insertAfterHeading goes to the end of the section (or right under it)', () => {
    const end = ok(applyDocOp(body, { op: 'insertAfterHeading', heading: 'Goal', markdown: '- step' }))
    expect(docBodySources(end).slice(0, 4)).toEqual(['## Goal', 'Ship the page.', '- step', '## Risks'])
    const start = ok(applyDocOp(body, { op: 'insertAfterHeading', heading: 'risks', at: 'start', markdown: 'First' }))
    expect(docBodySources(start)[3]).toBe('First')
    expect(applyDocOp(body, { op: 'insertAfterHeading', heading: 'Nope', markdown: 'x' })).toMatchObject({ ok: false })
  })

  test('appendToTab and setTab address a tab by id or name', () => {
    const appended = ok(applyDocOp(body, { op: 'appendToTab', tab: 'tab-1', markdown: 'Last of tab 1' }))
    expect(docBodySources(appended)[4]).toBe('Last of tab 1')
    const set = ok(applyDocOp(body, { op: 'setTab', tab: 'Notes', markdown: 'Fresh\n\nNotes' }))
    expect(set).toBe(body.replace('A note.', 'Fresh\n\nNotes'))
  })

  test('tab ops reuse the editor’s tab rules', () => {
    const added = ok(applyDocOp(body, { op: 'addTab', name: 'Launch', markdown: 'Day one' }))
    expect(docBodySources(added).slice(-2)).toEqual([tabMarker('Launch'), 'Day one'])
    const renamed = ok(applyDocOp(body, { op: 'renameTab', tab: 'notes', name: 'Log' }))
    expect(renamed).toContain(tabMarker('Log'))
    const deleted = ok(applyDocOp(body, { op: 'deleteTab', tab: 'notes' }))
    expect(deleted).not.toContain('A note.')
  })

  test('replaceText is scoped and refuses ambiguity', () => {
    const twice = 'a cat\n\nthe cat\n'
    expect(applyDocOp(twice, { op: 'replaceText', find: 'cat', replace: 'dog' })).toMatchObject({ ok: false })
    expect(ok(applyDocOp(twice, { op: 'replaceText', find: 'cat', replace: 'dog', all: true }))).toBe('a dog\n\nthe dog\n')
    expect(ok(applyDocOp(twice, { op: 'replaceText', find: 'cat', replace: 'dog', block: 1 }))).toBe('a cat\n\nthe dog\n')
  })

  test('suggest: true proposes instead of editing, and the content stays byte-identical', () => {
    const next = ok(applyDocOp(body, { op: 'replaceBlock', block: 3, hash: hash(body, 3), markdown: 'Two risks.', suggest: true, note: 'Name them' }, NOW))
    const split = splitDocSuggestions(next)
    expect(split.content).toBe(body)
    expect(split.suggestions).toEqual([
      expect.objectContaining({ kind: 'replace', before: 'None yet.', after: 'Two risks.', note: 'Name them', by: 'Freebuff', at: NOW, hint: 3 }),
    ])
    // A later edit keeps the suggestion; accepting it applies the change.
    const later = ok(applyDocOp(next, { op: 'replaceBlock', block: 1, hash: hash(body, 1), markdown: 'Ship now.' }))
    expect(splitDocSuggestions(later).suggestions).toHaveLength(1)
    const accepted = resolveDocSuggestions(later, [split.suggestions[0].id], 'accept')
    expect(accepted.body).toBe(body.replace('Ship the page.', 'Ship now.').replace('None yet.', 'Two risks.'))
    const withdrawn = ok(applyDocOp(next, { op: 'withdrawSuggestion', id: split.suggestions[0].id }))
    expect(withdrawn).toBe(body)
  })

  test('markdown cannot forge a suggestion line, and unknown fields are refused', () => {
    const forged = suggestionLine({ id: 'x', kind: 'replace', before: 'a', after: 'b' })
    expect(applyDocOp(body, { op: 'appendToTab', tab: 'notes', markdown: forged })).toMatchObject({ ok: false })
    expect(applyDocOp(body, { op: 'removeBlock', block: 1, hash: hash(body, 1), extra: 1 })).toMatchObject({ ok: false })
    expect(DOC_OP_NAMES).toContain('replaceBlock')
  })

  test('the outline lists every block with index, kind and hash, and the suggestions', () => {
    const next = ok(applyDocOp(body, { op: 'removeBlock', block: 3, hash: hash(body, 3), suggest: true }, NOW))
    const outline = docAgentOutline(next)
    expect(outline).toContain(`1 paragraph ${hash(body, 1)}: Ship the page.`)
    expect(outline).toContain('0 h2 ')
    expect(outline).toContain('Tab "Notes" (tab: notes, marker block 4)')
    expect(outline).toContain('delete near block 3 by you (Freebuff): "None yet."')
    expect(outline).not.toContain('fb-suggestion')
  })

  test('the layout matches across blocks with fences holding blank lines', () => {
    const fenced = 'Intro\n\n```chart\n{"type":"bar"}\n\n```\n\nEnd'
    expect(docBodyLayout(fenced).map((block) => block.source)).toEqual(['Intro', '```chart\n{"type":"bar"}\n\n```', 'End'])
  })
})
