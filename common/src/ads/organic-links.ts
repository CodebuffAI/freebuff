/** Organic attribution starts with PostHog's public site and account hosts. */
const POSTHOG_LINK_HOSTS = new Set([
  'posthog.com',
  'www.posthog.com',
  'app.posthog.com',
  'us.posthog.com',
  'eu.posthog.com',
])

export const ORGANIC_LINK_MAX_URL_LENGTH = 2048
export type OrganicLinkSurface = 'web' | 'desktop'

/** Never replace an existing sponsored click or turn an arbitrary URL into a redirect. */
export function isOrganicPostHogUrl(value: string): boolean {
  if (!value || value.length > ORGANIC_LINK_MAX_URL_LENGTH) return false
  try {
    const url = new URL(value)
    return (
      (url.protocol === 'https:' || url.protocol === 'http:') &&
      POSTHOG_LINK_HOSTS.has(url.hostname) &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.searchParams.has('bfcid')
    )
  } catch {
    return false
  }
}
