/**
 * Inline ad layout — the single implementation of how an ad is fitted into a
 * fixed character width.
 *
 * This lives in `common` rather than in the CLI because two surfaces have to
 * agree on it exactly: the CLI, which renders the ad, and the advertiser
 * campaign builder in `freebuff/web`, whose creative preview has to show an
 * advertiser what their copy will actually look like at the widths the
 * console offers (`PLACEMENT_PREVIEW_WIDTHS`).
 *
 * A CSS approximation of this in the web preview would be wrong. Note that
 * {@link truncateToWidth} measures with `String.length`, which counts UTF-16
 * code units rather than display columns — so emoji and CJK text truncate
 * differently here than a proportional-font preview would suggest. That
 * behaviour is deliberate to document rather than silently diverge from: the
 * preview must reproduce what the terminal does, including where it is wrong.
 */

import { sanitizeTerminalText } from '../util/terminal-safe-text'

/** Widths where inline ad layout actually changes behaviour. */
export const MIN_INLINE_WIDTH_WITH_DESTINATION = 48
/**
 * The narrowest width the CLI transcript renderer draws an inline ad at.
 *
 * This is a RENDERER fact, not a console-preview choice: the console's
 * `PLACEMENT_PREVIEW_WIDTHS` no longer offers it (almost nobody runs a
 * terminal this narrow), but real terminals can still be this size, so the
 * house-ad width budget keeps enforcing the title here — a cut title reads
 * as a different product, at any width.
 */
export const MIN_INLINE_AD_WIDTH = 20
export const MAX_DESC_LINES = 2
export const INLINE_AD_DISCLOSURE = 'Ad'
export const INLINE_AD_GAP = 2
export const INLINE_AD_LINK_SUFFIX = ' ↗'

/**
 * The fields of an ad that layout depends on. Structural rather than the CLI's
 * `AdResponse` so `common` does not depend on the CLI.
 */
export interface InlineAdLayoutInput {
  adText: string
  title: string
  url: string
}

export function truncateToLines(
  text: string,
  lineWidth: number,
  maxLines: number,
): string {
  if (lineWidth <= 0) return text
  const maxChars = lineWidth * maxLines
  if (text.length <= maxChars) return text
  return text.slice(0, maxChars - 1) + '…'
}

export function truncateToWidth(text: string, width: number): string {
  if (width <= 0) return ''
  if (text.length <= width) return text
  return text.slice(0, width - 1) + '…'
}

export const extractDomain = (url: string): string => {
  try {
    const parsed = new URL(url)
    return parsed.hostname.replace(/^www\./, '')
  } catch {
    // An unparseable value is shown as-is, so it must at least be inert.
    return sanitizeTerminalText(url)
  }
}

/**
 * What the ad shows as its destination. An ad with no destination URL falls
 * back to its title — a headline where a Gravity ad renders `neon.tech`.
 */
export function getAdDisplayLabel(
  ad: Pick<InlineAdLayoutInput, 'title' | 'url'>,
): {
  text: string
  variant: 'domain' | 'title'
} {
  const url = ad.url.trim()
  if (url) {
    return { text: extractDomain(url), variant: 'domain' }
  }

  return { text: ad.title.trim() || 'Sponsored', variant: 'title' }
}

/**
 * Fit an ad into `width` columns.
 *
 * Below {@link MIN_INLINE_WIDTH_WITH_DESTINATION} the destination label is
 * dropped entirely — the advertiser's domain is not shown at all. That is the
 * single most surprising thing about narrow terminals and the reason the
 * builder previews 20 columns at all.
 */
export function getInlineAdLayout(
  ad: InlineAdLayoutInput,
  width: number,
): { title: string; description: string; label: string } {
  const contentWidth = Math.max(0, width - 4) // border + horizontal padding
  const displayLabel = getAdDisplayLabel(ad)
  const headerTrailingWidth = INLINE_AD_GAP + INLINE_AD_DISCLOSURE.length
  const titleWidth = Math.max(0, contentWidth - headerTrailingWidth)
  const destinationLabel =
    width >= MIN_INLINE_WIDTH_WITH_DESTINATION &&
    displayLabel.variant === 'domain'
      ? displayLabel.text
      : ''
  const maxLabelWidth = Math.max(0, Math.min(24, Math.floor(contentWidth / 3)))
  const label = truncateToWidth(destinationLabel, maxLabelWidth)
  const trailingWidth = label
    ? INLINE_AD_GAP + label.length + INLINE_AD_LINK_SUFFIX.length
    : 0
  const descriptionWidth = Math.max(0, contentWidth - trailingWidth)

  return {
    title: truncateToWidth(ad.title.trim() || displayLabel.text, titleWidth),
    description: truncateToWidth(ad.adText.trim(), descriptionWidth),
    label,
  }
}

