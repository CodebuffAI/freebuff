import { describe, expect, test } from 'bun:test'

import { describeArtifactDiff, diffArtifactBodies, restoreArtifactChange, wordDiff, type ArtifactDiff, type ArtifactDiffChange } from './artifact-diff'
import { parseDashboard } from './artifact-kinds/data'
import { DESIGN_EXAMPLE, validateDesign } from './artifact-kinds/design'
import { docBlockIds } from './artifact-kinds/doc-block-ids'
import { docBlockHash } from './artifact-kinds/doc-blocks'
import { applyDocOp } from './artifact-kinds/doc-ops'
import { joinDocSuggestions, splitDocSuggestions, type DocSuggestionRecord } from './artifact-kinds/doc-suggestions'
import { tabMarker } from './artifact-kinds/doc-tabs'
import { parseWorkbook } from './artifact-kinds/sheet'
import { parseDeck } from './artifact-kinds/slides'
import { WHITEBOARD_EXAMPLE, parseBoard } from './artifact-kinds/whiteboard'

import type { ArtifactKind } from './artifacts'

type Json = Record<string, unknown>

const json = (value: unknown) => JSON.stringify(value)
const clone = <T>(value: T): T => structuredClone(value)

function diff(kind: ArtifactKind, before: unknown, after: unknown, options?: { cap?: number; rowSamples?: number }): ArtifactDiff {
  return diffArtifactBodies(kind, typeof before === 'string' ? before : json(before), typeof after === 'string' ? after : json(after), options)
}

function change(d: ArtifactDiff, id: string): ArtifactDiffChange {
  const found = d.changes.find((c) => c.id === id)
  if (!found) throw new Error(`no change ${id} in ${d.changes.map((c) => c.id).join(', ')}`)
  return found
}

function restore(kind: ArtifactKind, before: unknown, after: unknown, current: unknown, id: string): string {
  const result = restoreArtifactChange(kind, json(before), json(after), json(current), id)
  if (!result.ok) throw new Error(`expected a restore, got: ${result.reason}`)
  return result.body
}

function refused(kind: ArtifactKind, before: unknown, after: unknown, current: unknown, id: string): string {
  const result = restoreArtifactChange(kind, json(before), json(after), json(current), id)
  if (result.ok) throw new Error(`expected a refusal, got ${result.body}`)
  return result.reason
}

const joined = (segments: { op: string; text: string }[], keep: 'before' | 'after') =>
  segments.filter((s) => s.op === 'same' || s.op === (keep === 'before' ? 'del' : 'add')).map((s) => s.text).join('')

// ---------------------------------------------------------------------------------------------

describe('wordDiff', () => {
  test('marks changed words and keeps whitespace', () => {
    const segments = wordDiff('the quick brown fox', 'the slow brown fox jumps')
    expect(segments).toEqual([
      { op: 'same', text: 'the ' },
      { op: 'del', text: 'quick' },
      { op: 'add', text: 'slow' },
      { op: 'same', text: ' brown fox' },
      { op: 'add', text: ' jumps' },
    ])
  })

  test('round-trips both sides', () => {
    const a = 'Line one\n\nline  two with   spaces'
    const b = 'Line 1\nline two with spaces and more'
    const segments = wordDiff(a, b)
    expect(joined(segments, 'before')).toBe(a)
    expect(joined(segments, 'after')).toBe(b)
  })

  test('empty and equal inputs', () => {
    expect(wordDiff('', '')).toEqual([])
    expect(wordDiff('same', 'same')).toEqual([{ op: 'same', text: 'same' }])
    expect(wordDiff('', 'new')).toEqual([{ op: 'add', text: 'new' }])
    expect(wordDiff('old', '')).toEqual([{ op: 'del', text: 'old' }])
  })

  test('falls back to a whole-middle replace past the LCS cap, keeping prefix and suffix', () => {
    const a = `start ${Array.from({ length: 600 }, (_v, i) => `a${i}`).join(' ')} end`
    const b = `start ${Array.from({ length: 600 }, (_v, i) => `b${i}`).join(' ')} end`
    const segments = wordDiff(a, b)
    expect(segments[0]).toEqual({ op: 'same', text: 'start ' })
    expect(segments.at(-1)).toEqual({ op: 'same', text: ' end' })
    expect(segments.filter((s) => s.op === 'del')).toHaveLength(1)
    expect(joined(segments, 'before')).toBe(a)
    expect(joined(segments, 'after')).toBe(b)
  })
})

// ---------------------------------------------------------------------------------------------

