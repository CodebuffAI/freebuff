import { describe, expect, test } from 'bun:test'

import { slidesLayoutIssues, slidesLayoutReport } from './slides-layout-report'
import { slidesOverflowIssues, slidesTextRegions } from './slides-overflow'
import { buildSteps, bulletSteps, elementBuildStep, listItemCount, setDeckStyle } from './slides-ops'
import {
  connectElements,
  connectorLine,
  contrastRatio,
  findInDeck,
  importSlides,
  magicMoves,
  replaceInDeck,
  setDeckAspect,
  elementBuildGroups,
  setDeckTokens,
  setElementBuilds,
  setReadingOrder,
  slideReadingOrder,
  slidesFromText,
  tokensFromDesign,
} from './slides-r5'
import { DECK_FONT_IDS, SLIDE_ICONS, deckFontStack, parseDeck, type Deck, type Slide } from './slides'

/** A deck stored by round 4 (every field it knew), frozen: round 5 must read it exactly as before. */
const PRE_ROUND_5 = Object.freeze({
  version: 1,
  title: 'Launch',
  aspect: '16:9',
  theme: 'bold',
  accent: 'green',
  transition: 'slide',
  fonts: { heading: 'serif', body: 'system' },
  footer: 'Acme',
  slideNumbers: false,
  slides: [
    { id: 'cover', layout: 'title', title: 'Launch', subtitle: 'Q4', notes: 'Hi', transition: 'fade' },
    {
      id: 'plan',
      layout: 'title-body',
      title: 'Plan',
      body: '- One\n  - nested\n- Two',
      build: 'bullets',
      section: 'Plan',
      sectionDescription: 'What we do',
      style: { title: { size: 'lg', align: 'center', color: 'accent' } },
      elements: [
        { id: 'box', type: 'rect', x: 100, y: 100, w: 200, h: 80, fill: 'tint', stroke: 'accent', strokeWidth: 2, text: 'Box', rotation: 10 },
        { id: 'pic', type: 'image', x: 400, y: 100, w: 200, h: 120, src: '/_asset/abc', alt: 'A chart', fit: 'cover' },
        { id: 'arrow-1', type: 'arrow', x: 300, y: 130, w: 100, h: 20, stroke: 'ink' },
      ],
    },
    { id: 'pic2', layout: 'image', image: { src: '/_asset/x', alt: 'x', position: { x: 10, y: 20 } }, subtitle: 'caption' },
  ],
})

const json = (value: unknown) => JSON.parse(JSON.stringify(value))

function deckOf(slides: Slide[], extra: Partial<Deck> = {}): Deck {
  return { version: 1, title: 'T', aspect: '16:9', slides, ...extra }
}

