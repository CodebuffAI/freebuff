import { describe, expect, test } from 'bun:test'

import { mergeArtifactBodies, type ArtifactMergeResult } from './artifact-merge'
import { joinDocSuggestions, splitDocSuggestions, type DocSuggestionRecord } from './artifact-kinds/doc-suggestions'
import { tabMarker } from './artifact-kinds/doc-tabs'

import type { ArtifactKind } from './artifacts'

// The polling sync merges a reader's unsaved edits with the server's newer revision. A wrong
// "ok" here silently drops someone's work, so every kind is checked for the same contract.

const json = (value: unknown) => JSON.stringify(value)
const clone = <T>(value: T): T => structuredClone(value)

function merge(kind: ArtifactKind, base: unknown, mine: unknown, theirs: unknown): ArtifactMergeResult {
  return mergeArtifactBodies(kind, json(base), json(mine), json(theirs))
}

function merged(result: ArtifactMergeResult): any {
  if (!result.ok) throw new Error(`expected a merge, got conflicts: ${result.conflicts.join(', ')}`)
  return JSON.parse(result.body)
}

function conflicts(result: ArtifactMergeResult): string[] {
  if (result.ok) throw new Error(`expected conflicts, got ${result.body}`)
  return result.conflicts
}

// ---------------------------------------------------------------------------------------------

const sheet = (): any => ({
  version: 1,
  title: 'Plan',
  revision: 4,
  tabs: [
    { id: 't1', name: 'Budget', cells: { A1: { v: 'Item' }, B4: { v: 10 } } },
    { id: 't2', name: 'Notes', cells: {} },
  ],
})

describe('sheet', () => {
  test('edits to different cells of one tab merge', () => {
    const base = sheet()
    const mine = clone(base)
    mine.tabs[0].cells.B4 = { v: 11 }
    const theirs = clone(base)
    ;(theirs.tabs[0].cells as Record<string, unknown>).C9 = { v: 'new' }
    theirs.revision = 5
    const out = merged(merge('sheet', base, mine, theirs))
    expect(out.tabs[0].cells).toEqual({ A1: { v: 'Item' }, B4: { v: 11 }, C9: { v: 'new' } })
    expect(out.revision).toBe(5)
  })

  test('the same cell changed differently conflicts and names it', () => {
    const base = sheet()
    const mine = clone(base)
    mine.tabs[0].cells.B4 = { v: 11 }
    const theirs = clone(base)
    theirs.tabs[0].cells.B4 = { v: 12 }
    expect(conflicts(merge('sheet', base, mine, theirs))).toEqual(['cell Budget!B4'])
  })

  test('the same cell changed identically merges (key order ignored)', () => {
    const base = sheet()
    const mine = clone(base)
    mine.tabs[0].cells.B4 = { v: 11, bold: true } as never
    const theirs = clone(base)
    theirs.tabs[0].cells.B4 = { bold: true, v: 11 } as never
    theirs.title = 'Plan 2'
    expect(merged(merge('sheet', base, mine, theirs)).tabs[0].cells.B4).toEqual({ v: 11, bold: true })
  })

  test('a tab field other than cells is its own unit', () => {
    const base = sheet()
    const mine = clone(base) as any
    mine.tabs[0].frozenRows = 1
    const theirs = clone(base) as any
    theirs.tabs[0].frozenRows = 2
    theirs.tabs[0].cells.A1 = { v: 'Thing' }
    expect(conflicts(merge('sheet', base, mine, theirs))).toEqual(['frozenRows of tab "Budget"'])
  })

  test('a tab deleted on one side and edited on the other conflicts', () => {
    const base = sheet()
    const mine = clone(base)
    mine.tabs[0].cells.B4 = { v: 99 }
    const theirs = clone(base)
    theirs.tabs.splice(0, 1)
    expect(conflicts(merge('sheet', base, mine, theirs))).toEqual(['tab "Budget"'])
  })

  test('tabs added on both sides are both kept; a reorder on one side keeps the other side edit', () => {
    const base = sheet()
    const mine = clone(base)
    mine.tabs.reverse()
    mine.tabs.push({ id: 'm', name: 'Mine', cells: {} })
    const theirs = clone(base)
    theirs.tabs[0].cells.A1 = { v: 'Thing' }
    theirs.tabs.push({ id: 'th', name: 'Theirs', cells: {} })
    const out = merged(merge('sheet', base, mine, theirs))
    expect(out.tabs.map((t: { id: string }) => t.id)).toEqual(['t2', 't1', 'm', 'th'])
    expect(out.tabs[1].cells.A1).toEqual({ v: 'Thing' })
  })

  test('both sides reordering tabs differently conflicts', () => {
    const base = sheet()
    base.tabs.push({ id: 't3', name: 'Third', cells: {} })
    const mine = clone(base)
    mine.tabs = [mine.tabs[2], mine.tabs[0], mine.tabs[1]]
    const theirs = clone(base)
    theirs.tabs = [theirs.tabs[1], theirs.tabs[0], theirs.tabs[2]]
    expect(conflicts(merge('sheet', base, mine, theirs))).toEqual(['tab order'])
  })
})

// ---------------------------------------------------------------------------------------------

const deck = (): any => ({
  version: 1,
  title: 'Pitch',
  aspect: '16:9',
  slides: [
    { id: 'intro', layout: 'title', title: 'Hello' },
    { id: 'body', layout: 'content', body: 'Points' },
    { id: 'end', layout: 'title', title: 'Bye' },
  ],
})

describe('slides', () => {
  test('different slides edited merge; the same slide edited differently conflicts', () => {
    const base = deck()
    const mine = clone(base)
    mine.slides[0].title = 'Hi'
    const theirs = clone(base)
    theirs.slides[2].title = 'Ciao'
    theirs.title = 'Pitch v2'
    const out = merged(merge('slides', base, mine, theirs))
    expect(out.slides.map((s: { title?: string }) => s.title)).toEqual(['Hi', undefined, 'Ciao'])
    expect(out.title).toBe('Pitch v2')

    const clash = clone(base)
    clash.slides[0].title = 'Hey'
    expect(conflicts(merge('slides', base, mine, clash))).toEqual(['slide "intro"'])
  })

  test('a slide deleted on one side and edited on the other conflicts; deleted untouched is fine', () => {
    const base = deck()
    const mine = clone(base)
    mine.slides[1].body = 'More points'
    const theirs = clone(base)
    theirs.slides.splice(1, 1)
    expect(conflicts(merge('slides', base, mine, theirs))).toEqual(['slide "body"'])

    const untouched = clone(base)
    untouched.slides[0].title = 'Hi'
    expect(merged(merge('slides', base, untouched, theirs)).slides.map((s: { id: string }) => s.id)).toEqual(['intro', 'end'])
  })

  test('slides appended on both sides are kept; a move on one side and an edit on the other merge', () => {
    const base = deck()
    const mine = clone(base)
    mine.slides = [mine.slides[2], mine.slides[0], mine.slides[1]]
    mine.slides.push({ id: 'm', layout: 'title', title: 'M' })
    const theirs = clone(base)
    theirs.slides[1].body = 'Edited'
    theirs.slides.push({ id: 't', layout: 'title', title: 'T' })
    const out = merged(merge('slides', base, mine, theirs))
    expect(out.slides.map((s: { id: string }) => s.id)).toEqual(['end', 'intro', 'body', 'm', 't'])
    expect(out.slides[2].body).toBe('Edited')
  })

  test('the same new id added differently on both sides conflicts', () => {
    const base = deck()
    const mine = clone(base)
    mine.slides.push({ id: 'new', layout: 'title', title: 'A' })
    const theirs = clone(base)
    theirs.slides.push({ id: 'new', layout: 'title', title: 'B' })
    expect(conflicts(merge('slides', base, mine, theirs))).toEqual(['slide "new"'])
  })
})

// ---------------------------------------------------------------------------------------------

const board = (): any => ({
  version: 1,
  title: 'Map',
  elements: [
    { id: 'a', type: 'note', x: 0, y: 0, text: 'A' },
    { id: 'b', type: 'note', x: 200, y: 0, text: 'B' },
    { id: 'c', type: 'note', x: 400, y: 0, text: 'C' },
  ],
})

