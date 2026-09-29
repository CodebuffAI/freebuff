/**
 * Freebuff's default UTM tags on links that send a developer to an advertiser.
 *
 * An advertiser can only credit Freebuff for a visit its analytics can see
 * came from Freebuff. The `bfcid` click token does that for an advertiser
 * integrated for postbacks, but most campaigns carry `internal` conversion
 * authority, which mints no token at all, and a visitor from a sponsored run
 * reaches the advertiser through URLs the agent relays from the procedure
 * rather than through our redirect. Infisical (2026-09-29) reported every one
 * of those visits arriving untagged.
 *
 * ## The rules
 *
 * A link that already carries ANY `utm_*` parameter is the advertiser's own
 * tagging and is left byte-identical. Filling individual missing keys around
 * an advertiser's partial tagging would mix their taxonomy with ours in one
 * visit, which is worse than either alone.
 *
 * An untagged link gains the ADVERTISER'S tags when it has any: the
 * `utm_source`, `utm_medium` and `utm_campaign` it put on its campaign landing
 * URL, which is how its own reports already group Freebuff traffic
 * (Infisical: `utm_campaign=secrets_management`; Boot.dev: `utm_medium=cpc`).
 * `utm_content`/`utm_term` are not copied: they name the display creative the
 * landing URL was written for, not the link being tagged. Only a campaign that
 * set no `utm_source` gets ours:
 * `utm_source=freebuff&utm_medium=paid&utm_campaign=<campaign name slug>`.
 */

export const AD_LINK_UTM_SOURCE = 'freebuff'
export const AD_LINK_UTM_MEDIUM = 'paid'

const UTM_CAMPAIGN_MAX_CHARS = 64

function hasUtmParams(url: URL): boolean {
  for (const key of url.searchParams.keys()) {
    if (key.toLowerCase().startsWith('utm_')) return true
  }
  return false
}

/** Ordered `[key, value]` pairs appended to an untagged link. */
export type AdLinkUtmTags = ReadonlyArray<readonly [string, string]>

/** Our default `utm_campaign`: the campaign name as a slug, or its id when the name has no usable characters. */
export function adLinkUtmCampaign(campaign: {
  id: string
  name?: string | null
}): string {
  const slug = (campaign.name ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, UTM_CAMPAIGN_MAX_CHARS)
    .replace(/-+$/g, '')
  return slug || campaign.id
}

const ADVERTISER_UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign']

/**
 * The tags an untagged link to this campaign's advertiser gains: the
 * advertiser's own from its campaign landing URL when it set `utm_source`
 * there, ours otherwise.
 */
export function adLinkUtmTags(campaign: {
  id: string
  name?: string | null
  landingUrl?: string | null
}): AdLinkUtmTags {
  try {
    const landing = new URL(campaign.landingUrl ?? '')
    if (landing.searchParams.get('utm_source')) {
      return ADVERTISER_UTM_KEYS.flatMap((key) => {
        const value = landing.searchParams.get(key)
        return value ? [[key, value] as const] : []
      })
    }
  } catch {
    // No usable landing URL: our defaults.
  }
  return [
    ['utm_source', AD_LINK_UTM_SOURCE],
    ['utm_medium', AD_LINK_UTM_MEDIUM],
    ['utm_campaign', adLinkUtmCampaign(campaign)],
  ]
}

/**
 * The link with `tags` appended, or the input unchanged when it already
 * carries `utm_*`, is not http(s), or does not parse. Never throws: a link we
 * cannot tag is still a link the developer should reach.
 */
export function withDefaultAdLinkUtm(
  rawUrl: string,
  tags: AdLinkUtmTags,
): string {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return rawUrl
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return rawUrl
  if (hasUtmParams(url) || tags.length === 0) return rawUrl
  for (const [key, value] of tags) url.searchParams.set(key, value)
  return url.toString()
}

/** Two-label public suffixes common enough to matter (`example.co.uk`). */
const SECOND_LEVEL_LABELS = new Set([
  'ac',
  'co',
  'com',
  'edu',
  'gov',
  'net',
  'org',
])

function registrableDomain(hostname: string): string {
  const host = hostname
    .toLowerCase()
    .replace(/^www\./, '')
    .replace(/\.$/, '')
  if (/^[\d.]+$/.test(host) || host.includes(':')) return host
  const labels = host.split('.')
  if (labels.length <= 2) return host
  const tld = labels[labels.length - 1]!
  const sld = labels[labels.length - 2]!
  const keep = tld.length === 2 && SECOND_LEVEL_LABELS.has(sld) ? 3 : 2
  return labels.slice(-keep).join('.')
}

/**
 * The advertiser's own domains, from its campaign landing URL, creative URLs
 * and profile website. `get.infisical.com` and `infisical.com` both yield
 * `infisical.com`, so `app.infisical.com` in a procedure is recognised.
 */