describe('doc', () => {
  const before = '# Intro\n\nFirst paragraph here.\n\nSecond paragraph.\n\n- a\n- b\n'

  test('identical bodies: no changes', () => {
    const d = diff('doc', before, before)
    expect(d.ok).toBe(true)
    expect(d.changes).toEqual([])
    expect(d.summary).toBe('No changes')
  })

  test('an edited block is changed with a word diff; an inserted one is added', () => {
    const after = '# Intro\n\nFirst paragraph there.\n\nNew one.\n\nSecond paragraph.\n\n- a\n- b\n'
    const d = diff('doc', before, after)
    // LCS aligns "Second paragraph." so the edit and insertion form one hunk: paired by position.
    const edited = change(d, 'block:2')
    expect(edited.op).toBe('changed')
    expect(edited.label).toBe('Paragraph 2')
    expect(edited.before).toBe('First paragraph here.')
    expect(edited.words?.some((w) => w.op === 'del' && w.text === 'here.')).toBe(true)
    expect(change(d, 'block:3').op).toBe('added')
    expect(d.summary).toBe('1 block changed, 1 added')
    expect(d.counts).toEqual([{ unit: 'block', added: 1, removed: 0, changed: 1, moved: 0, renamed: 0 }])
  })

  test('removed blocks and block labels', () => {
    const after = '# Intro\n\n- a\n- b\n'
    const d = diff('doc', before, after)
    expect(d.changes.map((c) => [c.op, c.label])).toEqual([
      ['removed', 'Paragraph 2'],
      ['removed', 'Paragraph 3'],
    ])
    const headed = diff('doc', '# Intro\n\nx', '# Intro now\n\nx')
    expect(headed.changes[0].label).toBe('Heading “Intro now”')
    expect(diff('doc', 'x\n\n```\ncode\n```', 'x\n\n```\ncode2\n```').changes[0].label).toBe('Code block 2')
    expect(diff('doc', 'x\n\n| a |\n|---|', 'x\n\n| b |\n|---|').changes[0].label).toBe('Table 2')
    expect(diff('doc', 'x\n\n- a', 'x\n\n- b').changes[0].label).toBe('List 2')
  })

  test('the suggestions sidecar is not a block', () => {
    const record: DocSuggestionRecord = { id: 's1', kind: 'replace', before: 'Second paragraph.', after: 'Second.', by: 'Ann' } as DocSuggestionRecord
    const withSidecar = joinDocSuggestions(before, [record])
    expect(splitDocSuggestions(withSidecar).suggestions).toHaveLength(1)
    expect(diff('doc', before, withSidecar).changes).toEqual([])
    const edited = joinDocSuggestions(before.replace('Second paragraph.', 'Second para.'), [record])
    expect(diff('doc', withSidecar, edited).changes.map((c) => c.id)).toEqual(['block:3'])
  })

  test('tabs: a renamed tab is renamed, an added tab is added, blocks group by tab', () => {
    const b = ['Intro text', tabMarker('Launch'), 'Launch notes', tabMarker('Risks'), 'Risk one'].join('\n\n')
    const a = ['Intro text', tabMarker('Launch plan'), 'Launch notes edited', tabMarker('Risks'), 'Risk one', tabMarker('Extra')].join('\n\n')
    const d = diff('doc', b, a)
    const renamed = d.changes.find((c) => c.unit === 'tab' && c.op === 'renamed')
    expect(renamed).toMatchObject({ id: 'tab:launch-plan', before: 'Launch', after: 'Launch plan', label: 'Tab “Launch plan”' })
    expect(d.changes.find((c) => c.unit === 'tab' && c.op === 'added')).toMatchObject({ id: 'tab:extra', label: 'Tab “Extra”' })
    expect(d.changes.find((c) => c.unit === 'block')).toMatchObject({ op: 'changed', group: 'Launch plan' })
  })

  test('restore a changed block, onto a current that moved on, keeping the sidecar', () => {
    const after = before.replace('First paragraph here.', 'First paragraph there.')
    const record = { id: 's9', kind: 'insert', anchor: '# Intro', after: 'Hi', by: 'Ann' } as DocSuggestionRecord
    const current = joinDocSuggestions(`${after}\nA later paragraph.\n`.replace('- a\n- b\n\nA', '- a\n- b\n\nA'), [record])
    const result = restoreArtifactChange('doc', before, after, current, 'block:2')
    if (!result.ok) throw new Error(result.reason)
    expect(result.body).toContain('First paragraph here.')
    expect(result.body).not.toContain('there.')
    expect(result.body).toContain('A later paragraph.')
    expect(splitDocSuggestions(result.body).suggestions.map((s) => s.id)).toEqual(['s9'])
  })

  test('restore a removed block after its old neighbour, and an added block out', () => {
    const after = '# Intro\n\nSecond paragraph.\n\n- a\n- b\n\nTail.\n'
    const d = diff('doc', before, after)
    const removed = d.changes.find((c) => c.op === 'removed')
    const added = d.changes.find((c) => c.op === 'added')
    if (!removed || !added) throw new Error('expected a removed and an added block')
    const back = restoreArtifactChange('doc', before, after, after, removed.id)
    if (!back.ok) throw new Error(back.reason)
    expect(back.body).toBe('# Intro\n\nFirst paragraph here.\n\nSecond paragraph.\n\n- a\n- b\n\nTail.\n')
    const out = restoreArtifactChange('doc', before, after, after, added.id)
    if (!out.ok) throw new Error(out.reason)
    expect(out.body).toBe('# Intro\n\nSecond paragraph.\n\n- a\n- b\n')
  })

  test('restoring a deleted duplicate preserves the surviving paragraph identity', () => {
    const initial = 'Alpha\n\nSep\n\nAlpha\n\nEnd\n'
    const originalIds = docBlockIds(initial, [])
    const removed = applyDocOp(initial, { op: 'removeBlock', id: originalIds[0], hash: docBlockHash('Alpha') })
    if (!removed.ok) throw new Error(removed.error)
    const result = restoreArtifactChange('doc', initial, removed.body, removed.body, 'block:1-removed')
    if (!result.ok) throw new Error(result.reason)
    const restored = splitDocSuggestions(result.body)
    expect(restored.content).toBe(initial)
    expect(docBlockIds(restored.content, restored.suggestions)).toEqual(originalIds)
    const edited = applyDocOp(result.body, { op: 'replaceBlock', id: originalIds[2], hash: docBlockHash('Alpha'), markdown: 'Changed' })
    if (!edited.ok) throw new Error(edited.error)
    expect(splitDocSuggestions(edited.body).content).toBe('Alpha\n\nSep\n\nChanged\n\nEnd\n')
  })

  test('restoring changed text into a duplicate keeps the changed block identity', () => {
    const initial = 'Alpha\n\nSep\n\nAlpha\n\nEnd\n'
    const originalIds = docBlockIds(initial, [])
    const changed = applyDocOp(initial, { op: 'replaceBlock', id: originalIds[2], hash: docBlockHash('Alpha'), markdown: 'Gamma' })
    if (!changed.ok) throw new Error(changed.error)
    const result = restoreArtifactChange('doc', initial, changed.body, changed.body, 'block:3')
    if (!result.ok) throw new Error(result.reason)
    const restored = splitDocSuggestions(result.body)
    expect(restored.content).toBe(initial)
    expect(docBlockIds(restored.content, restored.suggestions)).toEqual(originalIds)
  })

  test('restore refusals: block edited again, duplicated, or already back', () => {
    const after = before.replace('First paragraph here.', 'First paragraph there.')
    const again = after.replace('there.', 'everywhere.')
    const r1 = restoreArtifactChange('doc', before, after, again, 'block:2')
    expect(r1.ok).toBe(false)
    const dup = `${after}\nFirst paragraph there.\n`
    const r2 = restoreArtifactChange('doc', before, after, dup, 'block:2')
    expect(r2.ok ? '' : r2.reason).toContain('more than once')
    const r3 = restoreArtifactChange('doc', before, after, before, 'block:2')
    expect(r3.ok).toBe(false)
    expect(restoreArtifactChange('doc', before, after, after, 'block:99').ok).toBe(false)
  })

  test('restore a renamed tab marker', () => {
    const b = ['Intro', tabMarker('Launch'), 'Notes'].join('\n\n')
    const a = ['Intro', tabMarker('Launch plan'), 'Notes'].join('\n\n')
    const result = restoreArtifactChange('doc', b, a, a, 'tab:launch-plan')
    if (!result.ok) throw new Error(result.reason)
    expect(result.body).toBe(b)
  })

  test('CRLF bodies keep their line endings', () => {
    const b = 'One\r\n\r\nTwo\r\n'
    const a = 'One\r\n\r\nTwo edited\r\n'
    const result = restoreArtifactChange('doc', b, a, a, 'block:2')
    if (!result.ok) throw new Error(result.reason)
    expect(result.body).toBe(b)
  })
})