describe('whiteboard', () => {
  test('disjoint element edits merge; the same element edited differently conflicts', () => {
    const base = board()
    const mine = clone(base)
    mine.elements[0].x = 10
    const theirs = clone(base)
    theirs.elements[1].text = 'Bee'
    const out = merged(merge('whiteboard', base, mine, theirs))
    expect(out.elements[0].x).toBe(10)
    expect(out.elements[1].text).toBe('Bee')

    const clash = clone(base)
    clash.elements[0].x = 20
    expect(conflicts(merge('whiteboard', base, mine, clash))).toEqual(['element "a"'])
  })

  test('bring-to-front on one side and an edit on the other merge; delete vs edit conflicts', () => {
    const base = board()
    const mine = clone(base)
    mine.elements.push(mine.elements.shift()!)
    mine.elements.push({ id: 'm', type: 'note', x: 800, y: 0, text: 'M' })
    const theirs = clone(base)
    theirs.elements[0].text = 'Ay'
    theirs.elements.push({ id: 'd', type: 'note', x: 600, y: 0, text: 'D' })
    const out = merged(merge('whiteboard', base, mine, theirs))
    expect(out.elements.map((e: { id: string }) => e.id)).toEqual(['b', 'c', 'a', 'm', 'd'])
    expect(out.elements[2].text).toBe('Ay')

    const deleted = clone(base)
    deleted.elements.splice(0, 1)
    expect(conflicts(merge('whiteboard', base, theirs, deleted))).toEqual(['element "a"'])
  })
})

// ---------------------------------------------------------------------------------------------

const text = (id: string, content: string) => ({ id, type: 'text', text: content })
const design = (): any => ({
  version: 1,
  title: 'Site',
  boards: [
    {
      id: 'home',
      title: 'Home',
      x: 0,
      y: 0,
      w: 1440,
      h: 900,
      root: {
        id: 'root',
        type: 'frame',
        layout: 'stack-v',
        children: [
          { id: 'hero', type: 'frame', layout: 'stack-v', children: [text('h1', 'Welcome'), text('lede', 'Lede')] },
          { id: 'footer', type: 'frame', layout: 'stack-h', children: [text('copy', '(c)')] },
        ],
      },
    },
  ],
})
type D = ReturnType<typeof design> & Record<string, any>
const root = (d: D) => d.boards[0].root as any
const ids = (node: any): unknown => (node.children ? { [node.id]: node.children.map(ids) } : node.id)

describe('design', () => {
  test('edits to different nodes of one board merge', () => {
    const base = design()
    const mine = clone(base) as D
    root(mine).children[0].children[0].text = 'Hello'
    const theirs = clone(base) as D
    root(theirs).children[1].children[0].text = '(c) 2026'
    theirs.boards[0].title = 'Landing'
    const out = merged(merge('design', base, mine, theirs))
    expect(out.boards[0].title).toBe('Landing')
    expect(out.boards[0].root.children[0].children[0].text).toBe('Hello')
    expect(out.boards[0].root.children[1].children[0].text).toBe('(c) 2026')
  })

  test('the same node edited differently conflicts and names node and board', () => {
    const base = design()
    const mine = clone(base) as D
    root(mine).children[0].children[0].text = 'Hello'
    const theirs = clone(base) as D
    root(theirs).children[0].children[0].text = 'Hi'
    expect(conflicts(merge('design', base, mine, theirs))).toEqual(['node "h1" on board "Home"'])
  })

  test('a child added on one side and a node edited inside the same frame on the other merge', () => {
    const base = design()
    const mine = clone(base) as D
    root(mine).children[0].children.push(text('cta', 'Buy'))
    const theirs = clone(base) as D
    root(theirs).children[0].children[1].text = 'New lede'
    const out = merged(merge('design', base, mine, theirs))
    expect(ids(out.boards[0].root)).toEqual({ root: [{ hero: ['h1', 'lede', 'cta'] }, { footer: ['copy'] }] })
    expect(out.boards[0].root.children[0].children[1].text).toBe('New lede')
  })

  test('a move on one side and a props edit of the moved node on the other merge', () => {
    const base = design()
    const mine = clone(base) as D
    const lede = root(mine).children[0].children.pop()
    root(mine).children[1].children.unshift(lede)
    const theirs = clone(base) as D
    root(theirs).children[0].children[1].text = 'Better lede'
    const out = merged(merge('design', base, mine, theirs))
    expect(ids(out.boards[0].root)).toEqual({ root: [{ hero: ['h1'] }, { footer: ['lede', 'copy'] }] })
    expect(out.boards[0].root.children[1].children[0].text).toBe('Better lede')
  })

  test('the same frame restructured differently on both sides conflicts', () => {
    const base = design()
    const mine = clone(base) as D
    root(mine).children[0].children.push(text('a', 'A'))
    const theirs = clone(base) as D
    root(theirs).children[0].children.push(text('b', 'B'))
    expect(conflicts(merge('design', base, mine, theirs))).toEqual(['children of node "hero" on board "Home"'])
  })

  test('a frame deleted on one side while a child is added or a descendant edited on the other conflicts', () => {
    const base = design()
    const theirs = clone(base) as D
    root(theirs).children.splice(1, 1)
    const added = clone(base) as D
    root(added).children[1].children.push(text('more', 'More'))
    expect(conflicts(merge('design', base, added, theirs))).toContain('node "footer" on board "Home"')
    const edited = clone(base) as D
    root(edited).children[1].children[0].text = 'edited'
    expect(conflicts(merge('design', base, edited, theirs))).toEqual(['node "copy" on board "Home"'])
  })

  test('two moves that would nest two frames inside each other conflict instead of losing both', () => {
    // Frame A sits in hero, frame B in footer. Mine moves B into A; theirs moves A into B. Every
    // unit touched is distinct (hero's, footer's, A's and B's child lists), yet A and B would
    // only reach each other: a silent loss of both without the reachability check.
    const base = design() as D
    root(base).children[0].children.push({ id: 'A', type: 'frame', layout: 'stack-v', children: [] })
    root(base).children[1].children.push({ id: 'B', type: 'frame', layout: 'stack-v', children: [] })
    const mine = clone(base)
    const b = root(mine).children[1].children.pop()
    root(mine).children[0].children[2].children.push(b)
    const theirs = clone(base)
    const a = root(theirs).children[0].children.pop()
    root(theirs).children[1].children[1].children.push(a)
    const out = conflicts(merge('design', base, mine, theirs))
    expect(out.sort()).toEqual(['node "A" on board "Home" is no longer on any board', 'node "B" on board "Home" is no longer on any board'])
  })

  test('boards added on both sides are kept; a board deleted untouched goes', () => {
    const base = design()
    base.boards.push({ ...clone(base.boards[0]), id: 'old', title: 'Old', root: { id: 'oldroot', type: 'frame', layout: 'stack-v', children: [] } } as never)
    const mine = clone(base) as D
    mine.boards.push({ id: 'mb', title: 'Mine', x: 0, y: 1000, w: 400, h: 800, root: { id: 'mroot', type: 'frame', layout: 'stack-v', children: [text('mt', 'x')] } })
    const theirs = clone(base) as D
    theirs.boards.splice(1, 1)
    theirs.boards.push({ id: 'tb', title: 'Theirs', x: 0, y: 2000, w: 400, h: 800, root: { id: 'troot', type: 'frame', layout: 'stack-v', children: [] } })
    const out = merged(merge('design', base, mine, theirs))
    expect(out.boards.map((b: { id: string }) => b.id)).toEqual(['home', 'tb', 'mb'])
    expect(ids(out.boards[2].root)).toEqual({ mroot: ['mt'] })
  })
})

// ---------------------------------------------------------------------------------------------

const dashboard = (): any => ({
  version: 1,
  title: 'Sales',
  layout: 'grid',
  sources: [{ id: 's', label: 'CRM' }],
  datasets: [{ id: 'd', sourceId: 's', columns: [], rows: [] }],
  blocks: [
    { kind: 'text', id: 'b1', markdown: 'One' },
    { kind: 'text', id: 'b2', markdown: 'Two' },
  ],
  filters: [{ id: 'f', label: 'Region', datasetIds: ['d'], column: 'region', type: 'select' }],
})

describe('data', () => {
  test('different blocks, datasets and filters edited merge; the same block edited differently conflicts', () => {
    const base = dashboard()
    const mine = clone(base)
    mine.blocks[0].markdown = 'Uno'
    mine.filters[0].label = 'Area'
    const theirs = clone(base)
    theirs.blocks[1].markdown = 'Dos'
    theirs.datasets[0].rows = [{ a: 1 }] as never
    const out = merged(merge('data', base, mine, theirs))
    expect(out.blocks.map((b: { markdown: string }) => b.markdown)).toEqual(['Uno', 'Dos'])
    expect(out.filters[0].label).toBe('Area')
    expect(out.datasets[0].rows).toEqual([{ a: 1 }])

    const clash = clone(base)
    clash.blocks[0].markdown = 'Eins'
    expect(conflicts(merge('data', base, mine, clash))).toEqual(['block "b1"'])
  })

  test('blocks added on both sides are kept; delete vs edit of a dataset conflicts', () => {
    const base = dashboard()
    const mine = clone(base)
    mine.blocks.reverse()
    mine.blocks.push({ kind: 'text', id: 'm', markdown: 'M' })
    const theirs = clone(base)
    theirs.blocks[0].markdown = 'Uno'
    theirs.blocks.push({ kind: 'text', id: 't', markdown: 'T' })
    const out = merged(merge('data', base, mine, theirs))
    expect(out.blocks.map((b: { id: string }) => b.id)).toEqual(['b2', 'b1', 'm', 't'])
    expect(out.blocks[1].markdown).toBe('Uno')

    const edited = clone(base)
    edited.datasets[0].rows = [{ a: 2 }] as never
    const deleted = clone(base)
    deleted.datasets = []
    expect(conflicts(merge('data', base, edited, deleted))).toEqual(['dataset "d"'])
  })
})

