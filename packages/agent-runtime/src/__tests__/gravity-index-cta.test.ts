import { describe, expect, test } from 'bun:test'

import { resolveGravityIndexLink } from '../tools/gravity-index-cta'

import type { Message } from '@codebuff/common/types/messages/codebuff-message'
import type { JSONObject } from '@codebuff/common/types/json'

const gravityResult = (toolCallId: string, value: JSONObject): Message => ({
  role: 'tool',
  toolName: 'gravity_index',
  toolCallId,
  content: [{ type: 'json', value }],
})

describe('resolveGravityIndexLink', () => {
  test('returns the selected service name and description for the card', () => {
    const result = resolveGravityIndexLink({
      reference: {
        source: 'gravity_index',
        search_id: 'search-1',
        service_slug: 'neon',
      },
      messages: [
        gravityResult('gravity-1', {
          search_id: 'search-1',
          recommendation: {
            slug: 'supabase',
            name: 'Supabase',
            description: 'Postgres with auth',
            click_url: 'https://index.trygravity.ai/go/supabase',
          },
          options: [
            {
              slug: 'neon',
              name: '  Neon ',
              description: 'Serverless Postgres with branching',
              click_url: 'https://index.trygravity.ai/go/neon',
            },
          ],
        }),
      ],
    })

    expect(result).toEqual({
      success: true,
      value: {
        url: 'https://index.trygravity.ai/go/neon',
        service: {
          name: 'Neon',
          description: 'Serverless Postgres with branching',
        },
      },
    })
  })

  test('omits the service when Gravity sent no name, and caps a long description', () => {
    const noName = resolveGravityIndexLink({
      reference: { source: 'gravity_index', search_id: 's', service_slug: 'x' },
      messages: [
        gravityResult('g', {
          search_id: 's',
          recommendation: {
            slug: 'x',
            description: 'orphan',
            click_url: 'https://index.trygravity.ai/go/x',
          },
        }),
      ],
    })
    expect(noName).toEqual({
      success: true,
      value: { url: 'https://index.trygravity.ai/go/x' },
    })

    const long = resolveGravityIndexLink({
      reference: { source: 'gravity_index', search_id: 's', service_slug: 'x' },
      messages: [
        gravityResult('g', {
          search_id: 's',
          recommendation: {
            slug: 'x',
            name: 'X',
            description: 'a'.repeat(400),
            click_url: 'https://index.trygravity.ai/go/x',
          },
        }),
      ],
    })
    expect(long.success && long.value.service?.description?.length).toBe(300)
  })

  test('uses the selected recommendation click URL byte-for-byte', () => {
    const clickUrl =
      'https://index.trygravity.ai/go/recommendation?grclid=abc%2F123'
    const result = resolveGravityIndexLink({
      reference: {
        source: 'gravity_index',
        search_id: 'search-1',
        service_slug: 'resend',
      },
      messages: [
        gravityResult('gravity-1', {
          search_id: 'search-1',
          recommendation: {
            slug: 'sendgrid',
            click_url: 'https://index.trygravity.ai/go/earlier-search',
          },
        }),
        gravityResult('gravity-2', {
          // Follow-up searches can reuse their search_id. The latest matching
          // result must win over stale recommendations from an earlier call.
          search_id: 'search-1',
          recommendation: { slug: 'resend', click_url: clickUrl },
          click_url: 'https://index.trygravity.ai/go/top-level-fallback',
          credential_request: {
            setup_url: 'https://index.trygravity.ai/go/setup-fallback',
          },
        }),
      ],
    })

    expect(result).toEqual({ success: true, value: { url: clickUrl } })
  })

  test('resolves an explicitly selected option instead of the recommendation', () => {
    const optionUrl = 'https://index.trygravity.ai/go/selected-option'
    const result = resolveGravityIndexLink({
      reference: {
        source: 'gravity_index',
        search_id: 'search-1',
        service_slug: 'neon',
      },
      messages: [
        gravityResult('gravity-1', {
          search_id: 'search-1',
          recommendation: {
            slug: 'supabase',
            click_url: 'https://index.trygravity.ai/go/recommendation',
          },
          options: [
            { slug: 'supabase' },
            { slug: 'neon', click_url: optionUrl },
          ],
        }),
      ],
    })

    expect(result).toEqual({ success: true, value: { url: optionUrl } })
  })

  test('can use an earlier result when a follow-up reuses the search id', () => {
    const earlierUrl = 'https://index.trygravity.ai/go/earlier-option'
    const result = resolveGravityIndexLink({
      reference: {
        source: 'gravity_index',
        search_id: 'search-1',
        service_slug: 'neon',
      },
      messages: [
        gravityResult('gravity-1', {
          search_id: 'search-1',
          recommendation: { slug: 'supabase' },
          options: [{ slug: 'neon', click_url: earlierUrl }],
        }),
        gravityResult('gravity-2', {
          search_id: 'search-1',
          recommendation: {
            slug: 'supabase',
            click_url: 'https://index.trygravity.ai/go/latest-recommendation',
          },
        }),
      ],
    })

    expect(result).toEqual({ success: true, value: { url: earlierUrl } })
  })

  test('fails closed for unknown searches, services, and unsafe URLs', () => {
    const messages = [
      gravityResult('gravity-1', {
        search_id: 'search-1',
        recommendation: {
          slug: 'unsafe',
          click_url: 'javascript:alert(1)',
        },
      }),
    ]

    for (const reference of [
      {
        source: 'gravity_index' as const,
        search_id: 'missing-search',
        service_slug: 'unsafe',
      },
      {
        source: 'gravity_index' as const,
        search_id: 'search-1',
        service_slug: 'missing-service',
      },
      {
        source: 'gravity_index' as const,
        search_id: 'search-1',
        service_slug: 'unsafe',
      },
    ]) {
      const result = resolveGravityIndexLink({ reference, messages })
      expect(result.success).toBe(false)
    }
  })
})