// ---------------------------------------------------------------------------------------------

const deck = () => ({
  version: 1,
  title: 'Q3 deck',
  aspect: '16:9',
  slides: [
    { id: 'cover', layout: 'title', title: 'Q3 review' },
    { id: 'pricing', layout: 'title-body', title: 'Pricing', body: 'Plans start at $10', notes: 'Mention discounts' },
    {
      id: 'team',
      layout: 'title-body',
      title: 'Team',
      body: 'We hired three people',
      elements: [
        { id: 'box', type: 'rect', x: 10, y: 10, w: 20, h: 20, text: 'Callout' },
        { id: 'label', type: 'text', x: 50, y: 50, w: 30, h: 10, text: 'Hello' },
      ],
    },
  ],
})

describe('slides', () => {
  test('the fixture is a valid deck', () => {
    expect(parseDeck(deck()).ok).toBe(true)
  })

  test('a changed slide lists fields with a word diff', () => {
    const b = deck()
    const a = deck()
    a.slides[1].title = 'Pricing plans'
    a.slides[1].notes = 'Mention the discounts'
    const d = diff('slides', b, a)
    const c = change(d, 'slide:pricing')
    expect(c).toMatchObject({ unit: 'slide', op: 'changed', label: 'Slide 2 “Pricing plans”', fields: ['title', 'notes'] })
    expect(c.before).toBe('title: Pricing\nnotes: Mention discounts')
    expect(c.words?.some((w) => w.op === 'add' && w.text.includes('plans'))).toBe(true)
    expect(d.summary).toBe('1 slide changed')
  })

  test('reordered slides are moved, not changed; only the slide out of order moves', () => {
    const b = deck()
    const a = deck()
    a.slides = [a.slides[0], a.slides[2], a.slides[1]]
    const d = diff('slides', b, a)
    expect(d.changes).toHaveLength(1)
    expect(d.changes[0]).toMatchObject({ op: 'moved', fields: ['order'] })
    expect(d.summary).toBe('1 slide moved')
  })

  test('added and removed slides, deck settings', () => {
    const b = deck()
    const a = deck()
    a.slides.splice(1, 1)
    a.slides.push({ id: 'end', layout: 'title', title: 'Thanks' })
    a.title = 'Q3 deck v2'
    const d = diff('slides', b, a)
    expect(change(d, 'slide:pricing').op).toBe('removed')
    expect(change(d, 'slide:end')).toMatchObject({ op: 'added', label: 'Slide 3 “Thanks”' })
    expect(change(d, 'title')).toMatchObject({ unit: 'title', op: 'changed', before: 'Q3 deck', after: 'Q3 deck v2' })
  })

  test('elements: moved when only x/y change, changed otherwise, added and removed', () => {
    const b = deck()
    const a = deck()
    const els = a.slides[2].elements ?? []
    els[0].x = 40
    els[1].text = 'Hello there'
    els.push({ id: 'new', type: 'text', x: 1, y: 1, w: 5, h: 5, text: 'New' })
    const d = diff('slides', b, a)
    expect(change(d, 'element:team/box')).toMatchObject({ unit: 'element', op: 'moved', fields: ['x'], group: 'Slide 3 “Team”' })
    expect(change(d, 'element:team/label')).toMatchObject({ op: 'changed', fields: ['text'], before: 'Hello', after: 'Hello there' })
    expect(change(d, 'element:team/new').op).toBe('added')
    // The slide's own fields did not change.
    expect(d.changes.find((c) => c.id === 'slide:team')).toBeUndefined()
  })

  test('restore a changed slide onto a current that moved on, keeping other edits', () => {
    const b = deck()
    const a = deck()
    a.slides[1].title = 'Pricing plans'
    const current = clone(a)
    current.slides[0].title = 'Q3 review (final)'
    current.slides[1].body = 'Plans start at $12'
    const out = JSON.parse(restore('slides', b, a, current, 'slide:pricing'))
    expect(parseDeck(out).ok).toBe(true)
    expect(out.slides[1].title).toBe('Pricing')
    expect(out.slides[1].body).toBe('Plans start at $12')
    expect(out.slides[0].title).toBe('Q3 review (final)')
  })

  test('restore a removed slide at its place, a moved slide back, an added slide out', () => {
    const b = deck()
    const removed = deck()
    removed.slides.splice(1, 1)
    const back = JSON.parse(restore('slides', b, removed, removed, 'slide:pricing'))
    expect(back.slides.map((s: Json) => s.id)).toEqual(['cover', 'pricing', 'team'])
    expect(parseDeck(back).ok).toBe(true)

    const moved = deck()
    moved.slides = [moved.slides[0], moved.slides[2], moved.slides[1]]
    const id = diff('slides', b, moved).changes[0].id
    const unmoved = JSON.parse(restore('slides', b, moved, moved, id))
    expect(unmoved.slides.map((s: Json) => s.id)).toEqual(['cover', 'pricing', 'team'])

    const added = deck()
    added.slides.push({ id: 'end', layout: 'title', title: 'Thanks' })
    const out = JSON.parse(restore('slides', b, added, added, 'slide:end'))
    expect(out.slides.map((s: Json) => s.id)).toEqual(['cover', 'pricing', 'team'])
  })

  test('restore elements and unknown fields survive', () => {
    const b = deck()
    const a = deck()
    const els = a.slides[2].elements ?? []
    els[1].text = 'Hello there'
    const current = { ...clone(a), futureField: { x: 1 } }
    const out = JSON.parse(restore('slides', b, a, current, 'element:team/label'))
    expect(out.slides[2].elements[1].text).toBe('Hello')
    expect(out.futureField).toEqual({ x: 1 })
  })

  test('refusals: the last slide, a slide gone from current, one already back', () => {
    const one = { version: 1, title: 'D', aspect: '16:9', slides: [{ id: 'a', layout: 'title', title: 'A' }] }
    const two = { ...one, slides: [...one.slides, { id: 'b', layout: 'title', title: 'B' }] }
    const onlyB = { ...one, slides: [{ id: 'b', layout: 'title', title: 'B' }] }
    expect(refused('slides', one, two, onlyB, 'slide:b')).toContain('last')
    const b = deck()
    const a = deck()
    a.slides[1].title = 'Pricing plans'
    const gone = deck()
    gone.slides.splice(1, 1)
    expect(refused('slides', b, a, gone, 'slide:pricing')).toContain('no longer')
    expect(refused('slides', b, a, b, 'slide:pricing')).toContain('Nothing to restore')
  })
})

