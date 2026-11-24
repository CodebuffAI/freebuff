import { describe, expect, test } from 'bun:test'

import {
  gravityIndexApiInputSchema,
  gravityIndexInputSchema,
} from '../gravity-index'

describe('gravity-index schemas', () => {
  test('catalog actions keep runtime-stamped metadata', () => {
    for (const body of [
      { action: 'browse', category: 'Email' },
      { action: 'list_categories' },
      { action: 'get_service', slug: 'sendgrid' },
    ]) {
      const parsed = gravityIndexApiInputSchema.parse({
        ...body,
        metadata: { surface: 'freebuff_cli', client_platform: 'web' },
      })
      expect('metadata' in parsed && parsed.metadata).toEqual({
        surface: 'freebuff_cli',
        client_platform: 'web',
      })
    }
  })

  test('catalog actions reject non-object metadata, like search', () => {
    for (const action of ['browse', 'list_categories', 'search']) {
      const result = gravityIndexApiInputSchema.safeParse({
        action,
        query: 'email',
        metadata: 'freebuff_web',
      })
      expect(result.success).toBe(false)
    }
  })

  test('catalog actions still strip the other attribution fields', () => {
    const parsed = gravityIndexApiInputSchema.parse({
      action: 'list_categories',
      external_user_id: 'someone',
      external_session_id: 'session-1',
    })
    expect(parsed).toEqual({ action: 'list_categories' })
  })

  test('the tool-facing schema never offers metadata to the model', () => {
    expect(Object.keys(gravityIndexInputSchema.shape)).not.toContain(
      'metadata',
    )
  })
})
