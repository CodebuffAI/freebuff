/**
 * The CLI's inline LINK ad: one line at the end of an answer — the ad's copy,
 * underlined, then a dim "Ad" — drawn in place of the end-of-answer card.
 *
 * Two switches must both say yes before the CLI draws it:
 * - the server policy's `inlineAdStyle` is `link` (`INLINE_LINK_AD_LIVE` in
 *   `packages/internal/src/ad-serving/ad-policy.ts`, live for Web/Desktop);
 * - this file's {@link CLI_INLINE_LINK_AD_LIVE}.
 *
 * The CLI gate is separate because a change of CLI ad format needs the ad
 * network's written approval (#10807), which Web/Desktop's switch says
 * nothing about. With the gate off the CLI requests and draws exactly the
 * card it drew before this file existed.
 */

/**
 * Whether the CLI may draw the inline link ad when the policy asks for it. A
 * checked-in constant, not an env var: flipping it is a reviewed one-line PR
 * and a CLI release, after the ad network's written approval.
 */
export const CLI_INLINE_LINK_AD_LIVE = false

/** The CLI link ad's placement (`common/src/constants/freebuff-placements.ts`). */
export const CLI_INLINE_LINK_PLACEMENT_ID = 'Inline-Link-After-Agent-CLI'

export type CliInlineAdStyle = 'card' | 'link'

/**
 * How the CLI draws an answer's inline ad: `link` only when the CLI gate is
 * on AND the policy said `link`. An unresolved policy, a failed one, an older
 * server without the field and any other value all draw the card.
 */
export function cliInlineAdStyle(
  policyStyle: unknown,
  gate: boolean = CLI_INLINE_LINK_AD_LIVE,
): CliInlineAdStyle {
  return gate && policyStyle === 'link' ? 'link' : 'card'
}

/**
 * The placement one end-of-answer auction asks for, and the style its ad is
 * drawn in. Without a link placement (callers that never draw the link) or
 * with the gate off it is always the card placement.
 */
export function inlineAdRequestPlan(params: {
  cardPlacementId: string
  linkPlacementId?: string
  policyStyle: unknown
  gate?: boolean
}): { style: CliInlineAdStyle; placementId: string } {
  const style = params.linkPlacementId
    ? cliInlineAdStyle(params.policyStyle, params.gate)
    : 'card'
  return style === 'link' && params.linkPlacementId
    ? { style, placementId: params.linkPlacementId }
    : { style: 'card', placementId: params.cardPlacementId }
}

/** The longest link text, in characters, before the terminal width applies. */
export const CLI_INLINE_LINK_MAX_CHARS = 80

const ABBREVIATION = /(?:^|\s)(?:e\.g|i\.e|etc|vs|approx|incl|inc|no)\.$/i

function firstSentence(text: string): string | undefined {
  for (const match of text.matchAll(/[.!?](?=\s+[\p{Lu}\p{N}])/gu)) {
    const candidate = text.slice(0, match.index + 1)
    if (!ABBREVIATION.test(candidate)) return candidate
  }
  return undefined
}

/**
 * The words the link shows, the Web/Desktop rule (#10719): the ad's text,
 * else its title, else its CTA. Whole when it fits `max`; past that, its
 * first sentence if that fits, else cut between words with an ellipsis.
 */
export function inlineLinkText(
  ad: { adText?: string; title?: string; cta?: string },
  max: number = CLI_INLINE_LINK_MAX_CHARS,
): string {
  if (max <= 0) return ''
  const source =
    [ad.adText, ad.title, ad.cta]
      .map((value) => value?.replace(/\s+/g, ' ').trim() ?? '')
      .find((value) => value.length > 0) ?? ''
  const sentence = source.length > max ? firstSentence(source) : undefined
  const text = sentence && sentence.length <= max ? sentence : source
  // A lone full stop reads as a link's typo; an ellipsis or "!" is the copy's.
  if (text.length <= max) return text.replace(/(?<!\.)\.$/, '')
  if (max === 1) return '…'
  const cut = text.slice(0, max - 1)
  const space = cut.lastIndexOf(' ')
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:.-]+$/, '')}…`
}