// ---------------------------------------------------------------------------------------------

describe('doc', () => {
  const base = '# Title\n\nIntro paragraph.\n\nMiddle one.\n\nMiddle two.\n\n```\ncode\n\nstill code\n```\n\nEnd.\n'

  test('edits to different blocks merge, adjacent ones too, and keep the trailing newline', () => {
    const mine = base.replace('Middle one.', 'Middle ONE.')
    const theirs = base.replace('Middle two.', 'Middle TWO.').replace('End.', 'The end.')
    const result = mergeArtifactBodies('doc', base, mine, theirs)
    expect(result).toEqual({
      ok: true,
      body: '# Title\n\nIntro paragraph.\n\nMiddle ONE.\n\nMiddle TWO.\n\n```\ncode\n\nstill code\n```\n\nThe end.\n',
    })
  })

  test('the same block edited differently conflicts and names it; identical edits merge', () => {
    const mine = base.replace('Intro paragraph.', 'Intro A.')
    const theirs = base.replace('Intro paragraph.', 'Intro B.').replace('End.', 'Fin.')
    expect(conflicts(mergeArtifactBodies('doc', base, mine, theirs))).toEqual(['block 2 ("Intro paragraph.")'])
    const same = mergeArtifactBodies('doc', base, mine, mine.replace('End.', 'Fin.'))
    expect(same).toEqual({ ok: true, body: mine.replace('End.', 'Fin.') })
  })

  test('a block deleted on one side and edited on the other conflicts', () => {
    const mine = base.replace('Middle one.\n\n', '')
    const theirs = base.replace('Middle one.', 'Middle 1.')
    expect(conflicts(mergeArtifactBodies('doc', base, mine, theirs))).toEqual(['block 3 ("Middle one.")'])
  })

  test('insertions at different places merge; different insertions at one place conflict', () => {
    const mine = base.replace('Middle one.', 'New A.\n\nMiddle one.')
    const theirs = base.replace('End.', 'New B.\n\nEnd.')
    const out = mergeArtifactBodies('doc', base, mine, theirs)
    expect(out.ok && out.body).toBe(base.replace('Middle one.', 'New A.\n\nMiddle one.').replace('End.', 'New B.\n\nEnd.'))

    const clash = base.replace('Middle one.', 'New C.\n\nMiddle one.')
    expect(conflicts(mergeArtifactBodies('doc', base, mine, clash))).toEqual(['after block 2 ("Intro paragraph.")'])
  })

  test('an edit inside a fenced block is one block', () => {
    const mine = base.replace('still code', 'still code!')
    const theirs = base.replace('code\n\nstill', 'kode\n\nstill')
    expect(conflicts(mergeArtifactBodies('doc', base, mine, theirs))).toEqual(['block 5 ("```")'])
  })

  test('a side that only changed blank lines counts as unchanged', () => {
    const mine = base.replace('Intro paragraph.\n\n', 'Intro paragraph.\n\n\n\n')
    const theirs = base.replace('End.', 'Fin.')
    expect(mergeArtifactBodies('doc', base, mine, theirs)).toEqual({ ok: true, body: theirs })
  })

  test('CRLF bodies stay CRLF', () => {
    const crlf = (s: string) => s.replace(/\n/g, '\r\n')
    const theirs = crlf('A\n\nB\n\nC2\n')
    const out = mergeArtifactBodies('doc', crlf('A\n\nB\n\nC\n'), crlf('A1\n\nB\n\nC\n'), theirs)
    expect(out).toEqual({ ok: true, body: crlf('A1\n\nB\n\nC2\n') })
  })
})

// ---------------------------------------------------------------------------------------------

describe('every kind', () => {
  const samples: Array<[ArtifactKind, string]> = [
    ['doc', 'One\n\n\n\nTwo  \n'],
    // Odd spacing and key order: a re-stringify would change the bytes.
    ['sheet', '{ "title":"Plan", "version":1,\n "tabs":[{"name":"A","id":"t","cells":{}}] }'],
    ['slides', '{"version":1, "slides":[{"layout":"title","id":"s"}], "title":"x","aspect":"16:9"}'],
    ['whiteboard', '{"elements":[], "version":1,"title":"b" }'],
    ['design', '{"version":1,"title":"d",  "boards":[]}'],
    ['data', '{"version":1,"title":"t","layout":"grid","sources":[{"id":"s"}],"datasets":[],"blocks":[{"id":"b","kind":"text","markdown":"x"}] }'],
  ]

  for (const [kind, body] of samples) {
    test(`${kind}: an untouched side returns the other side byte-for-byte`, () => {
      const other = kind === 'doc' ? `${body}Three\n` : body.replace(/"title":\s*"([^"]*)"/, '"title":"$1 v2"')
      expect(other).not.toBe(body)
      expect(mergeArtifactBodies(kind, body, body, other)).toEqual({ ok: true, body: other })
      expect(mergeArtifactBodies(kind, body, other, body)).toEqual({ ok: true, body: other })
      expect(mergeArtifactBodies(kind, body, body, body)).toEqual({ ok: true, body })
      if (kind !== 'doc') {
        // Re-saved with no real change (spacing, key order): still the other side's exact bytes.
        const resaved = JSON.stringify(JSON.parse(body))
        expect(mergeArtifactBodies(kind, body, resaved, other)).toEqual({ ok: true, body: other })
      }
    })
  }

  const identical: Array<[ArtifactKind, () => any, (d: any) => void]> = [
    ['slides', deck, (d) => (d.slides[1].body = 'Same')],
    ['whiteboard', board, (d) => d.elements.push({ id: 'n', type: 'note', x: 9, y: 9, text: 'N' })],
    ['design', design, (d) => (d.boards[0].root.children[0].children[0].text = 'Same')],
    ['data', dashboard, (d) => d.datasets.splice(0, 1)],
  ]
  for (const [kind, make, edit] of identical) {
    test(`${kind}: the same edit made on both sides merges alongside a one-sided edit`, () => {
      const base = make()
      const mine = clone(base)
      edit(mine)
      const theirs = clone(mine)
      theirs.title = 'Renamed'
      expect(merged(merge(kind, base, mine, theirs))).toEqual(theirs)
    })
  }

  for (const kind of ['sheet', 'slides', 'whiteboard', 'design', 'data'] as const) {
    test(`${kind}: an unparseable side is a whole-body conflict`, () => {
      const good = '{"version":1,"title":"x"}'
      for (const sides of [
        ['{', good, good],
        [good, '{"version":', good],
        [good, good, 'not json'],
        [good, '[1,2]', good],
      ]) {
        expect(mergeArtifactBodies(kind, sides[0], sides[1], sides[2])).toEqual({ ok: false, conflicts: ['the whole body'], units: [{ key: 'body', label: 'the whole body' }] })
      }
    })
  }

  test('a top-level field changed differently on both sides conflicts; on one side it merges', () => {
    const base = deck()
    const mine = { ...clone(base), title: 'A' }
    const theirs = { ...clone(base), title: 'B' }
    expect(conflicts(merge('slides', base, mine, theirs))).toEqual(['title'])
    const accent = { ...clone(base), accent: 'blue' }
    expect(merged(merge('slides', base, mine, accent))).toMatchObject({ title: 'A', accent: 'blue' })
  })
})

test('preferMine keeps mine on the colliding unit and the other side everywhere else', async () => {
  const { mergeArtifactBodies: merge } = await import('./artifact-merge')
  const deck = (a: string, b: string) =>
    JSON.stringify({ version: 1, title: 'D', aspect: '16:9', slides: [{ id: 'a', layout: 'title', title: a }, { id: 'b', layout: 'title', title: b }] })
  const base = deck('A', 'B')
  const mine = deck('mine A', 'B')
  const theirs = deck('their A', 'their B')
  expect(merge('slides', base, mine, theirs).ok).toBe(false)
  const kept = merge('slides', base, mine, theirs, { preferMine: true })
  expect(kept.ok && JSON.parse(kept.body).slides.map((s: { title: string }) => s.title)).toEqual(['mine A', 'their B'])
})

