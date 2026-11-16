import { describe, expect, test } from 'bun:test'

import {
  addElement,
  clampBox,
  defaultElement,
  duplicateElements,
  moveElements,
  normaliseRotation,
  removeElements,
  reorderElement,
  resizeBox,
  rotationAt,
  snapBox,
  uniqueElementId,
  updateElement,
} from './slides-elements'
import {
  deckSections,
  deleteSlides,
  duplicateSlide,
  duplicateSlides,
  moveSlides,
  sectionForSlides,
  setSectionDescription,
  setSlideSection,
  setSlideTransition,
  slideTransition,
} from './slides-ops'
import { SLIDE_TEMPLATES, addSlideFromTemplate, slideFromTemplate } from './slides-templates'
import { DECK_ASPECTS, ELEMENT_TYPES, LIMITS, SLIDES_GUIDE, deckSchema, parseDeck, type Deck } from './slides'

/** A body stored before round 4, frozen here (never edited with the fixtures). */
const PRE_ROUND_4 = {
  version: 1,
  title: 'Q4 plan',
  aspect: '16:9',
  theme: 'tinted',
  accent: 'blue',
  transition: 'slide',
  fonts: { heading: 'serif' },
  footer: 'Acme',
  slideNumbers: false,
  slides: [
    { id: 'cover', layout: 'title', title: 'Q4 plan', subtitle: 'November', notes: 'Hello' },
    { id: 'why', layout: 'title-body', title: 'Why', body: '- a\n- b', section: 'Results', style: { title: { size: 'lg' } }, build: 'bullets' },
    { id: 'pic', layout: 'image', image: { src: 'https://example.com/a.png', alt: 'A', fit: 'cover', position: { x: 10, y: 20 } } },
    { id: 'cols', layout: 'two-column', columns: ['- x', '- y'] },
  ],
}

const deck = (): Deck => {
  const parsed = parseDeck(structuredClone(PRE_ROUND_4))
  if (!parsed.ok) throw new Error('fixture')
  return parsed.deck
}

describe('round-4 model', () => {
  test('a pre-round-4 body parses unchanged', () => {
    const original = structuredClone(PRE_ROUND_4)
    expect(deckSchema.parse(original)).toEqual(original)
    expect(JSON.stringify(deckSchema.parse(original))).toBe(JSON.stringify(PRE_ROUND_4))
  })

  test('elements, per-slide transitions and section descriptions validate', () => {
    const next = structuredClone(PRE_ROUND_4) as Record<string, unknown> & { slides: Array<Record<string, unknown>> }
    next.slides[1].sectionDescription = 'What we shipped'
    next.slides[1].transition = 'none'
    next.slides[1].elements = [
      { id: 'note', type: 'text', x: 600, y: 100, w: 300, h: 60, text: 'Callout', size: 20, color: 'accent', bold: true },
      { id: 'box', type: 'rect', x: 10, y: 10, w: 100, h: 50, fill: 'tint', stroke: 'accent', strokeWidth: 2, rotation: 15 },
      { id: 'go', type: 'arrow', x: 100, y: 300, w: 200, h: 20, stroke: 'ink' },
      { id: 'pic', type: 'image', x: 0, y: 0, w: 100, h: 100, src: '/_asset/abc', alt: 'logo' },
    ]
    expect(parseDeck(next).ok).toBe(true)
  })

  test('the schema refuses bad elements, duplicate ids, orphan descriptions and over-the-cap lists', () => {
    const withSlide = (patch: Record<string, unknown>) => {
      const next = structuredClone(PRE_ROUND_4) as { slides: Array<Record<string, unknown>> }
      Object.assign(next.slides[3], patch)
      return parseDeck(next)
    }
    const el = { id: 'a', type: 'rect', x: 0, y: 0, w: 10, h: 10 }
    expect(withSlide({ elements: [el, el] }).ok).toBe(false)
    expect(withSlide({ elements: [{ ...el, fill: '#ff0000' }] }).ok).toBe(false)
    expect(withSlide({ elements: [{ ...el, type: 'star' }] }).ok).toBe(false)
    expect(withSlide({ elements: [{ ...el, w: 0 }] }).ok).toBe(false)
    expect(withSlide({ elements: [{ ...el, x: 99999 }] }).ok).toBe(false)
    expect(withSlide({ elements: [{ id: 'i', type: 'image', x: 0, y: 0, w: 1, h: 1, src: 'javascript:alert(1)', alt: '' }] }).ok).toBe(false)
    expect(withSlide({ elements: [{ id: 'l', type: 'line', x: 0, y: 0, w: 10, h: 10, text: 'no labels on lines' }] }).ok).toBe(false)
    expect(withSlide({ elements: Array.from({ length: LIMITS.elements + 1 }, (_, i) => ({ ...el, id: `e${i}` })) }).ok).toBe(false)
    expect(withSlide({ sectionDescription: 'orphan' }).ok).toBe(false)
    expect(withSlide({ transition: 'zoom' }).ok).toBe(false)
  })

  test('every element type has a default that parses, at both aspects', () => {
    for (const aspect of DECK_ASPECTS)
      for (const type of ELEMENT_TYPES) {
        const base = deck()
        const result = addElement({ ...base, aspect }, 'cols', defaultElement(type, `${type}-1`, aspect))
        expect(result.ok).toBe(true)
        if (result.ok) expect(parseDeck(result.deck).ok).toBe(true)
      }
  })
})