// ---------------------------------------------------------------------------------------------

const workbook = () => ({
  version: 1,
  title: 'Budget',
  tabs: [
    {
      id: 'sheet-1',
      name: 'Sheet1',
      cells: {
        A1: { v: 'Item', bold: true },
        B1: { v: 'Cost', bold: true },
        A2: { v: 'Rent' },
        B2: { v: 1000 },
        A3: { v: 'Food' },
        B3: { v: 300 },
        A4: { v: 'Total' },
        B4: { f: '=SUM(B2:B3)' },
      } as Record<string, Json>,
    },
    { id: 'notes', name: 'Notes', cells: { A1: { v: 'hello' } } as Record<string, Json> },
  ],
})

describe('sheet', () => {
  test('the fixture is a valid workbook', () => {
    expect(parseWorkbook(workbook()).ok).toBe(true)
  })

  test('cell value and formula changes, old → new', () => {
    const b = workbook()
    const a = workbook()
    a.tabs[0].cells.B2 = { v: 1200 }
    a.tabs[0].cells.B3 = { f: '=B2*0.3' }
    const d = diff('sheet', b, a)
    expect(change(d, 'cell:sheet-1!B2')).toMatchObject({ unit: 'cell', op: 'changed', label: 'Cell Sheet1!B2', before: '1000', after: '1200', group: 'Sheet1' })
    expect(change(d, 'cell:sheet-1!B3')).toMatchObject({ before: '300', after: '=B2*0.3' })
    expect(d.summary).toBe('2 cells changed')
    expect(describeArtifactDiff('sheet', json(b), json(a))).toContain('- changed Cell Sheet1!B2 — “1000” → “1200”')
  })

  test('an inserted row is one row change, not every cell below it', () => {
    const b = workbook()
    const a = workbook()
    const cells = a.tabs[0].cells
    // Insert a row at 3 ("Gas"), shifting Food and Total down; the SUM range grows.
    a.tabs[0].cells = {
      A1: cells.A1,
      B1: cells.B1,
      A2: cells.A2,
      B2: cells.B2,
      A3: { v: 'Gas' },
      B3: { v: 80 },
      A4: { v: 'Food' },
      B4: { v: 300 },
      A5: { v: 'Total' },
      B5: { f: '=SUM(B2:B4)' },
    }
    const d = diff('sheet', b, a)
    expect(d.changes.map((c) => `${c.unit}:${c.op}`)).toEqual(['row:added'])
    expect(change(d, 'row:sheet-1:3')).toMatchObject({ label: 'Row 3', after: 'A3: Gas | B3: 80', restorable: false })
    expect(d.summary).toBe('1 row added')
  })

  test('a deleted row with an edit below it', () => {
    const b = workbook()
    const a = workbook()
    a.tabs[0].cells = { A1: { v: 'Item', bold: true }, B1: { v: 'Cost', bold: true }, A2: { v: 'Food' }, B2: { v: 350 }, A3: { v: 'Total' }, B3: { f: '=SUM(B2:B2)' } }
    const d = diff('sheet', b, a)
    expect(change(d, 'row:sheet-1:2-removed')).toMatchObject({ op: 'removed', before: 'A2: Rent | B2: 1000' })
    const edited = change(d, 'cell:sheet-1!B2')
    expect(edited).toMatchObject({ before: '300', after: '350', restorable: false })
  })

  test('an inserted column aligns too', () => {
    const b = workbook()
    const a = workbook()
    const shifted: Record<string, Json> = {}
    for (const [address, cell] of Object.entries(b.tabs[0].cells)) {
      const col = address[0] === 'A' ? 'A' : 'C'
      shifted[`${col}${address.slice(1)}`] = cell
    }
    shifted.B1 = { v: 'Note' }
    shifted.B2 = { v: 'monthly' }
    a.tabs[0].cells = shifted
    const d = diff('sheet', b, a)
    expect(d.changes.map((c) => c.id)).toEqual(['column:sheet-1:B'])
  })

  test('format-only changes are counted and listed after value changes', () => {
    const b = workbook()
    const a = workbook()
    a.tabs[0].cells.A2 = { v: 'Rent', italic: true }
    a.tabs[0].cells.B3 = { v: 301 }
    const d = diff('sheet', b, a)
    expect(d.formatOnlyCount).toBe(1)
    expect(d.changes.map((c) => c.id)).toEqual(['cell:sheet-1!B3', 'cell:sheet-1!A2'])
    expect(change(d, 'cell:sheet-1!A2')).toMatchObject({ formatOnly: true, fields: ['italic'] })
    expect(d.summary).toBe('2 cells changed (1 format only)')
  })

  test('a renamed tab is renamed; tab added, removed, moved; tab layout is format', () => {
    const b = workbook()
    const renamed = workbook()
    renamed.tabs[1].name = 'Scratch'
    expect(diff('sheet', b, renamed).changes).toEqual([
      expect.objectContaining({ id: 'tab:notes', unit: 'tab', op: 'renamed', before: 'Notes', after: 'Scratch', label: 'Tab “Scratch”' }),
    ])
    const moved = workbook()
    moved.tabs.reverse()
    expect(diff('sheet', b, moved).changes.map((c) => c.op)).toEqual(['moved'])
    const added = workbook()
    added.tabs.push({ id: 'extra', name: 'Extra', cells: {} })
    expect(change(diff('sheet', b, added), 'tab:extra').op).toBe('added')
    const layout = workbook()
    Object.assign(layout.tabs[0], { frozenRows: 1 })
    expect(change(diff('sheet', b, layout), 'format:sheet-1')).toMatchObject({ unit: 'format', fields: ['frozenRows'] })
  })

  test('cap and omitted', () => {
    const b = workbook()
    const a = workbook()
    for (let r = 10; r < 60; r += 1) a.tabs[1].cells[`B${r}`] = { v: r }
    const d = diff('sheet', b, a, { cap: 5 })
    expect(d.changes).toHaveLength(5)
    expect(d.omitted).toBe(45)
    expect(d.counts[0].added).toBe(50)
    const text = describeArtifactDiff('sheet', json(b), json(a), { maxLines: 3 })
    expect(text.split('\n')).toHaveLength(5)
    expect(text).toContain('…and 47 more')
  })

  test('restore a cell onto a current that moved on', () => {
    const b = workbook()
    const a = workbook()
    a.tabs[0].cells.B2 = { v: 1200 }
    const current = clone(a)
    current.tabs[0].cells.B3 = { v: 999 }
    const out = JSON.parse(restore('sheet', b, a, current, 'cell:sheet-1!B2'))
    expect(parseWorkbook(out).ok).toBe(true)
    expect(out.tabs[0].cells.B2).toEqual({ v: 1000 })
    expect(out.tabs[0].cells.B3).toEqual({ v: 999 })
  })

  test('restore an added cell deletes it; a removed tab comes back; an added tab goes', () => {
    const b = workbook()
    const a = workbook()
    a.tabs[1].cells.C9 = { v: 'x' }
    const out = JSON.parse(restore('sheet', b, a, a, 'cell:notes!C9'))
    expect(out.tabs[1].cells.C9).toBeUndefined()

    const removed = workbook()
    removed.tabs.splice(1, 1)
    const back = JSON.parse(restore('sheet', b, removed, removed, 'tab:notes'))
    expect(back.tabs.map((t: Json) => t.id)).toEqual(['sheet-1', 'notes'])
    expect(parseWorkbook(back).ok).toBe(true)

    const added = workbook()
    added.tabs.push({ id: 'extra', name: 'Extra', cells: {} })
    expect(JSON.parse(restore('sheet', b, added, added, 'tab:extra')).tabs).toHaveLength(2)

    const renamed = workbook()
    renamed.tabs[1].name = 'Scratch'
    expect(JSON.parse(restore('sheet', b, renamed, renamed, 'tab:notes')).tabs[1].name).toBe('Notes')
  })

  test('refusals: cells of a shifted tab, rows moved since, a taken tab name', () => {
    const b = workbook()
    const a = workbook()
    a.tabs[0].cells = { A1: { v: 'Item', bold: true }, B1: { v: 'Cost', bold: true }, A2: { v: 'Food' }, B2: { v: 350 }, A3: { v: 'Total' }, B3: { f: '=SUM(B2:B2)' } }
    expect(refused('sheet', b, a, a, 'cell:sheet-1!B2')).toContain('inserted or deleted')
    expect(refused('sheet', b, a, a, 'row:sheet-1:2-removed')).toContain('inserted or deleted')

    const edited = workbook()
    edited.tabs[0].cells.B3 = { v: 301 }
    const shiftedSince = workbook()
    shiftedSince.tabs[0].cells = { A1: { v: 'Item', bold: true }, B1: { v: 'Cost', bold: true }, A2: { v: 'New' }, B2: { v: 1 }, A3: { v: 'Rent' }, B3: { v: 1000 }, A4: { v: 'Food' }, B4: { v: 301 }, A5: { v: 'Total' }, B5: { f: '=SUM(B2:B4)' } }
    expect(refused('sheet', b, edited, shiftedSince, 'cell:sheet-1!B3')).toContain('moved since')

    const removed = workbook()
    removed.tabs.splice(1, 1)
    const clash = clone(removed)
    clash.tabs.push({ id: 'other', name: 'notes', cells: {} })
    expect(refused('sheet', b, removed, clash, 'tab:notes')).toContain('already named')
  })
})