test('a row inserted on one side and a cell edited on the other lands the edit on the shifted cell (was: a conflict)', async () => {
  const { mergeArtifactBodies: merge } = await import('./artifact-merge')
  const { insertLines } = await import('./artifact-kinds/sheet-structure')
  const book = {
    version: 1, title: 'B',
    tabs: [{ id: 't', name: 'Budget', cells: { A1: { v: 'Item' }, A2: { v: 'Rent' }, B2: { v: 10 }, A3: { v: 'Food' }, B3: { v: 20 }, A4: { v: 'Fun' }, B4: { v: 5 } } }],
  }
  const base = JSON.stringify(book)
  const mine = JSON.stringify(insertLines(book as never, 't', 'row', 2, 1))
  const theirs = JSON.stringify({ ...book, tabs: [{ ...book.tabs[0]!, cells: { ...book.tabs[0]!.cells, B4: { v: 12 } } }] })
  const result = merge('sheet', base, mine, theirs)
  if (!result.ok) throw new Error(result.conflicts.join(', '))
  // Row 4 (Fun) moved to row 5, and their edit of B4 moved with it; nothing lands on the new blank row.
  const cells = JSON.parse(result.body).tabs[0].cells
  expect(cells.B5).toEqual({ v: 12 })
  expect(cells.A5).toEqual({ v: 'Fun' })
  expect(cells.B4).toEqual({ v: 20 })
  expect(cells.A3).toBeUndefined()
  // A plain cell edit on each side still merges cell by cell.
  const mineEdit = JSON.stringify({ ...book, tabs: [{ ...book.tabs[0]!, cells: { ...book.tabs[0]!.cells, B2: { v: 11 } } }] })
  expect(merge('sheet', base, mineEdit, theirs).ok).toBe(true)
})

describe('doc with tabs and agent suggestions (the docs round 4 session)', () => {
  const sg = (id: string, after: string): DocSuggestionRecord => ({ id, kind: 'replace', before: 'Alpha.', after })
  const text = `# Plan\n\nAlpha.\n\nBeta.\n\n${tabMarker('Launch')}\n\nGamma.\n\nDelta.\n`
  const base = joinDocSuggestions(text, [sg('sg-1', 'Alpha one.')])
  const records = (body: string) => splitDocSuggestions(body).suggestions.map((r) => r.id)
  const sidecars = (body: string) => body.split('\n\n').filter((block) => block.includes('fb-suggestion:')).length

  test('an agent suggestion and a user edit in another block merge silently, one sidecar, nothing dropped', () => {
    const agent = joinDocSuggestions(text, [sg('sg-1', 'Alpha one.'), sg('sg-2', 'Alpha two.')])
    const user = joinDocSuggestions(text.replace('Gamma.', 'Gamma, edited.'), [sg('sg-1', 'Alpha one.')])
    const result = mergeArtifactBodies('doc', base, user, agent)
    if (!result.ok) throw new Error(result.conflicts.join(', '))
    expect(splitDocSuggestions(result.body).content).toContain('Gamma, edited.')
    expect(records(result.body)).toEqual(['sg-1', 'sg-2'])
    expect(sidecars(result.body)).toBe(1)
  })

  test('the user accepting one suggestion while the agent adds another keeps both changes', () => {
    const accepted = joinDocSuggestions(text.replace('Alpha.', 'Alpha one.'), [])
    const agent = joinDocSuggestions(text.replace('Delta.', 'Delta, by the agent.'), [sg('sg-1', 'Alpha one.'), sg('sg-3', 'x')])
    const result = mergeArtifactBodies('doc', base, accepted, agent)
    if (!result.ok) throw new Error(result.conflicts.join(', '))
    const { content } = splitDocSuggestions(result.body)
    expect(content).toContain('Alpha one.')
    expect(content).toContain('Delta, by the agent.')
    expect(records(result.body)).toEqual(['sg-3'])
    expect(sidecars(result.body)).toBe(1)
  })

  test('the same block edited by both is a per-unit notice naming its tab; Keep mine keeps the sidecar once', () => {
    const agent = joinDocSuggestions(text.replace('Gamma.', 'Gamma (agent).'), [sg('sg-1', 'Alpha one.'), sg('sg-2', 'y')])
    const user = joinDocSuggestions(text.replace('Gamma.', 'Gamma (me).'), [sg('sg-1', 'Alpha one.')])
    const result = mergeArtifactBodies('doc', base, user, agent)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.conflicts).toEqual(['block 5 ("Gamma.") in tab "Launch"'])
    const kept = mergeArtifactBodies('doc', base, user, agent, { preferMine: true })
    if (!kept.ok) throw new Error('keep mine must merge')
    expect(splitDocSuggestions(kept.body).content).toContain('Gamma (me).')
    expect(records(kept.body)).toEqual(['sg-1', 'sg-2'])
    expect(sidecars(kept.body)).toBe(1)
  })

  test('one suggestion changed differently on both sides is its own conflict, not the raw sidecar line', () => {
    const agent = joinDocSuggestions(text, [sg('sg-1', 'A.')])
    const user = joinDocSuggestions(text, [sg('sg-1', 'B.')])
    const result = mergeArtifactBodies('doc', base, user, agent)
    expect(result).toEqual({ ok: false, conflicts: ['suggestion "sg-1"'], units: [{ key: 'suggestions/sg-1', label: 'suggestion "sg-1"' }] })
  })

  test('a tab renamed on one side and a block inside it edited on the other merge', () => {
    const renamed = joinDocSuggestions(text.replace(tabMarker('Launch'), tabMarker('Go live')), [sg('sg-1', 'Alpha one.')])
    const edited = joinDocSuggestions(text.replace('Delta.', 'Delta 2.'), [sg('sg-1', 'Alpha one.')])
    const result = mergeArtifactBodies('doc', base, edited, renamed)
    if (!result.ok) throw new Error(result.conflicts.join(', '))
    expect(result.body).toContain(tabMarker('Go live'))
    expect(result.body).toContain('Delta 2.')
    expect(sidecars(result.body)).toBe(1)
  })
})

// ---------------------------------------------------------------------------------------------
// Preserve by default: at every level the merge rebuilds, a field only one side added, changed
// or removed takes that side's value, while the other side's own edit to the same object lands
// too (so no case is decided by the untouched-side short cut). The fields are each round-4 field
// and a made-up `zz_future` a newer client might write.

type Patch = Record<string, unknown>
type Level = {
  name: string
  kind: ArtifactKind
  make: () => any
  /** The object at this level (found by id, so a reorder never misleads it). */
  at: (doc: any) => any
  /** The other side's edit: a key of the same object this side leaves alone. */
  other: [string, unknown]
  /** Each case: `a` is set on base for change/remove; add sets `a`, change sets `b`. */
  fields: Array<{ name: string; a: Patch; b: Patch }>
}

const future = { name: 'zz_future', a: { zz_future: { n: 1 } }, b: { zz_future: [2, 'two'] } }
const byId = (list: any[], id: string) => list.find((item) => item.id === id)
const findNode = (node: any, id: string): any =>
  node.id === id ? node : (node.children ?? []).map((child: any) => findNode(child, id)).find(Boolean)
const runs = (v: string, ...parts: Array<Record<string, unknown>>) => ({ v, runs: parts })

