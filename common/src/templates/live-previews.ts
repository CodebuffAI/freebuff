import LIVE_PREVIEWS from './live-previews.json'

/**
 * Templates we host a live copy of, by template id: what a gallery's Preview
 * opens before someone starts from the template. A template missing here has
 * no Preview.
 *
 * Kept beside the published catalogue rather than in it: the catalogue schema
 * is strict, so a new field there would make installed clients reject every
 * template. `scripts/templates/deploy-previews.ts` rewrites the JSON.
 */
export const TEMPLATE_LIVE_PREVIEWS: Readonly<Record<string, string>> =
  LIVE_PREVIEWS

export function templateLivePreview(templateId: string): string | undefined {
  return Object.hasOwn(TEMPLATE_LIVE_PREVIEWS, templateId)
    ? TEMPLATE_LIVE_PREVIEWS[templateId]
    : undefined
}

/** Hosts that let another page frame them; a live copy elsewhere opens in a tab only. */
const FRAMEABLE_HOST = /\.freebuff\.(site|page)$/

/**
 * The live copy a client may show inside itself (the workspace's Template
 * tab, the mobile new chat's card): the one a project started from a template
 * shows before its first message. Undefined when there is none to frame.
 */
export function templateEmbedPreview(templateId: string): string | undefined {
  const url = templateLivePreview(templateId)
  if (!url) return undefined
  try {
    return FRAMEABLE_HOST.test(new URL(url).hostname) ? url : undefined
  } catch {
    return undefined
  }
}