/* ------------------------------------------------------------------------- *
 * Dock V2 (COD-457)
 *
 * The above-input dock and its expandable detail panel. Same reason as
 * everything above it in this file: the terminal draws it and the advertiser
 * console previews it, and a CSS approximation of either would be a lie. The
 * grid, not the mockup, is the contract.
 * ------------------------------------------------------------------------- */

/** Interior columns eaten by the border (2) and the horizontal padding (2). */
export const DOCK_CHROME_WIDTH = 4
/** ` ↗` plus the CTA box's own border (2) and padding (2). */
export const DOCK_CTA_BOX_PADDING = 6
/** Columns between the copy block and the CTA box. */
export const DOCK_CTA_GAP = 2
/**
 * At or above this DOCK width the dock prints the keyboard chord hint.
 *
 * 78, not 80, because the dock is the terminal minus its two one-cell margins:
 * this is the "80-column terminal" threshold expressed in the only width this
 * function is ever given. Comparing 80 against the dock width silently moved
 * the rule to an 82-column terminal, where it never fired on the standard one.
 */
export const DOCK_CHORD_HINT_MIN_WIDTH = 78
/** The detail panel never gets wider than this, however wide the terminal is. */
export const DOCK_PANEL_MAX_WIDTH = 58
export const DOCK_PANEL_MAX_BODY_LINES = 4
export const DOCK_PANEL_MAX_BULLETS = 3

/** Advertiser-authored limits, enforced in the console and re-clamped here. */
export const DOCK_EXPANDED_BODY_MAX_LENGTH = 240
export const DOCK_BULLET_MAX_LENGTH = 40
export const DOCK_DIAGRAM_MAX_LENGTH = 40

/**
 * The optional expanded creative. Every field is nullable because only
 * first-party creatives can carry them: a Gravity or house ad reaches
 * the panel with nothing but its `adText`, and must still render a full panel.
 */
export interface DockAdInput extends InlineAdLayoutInput {
  cta?: string | null
  expandedBody?: string | null
  bullets?: readonly string[] | null
  diagram?: string | null
}

/**
 * Word-wrap `text` into at most `maxLines` lines of `width` columns.
 *
 * A word longer than the line is hard-split rather than allowed to overflow —
 * a URL in an advertiser's body must not push the panel's border off-screen.
 * Overflow past `maxLines` is truncated with an ellipsis on the last line, the
 * same visual contract as {@link truncateToWidth}.
 */
export function wrapToLines(
  text: string,
  width: number,
  maxLines: number,
): string[] {
  if (width <= 0 || maxLines <= 0) return []
  const words = text.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return []

  const lines: string[] = []
  let current = ''
  const pushCurrent = (): void => {
    if (current) lines.push(current)
    current = ''
  }

  let overflowed = false
  for (const word of words) {
    let remaining = word
    // A word wider than the line is hard-split across as many lines as it
    // needs; whatever is left of it then joins the flow normally.
    while (remaining.length > width) {
      pushCurrent()
      if (lines.length > maxLines) {
        overflowed = true
        break
      }
      lines.push(remaining.slice(0, width))
      remaining = remaining.slice(width)
    }
    if (overflowed || lines.length > maxLines) {
      overflowed = true
      break
    }
    if (!current) {
      current = remaining
    } else if (current.length + 1 + remaining.length <= width) {
      current = `${current} ${remaining}`
    } else {
      pushCurrent()
      if (lines.length > maxLines) {
        overflowed = true
        break
      }
      current = remaining
    }
  }
  pushCurrent()

  if (lines.length <= maxLines) return lines
  const kept = lines.slice(0, maxLines)
  const last = kept[maxLines - 1] ?? ''
  kept[maxLines - 1] = truncateToWidth(`${last} …`, width)
  return kept
}