describe('round-5 schema', () => {
  test('a pre-round-5 deck parses unchanged (no defaults added, nothing dropped)', () => {
    const parsed = parseDeck(json(PRE_ROUND_5))
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.deck).toEqual(json(PRE_ROUND_5))
  })

  test('the new fields and element types validate, and bad ones are refused', () => {
    const slide: Slide = {
      id: 's',
      layout: 'title-body',
      title: 'T',
      build: 'all',
      transition: 'magic',
      elements: [
        { id: 'a', type: 'rect', x: 0, y: 0, w: 10, h: 10, build: 1, animate: 'rise', readOrder: 2 },
        { id: 'i', type: 'icon', x: 0, y: 0, w: 10, h: 10, icon: 'rocket', label: 'Launch' },
        { id: 'l', type: 'link', x: 0, y: 0, w: 10, h: 10, url: 'https://example.com/x', title: 'Docs' },
        { id: 'c', type: 'connector', x: 0, y: 0, w: 10, h: 10, from: 'a', to: 'i', head: 'both' },
      ],
    }
    const deck = deckOf([slide], {
      transition: 'push',
      fonts: { heading: 'inter', body: 'google-sans' },
      tokens: { name: 'Acme', colors: { accent: '#0057ff', paper: '#ffffff' }, spacing: 'roomy' },
    })
    expect(parseDeck(deck).ok).toBe(true)
    const bad = (patch: Record<string, unknown>) => parseDeck({ ...deck, slides: [{ ...slide, elements: [{ ...slide.elements![0], ...patch }] }] }).ok
    expect(bad({ build: 0 })).toBe(false)
    expect(bad({ animate: 'spin' })).toBe(false)
    expect(parseDeck({ ...deck, slides: [{ ...slide, elements: [{ id: 'l', type: 'link', x: 0, y: 0, w: 1, h: 1, url: 'javascript:alert(1)', title: 'x' }] }] }).ok).toBe(false)
    expect(parseDeck({ ...deck, slides: [{ ...slide, elements: [{ id: 'l', type: 'link', x: 0, y: 0, w: 1, h: 1, url: 'http://example.com', title: 'x' }] }] }).ok).toBe(false)
    expect(parseDeck({ ...deck, slides: [{ ...slide, elements: [{ id: 'i', type: 'icon', x: 0, y: 0, w: 1, h: 1, icon: 'skull' }] }] }).ok).toBe(false)
    expect(parseDeck({ ...deck, tokens: { colors: { ink: 'red' } } }).ok).toBe(false)
    expect(parseDeck({ ...deck, tokens: { colors: { ink: '#000' } } }).ok).toBe(false)
    expect(parseDeck({ ...deck, fonts: { heading: 'comic-sans' } }).ok).toBe(false)
    // A connector naming a missing element still parses (a merge may remove one end).
    expect(parseDeck({ ...deck, slides: [{ ...slide, elements: [{ id: 'c', type: 'connector', x: 0, y: 0, w: 1, h: 1, from: 'gone', to: 'also' }] }] }).ok).toBe(true)
  })

  test('web fonts map to the app variables; icons are a fixed list', () => {
    expect(DECK_FONT_IDS).toContain('inter')
    expect(deckFontStack('inter')).toContain('var(--font-inter)')
    expect(deckFontStack('serif')).not.toContain('var(')
    expect(new Set(SLIDE_ICONS).size).toBe(SLIDE_ICONS.length)
  })
})

describe('builds', () => {
  test('bullets, every list item, then free elements by build number', () => {
    const slide: Slide = {
      id: 's',
      layout: 'title-body',
      body: '- One\n  - nested\n- Two',
      build: 'bullets',
      elements: [
        { id: 'a', type: 'rect', x: 0, y: 0, w: 1, h: 1, build: 3 },
        { id: 'b', type: 'rect', x: 0, y: 0, w: 1, h: 1, build: 1 },
        { id: 'c', type: 'rect', x: 0, y: 0, w: 1, h: 1, build: 3 },
        { id: 'd', type: 'rect', x: 0, y: 0, w: 1, h: 1 },
      ],
    }
    expect(listItemCount(slide.body)).toBe(3)
    expect(bulletSteps(slide)).toBe(2)
    expect(bulletSteps({ ...slide, build: 'all' })).toBe(3)
    expect(buildSteps(slide)).toBe(4)
    expect(elementBuildStep(slide, slide.elements![1])).toBe(3)
    expect(elementBuildStep(slide, slide.elements![0])).toBe(4)
    expect(elementBuildStep(slide, slide.elements![2])).toBe(4)
    expect(elementBuildStep(slide, slide.elements![3])).toBe(0)
    // A layout without bullets still builds its elements.
    expect(buildSteps({ ...slide, layout: 'quote' })).toBe(2)
  })
})

describe('aspect', () => {
  test('16:9 → 4:3 reflows elements to the new width and back again', () => {
    const deck = deckOf([
      { id: 's', layout: 'blank', elements: [{ id: 't', type: 'text', x: 480, y: 100, w: 400, h: 100, text: 'x', size: 40 }] },
    ])
    const narrow = setDeckAspect(deck, '4:3')
    expect(narrow.aspect).toBe('4:3')
    const el = narrow.slides[0].elements![0] as { x: number; y: number; w: number; h: number; size: number }
    expect(el).toMatchObject({ x: 360, w: 300, h: 75, y: 112.5, size: 30 })
    expect(parseDeck(narrow).ok).toBe(true)
    const back = setDeckAspect(narrow, '16:9')
    expect(back.slides[0].elements![0]).toMatchObject({ x: 480, w: 400, h: 100, y: 100, size: 40 })
    expect(setDeckAspect(deck, '16:9')).toBe(deck)
  })
})

