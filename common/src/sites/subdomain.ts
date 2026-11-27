import {
  impersonatesFreebuff,
  isReservedHostingSlug,
  withoutFreebuffBrand,
} from './reserved-names'

/**
 * DNS labels only. Reserved: the generated address namespace, the DNS target,
 * the hosting reserved words (`login`, `admin`…), any Freebuff or Codebuff
 * look-alike (reserved-names.ts), and punycode `xn--` labels, which a browser
 * can render as Unicode look-alikes no ASCII rule sees.
 */
export function siteSubdomainError(input: string): string | null {
  const name = input.trim().toLowerCase()
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(name))
    return 'Use 1–63 letters, numbers or hyphens. Start and end with a letter or number.'
  if (
    name === 'customers' ||
    /^site-[a-f0-9]{32}$/.test(name) ||
    name.startsWith('xn--') ||
    isReservedHostingSlug(name) ||
    impersonatesFreebuff(name)
  )
    return 'This subdomain is reserved. Choose another name.'
  return null
}

const SHORT_ID_LENGTH = 6
const PREVIEW_SUFFIX = '-preview'
// Leaves room for `-<id>-preview` inside a 63-character DNS label.
const NAME_SLUG_MAX = 63 - 1 - SHORT_ID_LENGTH - PREVIEW_SUFFIX.length

/**
 * `My Cool App!` → `my-cool-app`; falls back to `site` when nothing survives.
 * Words that read as Freebuff or Codebuff are dropped rather than refused, so
 * `Freebuff Airdrop` → `airdrop`: a generated address never reads as ours.
 */
export function siteNameSlug(name: string) {
  const slug = withoutFreebuffBrand(
    name
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-'),
  )
    .slice(0, NAME_SLUG_MAX)
    .replace(/-+$/, '')
  return slug || 'site'
}

/** Lowercase base36 suffix that keeps generated addresses distinct. */
export function siteShortId(random: Uint8Array) {
  if (random.length < SHORT_ID_LENGTH) throw new Error('Not enough randomness.')
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789'
  return Array.from(
    random.subarray(0, SHORT_ID_LENGTH),
    (byte) => alphabet[byte % alphabet.length],
  ).join('')
}

/** The addresses a new site starts with, before any rename. */
export function generatedSiteSubdomains(slug: string, shortId: string) {
  const production = `${slug}-${shortId}`
  return { production, preview: production + PREVIEW_SUFFIX }
}

export function siteHostname(env: {
  subdomain?: string | null
  worker_name: string
  domain: string
}) {
  return `${env.subdomain ?? env.worker_name}.${env.domain}`
}

export interface SiteSubdomainAvailability {
  subdomain: string
  available: boolean
}
