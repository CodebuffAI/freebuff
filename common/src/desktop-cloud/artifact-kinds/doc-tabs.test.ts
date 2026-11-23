import { describe, expect, test } from 'bun:test'

import { DOC_GUIDE } from './doc'
import {
  addTab,
  applyBlockEdit,
  cleanTabName,
  deleteTab,
  docTabs,
  moveTab,
  parseTabMarker,
  renameTab,
  splitBlocks,
  tabMarker,
  tabOfBlock,
  type TabChange,
} from './doc-tabs'

/** The blocks after a change's edits, each applied to what the last one left. */
function run(blocks: string[], change: TabChange): string[] {
  if ('error' in change) throw new Error(change.error)
  return change.edits.reduce<string[]>((current, edit) => {
    const next = applyBlockEdit(current, edit)
    if (!next) throw new Error(`edit refused: ${JSON.stringify(edit)}`)
    return next
  }, blocks)
}

const names = (blocks: string[]) => docTabs(blocks).map((tab) => tab.name)

// A doc body as stored before tabs existed (round 2): no marker, so exactly one tab.
const PRE_TABS_BODY = '## Goal\n\nShip it.\n\n<!-- a comment -->\n\n- [ ] one\n- [x] two\n\n| A | B |\n| --- | --- |\n| 1 | 2 |'

describe('tab markers', () => {
  test('parse the invisible comment form, quoted or in parentheses', () => {
    expect(parseTabMarker('[//]: # "tab: Launch notes"')).toBe('Launch notes')
    expect(parseTabMarker('[//]: # (tab: Notes)')).toBe('Notes')
    expect(parseTabMarker('[//]: #  "tab:   Spaced  "')).toBe('Spaced')
    expect(parseTabMarker('[//]: # "tab: "')).toBeNull()
    expect(parseTabMarker('[//]: # "a comment"')).toBeNull()
    expect(parseTabMarker('<!-- tab: Notes -->')).toBeNull()
    expect(parseTabMarker('Text\n[//]: # "tab: Notes"')).toBeNull()
  })

  test('a marker holds a clean one-line name', () => {
    expect(cleanTabName('  "Q3" \\ plan\n(draft) ')).toBe('Q3 plan draft')
    expect(cleanTabName('x'.repeat(80))).toHaveLength(60)
    expect(tabMarker('A "b"')).toBe('[//]: # "tab: A b"')
    expect(parseTabMarker(tabMarker('Round trip'))).toBe('Round trip')
  })
})

describe('docTabs', () => {
  test('a body without markers is exactly one tab holding every block', () => {
    const blocks = splitBlocks(PRE_TABS_BODY)
    expect(docTabs(blocks)).toEqual([{ id: 'tab-1', name: 'Tab 1', marker: null, start: 0, end: blocks.length }])
    expect(docTabs([])).toEqual([{ id: 'tab-1', name: 'Tab 1', marker: null, start: 0, end: 0 }])
  })

  test('blocks before the first marker are the unnamed first tab; ids are unique slugs', () => {
    const blocks = ['Intro', tabMarker('Notes'), 'a', 'b', tabMarker('Notes'), tabMarker('Q&A')]
    expect(docTabs(blocks)).toEqual([
      { id: 'tab-1', name: 'Tab 1', marker: null, start: 0, end: 1 },
      { id: 'notes', name: 'Notes', marker: 1, start: 2, end: 4 },
      { id: 'notes-2', name: 'Notes', marker: 4, start: 5, end: 5 },
      { id: 'q-a', name: 'Q&A', marker: 5, start: 6, end: 6 },
    ])
    expect(names([tabMarker('Only'), 'x'])).toEqual(['Only'])
    expect(tabOfBlock(docTabs(blocks), 1)?.id).toBe('notes')
    expect(tabOfBlock(docTabs(blocks), 3)?.id).toBe('notes')
  })
})

