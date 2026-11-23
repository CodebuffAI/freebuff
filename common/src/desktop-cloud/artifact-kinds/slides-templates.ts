/**
 * Slide templates: ready-made starting points (a layout, placeholder text and, where the layout
 * alone cannot draw it, free-position elements) for "Add slide" and the agent's
 * `addSlideFromTemplate`. Pure: the same template, id and aspect give the same slide, and every
 * slide satisfies `slideSchema`.
 */

import { DESIGN_SIZE, LIMITS, type Deck, type DeckAspect, type Slide, type SlideElement } from './slides'

export const SLIDE_TEMPLATES = [
  'title',
  'agenda',
  'comparison',
  'timeline',
  'big-number',
  'quote',
  'team',
  'closing',
] as const
export type SlideTemplate = (typeof SLIDE_TEMPLATES)[number]

export const SLIDE_TEMPLATE_LABEL: Record<SlideTemplate, string> = {
  title: 'Title',
  agenda: 'Agenda',
  comparison: 'Comparison',
  timeline: 'Timeline',
  'big-number': 'Big number',
  quote: 'Quote',
  team: 'Team',
  closing: 'Closing',
}

const r = (value: number) => Math.round(value * 10) / 10

/** A new slide from `template`, under `id`, laid out for the deck's `aspect`. */
export function slideFromTemplate(template: SlideTemplate, id: string, aspect: DeckAspect): Slide {
  const { width, height } = DESIGN_SIZE[aspect]
  switch (template) {
    case 'title':
      return { id, layout: 'title', title: 'Presentation title', subtitle: 'Presenter · date' }
    case 'agenda':
      return {
        id,
        layout: 'title-body',
        title: 'Agenda',
        body: '1. Where we are\n2. What we learned\n3. What we propose\n4. Next steps',
      }
    case 'comparison':
      return {
        id,
        layout: 'two-column',
        title: 'Option A vs option B',
        columns: ['**Option A**\n\n- Strength\n- Trade-off', '**Option B**\n\n- Strength\n- Trade-off'],
      }
    case 'timeline': {
      const left = 80
      const right = width - 80
      const axis = r(height * 0.55)
      const steps = 4
      const gap = (right - left) / (steps - 1)
      const elements: SlideElement[] = [
        { id: 'axis', type: 'line', x: left, y: axis - 10, w: right - left, h: 20, stroke: 'soft', strokeWidth: 3 },
      ]
      for (let i = 0; i < steps; i++) {
        const cx = r(left + gap * i)
        elements.push({ id: `dot-${i + 1}`, type: 'ellipse', x: r(cx - 10), y: axis - 10, w: 20, h: 20, fill: 'accent' })
        elements.push({
          id: `step-${i + 1}`,
          type: 'text',
          x: r(cx - gap / 2 + 8),
          y: axis + 24,
          w: r(gap - 16),
          h: 70,
          text: `Q${i + 1}\nMilestone`,
          size: 18,
          align: 'center',
        })
      }
      return { id, layout: 'title-body', title: 'Timeline', elements }
    }
    case 'big-number':
      return {
        id,
        layout: 'blank',
        elements: [
          { id: 'number', type: 'text', x: 64, y: r(height * 0.2), w: width - 128, h: 190, text: '42%', size: 140, bold: true, align: 'center', color: 'accent' },
          { id: 'caption', type: 'text', x: 64, y: r(height * 0.2 + 206), w: width - 128, h: 60, text: 'What this number means', size: 26, align: 'center', color: 'soft' },
        ],
      }
    case 'quote':
      return { id, layout: 'quote', body: 'A sentence worth repeating.', subtitle: 'Name, role' }
    case 'team': {
      const people = 4
      const size = 120
      const gap = (width - 128 - people * size) / (people - 1)
      const top = r(height * 0.36)
      const elements: SlideElement[] = []
      for (let i = 0; i < people; i++) {
        const x = r(64 + i * (size + gap))
        elements.push({ id: `photo-${i + 1}`, type: 'ellipse', x, y: top, w: size, h: size, fill: 'tint', stroke: 'accent', strokeWidth: 2 })
        elements.push({ id: `name-${i + 1}`, type: 'text', x: r(x - 30), y: top + size + 14, w: size + 60, h: 64, text: 'Name\nRole', size: 18, align: 'center' })
      }
      return { id, layout: 'title-body', title: 'The team', elements }
    }
    case 'closing':
      return { id, layout: 'section', title: 'Thank you', subtitle: 'Questions? name@example.com' }
  }
}

/**
 * Insert a slide from `template` after `afterIndex` (-1: first), under `id` (default: a fresh
 * `<template>-N`). A full deck or a taken id leaves the deck unchanged with `ok` false.
 */
export function addSlideFromTemplate(
  deck: Deck,
  afterIndex: number,
  template: SlideTemplate,
  id?: string,
): { ok: true; deck: Deck; id: string } | { ok: false; error: string } {
  if (deck.slides.length >= LIMITS.slides) return { ok: false, error: `a deck has at most ${LIMITS.slides} slides` }
  const used = new Set(deck.slides.map((slide) => slide.id))
  let slideId = id
  if (slideId === undefined) {
    for (let n = 1; ; n++) {
      const candidate = n === 1 ? template : `${template}-${n}`
      if (!used.has(candidate)) {
        slideId = candidate
        break
      }
    }
  } else if (used.has(slideId)) return { ok: false, error: `a slide "${slideId}" exists; give the new one another id` }
  const at = Math.max(0, Math.min(afterIndex + 1, deck.slides.length))
  const slides = [...deck.slides]
  slides.splice(at, 0, slideFromTemplate(template, slideId, deck.aspect))
  return { ok: true, deck: { ...deck, slides }, id: slideId }
}