export type DockAdLayout =
  | {
      /**
       * Below {@link MIN_INLINE_WIDTH_WITH_DESTINATION} the dock renders the
       * pre-existing five-row card verbatim. Nothing about the copy budget
       * moves at narrow widths, which is what keeps the house-ad width budget
       * (title at width 20) measuring the same thing it always did.
       */
      mode: 'card'
    }
  | {
      mode: 'dock'
      /** The literal disclosure word; the caller colours it. */
      sponsored: string
      /** `getAdDisplayLabel` text, truncated to what the label row can hold. */
      brand: string
      brandVariant: 'domain' | 'title'
      headline: string
      description: string
      /** 1 with a headline, 2 without — the rule `getCardAdLayout` already uses. */
      descriptionLines: number
      ctaText: string
      /** Total columns the bordered CTA box occupies, including its border. */
      ctaBoxWidth: number
      /** Columns available to the headline/description block. */
      copyWidth: number
      /** Right-aligned chord hint, or '' when it is suppressed. */
      chordHint: string
    }

export const DOCK_SPONSORED_LABEL = 'Sponsored'
export const DOCK_LABEL_SEPARATOR = ' · '

/**
 * Fit an ad into the resting dock at `width` columns.
 *
 * The CTA box is sized from the CTA text and then CLAMPED to half the interior:
 * an advertiser with a long call to action may not squeeze the headline out of
 * existence, and clamping here — rather than adding a second width fallback —
 * keeps the `card`/`dock` decision a pure function of terminal width.
 *
 * The chord hint is right-aligned inside the COPY block rather than the full
 * interior row, because the CTA box occupies all three interior rows on the
 * right. The spec's alternative — suppress the hint whenever the box is
 * present — would mean it never renders at all, so the hint moved rather than
 * died. It is still never a hover affordance.
 */
export function getDockAdLayout(
  ad: DockAdInput,
  width: number,
  options?: { chordHint?: string; collapsed?: boolean },
): DockAdLayout {
  if (width < MIN_INLINE_WIDTH_WITH_DESTINATION) return { mode: 'card' }

  // Every field is defaulted before it is read, for the reason
  // `getCardAdLayout` documents: providers cast their JSON rather than parse it.
  const title = (ad.title ?? '').trim()
  const cta = (ad.cta ?? '').trim()
  const adText = (ad.adText ?? '').trim()
  const url = ad.url ?? ''

  const interior = Math.max(0, width - DOCK_CHROME_WIDTH)
  const ctaBudget = Math.max(0, Math.floor(interior / 2))
  const ctaText = truncateToWidth(
    cta || 'Learn more',
    Math.max(1, ctaBudget - DOCK_CTA_BOX_PADDING),
  )
  const ctaBoxWidth = Math.min(ctaBudget, ctaText.length + DOCK_CTA_BOX_PADDING)
  const copyWidth = Math.max(0, interior - ctaBoxWidth - DOCK_CTA_GAP)

  const label = getAdDisplayLabel({ title, url })
  const headline = truncateToWidth(title, copyWidth)
  const descriptionLines = headline ? 1 : MAX_DESC_LINES

  const collapsed = options?.collapsed ?? true
  const rawHint = (options?.chordHint ?? '').trim()
  const hintFits = rawHint.length > 0 && rawHint.length + 2 < copyWidth
  const chordHint =
    collapsed && width >= DOCK_CHORD_HINT_MIN_WIDTH && hintFits ? rawHint : ''

  const brandBudget = Math.max(
    0,
    copyWidth -
      DOCK_SPONSORED_LABEL.length -
      DOCK_LABEL_SEPARATOR.length -
      (chordHint ? chordHint.length + 1 : 0),
  )

  return {
    mode: 'dock',
    sponsored: DOCK_SPONSORED_LABEL,
    brand: truncateToWidth(label.text, brandBudget),
    brandVariant: label.variant,
    headline,
    description: truncateToLines(adText, copyWidth, descriptionLines),
    descriptionLines,
    ctaText,
    ctaBoxWidth,
    copyWidth,
    chordHint,
  }
}