describe('magic move and connectors', () => {
  test('pairs elements by id and reports how they moved', () => {
    const a: Slide = { id: 'a', layout: 'blank', elements: [{ id: 'dot', type: 'ellipse', x: 0, y: 0, w: 100, h: 100 }, { id: 'gone', type: 'rect', x: 0, y: 0, w: 1, h: 1 }] }
    const b: Slide = { id: 'b', layout: 'blank', elements: [{ id: 'dot', type: 'ellipse', x: 400, y: 200, w: 200, h: 200, rotation: 45 }, { id: 'new', type: 'rect', x: 0, y: 0, w: 1, h: 1 }] }
    expect(magicMoves(a, b)).toEqual([{ id: 'dot', dx: -450, dy: -250, sx: 0.5, sy: 0.5, fromRotation: 0 }])
    expect(magicMoves(undefined, b)).toEqual([])
    expect(magicMoves(b, b)).toEqual([])
  })

  test('a connector runs edge to edge between its elements and follows them', () => {
    const deck = deckOf([
      {
        id: 's',
        layout: 'blank',
        elements: [
          { id: 'a', type: 'rect', x: 0, y: 0, w: 100, h: 100 },
          { id: 'b', type: 'rect', x: 300, y: 0, w: 100, h: 100 },
        ],
      },
    ])
    const result = connectElements(deck, 's', 'a', 'b')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const slide = result.deck.slides[0]
    const connector = slide.elements![0]
    expect(connector).toMatchObject({ type: 'connector', from: 'a', to: 'b', head: 'end' })
    if (connector.type !== 'connector') return
    expect(connectorLine(slide, connector)).toEqual({ x1: 100, y1: 50, x2: 300, y2: 50, bound: true })
    const moved = { ...slide, elements: slide.elements!.map((element) => (element.id === 'b' ? { ...element, y: 300 } : element)) }
    const line = connectorLine(moved, connector)
    expect(line.bound).toBe(true)
    expect(line.y2).toBe(300)
    expect(parseDeck(result.deck).ok).toBe(true)
    expect(connectElements(deck, 's', 'a', 'a').ok).toBe(false)
    expect(connectElements(deck, 's', 'a', 'zz').ok).toBe(false)
    const orphan = { ...slide, elements: slide.elements!.filter((element) => element.id !== 'b') }
    expect(connectorLine(orphan, connector).bound).toBe(false)
  })
})

describe('find and replace', () => {
  const deck = deckOf([
    { id: 'a', layout: 'title-body', title: 'Q3 results', body: '- Q3 revenue\n- q3 costs', notes: 'Q3 notes' },
    { id: 'b', layout: 'blank', elements: [{ id: 't', type: 'text', x: 0, y: 0, w: 10, h: 10, text: 'See Q3' }] },
  ])
  test('finds across titles, bodies, notes and element text', () => {
    const matches = findInDeck(deck, 'Q3')
    expect(matches.map((match) => match.field)).toEqual(['title', 'body', 'body', 'notes', 'element'])
    expect(findInDeck(deck, 'Q3', { matchCase: true })).toHaveLength(4)
    expect(findInDeck(deck, 'Q3', { includeNotes: false })).toHaveLength(4)
    expect(findInDeck(deck, 'Q', { wholeWord: true })).toHaveLength(0)
  })
  test('replaces all, or one match, as one deck', () => {
    const all = replaceInDeck(deck, 'q3', 'Q4')
    expect(all.replaced).toBe(5)
    expect(all.deck.slides[0].body).toBe('- Q4 revenue\n- Q4 costs')
    expect(all.deck.slides[1].elements![0]).toMatchObject({ text: 'See Q4' })
    const [, second] = findInDeck(deck, 'Q3')
    const one = replaceInDeck(deck, 'Q3', 'Q4', {}, second)
    expect(one.replaced).toBe(1)
    expect(one.deck.slides[0].body).toBe('- Q4 revenue\n- q3 costs')
    expect(one.deck.slides[0].title).toBe('Q3 results')
    expect(replaceInDeck(deck, 'nothing', 'x').deck).toBe(deck)
    // A replacement past a field's cap is skipped, never stored.
    const long = replaceInDeck(deck, 'Q3 results', 'x'.repeat(500))
    expect(long).toMatchObject({ replaced: 0, skipped: 1 })
  })
})