// ---------------------------------------------------------------------------------------------

const dashboard = () => ({
  version: 1,
  title: 'Sales',
  layout: 'grid',
  sources: [{ id: 'crm', label: 'CRM export' }],
  datasets: [
    {
      id: 'deals',
      sourceId: 'crm',
      title: 'Deals',
      columns: [
        { key: 'id', label: 'Id', type: 'string' },
        { key: 'amount', label: 'Amount', type: 'number' },
      ],
      rows: [
        { id: 'd1', amount: 5 },
        { id: 'd2', amount: 7 },
        { id: 'd3', amount: 9 },
      ] as Record<string, string | number | null>[],
    },
  ],
  blocks: [
    { kind: 'kpi', id: 'total', label: 'Total', datasetId: 'deals', value: { column: 'amount', agg: 'sum' }, format: 'number', sourceId: 'crm' },
    { kind: 'text', id: 'intro', markdown: 'Pipeline overview' },
  ] as Json[],
  filters: [] as Json[],
  params: [] as Json[],
})

describe('data', () => {
  test('the fixture is a valid dashboard', () => {
    const parsed = parseDashboard(dashboard())
    expect(parsed.ok ? [] : parsed.issues).toEqual([])
  })

  test('datasets report the row count and sample changed rows by id', () => {
    const b = dashboard()
    const a = dashboard()
    a.datasets[0].rows[1].amount = 8
    a.datasets[0].rows.push({ id: 'd4', amount: 1 })
    const d = diff('data', b, a, { rowSamples: 3 })
    const c = change(d, 'dataset:deals')
    expect(c).toMatchObject({ unit: 'dataset', op: 'changed', fields: ['rows'], label: 'Dataset “Deals”', before: '3 rows', after: '4 rows' })
    expect(c.detail).toEqual(['rows 3 → 4', 'row id=d2: amount 7 → 8', 'row id=d4 added'])
    expect(diff('data', b, a, { rowSamples: 1 }).changes[0].detail).toEqual(['rows 3 → 4', 'row id=d2: amount 7 → 8'])
    expect(describeArtifactDiff('data', json(b), json(a))).toContain('  row id=d2: amount 7 → 8')
  })

  test('blocks added, removed, changed, moved; sources and params', () => {
    const b = dashboard()
    const a = dashboard()
    a.blocks.reverse()
    a.blocks.push({ kind: 'text', id: 'outro', markdown: 'The end' })
    a.blocks[0] = { ...a.blocks[0], markdown: 'Pipeline overview, weekly' }
    a.sources.push({ id: 'sheet', label: 'Sheet' })
    a.params = [{ id: 'rate', label: 'Rate', default: 1 }]
    const d = diff('data', b, a)
    expect(change(d, 'block:intro')).toMatchObject({ op: 'changed', fields: ['markdown', 'order'], label: 'Text block “Pipeline overview, weekly”' })
    expect(change(d, 'block:outro').op).toBe('added')
    expect(change(d, 'source:sheet').op).toBe('added')
    expect(change(d, 'param:rate')).toMatchObject({ op: 'added', label: 'Parameter “Rate”' })
  })

  test('restore a block, a dataset, an added source; refusals for references', () => {
    const b = dashboard()
    const a = dashboard()
    a.blocks[1] = { ...a.blocks[1], markdown: 'Changed' }
    a.datasets[0].rows[0].amount = 50
    const current = { ...clone(a), subtitle: 'Live' }
    const out1 = JSON.parse(restore('data', b, a, current, 'block:intro'))
    expect(out1.blocks[1].markdown).toBe('Pipeline overview')
    expect(out1.subtitle).toBe('Live')
    expect(parseDashboard(out1).ok).toBe(true)
    const out2 = JSON.parse(restore('data', b, a, current, 'dataset:deals'))
    expect(out2.datasets[0].rows[0].amount).toBe(5)

    const removedKpi = dashboard()
    removedKpi.blocks.splice(0, 1)
    const back = JSON.parse(restore('data', b, removedKpi, removedKpi, 'block:total'))
    expect(back.blocks.map((x: Json) => x.id)).toEqual(['total', 'intro'])
    expect(parseDashboard(back).ok).toBe(true)
    // The KPI needs the dataset, which the current version dropped.
    const noData = { ...clone(removedKpi), datasets: [] }
    expect(refused('data', b, removedKpi, noData, 'block:total')).toContain('dataset "deals"')

    const withSheet = dashboard()
    withSheet.sources.push({ id: 'sheet', label: 'Sheet' })
    expect(JSON.parse(restore('data', b, withSheet, withSheet, 'source:sheet')).sources).toHaveLength(1)
    const used = clone(withSheet)
    used.datasets[0].sourceId = 'sheet'
    expect(refused('data', b, withSheet, used, 'source:sheet')).toContain('still uses it')
  })
})