describe('tab changes', () => {
  test('adding a tab to an unmarked doc names the first tab too, so it never vanishes', () => {
    const change = addTab(['Intro', 'More'])
    expect('edits' in change && change.edits).toHaveLength(2)
    const after = run(['Intro', 'More'], change)
    expect(after).toEqual([tabMarker('Tab 1'), 'Intro', 'More', tabMarker('Tab 2')])
    expect('select' in change && change.select).toBe('tab-2')
    // An empty doc: one insertion of both markers.
    const empty = addTab([])
    expect('edits' in empty && empty.edits).toHaveLength(1)
    expect(run([], empty)).toEqual([tabMarker('Tab 1'), tabMarker('Tab 2')])
  })

  test('adding to a marked doc is one insertion at the end, with a fresh name', () => {
    const blocks = [tabMarker('Tab 1'), 'a', tabMarker('Tab 2')]
    const change = addTab(blocks)
    expect('edits' in change && change.edits).toEqual([{ index: 3, span: 0, before: '', after: tabMarker('Tab 3') }])
    expect(names(run(blocks, addTab(blocks, 'Appendix')))).toEqual(['Tab 1', 'Tab 2', 'Appendix'])
  })

  test('rename replaces the marker, or gives the unnamed first tab one', () => {
    const blocks = ['Intro', tabMarker('Notes'), 'n']
    expect(run(blocks, renameTab(blocks, 'notes', 'Field notes'))).toEqual(['Intro', tabMarker('Field notes'), 'n'])
    expect(run(blocks, renameTab(blocks, 'tab-1', 'Overview'))).toEqual([tabMarker('Overview'), 'Intro', tabMarker('Notes'), 'n'])
    expect(renameTab(blocks, 'notes', '  ')).toEqual({ error: 'A tab needs a name.' })
    expect(renameTab(blocks, 'gone', 'x')).toEqual({ error: 'That tab is gone.' })
  })

  test('delete takes the marker and the content, and never the last tab', () => {
    const blocks = ['Intro', tabMarker('Notes'), 'n1', 'n2', tabMarker('End'), 'e']
    expect(run(blocks, deleteTab(blocks, 'notes'))).toEqual(['Intro', tabMarker('End'), 'e'])
    expect(run(blocks, deleteTab(blocks, 'tab-1'))).toEqual([tabMarker('Notes'), 'n1', 'n2', tabMarker('End'), 'e'])
    expect(deleteTab(['only'], 'tab-1')).toEqual({ error: 'A doc keeps at least one tab.' })
  })

  test('move cuts a whole tab and pastes it in place, naming an unnamed first tab', () => {
    const blocks = [tabMarker('A'), 'a', tabMarker('B'), 'b1', 'b2', tabMarker('C'), 'c']
    expect(names(run(blocks, moveTab(blocks, 'a', 2)))).toEqual(['B', 'C', 'A'])
    expect(run(blocks, moveTab(blocks, 'c', 0))).toEqual([tabMarker('C'), 'c', tabMarker('A'), 'a', tabMarker('B'), 'b1', 'b2'])
    expect(run(blocks, moveTab(blocks, 'b', 2))).toEqual([tabMarker('A'), 'a', tabMarker('C'), 'c', tabMarker('B'), 'b1', 'b2'])
    const change = moveTab(blocks, 'a', 1)
    expect('edits' in change && change.edits).toEqual([
      { index: 0, span: 2, before: `${tabMarker('A')}\n\na`, after: `${tabMarker('A')}\n\na`, moveTo: 3 },
    ])
    const unnamed = ['Intro', tabMarker('B'), 'b']
    expect(run(unnamed, moveTab(unnamed, 'b', 0))).toEqual([tabMarker('B'), 'b', tabMarker('Tab 1'), 'Intro'])
    expect(moveTab(blocks, 'a', 0)).toEqual({ edits: [], select: 'a' })
  })

  test('an edit whose source no longer matches is refused', () => {
    expect(applyBlockEdit(['a', 'b'], { index: 1, before: 'x', after: 'y' })).toBeNull()
    expect(applyBlockEdit(['a'], { index: 2, span: 0, before: '', after: 'y' })).toBeNull()
  })
})

test('the guide tells the agent how tabs are written', () => {
  expect(DOC_GUIDE).toContain('[//]: # "tab: Launch notes"')
  expect(DOC_GUIDE).toContain('#tab=')
})