describe('import', () => {
  test('a Markdown deck: --- and headings make slides, # a section, > a quote, Notes: the notes', () => {
    const slides = slidesFromText(
      ['# Results', '## The year in numbers', '', '## Revenue', '- Up 20%', '  - mostly EU', 'Notes: say the EU part slowly', '---', '> Ship it.', '-- Grace'].join('\n'),
    )
    expect(slides.map((slide) => [slide.layout, slide.title ?? slide.body])).toEqual([
      ['section', 'Results'],
      ['title-body', 'Revenue'],
      ['quote', 'Ship it.'],
    ])
    expect(slides[0]).toMatchObject({ subtitle: 'The year in numbers', section: 'Results' })
    expect(slides[1]).toMatchObject({ body: '- Up 20%\n  - mostly EU', notes: 'say the EU part slowly' })
    expect(slides[2]).toMatchObject({ subtitle: 'Grace' })
    expect(parseDeck(deckOf(slides)).ok).toBe(true)
  })

  test('a plain outline: top-level lines are titles, indented ones the bullets', () => {
    const slides = slidesFromText('Intro\n  - who we are\n  - why now\n- Plan\n    - phase one', deckOf([{ id: 'intro', layout: 'title-body' }]))
    expect(slides).toEqual([
      { id: 'intro-2', layout: 'title-body', title: 'Intro', body: '- who we are\n- why now' },
      { id: 'plan', layout: 'title-body', title: 'Plan', body: '- phase one' },
    ])
    const deck = deckOf([{ id: 'intro', layout: 'title-body' }])
    const merged = importSlides(deck, slides, 'insert', -1)
    expect(merged.slides.map((slide) => slide.id)).toEqual(['intro-2', 'plan', 'intro'])
    expect(importSlides(deck, slides, 'replace').slides).toHaveLength(2)
    expect(importSlides(deck, [], 'insert')).toBe(deck)
  })
})

describe('design-system tokens', () => {
  test('a Design artifact\'s tokens map to deck roles, fonts and spacing', () => {
    const found = tokensFromDesign(
      { colors: { text: '#111111', muted: '#666', primary: '#0057FF', background: '#ffffff', surface: '#f4f6ff' }, fonts: { heading: 'serif', body: 'humanist' }, spacingUnit: 4 },
      'Acme',
    )
    expect(found).toEqual({
      tokens: { name: 'Acme', colors: { ink: '#111111', soft: '#666666', accent: '#0057ff', paper: '#ffffff', tint: '#f4f6ff' }, spacing: 'compact' },
      fonts: { heading: 'serif', body: 'humanist' },
    })
    expect(tokensFromDesign({ tokens: { colors: { primary: 'red' } } })).toBeNull()
    expect(tokensFromDesign('nope')).toBeNull()
    const deck = deckOf([{ id: 's', layout: 'title' }])
    const installed = setDeckTokens(deck, found!.tokens, found!.fonts)
    expect(parseDeck(installed).ok).toBe(true)
    expect(installed.fonts).toEqual({ heading: 'serif', body: 'humanist' })
    expect(setDeckTokens(installed, null).tokens).toBeUndefined()
    expect(setDeckStyle(deck, { tokens: found!.tokens }).tokens).toEqual(found!.tokens)
  })

  test('contrast ratio follows WCAG', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBe(21)
    expect(contrastRatio('#777777', '#ffffff')).toBeCloseTo(4.48, 1)
  })
})