// ---------------------------------------------------------------------------------------------

const board = () => clone(WHITEBOARD_EXAMPLE) as unknown as { version: 1; title: string; elements: Json[] }

describe('whiteboard', () => {
  test('the fixture is a valid board', () => {
    expect(parseBoard(board()).ok).toBe(true)
  })

  test('moves, text edits, connectors', () => {
    const b = board()
    const a = board()
    const byId = (id: string) => a.elements.find((e) => e.id === id) as Json
    Object.assign(byId('q1'), { x: 60, y: 400 })
    byId('q2').text = 'Offer Google and GitHub sign-in?'
    byId('a2').to = { elementId: 'welcome' }
    a.elements.push({ type: 'note', id: 'q4', x: 0, y: 0, w: 100, h: 100, text: 'New', color: 'green' })
    const d = diff('whiteboard', b, a)
    expect(change(d, 'element:q1')).toMatchObject({ op: 'moved', fields: ['x', 'y'] })
    const edit = change(d, 'element:q2')
    expect(edit).toMatchObject({ op: 'changed', fields: ['text'], label: 'Note “Offer Google and GitHub sign-in?”' })
    expect(edit.words?.some((w) => w.op === 'add')).toBe(true)
    expect(change(d, 'connector:a2')).toMatchObject({ unit: 'connector', op: 'changed', fields: ['to'], label: 'Connector form → welcome' })
    expect(change(d, 'element:q4').op).toBe('added')
    expect(d.summary).toBe('1 connector changed; 1 element changed, 1 added, 1 moved')
  })

  test('restore a moved element and a removed connector', () => {
    const b = board()
    const a = board()
    Object.assign(a.elements.find((e) => e.id === 'q1') as Json, { x: 60 })
    a.elements = a.elements.filter((e) => e.id !== 'a1')
    const out = JSON.parse(restore('whiteboard', b, a, a, 'element:q1'))
    expect(out.elements.find((e: Json) => e.id === 'q1').x).toBe(40)
    const back = JSON.parse(restore('whiteboard', b, a, a, 'connector:a1'))
    expect(back.elements.findIndex((e: Json) => e.id === 'a1')).toBe(5)
    expect(parseBoard(back).ok).toBe(true)
  })

  test('refuse a connector whose bound element is gone; removing an element takes its arrows', () => {
    const b = board()
    const a = board()
    a.elements = a.elements.filter((e) => e.id !== 'a1')
    const current = clone(a)
    current.elements = current.elements.filter((e) => e.id !== 'visit')
    expect(refused('whiteboard', b, a, current, 'connector:a1')).toContain('"visit"')

    const added = board()
    added.elements.push({ type: 'note', id: 'n9', x: 0, y: 0, w: 100, h: 100, text: 'temp', color: 'yellow' })
    added.elements.push({ type: 'arrow', id: 'a9', from: { elementId: 'n9' }, to: { elementId: 'form' }, style: 'solid' })
    const out = JSON.parse(restore('whiteboard', b, added, added, 'element:n9'))
    expect(out.elements.some((e: Json) => e.id === 'n9' || e.id === 'a9')).toBe(false)
    expect(parseBoard(out).ok).toBe(true)
  })
})

// ---------------------------------------------------------------------------------------------

type DesignJson = { boards: Array<Json & { root: Json }>; tokens: { colors: Record<string, string> } } & Json
const design = () => clone(DESIGN_EXAMPLE) as unknown as DesignJson

function findNode(node: Json, id: string): Json | undefined {
  if (node.id === id) return node
  for (const kid of (node.children as Json[] | undefined) ?? []) {
    const found = findNode(kid, id)
    if (found) return found
  }
  return undefined
}
const nodeIn = (d: DesignJson, id: string): Json => {
  for (const b of d.boards) {
    const found = findNode(b.root, id)
    if (found) return found
  }
  throw new Error(`no node ${id}`)
}
const parentOf = (d: DesignJson, id: string): Json => {
  const visit = (node: Json): Json | undefined => {
    const kids = (node.children as Json[] | undefined) ?? []
    if (kids.some((k) => k.id === id)) return node
    for (const kid of kids) {
      const found = visit(kid)
      if (found) return found
    }
    return undefined
  }
  for (const b of d.boards) {
    const found = visit(b.root)
    if (found) return found
  }
  throw new Error(`no parent of ${id}`)
}