/** Which optional block a degradation step gave up, in the order it gave it up. */
export type DockPanelDropped = 'diagram' | 'bullets' | 'body'

export interface DockPanelLayout {
  /**
   * False when even the smallest panel would cover the composer. The caller
   * must then refuse to expand — a panel that hides the input box is worse
   * than no panel at all.
   */
  fits: boolean
  width: number
  /** Total rows including the panel's own border. */
  height: number
  brand: string
  headline: string
  bodyLines: string[]
  diagram: string
  bullets: string[]
  ctaText: string
  dropped: DockPanelDropped[]
}

/** Interior rows that are always present at the head: header, blank, headline. */
const PANEL_FIXED_HEAD_ROWS = 3
/** Interior rows always present at the foot: divider, blank, three-row CTA box. */
const PANEL_FIXED_FOOT_ROWS = 1 + 1 + 3
/** The panel's own top and bottom border. */
const PANEL_BORDER_ROWS = 2
/** Below two body lines there is no pitch left, so the panel refuses to open. */
const PANEL_MIN_BODY_LINES = 2

/**
 * Plan the expanded panel for `availableRows` rows of free space.
 *
 * Pure, and tested as such, because the thing it protects — never covering the
 * composer on a 24-row terminal — is not observable from a snapshot of a wide
 * one. The ladder drops the diagram, then the bullets, then body lines 3-4, in
 * that order, and then gives up (`fits: false`).
 */
export function getDockPanelLayout(
  ad: DockAdInput,
  options: { width: number; availableRows: number },
): DockPanelLayout {
  const width = Math.max(
    0,
    Math.min(DOCK_PANEL_MAX_WIDTH, Math.floor(options.width)),
  )
  const interiorWidth = Math.max(0, width - DOCK_CHROME_WIDTH)

  const title = (ad.title ?? '').trim()
  const url = ad.url ?? ''
  const brandLabel = getAdDisplayLabel({ title, url })
  const brand = truncateToWidth(
    brandLabel.text,
    Math.max(0, interiorWidth - DOCK_SPONSORED_LABEL.length - 1),
  )
  const headline = truncateToWidth(title, interiorWidth)
  const ctaText = truncateToWidth(
    (ad.cta ?? '').trim() || 'Learn more',
    Math.max(1, interiorWidth - DOCK_CTA_BOX_PADDING),
  )

  const bodySource = (ad.expandedBody ?? '').trim() || (ad.adText ?? '').trim()
  const allBodyLines = wrapToLines(
    bodySource.slice(0, DOCK_EXPANDED_BODY_MAX_LENGTH),
    interiorWidth,
    DOCK_PANEL_MAX_BODY_LINES,
  )
  const rawDiagram = truncateToWidth(
    (ad.diagram ?? '').trim().slice(0, DOCK_DIAGRAM_MAX_LENGTH),
    interiorWidth,
  )
  const allBullets = (ad.bullets ?? [])
    .map((bullet) => (bullet ?? '').trim())
    .filter(Boolean)
    .slice(0, DOCK_PANEL_MAX_BULLETS)
    .map((bullet) =>
      truncateToWidth(
        bullet.slice(0, DOCK_BULLET_MAX_LENGTH),
        Math.max(0, interiorWidth - 2),
      ),
    )

  let bodyLines = allBodyLines
  let diagram = rawDiagram
  let bullets = allBullets
  const dropped: DockPanelDropped[] = []

  const totalRows = (): number =>
    PANEL_FIXED_HEAD_ROWS +
    bodyLines.length +
    (diagram ? 2 : 0) +
    (bullets.length > 0 ? 1 + bullets.length : 0) +
    PANEL_FIXED_FOOT_ROWS +
    PANEL_BORDER_ROWS

  if (totalRows() > options.availableRows && diagram) {
    diagram = ''
    dropped.push('diagram')
  }
  if (totalRows() > options.availableRows && bullets.length > 0) {
    bullets = []
    dropped.push('bullets')
  }
  if (
    totalRows() > options.availableRows &&
    bodyLines.length > PANEL_MIN_BODY_LINES
  ) {
    bodyLines = bodyLines.slice(0, PANEL_MIN_BODY_LINES)
    dropped.push('body')
  }

  const height = totalRows()
  return {
    fits: width > 0 && height <= options.availableRows,
    width,
    height,
    brand,
    headline,
    bodyLines,
    diagram,
    bullets,
    ctaText,
    dropped,
  }
}

