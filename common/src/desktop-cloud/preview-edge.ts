/**
 * Hosts served by our own preview edge (`cloud-preview-edge/`), for sandbox
 * providers whose edge cannot ask us who is calling. A preview there is
 * `pv-<chat key>-<generation>.<domain>`, authorised per request by the Cloud
 * API exactly as a Freestyle preview is.
 *
 * The domains are the Sites zones, production then staging: one level down is
 * covered by each zone's own certificate, and the Sites dispatcher, which owns
 * the zone's wildcard route, hands these labels to the edge
 * (`sites-dispatcher/worker.ts`). No site is ever named `pv-…` (sites are
 * `site-<hex>`). A client opens a preview URL only on a host this recognises.
 */
export const CLOUD_PREVIEW_EDGE_DOMAINS = ['freebuff.site', 'freebuffweb.site'] as const

/** The label `previewEdgeHost` builds: a chat key, a provider, a generation id. */
const LABEL =
  /^pv-[a-f0-9]{12}-[a-z0-9]{2,12}-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/

/** `chatKey` is the first 12 hex of the chat's execution key; `slug` is `fb-<provider>-<uuid>`. */
export function previewEdgeHost(chatKey: string, slug: string, domain: string) {
  return `pv-${chatKey}-${slug.replace(/^fb-/, '')}.${domain}`
}

/** Whether one DNS label is a preview edge label. */
export const isPreviewEdgeLabel = (label: string) => LABEL.test(label)

/** The edge domain a hostname belongs to, or null when it is not a preview edge host. */
export function previewEdgeDomain(hostname: string): string | null {
  for (const domain of CLOUD_PREVIEW_EDGE_DOMAINS) {
    if (!hostname.endsWith(`.${domain}`)) continue
    return isPreviewEdgeLabel(hostname.slice(0, -domain.length - 1)) ? domain : null
  }
  return null
}

/**
 * An Agent 37 embed link's host (docs/cloud-agent37.md, "Previews"):
 * `<instance id>-<port>-<token>.agent37.app`. The provider's own edge checks
 * the token, which is part of the hostname, on every request, so the link
 * frames in the iframe panel with no cookie. One label under the provider's
 * domain, nothing else.
 */
const AGENT37_EMBED_HOST = /^[a-z0-9]{10}-[0-9]{4,5}-[a-z0-9]{16,}\.agent37\.app$/

/** Whether a hostname is an Agent 37 embed link's. */
export const isAgent37EmbedHost = (hostname: string) =>
  hostname.length <= 63 + '.agent37.app'.length && AGENT37_EMBED_HOST.test(hostname)