describe('element edits', () => {
  const withBox = () => {
    const result = addElement(deck(), 'cols', { id: 'box', type: 'rect', x: 100, y: 100, w: 200, h: 100 })
    if (!result.ok) throw new Error(result.error)
    return result.deck
  }

  test('add refuses unknown slides and the cap; a taken id gets a fresh one', () => {
    expect(addElement(deck(), 'nope', defaultElement('text', 't', '16:9'))).toEqual({ ok: false, error: 'there is no slide "nope"' })
    const base = withBox()
    const again = addElement(base, 'cols', { id: 'box', type: 'rect', x: 0, y: 0, w: 5, h: 5 })
    expect(again.ok && again.id).toBe('rect-1')
    let full = deck()
    for (let i = 0; i < LIMITS.elements; i++) {
      const result = addElement(full, 'cols', { id: `e${i}`, type: 'text', x: 0, y: 0, w: 10, h: 10 })
      if (!result.ok) throw new Error(result.error)
      full = result.deck
    }
    expect(addElement(full, 'cols', { id: 'one-more', type: 'text', x: 0, y: 0, w: 10, h: 10 }).ok).toBe(false)
  })

  test('update merges, clamps, normalises rotation, clears with null and reports a no-op', () => {
    const base = withBox()
    const moved = updateElement(base, 'cols', 'box', { x: 99999, rotation: 370, fill: 'accent' })
    const el = moved.slides[3].elements![0]
    expect(el).toMatchObject({ x: 2000, rotation: 10, fill: 'accent' })
    const cleared = updateElement(moved, 'cols', 'box', { rotation: 0, fill: null, x: 100 })
    expect(cleared.slides[3].elements![0]).toEqual(base.slides[3].elements![0])
    expect(updateElement(base, 'cols', 'box', { x: 100 })).toBe(base)
    expect(updateElement(base, 'cols', 'missing', { x: 1 })).toBe(base)
    // id and type never change; required fields are never cleared.
    expect(updateElement(base, 'cols', 'box', { id: 'other', type: 'ellipse', w: null })).toBe(base)
  })

  test('remove, reorder, move and duplicate', () => {
    let next = withBox()
    const second = addElement(next, 'cols', { id: 'top', type: 'text', x: 0, y: 0, w: 50, h: 20, text: 'Hi' })
    if (!second.ok) throw new Error(second.error)
    next = second.deck
    expect(reorderElement(next, 'cols', 'top', 'front')).toBe(next)
    const back = reorderElement(next, 'cols', 'top', 'back')
    expect(back.slides[3].elements!.map((e) => e.id)).toEqual(['top', 'box'])
    expect(reorderElement(back, 'cols', 'top', 'forward').slides[3].elements!.map((e) => e.id)).toEqual(['box', 'top'])
    const moved = moveElements(next, 'cols', ['box'], 10, -5)
    expect(moved.slides[3].elements![0]).toMatchObject({ x: 110, y: 95 })
    expect(moveElements(next, 'cols', ['box'], 0, 0)).toBe(next)
    const copied = duplicateElements(next, 'cols', ['box', 'top'])
    expect(copied.ids).toEqual(['box-1', 'top-1'])
    expect(copied.deck.slides[3].elements![2]).toMatchObject({ id: 'box-1', x: 116, y: 116 })
    const removed = removeElements(copied.deck, 'cols', ['box-1', 'top-1', 'box', 'top'])
    // An emptied list drops the field: the slide is what it was before any element.
    expect(removed.slides[3]).toEqual(deck().slides[3])
    expect(parseDeck(copied.deck).ok).toBe(true)
  })

  test('ids are unique and deterministic', () => {
    const slide = withBox().slides[3]
    expect(uniqueElementId(slide, 'box')).toBe('box-1')
    expect(uniqueElementId(slide, 'text')).toBe('text-1')
    expect(uniqueElementId(slide, '***')).toBe('element-1')
  })
})