/* ------------------------------------------------------------------------- *
 * Partner line
 *
 * The CLI's rendering of a PARTNER placement: one row of the advertiser's
 * colour, above the input or under `/review`. Desktop draws the same deal as
 * a pill with their logo in it; a terminal has no images, so the row carries
 * the title, the destination and the disclosure and nothing else.
 * ------------------------------------------------------------------------- */

/**
 * The disclosure on a partner row, and the reason this is a separate constant
 * from {@link INLINE_AD_DISCLOSURE} despite being the same word: the inline
 * one is drawn in the muted foreground against our surface, and this one is
 * drawn in the ADVERTISER's ink against their fill. The two are free to
 * diverge in casing or spacing without one silently restyling the other.
 */
export const PARTNER_LINE_DISCLOSURE = 'Ad'
/** Columns between the title and the destination label. */
export const PARTNER_LINE_GAP = 2
/**
 * Below this the row drops the destination entirely and keeps the title.
 *
 * The same trade {@link MIN_INLINE_WIDTH_WITH_DESTINATION} makes, at a lower
 * width: this is ONE row with no border and no CTA box, so it still reads at
 * widths where the inline card has already given up. What it may never drop
 * is the disclosure -- an unlabelled line of somebody's brand colour inside
 * our chrome is the one state this format must not have.
 */
export const MIN_PARTNER_WIDTH_WITH_DESTINATION = 44

export interface PartnerLineLayout {
  title: string
  /** The advertiser's domain, or '' when the row is too narrow for it. */
  label: string
  disclosure: string
}

/**
 * Fit a partner row into `width` columns.
 *
 * Pure and in `common` for the reason every other function in this file is:
 * the CLI draws this row and the advertiser console previews it, and a CSS
 * approximation of a character grid is a confident lie. The console imports
 * this and renders the answer in `ch`.
 */
export function getPartnerLineLayout(
  ad: Pick<InlineAdLayoutInput, 'title' | 'url'>,
  width: number,
): PartnerLineLayout {
  // One cell of padding each side, which is what the CLI's row draws with.
  const interior = Math.max(0, width - 2)
  const displayLabel = getAdDisplayLabel({
    title: ad.title ?? '',
    url: ad.url ?? '',
  })
  const disclosureWidth = PARTNER_LINE_GAP + PARTNER_LINE_DISCLOSURE.length
  // The label is the advertiser's domain only. Falling back to the title
  // here, as the inline card does, would print the title twice on one row.
  const destination =
    width >= MIN_PARTNER_WIDTH_WITH_DESTINATION &&
    displayLabel.variant === 'domain'
      ? displayLabel.text
      : ''
  // A third of the row, as the inline card budgets its own label: the title
  // is the subject and the domain is the attribution, and at the breakpoint
  // above a third is exactly enough for a real domain.
  const labelBudget = Math.max(0, Math.min(24, Math.floor(interior / 3)))
  const label = truncateToWidth(destination, labelBudget)
  const titleWidth = Math.max(
    0,
    interior - disclosureWidth - (label ? label.length + PARTNER_LINE_GAP : 0),
  )
  return {
    title: truncateToWidth((ad.title ?? '').trim(), titleWidth),
    label,
    disclosure: PARTNER_LINE_DISCLOSURE,
  }
}

/**
 * `#rrggbb`, the only brand colour a partner creative may state.
 *
 * Shared by the console's write validation and both clients' render paths,
 * and checked at every one of them even though `ck_ad_placement_creative_
 * brand_hex` already constrains the column: these two fields are the only
 * creative values a client interpolates into a STYLE rather than rendering as
 * text, and the cost of the check is one regex.
 */
const BRAND_HEX = /^#[0-9a-f]{6}$/i

export function isValidBrandHex(value: string | null | undefined): boolean {
  return typeof value === 'string' && BRAND_HEX.test(value)
}