export function advertiserLinkDomains(
  urls: ReadonlyArray<string | null | undefined>,
): string[] {
  const domains = new Set<string>()
  for (const raw of urls) {
    if (!raw) continue
    try {
      const url = new URL(raw)
      if (url.protocol === 'https:' || url.protocol === 'http:') {
        domains.add(registrableDomain(url.hostname))
      }
    } catch {
      // Not a URL; contributes no domain.
    }
  }
  return [...domains]
}

/** Fenced blocks and inline code spans: text the agent runs or writes verbatim. */
const CODE_SPAN = /```[\s\S]*?(?:```|$)|`[^`\n]*`/g
const URL_CANDIDATE = /https?:\/\/[^\s<>"'`]+/g
/** Sentence punctuation that ends a URL in prose rather than belonging to it. */
const TRAILING_PUNCTUATION = /[.,;:!?'"]+$/
/**
 * A URL handed to a command earlier in the same clause. `&` is a shell
 * control operator, so a tagged URL left unquoted in `curl …` would
 * background the command and drop every parameter after it. The clause ends
 * at punctuation followed by whitespace, so "If you use bun, sign up at …"
 * is still prose.
 */
const COMMAND_BEFORE_URL =
  /\b(?:curl|wget|git\s+(?:clone|remote|submodule)|pip3?\s+install|npm\s+(?:i|install)|npx|bunx?|pnpm|yarn|brew|docker|kubectl|helm|go\s+(?:get|install)|cargo\s+install|iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b(?:(?![.,;:!?]\s)[^\n])*$/i
/** A path ending in a file extension is a download or a machine-read file (`llms.txt`, `install.sh`), not a page. */
const FILE_EXTENSION = /\.([a-z0-9]{1,8})$/i
const PAGE_EXTENSIONS = new Set(['html', 'htm', 'php', 'asp', 'aspx'])

function trimUrlCandidate(candidate: string): string {
  let url = candidate.replace(TRAILING_PUNCTUATION, '')
  // A closing bracket belongs to the URL only when the URL opened one, as in
  // a Wikipedia path; otherwise it closes a Markdown link or a parenthetical.
  for (const [open, close] of [
    ['(', ')'],
    ['[', ']'],
  ] as const) {
    while (
      url.endsWith(close) &&
      url.split(close).length > url.split(open).length
    ) {
      url = url.slice(0, -1).replace(TRAILING_PUNCTUATION, '')
    }
  }
  return url
}

function isTaggablePageLink(
  raw: string,
  domains: ReadonlySet<string>,
): boolean {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false
  if (!domains.has(registrableDomain(url.hostname))) return false
  if (hasUtmParams(url)) return false
  const host = url.hostname.toLowerCase()
  if (host.startsWith('api.')) return false
  const segments = url.pathname.split('/').filter(Boolean)
  if (segments.some((segment) => segment.toLowerCase() === 'api')) return false
  const extension = FILE_EXTENSION.exec(segments[segments.length - 1] ?? '')
  if (extension && !PAGE_EXTENSIONS.has(extension[1]!.toLowerCase()))
    return false
  return true
}

/**
 * Tag the links in an agentic procedure that a developer would OPEN: pages on
 * the advertiser's own domains, in prose.
 *
 * Applied when the procedure is SAVED, never when it is served. The stored
 * text is what the reviewer approves, what Desktop hashes for consent and
 * what the run executes, so tagging it once at write time keeps all three
 * byte-identical; rewriting at serve time would make the executed text differ
 * from the reviewed text and from every stored procedure hash.
 *
 * Deliberately conservative, because a wrong tag can break a run rather than
 * merely mis-attribute a visit. Left untouched: anything inside code spans or
 * fenced blocks, a URL following a command on its line, API hosts and paths,
 * file URLs (`llms.txt`, `install.sh`), other companies' domains, and links
 * already carrying `utm_*`. Everything outside a tagged URL is preserved
 * byte for byte, and a second pass changes nothing.
 */
export function tagSponsoredProcedureLinks(
  procedure: string,
  input: { domains: readonly string[]; tags: AdLinkUtmTags },
): string {
  const domains = new Set(input.domains.map((domain) => domain.toLowerCase()))
  if (domains.size === 0) return procedure

  const tagProse = (prose: string, precedingText: string): string =>
    prose.replace(URL_CANDIDATE, (candidate, offset: number) => {
      const url = trimUrlCandidate(candidate)
      const line =
        (precedingText + prose.slice(0, offset)).split('\n').pop() ?? ''
      if (COMMAND_BEFORE_URL.test(line)) return candidate
      if (!isTaggablePageLink(url, domains)) return candidate
      return withDefaultAdLinkUtm(url, input.tags) + candidate.slice(url.length)
    })

  let result = ''
  let cursor = 0
  for (const match of procedure.matchAll(CODE_SPAN)) {
    const prose = procedure.slice(cursor, match.index)
    result += tagProse(prose, procedure.slice(0, cursor))
    result += match[0]
    cursor = match.index! + match[0].length
  }
  result += tagProse(procedure.slice(cursor), procedure.slice(0, cursor))
  return result
}