describe('element geometry', () => {
  test('rotation normalises into (-180, 180]', () => {
    expect(normaliseRotation(190)).toBe(-170)
    expect(normaliseRotation(-180)).toBe(180)
    expect(normaliseRotation(360)).toBe(0)
    expect(normaliseRotation(Number.NaN)).toBe(0)
  })

  test('resize keeps the opposite edge and a minimum, and a corner can keep the ratio', () => {
    const box = { x: 100, y: 100, w: 200, h: 100 }
    expect(resizeBox(box, 'e', 50, 0)).toEqual({ x: 100, y: 100, w: 250, h: 100 })
    expect(resizeBox(box, 'nw', 20, 10)).toEqual({ x: 120, y: 110, w: 180, h: 90 })
    expect(resizeBox(box, 'w', 500, 0)).toEqual({ x: 292, y: 100, w: 8, h: 100 })
    expect(resizeBox(box, 'se', 100, 0, true)).toEqual({ x: 100, y: 100, w: 300, h: 150 })
  })

  test('rotation from a handle, with 15-degree snapping', () => {
    const centre = { x: 0, y: 0 }
    expect(rotationAt(centre, { x: 0, y: -10 })).toBe(0)
    expect(rotationAt(centre, { x: 10, y: 0 })).toBe(90)
    expect(rotationAt(centre, { x: 10, y: -9 }, true)).toBe(45)
  })

  test('snap to the canvas centre and to another box, with guides', () => {
    const canvas = { width: 960, height: 540 }
    const centred = snapBox({ x: 378, y: 10, w: 200, h: 50 }, [], canvas)
    expect(centred.dx).toBe(2)
    expect(centred.guides).toContainEqual({ axis: 'x', at: 480 })
    const edge = snapBox({ x: 304, y: 200, w: 50, h: 50 }, [{ x: 100, y: 100, w: 200, h: 100 }], canvas)
    expect(edge.dx).toBe(-4)
    expect(snapBox({ x: 150, y: 150, w: 10, h: 10 }, [], canvas, 6)).toEqual({ dx: 0, dy: 0, guides: [] })
  })

  test('clampBox keeps every box parseable', () => {
    expect(clampBox({ x: -5000, y: 5000, w: 0, h: 1e9 })).toEqual({ x: -1000, y: 2000, w: 1, h: 2000 })
  })
})