describe('design', () => {
  test('the fixture is a valid design', () => {
    const v = validateDesign(design())
    expect(v.ok ? [] : v.errors).toEqual([])
  })

  test('node props, moves between parents, adds and removes; tokens and boards', () => {
    const b = design()
    const a = design()
    nodeIn(a, 'd-headline').text = 'Get paid on time'
    // Move the sign-in button from the links frame into the nav.
    const links = nodeIn(a, 'd-links')
    const signin = (links.children as Json[]).pop() as Json
    ;(nodeIn(a, 'd-nav').children as Json[]).push(signin)
    // Remove the tour button; add a badge.
    const ctas = nodeIn(a, 'd-ctas')
    ctas.children = (ctas.children as Json[]).filter((k) => k.id !== 'd-tour')
    ;(nodeIn(a, 'd-copy').children as Json[]).push({ type: 'text', id: 'd-badge', text: 'New', style: 'small' })
    a.tokens.colors.primary = '#123456'
    a.boards[1].title = 'Phone'
    const d = diff('design', b, a)
    expect(change(d, 'node:d-headline')).toMatchObject({ unit: 'node', op: 'changed', fields: ['text'], group: 'Landing — Desktop' })
    expect(change(d, 'node:d-signin')).toMatchObject({ op: 'moved', fields: ['parent'] })
    expect(change(d, 'node:d-tour').op).toBe('removed')
    expect(change(d, 'node:d-badge').op).toBe('added')
    expect(change(d, 'token:colors.primary')).toMatchObject({ unit: 'token', op: 'changed', before: '#0f766e', after: '#123456' })
    expect(change(d, 'board:phone')).toMatchObject({ unit: 'board', op: 'changed', fields: ['title'] })
  })

  test('a new subtree reports only its top node', () => {
    const b = design()
    const a = design()
    ;(nodeIn(a, 'd-copy').children as Json[]).push({
      type: 'frame',
      id: 'd-box',
      layout: 'stack-v',
      children: [{ type: 'text', id: 'd-box-t', text: 'Inside', style: 'body' }],
    })
    const d = diff('design', b, a)
    expect(d.changes.map((c) => c.id)).toEqual(['node:d-box'])
  })

  test('restore node props, a move, a removal and an addition, each a valid design', () => {
    const b = design()
    const a = design()
    nodeIn(a, 'd-headline').text = 'Get paid on time'
    const links = nodeIn(a, 'd-links')
    const signin = (links.children as Json[]).pop() as Json
    ;(nodeIn(a, 'd-nav').children as Json[]).push(signin)
    const ctas = nodeIn(a, 'd-ctas')
    ctas.children = (ctas.children as Json[]).filter((k) => k.id !== 'd-tour')
    ;(nodeIn(a, 'd-copy').children as Json[]).push({ type: 'text', id: 'd-badge', text: 'New', style: 'small' })
    const current = clone(a)
    nodeIn(current, 'p-headline').text = 'Phone headline'

    const check = (body: string) => {
      const out = JSON.parse(body) as DesignJson
      const v = validateDesign(out)
      expect(v.ok ? [] : v.errors).toEqual([])
      return out
    }
    const props = check(restore('design', b, a, current, 'node:d-headline'))
    expect(nodeIn(props, 'd-headline').text).toBe('Get paid on time, without the follow-up emails')
    expect(nodeIn(props, 'p-headline').text).toBe('Phone headline')
    const moved = check(restore('design', b, a, current, 'node:d-signin'))
    expect(parentOf(moved, 'd-signin').id).toBe('d-links')
    expect((nodeIn(moved, 'd-links').children as Json[]).map((k) => k.id)).toEqual(['d-link-product', 'd-link-pricing', 'd-signin'])
    const removed = check(restore('design', b, a, current, 'node:d-tour'))
    expect((nodeIn(removed, 'd-ctas').children as Json[]).map((k) => k.id)).toEqual(['d-cta', 'd-tour'])
    const added = check(restore('design', b, a, current, 'node:d-badge'))
    expect(() => nodeIn(added, 'd-badge')).toThrow()
  })

  test('refusals: node gone, parent gone, colour still used', () => {
    const b = design()
    const a = design()
    nodeIn(a, 'd-headline').text = 'Get paid on time'
    const gone = clone(a)
    const copy = nodeIn(gone, 'd-copy')
    copy.children = (copy.children as Json[]).filter((k) => k.id !== 'd-headline')
    expect(refused('design', b, a, gone, 'node:d-headline')).toContain('no longer')

    const removed = design()
    const ctas = nodeIn(removed, 'd-ctas')
    ctas.children = (ctas.children as Json[]).filter((k) => k.id !== 'd-tour')
    const noParent = clone(removed)
    const copy2 = nodeIn(noParent, 'd-copy')
    copy2.children = (copy2.children as Json[]).filter((k) => k.id !== 'd-ctas')
    expect(refused('design', b, removed, noParent, 'node:d-tour')).toContain('parent')

    const newColour = design()
    newColour.tokens.colors.brand = '#ff0000'
    nodeIn(newColour, 'd-logo').color = 'brand'
    expect(refused('design', b, newColour, newColour, 'token:colors.brand')).toContain('still used')
  })
})

// ---------------------------------------------------------------------------------------------