const levels: Level[] = [
  {
    name: 'sheet root',
    kind: 'sheet',
    make: sheet,
    at: (d) => d,
    other: ['title', 'Plan v2'],
    fields: [
      future,
      { name: 'locale', a: { locale: 'en-GB' }, b: { locale: 'de-DE' } },
      { name: 'timeZone', a: { timeZone: 'Europe/London' }, b: { timeZone: 'Asia/Tokyo' } },
      {
        name: 'deletedTabs',
        a: { deletedTabs: [{ tab: { id: 'old', name: 'Old', cells: {} }, index: 1 }] },
        b: { deletedTabs: [{ tab: { id: 'old', name: 'Old', cells: { A1: { v: 1 } } }, index: 0 }, { tab: { id: 'o2', name: 'O2', cells: {} }, index: 2 }] },
      },
    ],
  },
  {
    name: 'sheet deletedTabs entry',
    kind: 'sheet',
    make: () => ({ ...sheet(), deletedTabs: [{ tab: { id: 'old', name: 'Old', cells: {} }, index: 1 }] }),
    at: (d) => d.deletedTabs.find((e: any) => e.tab.id === 'old'),
    other: ['index', 2],
    fields: [future, { name: 'names', a: { names: [{ name: 'Total', ref: 'A1' }] }, b: { names: [] } }],
  },
  {
    name: 'sheet tab',
    kind: 'sheet',
    make: sheet,
    at: (d) => byId(d.tabs, 't1'),
    other: ['frozenRows', 1],
    fields: [
      future,
      { name: 'rowGroups', a: { rowGroups: [{ from: 2, to: 3 }] }, b: { rowGroups: [{ from: 2, to: 3, collapsed: true }, { from: 5, to: 6 }] } },
      { name: 'colGroups', a: { colGroups: [{ from: 'B', to: 'C' }] }, b: { colGroups: [{ from: 'B', to: 'D' }] } },
      { name: 'gridlines', a: { gridlines: false }, b: { gridlines: true } },
    ],
  },
  {
    name: 'sheet cell',
    kind: 'sheet',
    make: sheet,
    at: (d) => byId(d.tabs, 't1').cells.B4,
    other: ['bold', true],
    fields: [
      future,
      { name: 'runs', a: runs('Total due', { text: 'Total', bold: true }, { text: ' due' }), b: runs('Total due', { text: 'Total due', italic: true }) },
      { name: 'currency', a: { currency: 'EUR' }, b: { currency: 'GBP' } },
      { name: 'link', a: { link: 'https://a.example' }, b: { link: 'mailto:b@example.com' } },
    ],
  },
  {
    name: 'slides root',
    kind: 'slides',
    make: deck,
    at: (d) => d,
    other: ['title', 'Pitch v2'],
    fields: [future, { name: 'transition', a: { transition: 'fade' }, b: { transition: 'slide' } }],
  },
  {
    name: 'slide',
    kind: 'slides',
    make: deck,
    at: (d) => byId(d.slides, 'body'),
    other: ['notes', 'Say hi'],
    fields: [
      future,
      {
        name: 'elements',
        a: { elements: [{ id: 'e1', type: 'text', x: 0, y: 0, w: 200, h: 60, text: 'Hi' }] },
        b: { elements: [{ id: 'e1', type: 'text', x: 9, y: 0, w: 200, h: 60, text: 'Hi' }, { id: 'e2', type: 'rect', x: 0, y: 99, w: 50, h: 50 }] },
      },
      { name: 'transition', a: { transition: 'none' }, b: { transition: 'fade' } },
    ],
  },
  {
    name: 'slide element',
    kind: 'slides',
    make: () => {
      const d = deck()
      d.slides[1].elements = [{ id: 'e1', type: 'text', x: 0, y: 0, w: 200, h: 60, text: 'Hi' }, { id: 'e2', type: 'arrow', x: 0, y: 0, w: 10, h: 10 }]
      return d
    },
    at: (d) => byId(byId(d.slides, 'body').elements, 'e1'),
    other: ['x', 40],
    fields: [future, { name: 'rotation', a: { rotation: 15 }, b: { rotation: -30 } }, { name: 'bold', a: { bold: true }, b: { bold: false } }],
  },
  {
    name: 'whiteboard root',
    kind: 'whiteboard',
    make: board,
    at: (d) => d,
    other: ['title', 'Map v2'],
    fields: [future],
  },
  ...(
    [
      ['note', 'a', ['text', 'Ay'], [
        { name: 'votes', a: { votes: 2 }, b: { votes: 5 } },
        { name: 'fill', a: { fill: 'blue' }, b: { fill: '#ff0000' } },
      ]],
      ['shape with a timer', 'sh', ['text', 'Go'], [{ name: 'timer', a: { timer: { duration: 300 } }, b: { timer: { duration: 300, startedAt: 1_700_000_000_000 } } }]],
      ['sticker', 'st', ['x', 77], [{ name: 'attachedTo', a: { attachedTo: 'a' }, b: { attachedTo: 'b' } }]],
      ['arrow', 'ar', ['label', 'yes'], [
        { name: 'stroke', a: { stroke: 'red' }, b: { stroke: '#00ff00' } },
        { name: 'head', a: { head: 'start' }, b: { head: 'both' } },
      ]],
    ] as Array<[string, string, [string, unknown], Level['fields']]>
  ).map(([name, id, other, fields]): Level => ({
    name: `whiteboard ${name}`,
    kind: 'whiteboard',
    make: () => {
      const d = board()
      d.elements.push(
        { id: 'sh', type: 'shape', kind: 'rect', x: 0, y: 300, w: 100, h: 100, text: '' },
        { id: 'st', type: 'sticker', sticker: 'heart', x: 0, y: 500, w: 56, h: 56 },
        { id: 'ar', type: 'arrow', from: { elementId: 'a' }, to: { elementId: 'b' }, style: 'solid' },
      )
      return d
    },
    at: (d) => byId(d.elements, id),
    other,
    fields: [future, ...fields],
  })),
  {
    name: 'design root',
    kind: 'design',
    make: design,
    at: (d) => d,
    other: ['title', 'Site v2'],
    fields: [
      future,
      { name: 'styles', a: { styles: { text: [{ id: 'h', name: 'Heading', style: 'h1' }] } }, b: { styles: { fills: [{ id: 'f', name: 'Brand', fill: 'accent' }] } } },
      { name: 'startBoard', a: { startBoard: 'home' }, b: { startBoard: 'other' } },
    ],
  },
  {
    name: 'design text style',
    kind: 'design',
    make: () => ({ ...design(), styles: { text: [{ id: 'h', name: 'Heading', style: 'h1' }] } }),
    at: (d) => byId(d.styles.text, 'h'),
    other: ['name', 'Big heading'],
    fields: [future, { name: 'fontSize', a: { fontSize: 40 }, b: { fontSize: 48 } }],
  },
  {
    name: 'design board',
    kind: 'design',
    make: design,
    at: (d) => byId(d.boards, 'home'),
    other: ['background', 'surface'],
    fields: [
      future,
      { name: 'breakpoints', a: { breakpoints: [{ id: 'mobile', title: 'Mobile', w: 390 }] }, b: { breakpoints: [{ id: 'mobile', title: 'Phone', w: 390, h: 844 }, { id: 'tab', title: 'Tablet', w: 768 }] } },
      { name: 'guides', a: { guides: { x: [10] } }, b: { guides: { x: [10, 20], y: [5] } } },
      { name: 'layoutGrid', a: { layoutGrid: { columns: 12, gutter: 24, margin: 80 } }, b: { layoutGrid: { columns: 4, gutter: 16, margin: 16 } } },
    ],
  },
  ...(['h1', 'hero'] as const).map((id): Level => ({
    name: `design node ${id}`,
    kind: 'design',
    make: design,
    at: (d) => findNode(byId(d.boards, 'home').root, id),
    other: id === 'h1' ? ['text', 'Hello'] : ['gap', 24],
    fields: [
      future,
      { name: 'responsive', a: { responsive: { mobile: { hidden: true } } }, b: { responsive: { mobile: { hidden: false, fontSize: 20 }, tab: { x: 4 } } } },
      { name: 'constraints', a: { constraints: { h: 'left' } }, b: { constraints: { h: 'right', v: 'bottom' } } },
      ...(id === 'h1'
        ? [{ name: 'textStyle', a: { textStyle: 'h' }, b: { textStyle: 'body' } }, { name: 'fontSize', a: { fontSize: 40 }, b: { fontSize: 12 } }]
        : [{ name: 'rowGap', a: { rowGap: 8 }, b: { rowGap: 16 } }, { name: 'fillStyle', a: { fillStyle: 'f' }, b: { fillStyle: 'g' } }]),
    ],
  })),
  {
    name: 'design responsive override',
    kind: 'design',
    make: () => {
      const d = design()
      findNode(d.boards[0].root, 'h1').responsive = { mobile: { hidden: true } }
      return d
    },
    at: (d) => findNode(byId(d.boards, 'home').root, 'h1').responsive.mobile,
    other: ['hidden', false],
    fields: [future, { name: 'fontSize', a: { fontSize: 18 }, b: { fontSize: 20 } }],
  },
  {
    name: 'data root',
    kind: 'data',
    make: dashboard,
    at: (d) => d,
    other: ['title', 'Sales v2'],
    fields: [future],
  },
  {
    name: 'data block',
    kind: 'data',
    make: dashboard,
    at: (d) => byId(d.blocks, 'b1'),
    other: ['markdown', 'Uno'],
    fields: [future],
  },
]