describe('transitions, sections and multi-slide edits', () => {
  test('a slide transition overrides the deck, and clears back to it', () => {
    const base = deck()
    expect(slideTransition(base, 1)).toBe('slide')
    const cut = setSlideTransition(base, 'why', 'none')
    expect(slideTransition(cut, 1)).toBe('none')
    expect(slideTransition({ slides: base.slides }, 0)).toBe('fade')
    expect(setSlideTransition(cut, 'why', 'none')).toBe(cut)
    expect(setSlideTransition(cut, 'why', undefined).slides[1]).toEqual(base.slides[1])
  })

  test('section descriptions live with their section, and copies never carry them', () => {
    const base = deck()
    const described = setSectionDescription(base, 'why', '  What   we shipped ')
    expect(described.slides[1].sectionDescription).toBe('What we shipped')
    expect(deckSections(described)[1]).toEqual({ name: 'Results', description: 'What we shipped', start: 1, end: 4 })
    // A slide that starts no section takes none.
    expect(setSectionDescription(base, 'cols', 'x')).toBe(base)
    expect(duplicateSlide(described, 'why').deck.slides[2].sectionDescription).toBeUndefined()
    const ended = setSlideSection(described, 'why', '')
    expect('sectionDescription' in ended.slides[1]).toBe(false)
    expect(parseDeck(ended).ok).toBe(true)
  })

  test('delete, duplicate, move and section several slides at once', () => {
    const base = deck()
    const removed = deleteSlides(base, ['why', 'pic'])
    expect(removed.deck.slides.map((s) => s.id)).toEqual(['cover', 'cols'])
    expect(removed.selectId).toBe('cols')
    expect(deleteSlides(base, base.slides.map((s) => s.id)).deck.slides).toHaveLength(1)
    const copied = duplicateSlides(base, ['cover', 'pic'])
    expect(copied.deck.slides.map((s) => s.id)).toEqual(['cover', 'why', 'pic', 'cover-2', 'pic-2', 'cols'])
    expect(parseDeck(copied.deck).ok).toBe(true)
    expect(moveSlides(base, ['why', 'pic'], 1).slides.map((s) => s.id)).toEqual(['cover', 'cols', 'why', 'pic'])
    expect(moveSlides(base, ['why', 'pic'], -1).slides.map((s) => s.id)).toEqual(['why', 'pic', 'cover', 'cols'])
    expect(moveSlides(base, ['cover'], -1)).toBe(base)
    const sectioned = sectionForSlides(base, ['pic', 'why'], 'Body')
    expect(sectioned.slides.map((s) => s.section ?? null)).toEqual([null, 'Body', null, null])
  })
})

describe('templates', () => {
  test('every template makes a valid slide at both aspects', () => {
    for (const aspect of DECK_ASPECTS)
      for (const template of SLIDE_TEMPLATES) {
        const slide = slideFromTemplate(template, 't', aspect)
        expect(parseDeck({ ...deck(), aspect, slides: [slide] }).ok).toBe(true)
      }
  })

  test('template text boxes are tall enough for their lines (no overflow warning on a fresh slide)', () => {
    for (const aspect of DECK_ASPECTS)
      for (const template of SLIDE_TEMPLATES)
        for (const element of slideFromTemplate(template, 't', aspect).elements ?? []) {
          if (element.type !== 'text') continue
          const lines = (element.text ?? '').split('\n').length
          expect(element.h).toBeGreaterThanOrEqual(lines * (element.size ?? 24) * 1.25)
        }
  })

  test('add from a template: placed, fresh id, refusals', () => {
    const base = deck()
    const first = addSlideFromTemplate(base, 0, 'timeline')
    expect(first.ok && first.id).toBe('timeline')
    if (!first.ok) throw new Error(first.error)
    expect(first.deck.slides[1].elements?.length).toBeGreaterThan(4)
    const second = addSlideFromTemplate(first.deck, -1, 'timeline')
    expect(second.ok && second.deck.slides[0].id).toBe('timeline-2')
    expect(addSlideFromTemplate(base, 0, 'agenda', 'why')).toEqual({ ok: false, error: 'a slide "why" exists; give the new one another id' })
  })

  test('the guide names every template, element type, new field and op', () => {
    for (const template of SLIDE_TEMPLATES) expect(SLIDES_GUIDE).toContain(`"${template}"`)
    for (const type of ELEMENT_TYPES) expect(SLIDES_GUIDE).toContain(`"${type}"`)
    for (const word of ['"elements"', '"sectionDescription"', '"transition"', '"addElement"', '"updateElement"', '"removeElement"', '"reorderElement"', '"addSlideFromTemplate"', '"duplicateSlide"', '"setSection"', '"setTransition"', '"setDeckStyle"'])
      expect(SLIDES_GUIDE).toContain(word)
  })
})
