import { describe, expect, test } from 'bun:test'

import { isOrganicPostHogUrl } from './organic-links'

describe('organic PostHog links', () => {
  test.each([
    'https://posthog.com/docs?utm_source=docs#install',
    'https://www.posthog.com/',
    'https://app.posthog.com/signup',
    'https://us.posthog.com/signup',
    'https://eu.posthog.com/signup',
    'http://posthog.com/',
    'https://POSTHOG.com:443/docs',
  ])('accepts %s', (url) => expect(isOrganicPostHogUrl(url)).toBe(true))

  test.each([
    'https://posthog.com/?bfcid=existing',
    'https://posthog.com/?bfcid=',
    'https://posthog.com/?%62fcid=existing',
    'https://posthog.com.attacker.com/',
    'https://attacker.com/?next=https://posthog.com',
    'https://user:password@posthog.com/',
    'https://posthog.com@attacker.com/',
    'https://posthog.com:8443/',
    'https://us.i.posthog.com/capture',
    'https://other.posthog.com/',
    '//posthog.com/',
    'javascript:alert(1)',
    'file:///posthog.com',
    '/docs',
    '',
    `https://posthog.com/${'a'.repeat(2048)}`,
  ])('leaves %s alone', (url) => expect(isOrganicPostHogUrl(url)).toBe(false))
})
