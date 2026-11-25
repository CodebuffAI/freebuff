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
  test('the tool-facing schema never offers the end-user runtime fields', () => {
    const keys = Object.keys(gravityIndexInputSchema.shape)
    for (const field of ['end_user_ip', 'end_user_agent', 'ad_session_id']) {
      expect(keys).not.toContain(field)
    }
    const parsed = gravityIndexInputSchema.parse({
      action: 'search',
      query: 'email',
      end_user_ip: '8.8.8.8',
      end_user_agent: 'ua',
      ad_session_id: 'session',
    })
    expect(parsed).not.toHaveProperty('end_user_ip')
    expect(parsed).not.toHaveProperty('end_user_agent')
    expect(parsed).not.toHaveProperty('ad_session_id')
  })

  test('the API search schema keeps the end-user runtime fields', () => {
    const parsed = gravityIndexApiInputSchema.parse({
      action: 'search',
      query: 'email',
      end_user_ip: '8.8.8.8',
      end_user_agent: 'Mozilla/5.0',
      ad_session_id: 'ad-session-1',
    })
    expect(parsed).toMatchObject({
      end_user_ip: '8.8.8.8',
      end_user_agent: 'Mozilla/5.0',
      ad_session_id: 'ad-session-1',
    })
  })

  test('the API search schema caps the end-user runtime fields', () => {
    const base = { action: 'search', query: 'email' }
    for (const [field, max] of [
      ['end_user_ip', 64],
      ['end_user_agent', 1024],
      ['ad_session_id', 256],
    ] as const) {
      expect(
        gravityIndexApiInputSchema.safeParse({ ...base, [field]: 'x'.repeat(max) })
          .success,
      ).toBe(true)
      expect(
        gravityIndexApiInputSchema.safeParse({
          ...base,
          [field]: 'x'.repeat(max + 1),
        }).success,
      ).toBe(false)
    }
  })

  test('only search accepts the end-user runtime fields', () => {
    for (const body of [
      { action: 'browse', category: 'Email' },
      { action: 'list_categories' },
      { action: 'get_service', slug: 'sendgrid' },
    ]) {
      const parsed = gravityIndexApiInputSchema.parse({
        ...body,
        end_user_ip: '8.8.8.8',
        end_user_agent: 'ua',
        ad_session_id: 'session',
      })
      expect(parsed).not.toHaveProperty('end_user_ip')
      expect(parsed).not.toHaveProperty('end_user_agent')
      expect(parsed).not.toHaveProperty('ad_session_id')
    }
  })
})
