import { describe, expect, test } from 'bun:test'
import { parseDeck, type Deck } from './slides'
import {
  bulletCount,
  buildSteps,
  clampPosition,
  deckFooter,
  setDeckStyle,
  setElementStyle,
  setSlideBuild,
  setSlideImage,
  stylableElements,
} from './slides-ops'

/** A deck exactly as round 2 stored it: no field added in round 3. It must keep parsing as-is. */
const PRE_R3_BODY = JSON.stringify({
  version: 1,
  title: 'Launch',
  aspect: '16:9',
  theme: 'tinted',
  accent: 'blue',
  transition: 'slide',
  slides: [
    { id: 'cover', layout: 'title', title: 'Launch', subtitle: 'Q4', notes: 'Hi' },
    { id: 'why', layout: 'title-body', title: 'Why', body: '- One\n- Two', section: 'Intro' },
    { id: 'pic', layout: 'image', image: { src: '/_asset/abc', alt: 'Shot', fit: 'cover' } },
    { id: 'cols', layout: 'two-column', columns: ['- a', '- b'] },
  ],
})

const base = (): Deck => {
  const parsed = parseDeck(JSON.parse(PRE_R3_BODY))
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues))
  return parsed.deck
}

describe('round-3 slides model', () => {
  test('a pre-round-3 body parses unchanged', () => {
    const parsed = parseDeck(JSON.parse(PRE_R3_BODY))
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(JSON.stringify(parsed.deck)).toBe(PRE_R3_BODY)
  })

  test('the new optional fields parse, and bad values are refused', () => {
    const deck = {
      ...base(),
      fonts: { heading: 'serif', body: 'humanist' },
      footer: 'Acme',
      slideNumbers: false,
      slides: [
        { id: 'a', layout: 'title-body', body: '- x', build: 'bullets', style: { title: { size: 'xl', align: 'center', color: 'accent' } } },
        { id: 'b', layout: 'image', image: { src: '/x.png', alt: '', fit: 'cover', position: { x: 10, y: 90 } } },
      ],
    }
    expect(parseDeck(deck).ok).toBe(true)
    expect(parseDeck({ ...deck, fonts: { heading: 'Comic Sans' } }).ok).toBe(false)
    expect(parseDeck({ ...deck, footer: 'x'.repeat(121) }).ok).toBe(false)
    const badStyle = { ...deck, slides: [{ id: 'a', layout: 'blank', style: { body: { color: '#ff0000' } } }] }
    expect(parseDeck(badStyle).ok).toBe(false)
    const badElement = { ...deck, slides: [{ id: 'a', layout: 'blank', style: { footer: {} } }] }
    expect(parseDeck(badElement).ok).toBe(false)
    const badPosition = { ...deck, slides: [{ id: 'b', layout: 'image', image: { src: '/x', alt: '', position: { x: 120, y: 0 } } }] }
    expect(parseDeck(badPosition).ok).toBe(false)
  })

  test('element styles merge, clear and vanish when empty', () => {
    const deck = base()
    const styled = setElementStyle(deck, 'why', 'title', { size: 'lg', align: 'center' })
    expect(styled.slides[1].style).toEqual({ title: { size: 'lg', align: 'center' } })
    const coloured = setElementStyle(styled, 'why', 'title', { color: 'soft', align: null })
    expect(coloured.slides[1].style).toEqual({ title: { size: 'lg', color: 'soft' } })
    // md is the layout's own size: not stored.
    expect(setElementStyle(deck, 'why', 'body', { size: 'md' })).toBe(deck)
    // A reset leaves the slide exactly as it was.
    const reset = setElementStyle(coloured, 'why', 'title', null)
    expect(reset.slides[1]).toEqual(deck.slides[1])
    expect('style' in reset.slides[1]).toBe(false)
    // Unknown values and slides change nothing.
    expect(setElementStyle(deck, 'why', 'title', { color: 'red' as never })).toBe(deck)
    expect(setElementStyle(deck, 'nope', 'title', { size: 'lg' })).toBe(deck)
    for (const next of [styled, coloured, reset]) expect(parseDeck(next).ok).toBe(true)
  })

  test('each layout offers the elements it draws', () => {
    expect(stylableElements('title')).toEqual(['title', 'subtitle'])
    expect(stylableElements('quote')).toEqual(['body', 'subtitle'])
    expect(stylableElements('blank')).toEqual(['body'])
    expect(stylableElements('chart')).toEqual(['title', 'body'])
  })

  test('deck look: fonts, footer and numbers', () => {
    const deck = base()
    const look = setDeckStyle(deck, { fonts: { heading: 'serif' }, footer: '  Acme   inc ', slideNumbers: false })
    expect(look.fonts).toEqual({ heading: 'serif' })
    expect(look.footer).toBe(' Acme inc ')
    expect(deckFooter(look)).toEqual({ text: ' Acme inc ', numbers: false })
    expect(deckFooter(deck)).toEqual({ text: 'Launch', numbers: true })
    // Defaults clear their field.
    const back = setDeckStyle(look, { fonts: {}, footer: undefined, slideNumbers: true })
    expect(JSON.stringify(back)).toBe(PRE_R3_BODY)
    // An empty footer is kept: it hides the footer text.
    expect(setDeckStyle(deck, { footer: '' }).footer).toBe('')
    expect(setDeckStyle(deck, { footer: 'x'.repeat(500) }).footer).toHaveLength(120)
    // Same values: the same deck.
    expect(setDeckStyle(look, { fonts: { heading: 'serif' } })).toBe(look)
    expect(parseDeck(look).ok).toBe(true)
  })

  test('image position is kept, clamped, and dropped at the centre', () => {
    const deck = base()
    const image = deck.slides[2].image!
    const moved = setSlideImage(deck, 'pic', { ...image, position: { x: 12.345, y: 140 } })
    expect(moved.slides[2].image?.position).toEqual({ x: 12.3, y: 100 })
    const centred = setSlideImage(moved, 'pic', { ...image, position: { x: 50, y: 50 } })
    expect(centred.slides[2].image).toEqual(image)
    expect(clampPosition({ x: Number.NaN, y: -3 })).toEqual({ x: 50, y: 0 })
    expect(parseDeck(moved).ok).toBe(true)
  })

  test('bullet builds count top-level items only', () => {
    expect(bulletCount('- a\n  - nested\n- b\n\ntext\n1. c\n```\n- code\n```')).toBe(3)
    expect(bulletCount(undefined)).toBe(0)
    expect(bulletCount('-not a bullet\n* yes')).toBe(1)
    const deck = setSlideBuild(base(), 'why', 'bullets')
    expect(deck.slides[1].build).toBe('bullets')
    expect(buildSteps(deck.slides[1])).toBe(2)
    const cols = setSlideBuild(deck, 'cols', 'bullets')
    expect(buildSteps(cols.slides[3])).toBe(2)
    // A layout without a body never builds.
    expect(setSlideBuild(deck, 'cover', 'bullets')).toBe(deck)
    expect(buildSteps({ id: 'x', layout: 'title-body', body: '- a' })).toBe(0)
    const off = setSlideBuild(cols, 'why', undefined)
    expect('build' in off.slides[1]).toBe(false)
    expect(parseDeck(cols).ok).toBe(true)
  })
})