describe('layout report', () => {
  test('lists regions, placements and every kind of finding', () => {
    const deck = deckOf([
      {
        id: 'busy',
        layout: 'title-body',
        body: '| a | b |\n|---|---|\n| ' + 'x'.repeat(120) + ' | ' + 'y'.repeat(120) + ' |',
        image: undefined,
        elements: [
          { id: 'one', type: 'text', x: 100, y: 100, w: 200, h: 80, text: 'Hello' },
          { id: 'two', type: 'text', x: 200, y: 120, w: 200, h: 80, text: 'World', size: 10 },
          { id: 'off', type: 'rect', x: 2000, y: 0, w: 10, h: 10 },
          { id: 'edge', type: 'rect', x: 900, y: 0, w: 200, h: 10 },
          { id: 'faint', type: 'rect', x: 500, y: 300, w: 200, h: 100, text: 'low', fill: 'tint', color: 'accent', size: 14 },
          { id: 'pic', type: 'image', x: 0, y: 400, w: 50, h: 50, src: '/_asset/a', alt: '' },
          { id: 'wire', type: 'connector', x: 0, y: 0, w: 10, h: 10, from: 'one', to: 'missing' },
        ],
      },
    ])
    const [report] = slidesLayoutReport(deck)
    expect(report.hasTitle).toBe(false)
    expect(report.images).toEqual({ count: 1, missingAlt: 1 })
    expect(report.elements.find((element) => element.id === 'off')?.placement).toBe('off')
    expect(report.elements.find((element) => element.id === 'edge')?.placement).toBe('partly-off')
    expect(report.regions.some((region) => region.region === 'body')).toBe(true)
    const kinds = new Set(report.issues.map((issue) => issue.kind))
    for (const kind of ['overflow', 'overlap', 'off-canvas', 'contrast', 'missing-alt', 'missing-title', 'small-text', 'unbound-connector'])
      expect(kinds.has(kind as never)).toBe(true)
    // The table width check is part of the overflow estimate the agent's read already returns.
    expect(slidesOverflowIssues(deck).some((issue) => issue.message.includes('px across'))).toBe(true)
    expect(slidesLayoutIssues(deck).length).toBe(report.issues.length)
  })

  test('a clean deck has no findings, and text regions carry their capacity', () => {
    const deck = deckOf([{ id: 'ok', layout: 'title-body', title: 'Fine', body: '- one\n- two' }])
    expect(slidesLayoutIssues(deck)).toEqual([])
    const regions = slidesTextRegions(deck)
    const body = regions.find((region) => region.region === 'body')!
    expect(body.chars).toBe(7)
    expect(body.capacity).toBeGreaterThan(100)
    expect(body.fill).toBeLessThan(1)
    // Roomy spacing leaves less room than compact.
    const roomy = slidesTextRegions({ ...deck, tokens: { spacing: 'roomy' } }).find((region) => region.region === 'body')!
    const compact = slidesTextRegions({ ...deck, tokens: { spacing: 'compact' } }).find((region) => region.region === 'body')!
    expect(roomy.capacity).toBeLessThan(compact.capacity)
  })
})

describe('reading order and element builds', () => {
  const deck = deckOf([
    {
      id: 's',
      layout: 'blank',
      elements: [
        { id: 'a', type: 'rect', x: 0, y: 0, w: 1, h: 1 },
        { id: 'b', type: 'rect', x: 0, y: 0, w: 1, h: 1 },
        { id: 'c', type: 'connector', x: 0, y: 0, w: 1, h: 1, from: 'a', to: 'b' },
        { id: 'd', type: 'rect', x: 0, y: 0, w: 1, h: 1 },
      ],
    },
  ])
  test('numbered elements read first, then the rest back to front, connectors never', () => {
    const ordered = setReadingOrder(deck, 's', ['d', 'b'])
    expect(slideReadingOrder(ordered.slides[0]).map((element) => element.id)).toEqual(['d', 'b', 'a'])
    expect(setReadingOrder(ordered, 's', ['d', 'b'])).toBe(ordered)
    expect(parseDeck(ordered).ok).toBe(true)
  })
  test('build groups round-trip', () => {
    const built = setElementBuilds(deck, 's', [['b'], ['a', 'd']])
    expect(elementBuildGroups(built.slides[0])).toEqual([['b'], ['a', 'd']])
    expect(buildSteps(built.slides[0])).toBe(2)
    expect(elementBuildGroups(setElementBuilds(built, 's', []).slides[0])).toEqual([])
  })
})
