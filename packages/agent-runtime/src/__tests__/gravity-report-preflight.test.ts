import { describe, expect, test } from 'bun:test'

import {
  normalizeGravitySlug,
  preflightReportIntegration,
} from '../tools/handlers/tool/gravity-index'

import type { Message } from '@codebuff/common/types/messages/codebuff-message'

const searchResult = (
  searchId: string,
  recommended: string | null,
  options: string[] = [],
): Message =>
  ({
    role: 'tool',
    toolName: 'gravity_index',
    toolCallId: `call-${searchId}`,
    content: [
      {
        type: 'json',
        value: {
          search_id: searchId,
          ...(recommended ? { recommendation: { slug: recommended } } : {}),
          options: options.map((slug) => ({ slug })),
        },
      },
    ],
  }) as unknown as Message

describe('normalizeGravitySlug', () => {
  test('lowercases and kebab-cases', () => {
    expect(normalizeGravitySlug(' Google_AI Studio ')).toBe('google-ai-studio')
  })
})

describe('preflightReportIntegration', () => {
  test('sends the recommended slug spelled exactly as Gravity returned it', () => {
    expect(
      preflightReportIntegration({
        searchId: 's1',
        integratedSlug: 'Resend',
        messages: [searchResult('s1', 'resend')],
      }),
    ).toEqual({
      kind: 'send',
      searchId: 's1',
      integratedSlug: 'resend',
      rewritten: 'slug',
    })
  })

  test('swaps in the search in this run that recommended the service', () => {
    expect(
      preflightReportIntegration({
        searchId: 's2',
        integratedSlug: 'stripe',
        messages: [searchResult('s1', 'stripe'), searchResult('s2', 'clerk')],
      }),
    ).toEqual({
      kind: 'send',
      searchId: 's1',
      integratedSlug: 'stripe',
      rewritten: 'search_id',
    })
  })

  test('refuses an option slug no search recommended', () => {
    const result = preflightReportIntegration({
      searchId: 's1',
      integratedSlug: 'mailgun',
      messages: [searchResult('s1', 'resend', ['mailgun'])],
    })
    expect(result.kind).toBe('refuse')
    if (result.kind === 'refuse') {
      expect(result.errorMessage).toContain('only as an option')
    }
  })

  test('refuses a search that returned no recommendation', () => {
    const result = preflightReportIntegration({
      searchId: 's1',
      integratedSlug: 'mailgun',
      messages: [searchResult('s1', null, ['mailgun'])],
    })
    expect(result.kind).toBe('refuse')
    if (result.kind === 'refuse') {
      expect(result.errorMessage).toContain('no recommendation')
    }
  })

  test('passes through a search this run never saw (catalog hand-off)', () => {
    expect(
      preflightReportIntegration({
        searchId: 'catalog-1',
        integratedSlug: 'resend',
        messages: [],
      }),
    ).toEqual({
      kind: 'send',
      searchId: 'catalog-1',
      integratedSlug: 'resend',
    })
  })
})
