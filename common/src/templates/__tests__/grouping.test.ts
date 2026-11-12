import { describe, expect, test } from 'bun:test'

import { PICKER_FEATURED_TEMPLATE_IDS, templateCategories } from '../grouping'

type Entry = { id: string; kind: 'site' | 'app'; tags: string[] }

const chips = (
  templates: Entry[],
  options?: Parameters<typeof templateCategories>[1],
) =>
  templateCategories(templates, options).map(({ label, templates }) => [
    label,
    templates.map(({ id }) => id),
  ])

describe('templateCategories', () => {
  test('files each template under its category tag, in the given order', () => {
    expect(
      chips([
        { id: 'saas-landing', kind: 'site', tags: ['category:landing-page'] },
        { id: 'store', kind: 'site', tags: ['category:store'] },
        { id: 'portfolio', kind: 'site', tags: ['category:portfolio'] },
        { id: 'chess', kind: 'app', tags: ['category:game'] },
        { id: 'crm', kind: 'app', tags: ['category:saas'] },
        // The tag wins over a kind and tags that would guess otherwise.
        { id: 'arcade-site', kind: 'site', tags: ['category:game', 'store'] },
      ]),
    ).toEqual([
      ['Featured', ['store', 'portfolio']],
      ['All', ['saas-landing', 'store', 'portfolio', 'chess', 'crm', 'arcade-site']],
      ['Landing pages', ['saas-landing']],
      ['Stores', ['store']],
      ['Portfolio', ['portfolio']],
      ['Games', ['chess', 'arcade-site']],
      ['SaaS', ['crm']],
    ])
  })

  test('leaves out starters, from All too, and any chip with nothing in it', () => {
    expect(
      chips([
        { id: 'blank-website', kind: 'site', tags: ['category:starter'] },
        { id: 'crm', kind: 'app', tags: ['category:saas'] },
      ]),
    ).toEqual([
      ['All', ['crm']],
      ['SaaS', ['crm']],
    ])
  })

  test('guesses for an entry published before category tags', () => {
    expect(
      chips([
        { id: 'fintech-landing', kind: 'site', tags: ['marketing'] },
        { id: 'estate-agent', kind: 'site', tags: ['real-estate'] },
        { id: 'shop', kind: 'site', tags: ['ecommerce'] },
        { id: 'blog', kind: 'site', tags: ['blog'] },
        { id: 'flappy-bird', kind: 'app', tags: ['game'] },
        { id: 'moodboard', kind: 'app', tags: ['creative'] },
      ]),
    ).toEqual([
      ['Featured', ['estate-agent', 'moodboard']],
      ['All', ['fintech-landing', 'estate-agent', 'shop', 'blog', 'flappy-bird', 'moodboard']],
      ['Landing pages', ['fintech-landing', 'estate-agent']],
      ['Stores', ['shop']],
      ['Portfolio', ['blog']],
      ['Games', ['flappy-bird']],
      ['SaaS', ['moodboard']],
    ])
  })

  test('Featured lists the picked templates in the picked order, starters never', () => {
    expect(
      chips(
        [
          { id: 'blank-website', kind: 'site', tags: ['category:starter'] },
          { id: 'moodboard', kind: 'app', tags: ['category:saas'] },
          { id: 'crm', kind: 'app', tags: ['category:saas'] },
          { id: 'crosscut', kind: 'app', tags: ['category:game'] },
        ],
        { featured: PICKER_FEATURED_TEMPLATE_IDS, starters: true },
      )[0],
    ).toEqual(['Featured', ['crosscut', 'moodboard']])
  })

  test('a new-project picker drops Featured and keeps starters, in All and their own chip', () => {
    expect(
      chips(
        [
          { id: 'blank-website', kind: 'site', tags: ['category:starter'] },
          { id: 'store', kind: 'site', tags: ['category:store'] },
          { id: 'crm', kind: 'app', tags: ['category:saas'] },
        ],
        { featured: false, starters: true },
      ),
    ).toEqual([
      ['All', ['blank-website', 'store', 'crm']],
      ['Stores', ['store']],
      ['SaaS', ['crm']],
      ['Starters', ['blank-website']],
    ])
  })
})
