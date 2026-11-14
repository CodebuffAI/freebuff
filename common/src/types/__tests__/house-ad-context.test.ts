import { expect, test } from 'bun:test'
import { parseHouseAdContext } from '../house-ad-context'

test('missing discovery facts remain unknown and explicit false survives', () => {
  expect(parseHouseAdContext({ app: 'web' })).toEqual({ app: 'web' })
  expect(
    parseHouseAdContext({ app: 'desktop', isDefaultTheme: false }),
  ).toEqual({
    app: 'desktop',
    isDefaultTheme: false,
  })
  expect(parseHouseAdContext(undefined)).toBeUndefined()
  expect(parseHouseAdContext({ app: 'cli' })).toBeUndefined()
  expect(
    parseHouseAdContext({ app: 'desktop', isDefaultTheme: 'true' }),
  ).toBeUndefined()
})