describe('preserve by default: a field only one side touched takes that side', () => {
  const apply = (target: any, patch: Patch) => Object.assign(target, clone(patch))
  const remove = (target: any, patch: Patch) => Object.keys(patch).forEach((key) => delete target[key])
  for (const level of levels) {
    test(level.name, () => {
      let cases = 0
      for (const field of level.fields) {
        for (const op of ['add', 'change', 'remove'] as const) {
          for (const side of ['mine', 'theirs'] as const) {
            for (const preferMine of [false, true]) {
              const base = level.make()
              if (op !== 'add') apply(level.at(base), field.a)
              const changed = clone(base)
              if (op === 'add') apply(level.at(changed), field.a)
              if (op === 'change') apply(level.at(changed), field.b)
              if (op === 'remove') remove(level.at(changed), field.a)
              const other = clone(base)
              level.at(other)[level.other[0]] = level.other[1]
              const [mine, theirs] = side === 'mine' ? [changed, other] : [other, changed]
              const what = `${level.name}: ${op} ${field.name} on ${side}${preferMine ? ' (keep mine)' : ''}`
              const result = mergeArtifactBodies(level.kind, json(base), json(mine), json(theirs), { preferMine })
              if (!result.ok) throw new Error(`${what}: conflicts ${result.conflicts.join(', ')}`)
              const got = level.at(JSON.parse(result.body))
              const want = level.at(changed)
              for (const key of Object.keys(field.a)) expect({ what, key, value: got[key] }).toEqual({ what, key, value: want[key] })
              expect({ what, other: got[level.other[0]] }).toEqual({ what, other: level.other[1] })
              cases += 1
            }
          }
        }
      }
      expect(cases).toBe(level.fields.length * 12)
    })
  }
})

describe('round-4 fields merge by their own rules', () => {
  test('a sheet cell value and its rich-text runs are one unit; formatting beside it merges', () => {
    const base = sheet()
    const mine = clone(base)
    mine.tabs[0].cells.B4 = runs('Due', { text: 'Due', bold: true })
    const theirs = clone(base)
    theirs.tabs[0].cells.B4 = { v: 12, fmt: 'currency' }
    expect(conflicts(merge('sheet', base, mine, theirs))).toEqual(['cell Budget!B4'])
    const styled = clone(base)
    styled.tabs[0].cells.B4 = { v: 10, fmt: 'currency' }
    expect(merged(merge('sheet', base, mine, styled)).tabs[0].cells.B4).toEqual({ ...runs('Due', { text: 'Due', bold: true }), fmt: 'currency' })
  })

  test('row groups added on both sides are both kept; overlapping groups conflict', () => {
    const base = sheet()
    const mine = clone(base)
    mine.tabs[0].rowGroups = [{ from: 2, to: 3 }]
    const theirs = clone(base)
    theirs.tabs[0].rowGroups = [{ from: 5, to: 6, collapsed: true }]
    expect(merged(merge('sheet', base, mine, theirs)).tabs[0].rowGroups).toEqual([{ from: 5, to: 6, collapsed: true }, { from: 2, to: 3 }])
    const overlapping = clone(base)
    overlapping.tabs[0].rowGroups = [{ from: 3, to: 4 }]
    expect(conflicts(merge('sheet', base, mine, overlapping))).toEqual(['rowGroups of tab "Budget"'])
  })

  test('tabs deleted on both sides both land in the trash, capped at the newest five', () => {
    const entry = (id: string) => ({ tab: { id, name: id, cells: {} }, index: 0 })
    const base = { ...sheet(), deletedTabs: ['o1', 'o2', 'o3', 'o4'].map(entry) }
    const mine = clone(base)
    mine.tabs = mine.tabs.filter((t: any) => t.id !== 't1')
    mine.deletedTabs.push(entry('t1'))
    const theirs = clone(base)
    theirs.tabs = theirs.tabs.filter((t: any) => t.id !== 't2')
    theirs.deletedTabs.push(entry('t2'))
    const out = merged(merge('sheet', base, mine, theirs))
    expect(out.tabs).toEqual([])
    expect(out.deletedTabs.map((e: any) => e.tab.id)).toEqual(['o2', 'o3', 'o4', 't2', 't1'])
  })

  test('slide elements merge per element id, and elements added on both sides are kept', () => {
    const base = deck()
    base.slides[1].elements = [{ id: 'e1', type: 'text', x: 0, y: 0, w: 100, h: 40, text: 'A' }]
    const mine = clone(base)
    mine.slides[1].elements[0].x = 50
    mine.slides[1].elements.push({ id: 'm', type: 'rect', x: 0, y: 0, w: 10, h: 10 })
    const theirs = clone(base)
    theirs.slides[1].elements[0].text = 'B'
    theirs.slides[1].elements.push({ id: 't', type: 'ellipse', x: 0, y: 0, w: 10, h: 10 })
    const out = merged(merge('slides', base, mine, theirs))
    expect(out.slides[1].elements.map((e: any) => e.id)).toEqual(['e1', 't', 'm'])
    expect(out.slides[1].elements[0]).toMatchObject({ x: 50, text: 'B' })
    const clash = clone(base)
    clash.slides[1].elements[0].x = 70
    expect(conflicts(merge('slides', base, mine, clash))).toEqual(['element "e1" on slide "body"'])
  })

  test('dot votes cast on both sides add up', () => {
    const base = board()
    base.elements[0].votes = 2
    const mine = clone(base)
    mine.elements[0].votes = 3
    const theirs = clone(base)
    theirs.elements[0].votes = 5
    expect(merged(merge('whiteboard', base, mine, theirs)).elements[0].votes).toBe(6)
  })

  test('guides and breakpoints added on both sides are all kept', () => {
    const base = design() as D
    base.boards[0].guides = { x: [10] }
    const mine = clone(base)
    mine.boards[0].guides.x.push(20)
    mine.boards[0].breakpoints = [{ id: 'mobile', title: 'Mobile', w: 390 }]
    const theirs = clone(base)
    theirs.boards[0].guides.x = [30]
    theirs.boards[0].breakpoints = [{ id: 'tab', title: 'Tablet', w: 768 }]
    const out = merged(merge('design', base, mine, theirs))
    expect(out.boards[0].guides).toEqual({ x: [30, 20] })
    expect(out.boards[0].breakpoints.map((b: any) => b.id)).toEqual(['tab', 'mobile'])
  })
})

describe('whiteboard: no arrow outlives the element it is bound to', () => {
  const wired = (): any => {
    const d = board()
    d.elements.push(
      { id: 'ab', type: 'arrow', from: { elementId: 'a' }, to: { elementId: 'b' }, style: 'solid' },
      { id: 'st', type: 'sticker', sticker: 'heart', x: 0, y: 0, w: 56, h: 56, attachedTo: 'a' },
    )
    return d
  }
  // As `deleteElements` does: the element, its bound arrows gone, its stickers detached.
  const deleteA = (d: any) => {
    d.elements = d.elements.filter((e: any) => e.id !== 'a' && e.id !== 'ab')
    delete byId(d.elements, 'st').attachedTo
    return d
  }

  test('one side deleted an element and its arrows while the other edited an arrow, added one and moved a sticker', () => {
    const base = wired()
    const mine = deleteA(clone(base))
    const theirs = clone(base)
    byId(theirs.elements, 'ab').label = 'edited'
    byId(theirs.elements, 'st').x = 300
    theirs.elements.push({ id: 'ca', type: 'arrow', from: { elementId: 'c' }, to: { elementId: 'a' }, style: 'dashed' })
    theirs.elements.push({ id: 'cb', type: 'arrow', from: { elementId: 'c' }, to: { elementId: 'b' }, style: 'dashed' })
    for (const [m, t] of [[mine, theirs], [theirs, mine]]) {
      const out = merged(merge('whiteboard', base, m, t))
      expect(out.elements.map((e: any) => e.id).sort()).toEqual(['b', 'c', 'cb', 'st'])
      expect(byId(out.elements, 'st')).toEqual({ id: 'st', type: 'sticker', sticker: 'heart', x: 300, y: 0, w: 56, h: 56 })
    }
  })

  test('an element deleted on one side and edited on the other still conflicts', () => {
    const base = wired()
    const theirs = clone(base)
    byId(theirs.elements, 'a').text = 'Ay'
    expect(conflicts(merge('whiteboard', base, deleteA(clone(base)), theirs))).toEqual(['element "a"'])
  })
})

// ---------------------------------------------------------------------------------------------
// Correctness round 5: Keep mine, per-unit resolution, delete-vs-edit, sheet shifts, idempotence.