describe('unparseable and odd bodies', () => {
  test('an unparseable JSON body is ok:false with one whole-body change', () => {
    for (const kind of ['slides', 'sheet', 'data', 'whiteboard', 'design'] as const) {
      const d = diffArtifactBodies(kind, '{"version":1', json(deck()))
      expect(d.ok).toBe(false)
      expect(d.changes).toEqual([expect.objectContaining({ id: 'body', unit: 'body', op: 'changed', restorable: false })])
      expect(restoreArtifactChange(kind, '{"version":1', json(deck()), json(deck()), 'body').ok).toBe(false)
    }
  })

  test('duplicate ids are not comparable; arrays at the root too', () => {
    const b = deck()
    const a = deck()
    a.slides.push(clone(a.slides[0]))
    expect(diff('slides', b, a).ok).toBe(false)
    expect(diffArtifactBodies('sheet', '[]', '[]').ok).toBe(false)
  })

  test('key order and spacing alone change nothing', () => {
    const b = deck()
    expect(diffArtifactBodies('slides', JSON.stringify(b, null, 2), json(b)).changes).toEqual([])
  })

  test('describeArtifactDiff: summary line and bullets', () => {
    const b = deck()
    const a = deck()
    a.slides[1].title = 'Pricing plans'
    a.slides[1].notes = 'Mention the discounts'
    const text = describeArtifactDiff('slides', json(b), json(a))
    expect(text.split('\n')[0]).toBe('1 slide changed')
    expect(text.split('\n')[1]).toBe('- changed Slide 2 “Pricing plans”: title, notes — “title: Pricing notes: Mention discounts” → “title: Pricing plans notes: Mention the discounts”')
    expect(describeArtifactDiff('doc', 'a', 'a')).toBe('No changes')
    expect(describeArtifactDiff('slides', 'nope', json(a)).split('\n')[0]).toContain('whole body')
  })

  test('sheet: formatting a blank cell is format-only; a defined name blocks removing its tab', () => {
    const b = workbook()
    const a = workbook()
    a.tabs[1].cells.D4 = { bold: true }
    const d = diff('sheet', b, a)
    expect(d.formatOnlyCount).toBe(1)
    expect(change(d, 'cell:notes!D4')).toMatchObject({ op: 'changed', formatOnly: true, fields: ['bold'] })
    expect(JSON.parse(restore('sheet', b, a, a, 'cell:notes!D4')).tabs[1].cells.D4).toBeUndefined()

    const added = workbook()
    added.tabs.push({ id: 'extra', name: 'Extra', cells: {} })
    const named = { ...clone(added), names: [{ name: 'Rng', tab: 'extra', range: 'A1:A2' }] }
    expect(refused('sheet', b, added, named, 'tab:extra')).toContain('defined name')
  })

  test('design: a replaced board root is a board change, restorable', () => {
    const b = design()
    const a = design()
    a.boards[1].root = { type: 'frame', id: 'p-root2', layout: 'stack-v', children: [{ type: 'text', id: 'p-new', text: 'Fresh', style: 'body' }] }
    const d = diff('design', b, a)
    expect(d.changes.map((c) => c.id)).toEqual(['board:phone'])
    expect(change(d, 'board:phone').fields).toEqual(['root'])
    const out = JSON.parse(restore('design', b, a, a, 'board:phone'))
    expect(out).toEqual(b)
  })

  test('round trip: restoring every change one at a time gets back to before', () => {
    const cases: Array<[ArtifactKind, unknown, unknown]> = []
    {
      const b = deck()
      const a = deck()
      a.title = 'New title'
      a.slides[1].title = 'Pricing plans'
      a.slides = [a.slides[0], a.slides[2], a.slides[1]]
      const els = a.slides[1].elements ?? []
      els[0].x = 44
      els.splice(1, 1)
      a.slides.push({ id: 'end', layout: 'title', title: 'Thanks' })
      cases.push(['slides', b, a])
    }
    {
      const b = workbook()
      const a = workbook()
      a.tabs[0].cells.B2 = { v: 1 }
      a.tabs[0].cells.A2 = { v: 'Rent', italic: true }
      delete a.tabs[1].cells.A1
      a.tabs[1].name = 'Scratch'
      a.tabs.push({ id: 'extra', name: 'Extra', cells: {} })
      cases.push(['sheet', b, a])
    }
    {
      const b = dashboard()
      const a = dashboard()
      a.blocks.reverse()
      a.blocks.push({ kind: 'text', id: 'outro', markdown: 'The end' })
      a.datasets[0].rows[0].amount = 1
      Object.assign(a, { subtitle: 'New' })
      cases.push(['data', b, a])
    }
    {
      const b = board()
      const a = board()
      Object.assign(a.elements[1], { x: 5 })
      a.elements = a.elements.filter((e) => e.id !== 'q3' && e.id !== 'a4')
      a.elements.push({ type: 'note', id: 'n9', x: 0, y: 0, w: 100, h: 100, text: 'temp', color: 'yellow' })
      cases.push(['whiteboard', b, a])
    }
    {
      const b = design()
      const a = design()
      nodeIn(a, 'd-headline').text = 'Changed'
      const ctas = nodeIn(a, 'd-ctas')
      ctas.children = (ctas.children as Json[]).reverse()
      a.tokens.colors.primary = '#000000'
      a.boards[1].title = 'Phone'
      ;(nodeIn(a, 'd-copy').children as Json[]).push({ type: 'text', id: 'd-badge', text: 'New', style: 'small' })
      cases.push(['design', b, a])
    }
    for (const [kind, b, a] of cases) {
      const d = diff(kind, b, a)
      expect(d.changes.length).toBeGreaterThan(1)
      let body = json(a)
      for (const c of d.changes) {
        expect(c.restorable).toBe(true)
        const result = restoreArtifactChange(kind, json(b), json(a), body, c.id)
        if (!result.ok) throw new Error(`${kind} ${c.id}: ${result.reason}`)
        body = result.body
      }
      expect(JSON.parse(body)).toEqual(b)
    }
    const docBefore = '# A\n\nOne\n\nTwo\n\nThree\n'
    const docAfter = '# A\n\nOne edited\n\nThree\n\nFour\n'
    let docBody = docAfter
    for (const c of diffArtifactBodies('doc', docBefore, docAfter).changes) {
      const result = restoreArtifactChange('doc', docBefore, docAfter, docBody, c.id)
      if (!result.ok) throw new Error(`doc ${c.id}: ${result.reason}`)
      docBody = result.body
    }
    expect(docBody).toBe(docBefore)
  })

  test('big bodies stay fast: a 3000-row tab with an insert, 800 reversed elements', () => {
    const b = workbook()
    for (let r = 1; r <= 3000; r += 1) b.tabs[1].cells[`A${r}`] = { v: `row ${r}` }
    const a = clone(b)
    const cells: Record<string, Json> = {}
    for (const [address, cell] of Object.entries(b.tabs[1].cells)) {
      const r = Number(address.slice(1))
      cells[`A${r >= 1500 ? r + 1 : r}`] = cell
    }
    cells.A1500 = { v: 'inserted' }
    cells.A2999 = { v: 'edited' }
    a.tabs[1].cells = cells
    const started = performance.now()
    const d = diff('sheet', b, a)
    expect(d.changes.map((c) => c.id)).toEqual(['row:notes:1500', 'cell:notes!A2999'])
    expect(performance.now() - started).toBeLessThan(5000)

    const wb = { version: 1, title: 'Big', elements: Array.from({ length: 800 }, (_v, i) => ({ type: 'text', id: `t${i}`, x: i, y: 0, text: `t${i}`, size: 'm' })) }
    const reversed = { ...wb, elements: [...wb.elements].reverse() }
    const moves = diff('whiteboard', wb, reversed, { cap: 1000 })
    expect(moves.changes).toHaveLength(799)
    expect(moves.changes.every((c) => c.op === 'moved')).toBe(true)
  })

  test('ids are unique and stable across calls', () => {
    const b = design()
    const a = design()
    nodeIn(a, 'd-headline').text = 'x'
    a.boards.reverse()
    const first = diff('design', b, a).changes.map((c) => c.id)
    expect(new Set(first).size).toBe(first.length)
    expect(diff('design', b, a).changes.map((c) => c.id)).toEqual(first)
  })
})
