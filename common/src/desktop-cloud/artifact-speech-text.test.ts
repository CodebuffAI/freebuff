import { describe, expect, test } from 'bun:test'

import { DESIGN_EXAMPLE } from './artifact-kinds/design'
import { WHITEBOARD_EXAMPLE } from './artifact-kinds/whiteboard'
import { MAX_SPEECH_SENTENCE, artifactSpeechText, splitSpeechSentences } from './artifact-speech-text'

describe('splitSpeechSentences', () => {
  test('splits at sentence ends and line breaks, not at abbreviations, initials or decimals', () => {
    expect(splitSpeechSentences('Growth was 3.5% in the U.S. this week. Costs rose, e.g. hosting! Why?\nNext line')).toEqual([
      'Growth was 3.5% in the U.S. this week.',
      'Costs rose, e.g. hosting!',
      'Why?',
      'Next line',
    ])
  })

  test('drops empty pieces and breaks a long sentence at a comma or a space', () => {
    expect(splitSpeechSentences('  \n\n  ')).toEqual([])
    const long = Array.from({ length: 80 }, (_, i) => `word${i}`).join(' ')
    const pieces = splitSpeechSentences(`${long}, and then the end.`)
    expect(pieces.length).toBeGreaterThan(1)
    for (const piece of pieces) expect(piece.length).toBeLessThanOrEqual(MAX_SPEECH_SENTENCE)
    expect(pieces.join(' ')).toBe(`${long}, and then the end.`)
  })
})