describe('round 5 regressions', () => {
  test('design Keep mine yields a design body that validates (not the flattened tree)', async () => {
    const { validateDesign } = await import('./artifact-kinds/design')
    // The shared fixture's text nodes carry no `style`; a valid one, so validation means something.
    const styled = (node: any): any => (node.children ? { ...node, children: node.children.map(styled) } : { ...node, style: 'body' })
    const base = design()
    base.boards[0].root = styled(base.boards[0].root)
    expect(validateDesign(base).ok).toBe(true)
    const mine = clone(base)
    root(mine).children[0].children[0].text = 'Mine'
    const theirs = clone(base)
    root(theirs).children[0].children[0].text = 'Theirs'
    root(theirs).children[1].children[0].text = '(c) theirs'
    expect(conflicts(merge('design', base, mine, theirs)).length).toBe(1)
    const kept = mergeArtifactBodies('design', json(base), json(mine), json(theirs), { preferMine: true })
    if (!kept.ok) throw new Error(kept.conflicts.join(', '))
    const body = JSON.parse(kept.body)
    expect(validateDesign(body).ok).toBe(true)
    expect(root(body).children[0].children[0].text).toBe('Mine')
    expect(root(body).children[1].children[0].text).toBe('(c) theirs')
  })

  test('doc Keep mine keeps theirs’ non-clashing blocks and mine only on the clashing one', () => {
    const base = 'A.\n\nB.\n\nC.\n'
    const mine = 'A mine.\n\nB.\n\nC.\n'
    const theirs = 'A theirs.\n\nB.\n\nC theirs.\n'
    expect(mergeArtifactBodies('doc', base, mine, theirs).ok).toBe(false)
    const kept = mergeArtifactBodies('doc', base, mine, theirs, { preferMine: true })
    expect(kept.ok && kept.body).toBe('A mine.\n\nB.\n\nC theirs.\n')
    const theirsWins = mergeArtifactBodies('doc', base, mine, theirs, { resolve: 'theirs' })
    expect(theirsWins.ok && theirsWins.body).toBe(theirs)
  })

  test('per-unit resolution: each conflict has a key, and a map settles each one its own way', () => {
    const deck = (a: string, b: string) => ({ version: 1, title: 'D', aspect: '16:9', slides: [{ id: 'a', layout: 'title', title: a }, { id: 'b', layout: 'title', title: b }] })
    const base = deck('A', 'B')
    const mine = deck('mine A', 'mine B')
    const theirs = deck('their A', 'their B')
    const result = merge('slides', base, mine, theirs)
    if (result.ok) throw new Error('expected conflicts')
    expect(result.units.map((u) => u.label)).toEqual(['slide "a"', 'slide "b"'])
    const [a, b] = result.units.map((u) => u.key)
    const settled = mergeArtifactBodies('slides', json(base), json(mine), json(theirs), { resolve: { [a!]: 'mine', [b!]: 'theirs' } })
    expect(settled.ok && JSON.parse(settled.body).slides.map((s: { title: string }) => s.title)).toEqual(['mine A', 'their B'])
    // A map that leaves a conflict unsettled still fails, naming only that one.
    const partial = mergeArtifactBodies('slides', json(base), json(mine), json(theirs), { resolve: { [a!]: 'mine' } })
    expect(partial.ok ? [] : partial.units.map((u) => u.key)).toEqual([b])
  })

  test('delete vs edit is a conflict; Keep mine takes mine’s side of it (the delete or the edit)', () => {
    const deck = (slides: Array<{ id: string; title: string }>) => ({ version: 1, title: 'D', aspect: '16:9', slides: slides.map((s) => ({ ...s, layout: 'title' })) })
    const base = deck([{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }])
    const deleted = deck([{ id: 'b', title: 'B' }])
    const edited = deck([{ id: 'a', title: 'A2' }, { id: 'b', title: 'B' }])
    const titles = (r: ArtifactMergeResult) => (r.ok ? JSON.parse(r.body).slides.map((s: { title: string }) => s.title) : r.conflicts)
    expect(conflicts(merge('slides', base, deleted, edited))).toEqual(['slide "a"'])
    // Mine deleted it: Keep mine deletes it; theirs wins: their edit stays.
    expect(titles(mergeArtifactBodies('slides', json(base), json(deleted), json(edited), { preferMine: true }))).toEqual(['B'])
    expect(titles(mergeArtifactBodies('slides', json(base), json(deleted), json(edited), { resolve: 'theirs' }))).toEqual(['A2', 'B'])
    // Mine edited it: Keep mine keeps the edit; theirs wins: it is deleted.
    expect(titles(mergeArtifactBodies('slides', json(base), json(edited), json(deleted), { preferMine: true }))).toEqual(['A2', 'B'])
    expect(titles(mergeArtifactBodies('slides', json(base), json(edited), json(deleted), { resolve: 'theirs' }))).toEqual(['B'])
  })

  test('a row inserted above a lone cell moves the other side’s edits with it', async () => {
    const { insertLines } = await import('./artifact-kinds/sheet-structure')
    const book: any = { version: 1, title: 'B', tabs: [{ id: 't', name: 'Budget', cells: { A5: { v: 'x' } } }] }
    const mine = insertLines(book, 't', 'row', 0, 1)
    const theirs = clone(book)
    theirs.tabs[0].cells.B5 = { v: 'typed next to x' }
    for (const [m, t] of [[mine, theirs], [theirs, mine]]) {
      const out = merged(merge('sheet', book, m, t))
      expect(out.tabs[0].cells).toEqual({ A6: { v: 'x' }, B6: { v: 'typed next to x' } })
      expect(out.tabs[0].rows).toBe(1001)
    }
  })

  test('rows or columns inserted or deleted on one side; the other side’s edits land on the shifted addresses', async () => {
    const { insertLines, deleteLines } = await import('./artifact-kinds/sheet-structure')
    const book: any = {
      version: 1, title: 'B',
      tabs: [
        { id: 't', name: 'Budget', cells: { A1: { v: 'Item' }, A2: { v: 'Rent' }, B2: { v: 10 }, A3: { v: 'Food' }, B3: { v: 20 }, A4: { v: 'Fun' }, B4: { v: 5 } } },
        { id: 's', name: 'Sum', cells: { A1: { f: '=Budget!B4' } } },
      ],
    }
    const theirs = clone(book)
    theirs.tabs[0].cells.B4 = { v: 12 }
    theirs.tabs[0].cells.C3 = { v: 'note' }
    theirs.tabs[1].cells.A2 = { f: '=Budget!B3*2' }
    // Insert a row at 2 (before Food): B4 → B5, C3 → C4; formulas in the other tab follow.
    const inserted = merged(merge('sheet', book, insertLines(book, 't', 'row', 2, 1), theirs))
    expect(inserted.tabs[0].cells).toMatchObject({ B5: { v: 12 }, C4: { v: 'note' }, B4: { v: 20 } })
    expect(inserted.tabs[0].cells.A3).toBeUndefined()
    expect(inserted.tabs[1].cells).toEqual({ A1: { f: '=Budget!B5' }, A2: { f: '=Budget!B4*2' } })
    // Delete row 2 (Rent): B4 → B3, C3 → C2.
    const removed = merged(merge('sheet', book, deleteLines(book, 't', 'row', 1, 1), theirs))
    expect(removed.tabs[0].cells).toEqual({ A1: { v: 'Item' }, A2: { v: 'Food' }, B2: { v: 20 }, C2: { v: 'note' }, A3: { v: 'Fun' }, B3: { v: 12 } })
    expect(removed.tabs[1].cells).toEqual({ A1: { f: '=Budget!B3' }, A2: { f: '=Budget!B2*2' } })
    // Insert a column before B: B4 → C4, C3 → D3.
    const col = merged(merge('sheet', book, insertLines(book, 't', 'col', 1, 1), theirs))
    expect(col.tabs[0].cells.C4).toEqual({ v: 12 })
    expect(col.tabs[0].cells.D3).toEqual({ v: 'note' })
    expect(col.tabs[1].cells).toEqual({ A1: { f: '=Budget!C4' }, A2: { f: '=Budget!C3*2' } })
  })

  test('settled against a line edit, that side’s other edits on the tab and elsewhere survive', async () => {
    const { deleteLines, insertLines } = await import('./artifact-kinds/sheet-structure')
    const book: any = {
      version: 1, title: 'B',
      tabs: [
        { id: 't', name: 'T', cells: { A1: { v: 1 }, A2: { v: 2 }, A3: { v: 3 }, D5: { v: 'd' } } },
        { id: 's', name: 'S', cells: { A1: { f: '=T!A3' } } },
      ],
    }
    // Theirs deletes row 2 and edits D5 (now D4) and S!B1; mine edits A2, on the deleted row.
    const theirs: any = deleteLines(book, 't', 'row', 1, 1)
    theirs.tabs[0].cells.D4 = { v: 'their d' }
    theirs.tabs[1].cells.B1 = { v: 'their s' }
    const mine = clone(book)
    mine.tabs[0].cells.A2 = { v: 'mine' }
    expect(merge('sheet', book, mine, theirs).ok).toBe(false)
    const kept = merged(mergeArtifactBodies('sheet', json(book), json(mine), json(theirs), { resolve: 'mine' }))
    expect(kept.tabs[0].cells).toEqual({ A1: { v: 1 }, A2: { v: 'mine' }, A3: { v: 3 }, D5: { v: 'their d' } })
    expect(kept.tabs[1].cells).toEqual({ A1: { f: '=T!A3' }, B1: { v: 'their s' } })
    expect(kept.tabs[0].rows).toBeUndefined()
    // Both insert differently; theirs' cell edit survives the undo of their insert.
    const mineIns: any = insertLines(book, 't', 'row', 0, 1)
    const theirIns: any = insertLines(book, 't', 'row', 2, 1)
    theirIns.tabs[0].cells.D6 = { v: 'their d' }
    const both = merged(mergeArtifactBodies('sheet', json(book), json(mineIns), json(theirIns), { resolve: 'mine' }))
    expect(both.tabs[0].cells).toEqual({ A2: { v: 1 }, A3: { v: 2 }, A4: { v: 3 }, D6: { v: 'their d' } })
    expect(both.tabs[1].cells).toEqual({ A1: { f: '=T!A4' } })
  })

  test('an edit to a cell the other side deleted with its row is a conflict', async () => {
    const { deleteLines } = await import('./artifact-kinds/sheet-structure')
    const book: any = { version: 1, title: 'B', tabs: [{ id: 't', name: 'T', cells: { A1: { v: 1 }, A2: { v: 2 }, A3: { v: 3 } } }] }
    const theirs = clone(book)
    theirs.tabs[0].cells.A2 = { v: 22 }
    const result = merge('sheet', book, deleteLines(book, 't', 'row', 1, 1), theirs)
    expect(result.ok).toBe(false)
  })

  describe('design: settling a conflict always gives a valid design', () => {
    const styled = (node: any): any => (node.children ? { ...node, children: node.children.map(styled) } : { ...node, style: 'body' })
    const valid = () => {
      const d = design()
      d.boards[0].root = styled(d.boards[0].root)
      return d
    }
    const settle = async (base: unknown, mine: unknown, theirs: unknown, resolve: 'mine' | 'theirs') => {
      const { validateDesign } = await import('./artifact-kinds/design')
      const out = merged(mergeArtifactBodies('design', json(base), json(mine), json(theirs), { resolve }))
      expect(validateDesign(out).ok).toBe(true)
      return out
    }

    test('a frame deleted on one side, a child in it edited on the other', async () => {
      const base = valid()
      const deleted = clone(base)
      root(deleted).children.splice(1, 1)
      const edited = clone(base)
      root(edited).children[1].children[0].text = 'edited'
      expect(conflicts(merge('design', base, edited, deleted))).toEqual(['node "copy" on board "Home"'])
      // The edit kept: its frame comes back with it.
      expect(ids((await settle(base, edited, deleted, 'mine')).boards[0].root)).toEqual({ root: [{ hero: ['h1', 'lede'] }, { footer: ['copy'] }] })
      expect((await settle(base, edited, deleted, 'mine')).boards[0].root.children[1].children[0].text).toBe('edited')
      // The delete kept: the frame and the edited child go.
      expect(ids((await settle(base, edited, deleted, 'theirs')).boards[0].root)).toEqual({ root: [{ hero: ['h1', 'lede'] }] })
    })

    test('two moves that nest two frames in each other: a side settles it', async () => {
      const base = valid() as D
      root(base).children[0].children.push({ id: 'A', type: 'frame', layout: 'stack-v', children: [] })
      root(base).children[1].children.push({ id: 'B', type: 'frame', layout: 'stack-v', children: [] })
      const mine = clone(base)
      root(mine).children[0].children[2].children.push(root(mine).children[1].children.pop())
      const theirs = clone(base)
      root(theirs).children[1].children[1].children.push(root(theirs).children[0].children.pop())
      expect(ids((await settle(base, mine, theirs, 'mine')).boards[0].root)).toEqual({ root: [{ hero: ['h1', 'lede', { A: [{ B: [] }] }] }, { footer: ['copy'] }] })
      expect(ids((await settle(base, mine, theirs, 'theirs')).boards[0].root)).toEqual({ root: [{ hero: ['h1', 'lede'] }, { footer: ['copy', { B: [{ A: [] }] }] }] })
    })

    test('a board deleted on one side, a node on it edited on the other', async () => {
      const base = valid()
      const deleted = { ...clone(base), boards: [] }
      const edited = clone(base)
      root(edited).children[0].children[0].text = 'edited'
      expect(merge('design', base, edited, deleted).ok).toBe(false)
      const kept = await settle(base, edited, deleted, 'mine')
      expect(kept.boards.map((b: { id: string }) => b.id)).toEqual(['home'])
      expect(root(kept).children[0].children[0].text).toBe('edited')
      expect(ids(root(kept))).toEqual({ root: [{ hero: ['h1', 'lede'] }, { footer: ['copy'] }] })
      expect((await settle(base, edited, deleted, 'theirs')).boards).toEqual([])
    })
  })

  test('idempotence: merge(base, x, x) = x, merge(base, base, t) = t, merge(base, m, base) = m, and re-merging the result is stable', () => {
    const base = design()
    const mine = clone(base)
    root(mine).children[0].children[0].text = 'Mine'
    const theirs = clone(base)
    root(theirs).children[1].children[0].text = 'Theirs'
    const [b, m, t] = [base, mine, theirs].map(json)
    expect(mergeArtifactBodies('design', b!, m!, m!)).toMatchObject({ ok: true, body: m })
    expect(mergeArtifactBodies('design', b!, b!, t!)).toMatchObject({ ok: true, body: t })
    expect(mergeArtifactBodies('design', b!, m!, b!)).toMatchObject({ ok: true, body: m })
    const once = mergeArtifactBodies('design', b!, m!, t!)
    if (!once.ok) throw new Error('merge')
    const twice = mergeArtifactBodies('design', b!, once.body, t!)
    expect(twice.ok && JSON.parse(twice.body)).toEqual(JSON.parse(once.body))
  })
})

