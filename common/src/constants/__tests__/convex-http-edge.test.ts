import { describe, expect, test } from 'bun:test'

import {
  PLATFORM_CONVEX_SITE_URL_PROD,
  convexHttpUrl,
  edgePathForConvexPath,
} from '../convex-http-edge'

describe('convexHttpUrl', () => {
  test('prod Convex maps to the freebuff.com edge route', () => {
    expect(convexHttpUrl(PLATFORM_CONVEX_SITE_URL_PROD, '/github/webhook')).toBe(
      'https://freebuff.com/api/edge/github/webhook',
    )
    expect(
      convexHttpUrl(
        `${PLATFORM_CONVEX_SITE_URL_PROD}/`,
        '/api/internal/subscription/tier',
      ),
    ).toBe('https://freebuff.com/api/internal/subscription/tier')
  })

  test('any other deployment is called directly', () => {
    expect(
      convexHttpUrl('https://dev-otter-1.convex.site/', '/runtime-error'),
    ).toBe('https://dev-otter-1.convex.site/runtime-error')
    expect(
      convexHttpUrl('http://127.0.0.1:3211', '/api/internal/affiliate/events'),
    ).toBe('http://127.0.0.1:3211/api/internal/affiliate/events')
  })

  test('only non-/api/ paths move under /api/edge', () => {
    expect(edgePathForConvexPath('/image')).toBe('/api/edge/image')
    expect(edgePathForConvexPath('/api/screenshot/upload')).toBe(
      '/api/screenshot/upload',
    )
  })
})