describe('artifactSpeechText', () => {
  test('never throws: a bad or empty body reads as nothing', () => {
    for (const kind of ['doc', 'slides', 'sheet', 'data', 'whiteboard', 'design'] as const) {
      expect(artifactSpeechText(kind, '')).toEqual({ sentences: [], text: '' })
      if (kind !== 'doc') expect(artifactSpeechText(kind, '{not json')).toEqual({ sentences: [], text: '' })
      if (kind !== 'doc') expect(artifactSpeechText(kind, '{"version":1}')).toEqual({ sentences: [], text: '' })
    }
  })

  const DOC = [
    '# Launch plan',
    '*As of 2026-11-16 · Freebuff*',
    'We ship **Friday**. See [the board](https://example.com) for `details`',
    '- First item\n- [x] Second item\n  continues here',
    '```ts\nconst secret = 1\n```',
    '| Name | Owner |\n| --- | --- |\n| Docs | Ana |',
    '> [!NOTE]\n> Watch the date',
    '[//]: # "pending: the risks section"',
    '[//]: # "tab: Risks"',
    '## Risks',
    'Bots filling the form.',
    '[//]: # "fb-suggestion: {}"',
  ].join('\n\n')

  test('doc: headings, paragraphs, list items, tables and callouts; code, markers and the sidecar are skipped', () => {
    const speech = artifactSpeechText('doc', DOC)
    expect(speech.title).toBe('Launch plan')
    expect(speech.sentences).toEqual([
      'Launch plan.',
      'As of 2026-11-16 · Freebuff.',
      'We ship Friday.',
      'See the board for details.',
      'First item.',
      'Second item continues here.',
      'Name, Owner.',
      'Docs, Ana.',
      'Note: Watch the date.',
      'Risks.',
      'Bots filling the form.',
    ])
    expect(speech.text).toBe(speech.sentences.join(' '))
    expect(speech.text).not.toContain('secret')
  })

  test('doc: a selected tab reads only that tab', () => {
    expect(artifactSpeechText('doc', DOC, { tabId: 'risks' }).sentences).toEqual(['Risks.', 'Bots filling the form.'])
    expect(artifactSpeechText('doc', DOC, { tabId: 'tab-1' }).sentences[0]).toBe('Launch plan.')
  })

  const DECK = JSON.stringify({
    version: 1,
    title: 'Q4 launch',
    aspect: '16:9',
    slides: [
      { id: 'cover', layout: 'title', title: 'Q4 launch plan', subtitle: 'Freebuff team' },
      {
        id: 'why',
        layout: 'title-body',
        title: 'Why now',
        body: '- Users asked\n- Costs fell',
        notes: 'Pause here. Ask for questions',
        elements: [
          { id: 'tag', type: 'text', x: 10, y: 10, w: 100, h: 40, text: 'New!' },
          { id: 'rule', type: 'line', x: 0, y: 0, w: 100, h: 2 },
        ],
      },
    ],
  })

  test('slides: "Slide N. <title>." then subtitle, body, text elements and notes', () => {
    const speech = artifactSpeechText('slides', DECK)
    expect(speech.title).toBe('Q4 launch')
    expect(speech.sentences).toEqual([
      'Slide 1.',
      'Q4 launch plan.',
      'Freebuff team.',
      'Slide 2.',
      'Why now.',
      'Users asked.',
      'Costs fell.',
      'New!',
      'Speaker notes.',
      'Pause here.',
      'Ask for questions.',
    ])
    expect(artifactSpeechText('slides', DECK, { slideId: 'why' }).sentences[0]).toBe('Slide 2.')
  })

  const WORKBOOK = JSON.stringify({
    version: 1,
    title: 'Budget',
    tabs: [
      {
        id: 'budget',
        name: 'Budget',
        cells: {
          A1: { v: 'Item' },
          B1: { v: 'Cost' },
          A2: { v: 'Hosting' },
          B2: { v: 1200, fmt: 'currency' },
          A3: { v: 'Ads' },
          B3: { v: 300, fmt: 'currency' },
          A4: { v: 'Total' },
          B4: { f: '=SUM(B2:B3)', fmt: 'currency' },
          ...Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`A${i + 5}`, { v: `Row ${i + 5}` }])),
        },
      },
      { id: 'notes', name: 'Notes', cells: { A1: { v: 'Hello' } } },
    ],
  })

  test('sheet: without a range, the header row and the first five rows, values paired with headers', () => {
    const speech = artifactSpeechText('sheet', WORKBOOK)
    expect(speech.title).toBe('Budget')
    expect(speech.sentences).toEqual([
      'Budget.',
      'Columns: Item, Cost.',
      'Row 2.',
      'Item: Hosting, Cost: $1,200.00.',
      'Row 3.',
      'Item: Ads, Cost: $300.00.',
      'Row 4.',
      'Item: Total, Cost: $1,500.00.',
      'Row 5.',
      'Item: Row 5.',
      'Row 6.',
      'Item: Row 6.',
    ])
  })

  test('sheet: a selected range reads row by row, on the named tab', () => {
    expect(artifactSpeechText('sheet', WORKBOOK, { tabId: 'budget', range: 'a3:b4' }).sentences).toEqual([
      'Budget.',
      'Row 3: Ads, $300.00.',
      'Row 4: Total, $1,500.00.',
    ])
    expect(artifactSpeechText('sheet', WORKBOOK, { range: 'Notes!A1' }).sentences).toEqual(['Notes.', 'A1: Hello.'])
    // A huge range is clamped, never walked cell by cell.
    expect(artifactSpeechText('sheet', WORKBOOK, { range: 'A1:ZZ50000' }).sentences.length).toBeLessThan(40)
  })

  const DASHBOARD = JSON.stringify({
    version: 1,
    title: 'Signups',
    subtitle: 'All platforms',
    layout: 'grid',
    sources: [{ id: 'csv', label: 'Signup export' }],
    datasets: [
      {
        id: 'weekly',
        sourceId: 'csv',
        columns: [
          { key: 'week', label: 'Week', type: 'date' },
          { key: 'n', label: 'Signups', type: 'number' },
        ],
        rows: [
          { week: '2026-11-02', n: 96 },
          { week: '2026-11-09', n: 120 },
        ],
      },
    ],
    blocks: [
      { kind: 'section', id: 's1', title: 'Growth', description: 'How we grew' },
      { kind: 'kpi', id: 'total', label: 'Signups', datasetId: 'weekly', value: { column: 'n', agg: 'sum' }, format: 'integer', sourceId: 'csv' },
      { kind: 'kpi', id: 'goal', label: 'Goal', value: { literal: 500 }, format: 'number', sourceId: 'csv' },
      { kind: 'chart', id: 'trend', title: 'Signups by week', type: 'bar', datasetId: 'weekly', x: 'week', series: [{ key: 'n', label: 'Signups' }], sourceId: 'csv' },
      { kind: 'text', id: 'x', markdown: '**Note** the numbers.' },
    ],
  })

  test('data: title, KPIs as "<label>: <value>", sections, charts and text', () => {
    const speech = artifactSpeechText('data', DASHBOARD)
    expect(speech.title).toBe('Signups')
    expect(speech.sentences).toEqual([
      'Signups.',
      'All platforms.',
      'Growth.',
      'How we grew.',
      'Signups: 216.',
      'Goal: 500.',
      'Chart: Signups by week.',
      'Note the numbers.',
    ])
    expect(artifactSpeechText('data', DASHBOARD, { blockId: 'goal' }).sentences).toEqual(['Goal: 500.'])
  })

  test('whiteboard: rows top-to-bottom, each left-to-right (a taller shape keeps its place), sections then their notes', () => {
    const speech = artifactSpeechText('whiteboard', JSON.stringify(WHITEBOARD_EXAMPLE))
    expect(speech.title).toBe('Signup flow')
    expect(speech.sentences).toEqual([
      'Signup flow.',
      'Landing page.',
      'Sign-up form.',
      'Email valid?',
      'Welcome.',
      'Open questions.',
      'Do we need email verification on day one?',
      'Offer Google sign-in?',
      'Risk: bots filling the form.',
    ])
  })

  test('whiteboard: a note above its section on the page still reads under it when inside it', () => {
    const board = {
      version: 1,
      title: 'Retro',
      elements: [
        { type: 'note', id: 'loose', x: 0, y: 900, w: 200, h: 200, text: 'Loose **idea**', color: 'yellow' },
        { type: 'section', id: 'good', x: 0, y: 0, w: 600, h: 400, title: 'Went well' },
        { type: 'note', id: 'b', x: 300, y: 60, w: 200, h: 200, text: 'Shipped', color: 'green' },
        { type: 'note', id: 'a', x: 40, y: 60, w: 200, h: 200, text: '- Fast reviews\n- Good docs', color: 'green' },
      ],
    }
    expect(artifactSpeechText('whiteboard', JSON.stringify(board)).sentences).toEqual([
      'Went well.',
      'Fast reviews.',
      'Good docs.',
      'Shipped.',
      'Loose idea.',
    ])
  })

  const DESIGN = {
    version: 1,
    title: 'Sign in',
    boards: [
      {
        id: 'signin',
        title: 'Sign in screen',
        x: 0,
        y: 0,
        w: 390,
        h: 844,
        root: {
          type: 'frame',
          id: 'root',
          layout: 'stack-v',
          children: [
            { type: 'text', id: 'title', text: 'Welcome back', style: 'h1' },
            { type: 'text', id: 'secret', text: 'Hidden copy', style: 'body', hidden: true },
            {
              type: 'frame',
              id: 'row',
              layout: 'stack-h',
              children: [{ type: 'button', id: 'go', label: 'Continue', variant: 'primary' }],
            },
          ],
        },
      },
      {
        id: 'home',
        title: 'Home',
        x: 500,
        y: 0,
        w: 390,
        h: 844,
        root: { type: 'frame', id: 'home-root', layout: 'stack-v', children: [{ type: 'text', id: 'hi', text: 'Hi there', style: 'body' }] },
      },
    ],
  }

  test('design: board titles, then text and button labels in tree order; hidden nodes skipped', () => {
    const speech = artifactSpeechText('design', JSON.stringify(DESIGN))
    expect(speech.title).toBe('Sign in')
    expect(speech.sentences).toEqual(['Sign in screen.', 'Welcome back.', 'Continue.', 'Home.', 'Hi there.'])
    expect(artifactSpeechText('design', JSON.stringify(DESIGN), { boardId: 'home' }).sentences).toEqual(['Home.', 'Hi there.'])
  })

  test('design: the shipped example reads without throwing', () => {
    const speech = artifactSpeechText('design', JSON.stringify(DESIGN_EXAMPLE))
    expect(speech.sentences.length).toBeGreaterThan(0)
  })
})