describe('round 5 fields that are not keyed lists', () => {
  test("slides: a deck's design tokens merge per colour role, the same role changed on both sides is a conflict", () => {
    const base = { version: 1, title: 'D', aspect: '16:9', tokens: { name: 'Acme', colors: { ink: '#111111', accent: '#222222' } }, slides: [{ id: 's1', layout: 'title' }] }
    const mine = { ...clone(base), tokens: { ...base.tokens, colors: { ...base.tokens.colors, ink: '#333333' } } }
    const theirs = { ...clone(base), tokens: { ...base.tokens, name: 'Acme 2', colors: { ...base.tokens.colors, accent: '#444444' } } }
    expect(merged(merge('slides', base, mine, theirs)).tokens).toEqual({ name: 'Acme 2', colors: { ink: '#333333', accent: '#444444' } })
    const clash = { ...clone(base), tokens: { ...base.tokens, colors: { ...base.tokens.colors, ink: '#555555' } } }
    expect(merge('slides', base, mine, clash).ok).toBe(false)
  })

  test("sheet: a person cell's people and its shown value are one unit, its look another", () => {
    const cell = { v: 'Ada', people: [{ name: 'Ada' }] }
    const base = { version: 1, title: 'S', tabs: [{ id: 't', name: 'T', cells: { A1: cell } }] }
    const withCell = (a1: object) => ({ ...clone(base), tabs: [{ ...base.tabs[0], cells: { A1: a1 } }] })
    // One side renames the person (v and people together), the other bolds the cell: both land.
    const renamed = { v: 'Grace', people: [{ name: 'Grace' }] }
    expect(merged(merge('sheet', base, withCell(renamed), withCell({ ...cell, bold: true }))).tabs[0].cells.A1).toEqual({ ...renamed, bold: true })
    // One side changes the people, the other the text: never a cell whose text and people disagree.
    expect(merge('sheet', base, withCell({ v: 'Ada', people: [{ name: 'Ada' }, { name: 'Lin' }] }), withCell({ v: 'Ada L.', people: [{ name: 'Ada' }] })).ok).toBe(false)
  })

  test("whiteboard: a table's cells, merged cells and column weights are one unit; hidden and crop merge on their own", () => {
    const table = { id: 'tb', type: 'table', x: 0, y: 0, w: 280, h: 80, rows: [['a', 'b'], ['c', 'd']] }
    const image = { id: 'im', type: 'image', x: 300, y: 0, w: 100, h: 100, src: '/_asset/abc', alt: 'A' }
    const base = { version: 1, title: 'B', elements: [table, image] }
    const mine = { ...clone(base), elements: [{ ...table, merges: [{ row: 0, col: 0, rows: 1, cols: 2 }] }, { ...image, hidden: true }] }
    const theirs = { ...clone(base), elements: [{ ...table, rows: [['a'], ['c']] }, { ...image, crop: { x: 0, y: 0, w: 0.5, h: 0.5 } }] }
    // A merge spanning two columns over a table that dropped one would not fit: a conflict.
    expect(merge('whiteboard', base, mine, theirs).ok).toBe(false)
    const onlyImage = { ...clone(base), elements: [table, { ...image, crop: { x: 0, y: 0, w: 0.5, h: 0.5 } }] }
    expect(merged(merge('whiteboard', base, mine, onlyImage)).elements[1]).toEqual({ ...image, hidden: true, crop: { x: 0, y: 0, w: 0.5, h: 0.5 } })
  })
})
