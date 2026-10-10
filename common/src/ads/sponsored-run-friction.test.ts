import { describe, expect, test } from 'bun:test'

import {
  SPONSORED_FRICTION_DETAIL_MAX,
  formatSponsoredFrictionReport,
  scrubSponsoredFrictionDetail,
  sponsoredFrictionCategory,
  sponsoredFrictionInputSchema,
} from './sponsored-run-friction'

describe('scrubSponsoredFrictionDetail', () => {
  test('keeps the sentence and its numbers, drops what could name the user', () => {
    expect(
      scrubSponsoredFrictionDetail(
        'Step 2 needs Node 20; `npx acme init` read ~/work/app/.env and https://acme.example/k?t=1 for ada@example.com, key acme_abcdefghijklmnopqrstuvwxyz0123456789.',
      ),
    ).toBe(
      'Step 2 needs Node 20; `npx acme init` read <path> and <url> for <email>, key <token>.',
    )
  })

  test('first paragraph only, capped, and null when empty', () => {
    expect(scrubSponsoredFrictionDetail('One.\n\nTwo.')).toBe('One.')
    expect(scrubSponsoredFrictionDetail('   ')).toBeNull()
    expect(scrubSponsoredFrictionDetail(null)).toBeNull()
    expect(scrubSponsoredFrictionDetail('word '.repeat(400))!.length).toBe(
      SPONSORED_FRICTION_DETAIL_MAX,
    )
  })
})

describe('the wire', () => {
  test('an unknown category is other, a missing one null', () => {
    expect(sponsoredFrictionCategory('needs_login')).toBe('needs_login')
    expect(sponsoredFrictionCategory('added_next_year')).toBe('other')
    expect(sponsoredFrictionCategory(undefined)).toBeNull()
  })

  test('the tool input requires blocking, a category and a detail', () => {
    expect(
      sponsoredFrictionInputSchema.safeParse({
        category: 'other',
        detail: 'x',
      }).success,
    ).toBe(false)
    expect(
      sponsoredFrictionInputSchema.safeParse({
        blocking: false,
        category: 'command_failed',
        detail: 'The init flag was renamed; used the new one.',
      }).success,
    ).toBe(true)
  })

  test('one line for a reader', () => {
    expect(
      formatSponsoredFrictionReport({
        blocking: true,
        category: 'needs_login',
        step: 3,
        detail: 'Browser login.',
      }),
    ).toBe('blocker needs_login (step 3): Browser login.')
    expect(
      formatSponsoredFrictionReport({
        blocking: false,
        category: 'other',
        detail: null,
      }),
    ).toBe('friction other')
  })
})
