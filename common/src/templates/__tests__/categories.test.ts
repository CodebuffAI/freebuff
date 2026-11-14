import { describe, expect, test } from 'bun:test'

import { templateCategoryOf, templateCategoryProblem } from '../categories'

describe('template categories', () => {
  test('one known category tag names the category', () => {
    expect(templateCategoryOf(['category:store', 'ecommerce'])).toBe('store')
    expect(templateCategoryProblem({ id: 'shop', tags: ['ecommerce', 'category:store'] })).toBeNull()
  })

  test('none, several or an unknown one names no category, and says why', () => {
    expect(templateCategoryOf(['ecommerce'])).toBeNull()
    expect(templateCategoryOf(['category:store', 'category:saas'])).toBeNull()
    expect(templateCategoryOf(['category:shop'])).toBeNull()

    expect(templateCategoryProblem({ id: 'a', tags: ['ecommerce'] })).toStartWith(
      'a: add exactly one category tag (category:landing-page, category:store,',
    )
    expect(
      templateCategoryProblem({ id: 'b', tags: ['category:store', 'category:saas'] }),
    ).toBe('b: has category:store, category:saas; keep exactly one category tag')
    expect(templateCategoryProblem({ id: 'c', tags: ['category:shop'] })).toStartWith(
      'c: category:shop is not a category; use one of',
    )
  })
})
