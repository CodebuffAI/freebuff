import { TextAttributes } from '@opentui/core'
import {
  DOCK_LABEL_SEPARATOR,
  DOCK_PANEL_MAX_WIDTH,
  DOCK_SPONSORED_LABEL,
  INLINE_AD_DISCLOSURE,
  INLINE_AD_GAP,
  INLINE_AD_LINK_SUFFIX,
  MAX_DESC_LINES,
  getAdDisplayLabel,
  getDockAdLayout,
  getDockPanelLayout,
  getInlineAdLayout,
  truncateToLines,
  truncateToWidth,
} from '@codebuff/common/ads/inline-ad-layout'
import type { DockClickOrigin } from '@codebuff/common/ads/ad-event-hygiene'
import type { CliDockArm } from '@codebuff/common/util/ad-experiment'
import { visibleWaitingRoomPlacementIds } from '@codebuff/common/ads/waiting-room-placements'
import { isRemoteSession, showClipboardMessage } from '../utils/clipboard'
import { isOpenableWebUrl, safeOpen } from '../utils/open-url'
import React, { useState, useMemo, useEffect } from 'react'

import { greptileTerminalColors } from '../ads/partner-brand'
import { inlineLinkText, CLI_INLINE_LINK_MAX_CHARS } from '../ads/inline-link-ad'
import { layoutTruncated } from '../ads/ad-engagement'
import { noteAdDrawn } from '../ads/ad-expiry-clock'
import {
  reportInlineCardDrawn,
  reportInlineCardVisibility,
} from '../ads/ad-screen'
import { useAdEngagement } from '../ads/use-ad-engagement'

import { Button } from './button'
import { AdReportButton, AD_REPORT_CONTROL_COLUMNS } from './ad-report-button'
import { useTerminalDimensions } from '../hooks/use-terminal-dimensions'
import { useTheme } from '../hooks/use-theme'
import { BORDER_CHARS, INVERTED_CTA_FG } from '../utils/ui-constants'

import type { AdResponse } from '../hooks/use-gravity-ad'

interface ChoiceAdBannerProps {
  ads: AdResponse[]
  placementIds?: readonly string[]
  onClick?: (ad: AdResponse) => void
  onImpression?: (ad: AdResponse) => void
}

// border-top + 2 copy rows + cta row + border-bottom. The two copy rows are
// headline + 1 description line, or 2 description lines when the ad has no
// headline — see getCardAdLayout. Fixed either way, because the landing screen
// subtracts this from the model picker's height budget.
export const AD_CARD_HEIGHT = 5
export const INLINE_AD_CARD_HEIGHT = 4 // border-top + header row + detail row + border-bottom
/** The disclosure after the inline link ad's copy. */
const INLINE_LINK_DISCLOSURE = ` ${INLINE_AD_DISCLOSURE}`

// Layout lives in `common` so the advertiser campaign builder's creative
// preview fits copy exactly the way this renderer does. Re-exported here
// because this module was its original home.
export {
  extractDomain,
  getAdDisplayLabel,
  getDockAdLayout,
  getDockPanelLayout,
  getInlineAdLayout,
} from '@codebuff/common/ads/inline-ad-layout'

export function getCardAdLayout(
  ad: Pick<AdResponse, 'adText' | 'title' | 'cta' | 'url'>,
  width: number,
): {
  headline: string
  description: string
  descriptionLines: number
  ctaText: string
  labelText: string
  labelVariant: 'domain' | 'title'
} {
  // Every field is defaulted before it is read. `AdResponse` types these as
  // required strings, but nothing enforces that at runtime: the Gravity
  // provider casts `response.json()` rather than parsing it and `normalize()`
  // copies `cta: raw.cta` with no default — so a missing field is a case this
  // codebase already expects from a network. A throw here is a throw
  // inside AdCard's render on the landing screen, and `error-boundary.tsx` is a
  // passthrough that does not catch render errors.
  const title = (ad.title ?? '').trim()
  const cta = (ad.cta ?? '').trim()
  const adText = ad.adText ?? ''
  const url = ad.url ?? ''

  // Interior width less the padding and the ' Ad' disclosure, matching what
  // the description has always been given.
  const copyWidth = Math.max(0, width - 8)
  const headline = truncateToWidth(title, copyWidth)
  const descriptionLines = headline ? 1 : MAX_DESC_LINES
  // The title is no longer a CTA fallback: it has a row of its own, and using
  // it here too printed the same string twice on a five-row card.
  const ctaText = cta || 'Learn more'
  // Called with the defaulted fields, not `ad`: it reads `ad.url.trim()`
  // directly and would throw on the same malformed payload.
  const label = getAdDisplayLabel({ title, url })
  // Without a URL the label falls back to the title, which is now drawn one row
  // above. Same string, twice, for the same reason.
  const showLabel = label.variant === 'domain' || !headline

  return {
    headline,
    description: truncateToLines(adText, copyWidth, descriptionLines),
    descriptionLines,
    ctaText,
    labelText: showLabel
      ? truncateToWidth(label.text, Math.max(0, width - ctaText.length - 5))
      : '',
    labelVariant: label.variant,
  }
}

/** How long the "copy this link" line stays up after an ad click cannot open. */
export const AD_LINK_NOTICE_MS = 15_000

/** What became of one click on an ad. */
export type AdClickOutcome = 'opened' | 'link_shown' | 'ignored'

export type AdClickDeps = {
  open: (url: string) => Promise<boolean>
  isRemote: () => boolean
  showLink: (ad: Pick<AdResponse, 'url'>) => void
}

/**
 * The line shown when a click cannot open a browser here. It carries the
 * advertiser's plain landing `url`, never the tracked `clickUrl`: the tracked
 * link is a short-lived, per-impression redirect that counts a click when it
 * is followed, so pasting it elsewhere would count a click this client chose
 * not to record, and it stays live in scrollback after the user moves on.
 */
export function adLinkNotice(ad: Pick<AdResponse, 'url'>): string {
  return isOpenableWebUrl(ad.url)
    ? `Couldn't open a browser here. Link: ${ad.url}`
    : "Couldn't open a browser here."
}

const liveAdClickDeps: AdClickDeps = {
  open: safeOpen,
  isRemote: isRemoteSession,
  showLink: (ad) =>
    showClipboardMessage(adLinkNotice(ad), { durationMs: AD_LINK_NOTICE_MS }),
}

/**
 * The one path every ad click in this file takes: try to open the tracked
 * link, and report the click (`onOpened`) only when a browser was opened.
 *
 * A session over SSH never opens: the opener would run on the remote host,
 * where nobody is looking, and report success. There, and whenever opening
 * fails (no display server, WSL without Windows interop, a refused URL), no
 * click is reported and the landing URL is shown as a line to copy instead.
 */
export async function openAdClick(
  ad: Pick<AdResponse, 'clickUrl' | 'url'>,
  onOpened: () => void,
  deps: AdClickDeps = liveAdClickDeps,
): Promise<AdClickOutcome> {
  if (!ad.clickUrl) return 'ignored'
  let opened = false
  if (!deps.isRemote()) {
    try {
      opened = await deps.open(ad.clickUrl)
    } catch {
      opened = false
    }
  }
  if (opened) {
    onOpened()
    return 'opened'
  }
  deps.showLink(ad)
  return 'link_shown'
}

/**
 * Calculate evenly distributed column widths that sum exactly to availableWidth.
 * Distributes remainder pixels across the first N columns so there's no gap.
 */
function columnWidths(count: number, availableWidth: number): number[] {
  const base = Math.floor(availableWidth / count)
  const remainder = availableWidth - base * count
  return Array.from({ length: count }, (_, i) => base + (i < remainder ? 1 : 0))
}

/**
 * A single ad card: full-width above the input ({@link SingleAdBanner}),
 * content-width when interspersed inside an assistant response
 * (BlocksRenderer), and in a row of columns on the landing screen
 * ({@link ChoiceAdBanner}). Manages its own hover state.
 *
 * Impressions are deduped per impUrl in the ads hook. A pinned card (dock,
 * landing screen) reports its impression on mount and on ad rotation. An
 * inline transcript card reports it only once its rows have stayed inside the
 * transcript viewport for the dwell (`useAdEngagement`'s `onSeen`), or on a
 * click, whichever comes first.
 *
 * The `link` variant is the one-line inline link ad (`inlineStyle: 'link'`,
 * placement `Inline-Link-After-Agent-CLI`): the copy underlined, then a dim
 * "Ad". It is measured, seen, yielded to and clicked exactly as the inline
 * card is; only the drawing differs.
 */
export const AdCard: React.FC<{
  ad: AdResponse
  width: number
  variant?: 'card' | 'inline' | 'link'
  onClick?: (ad: AdResponse) => void
  onImpression?: (ad: AdResponse) => void
}> = ({ ad, width, variant = 'card', onClick, onImpression }) => {
  const baseTheme = useTheme()
  const brand = greptileTerminalColors(ad)
  const theme = brand
    ? { ...baseTheme, foreground: brand.ink, muted: brand.ink, primary: brand.ink }
    : baseTheme
  const [isHovered, setIsHovered] = useState(false)

  // Both transcript variants: the card and the link.
  const isInline = variant === 'inline' || variant === 'link'
  useEffect(() => {
    if (isInline) return
    onImpression?.(ad)
  }, [ad, onImpression, isInline])
  // One ad on screen at a time: our own units read whether a card is drawn.
  useEffect(() => {
    if (!isInline) return
    const drawn = { impUrl: ad.impUrl, provider: ad.provider }
    // Its expiry clock starts at the first draw (`ad-expiry-clock.ts`).
    noteAdDrawn(ad.impUrl)
    reportInlineCardDrawn(drawn, true)
    return () => reportInlineCardDrawn(drawn, false)
  }, [ad.impUrl, ad.provider, isInline])

  // Laid out before the early return below, so the engagement hook can judge
  // truncation from exactly what is drawn.
  const inlineLayout =
    variant === 'inline' ? getInlineAdLayout(ad, width) : null
  if (inlineLayout) {
    inlineLayout.title = truncateToWidth(
      inlineLayout.title,
      Math.max(0, width - 8 - AD_REPORT_CONTROL_COLUMNS),
    )
  }
  // The link's text, fitted to the row beside its " Ad" and report control.
  const linkText =
    variant === 'link'
      ? inlineLinkText(
          ad,
          Math.min(
            CLI_INLINE_LINK_MAX_CHARS,
            width - INLINE_LINK_DISCLOSURE.length - AD_REPORT_CONTROL_COLUMNS,
          ),
        )
      : null
  const card = variant === 'card' ? getCardAdLayout(ad, width) : null
  if (card?.headline) {
    card.headline = truncateToWidth(
      card.headline,
      Math.max(0, width - 8 - AD_REPORT_CONTROL_COLUMNS),
    )
  }
  // An inline card scrolls with the transcript and is measured; the dock and
  // the landing screen's columns sit outside any scrollbox.
  const engagement = useAdEngagement(ad.impUrl, {
    placement: isInline ? 'measured' : 'pinned',
    truncated: linkText !== null
      ? layoutTruncated([
          [inlineLinkText(ad, Number.MAX_SAFE_INTEGER), linkText],
        ])
      : inlineLayout
      ? layoutTruncated([
          [
            (ad.title ?? '').trim() ||
              getAdDisplayLabel({ title: '', url: ad.url ?? '' }).text,
            inlineLayout.title,
          ],
          [ad.adText, inlineLayout.description],
        ])
      : card
        ? layoutTruncated([
            [ad.title, card.headline],
            [ad.adText, card.description],
          ])
        : undefined,
    ...(isInline
      ? {
          onSeen: () => onImpression?.(ad),
          // One ad on screen at a time: the dock gives way while this card
          // is in the transcript viewport.
          onVisibility: (visible: boolean | undefined) =>
            reportInlineCardVisibility(ad, visible),
        }
      : {}),
  })

  const buttonProps = {
    ref: engagement.ref,
    onClick: (event?: unknown) => {
      if (!ad.clickUrl) return
      engagement.onClick(event)
      // A click is proof the card was on screen: an inline card clicked
      // before its dwell elapsed reports its impression now (deduped).
      onImpression?.(ad)
      void openAdClick(ad, () => onClick?.(ad))
    },
    onMouseOver: () => {
      setIsHovered(true)
      engagement.onHover(true)
    },
    onMouseOut: () => {
      setIsHovered(false)
      engagement.onHover(false)
    },
  }

  if (linkText !== null) {
    return (
      <Button
        {...buttonProps}
        style={{
          width,
          height: 1,
          flexDirection: 'row',
          overflow: 'hidden',
        }}
      >
        <text
          style={{
            fg: isHovered ? theme.primary : theme.link,
            flexShrink: 1,
            wrapMode: 'none',
          }}
          attributes={TextAttributes.UNDERLINE}
        >
          {linkText}
        </text>
        <box style={{ flexDirection: 'row', flexShrink: 0 }}>
          <text
            style={{ fg: theme.muted, wrapMode: 'none' }}
            attributes={TextAttributes.DIM}
          >
            {INLINE_LINK_DISCLOSURE}
          </text>
          <AdReportButton ad={{ ...ad, surface: 'cli' }} color={theme.muted} />
        </box>
      </Button>
    )
  }

  if (inlineLayout) {
    const accentColor = isHovered ? theme.primary : theme.muted
    return (
      <Button
        {...buttonProps}
        style={{
          width,
          height: INLINE_AD_CARD_HEIGHT,
          backgroundColor: brand?.background,
          borderStyle: 'single',
          borderColor: accentColor,
          customBorderChars: BORDER_CHARS,
          paddingLeft: 1,
          paddingRight: 1,
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        <box
          style={{
            width: '100%',
            height: 1,
            flexDirection: 'row',
            justifyContent: 'space-between',
            overflow: 'hidden',
          }}
        >
          <text
            style={{
              fg: isHovered ? theme.primary : theme.foreground,
              flexShrink: 1,
              wrapMode: 'none',
            }}
            attributes={TextAttributes.BOLD}
          >
            {inlineLayout.title}
          </text>
          <box style={{ flexDirection: 'row', flexShrink: 0 }}>
            <text style={{ fg: theme.muted, wrapMode: 'none' }}>
              {INLINE_AD_DISCLOSURE}
            </text>
            <AdReportButton ad={{ ...ad, surface: 'cli' }} color={theme.muted} />
          </box>
        </box>
        <box
          style={{
            width: '100%',
            height: 1,
            flexDirection: 'row',
            justifyContent: 'space-between',
            columnGap: INLINE_AD_GAP,
            overflow: 'hidden',
          }}
        >
          <text style={{ fg: theme.muted, flexShrink: 1, wrapMode: 'none' }}>
            {inlineLayout.description}
          </text>
          {inlineLayout.label && (
            <text
              style={{
                fg: accentColor,
                flexShrink: 0,
                wrapMode: 'none',
              }}
              attributes={TextAttributes.UNDERLINE}
            >
              {inlineLayout.label + INLINE_AD_LINK_SUFFIX}
            </text>
          )}
        </box>
      </Button>
    )
  }

  if (!card) return null

  return (
    <Button
      {...buttonProps}
      style={{
        width,
        height: AD_CARD_HEIGHT,
        backgroundColor: brand?.background,
        borderStyle: 'single',
        borderColor: isHovered ? theme.primary : theme.muted,
        customBorderChars: BORDER_CHARS,
        paddingLeft: 1,
        paddingRight: 1,
        flexDirection: 'column',
      }}
    >
      {/* The disclosure rides whichever row is first, so it is never below the
          fold of a card whose body has shrunk to one line. */}
      {card.headline ? (
        <box
          style={{
            flexDirection: 'row',
            justifyContent: 'space-between',
            alignItems: 'flex-start',
            height: 1,
            overflow: 'hidden',
          }}
        >
          <text
            style={{
              fg: isHovered ? theme.primary : theme.foreground,
              flexShrink: 1,
              wrapMode: 'none',
            }}
            attributes={TextAttributes.BOLD}
          >
            {card.headline}
          </text>
          <box style={{ flexDirection: 'row', flexShrink: 0 }}>
            <text style={{ fg: theme.muted }}>{' Ad'}</text>
            <AdReportButton ad={{ ...ad, surface: 'cli' }} color={theme.muted} />
          </box>
        </box>
      ) : null}
      <box
        style={{
          flexDirection: 'row',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          height: card.descriptionLines,
          overflow: 'hidden',
        }}
      >
        <text style={{ fg: theme.muted, flexShrink: 1 }}>
          {card.description}
        </text>
        {card.headline ? null : (
          <box style={{ flexDirection: 'row', flexShrink: 0 }}>
            <text style={{ fg: theme.muted }}>{' Ad'}</text>
            <AdReportButton ad={{ ...ad, surface: 'cli' }} color={theme.muted} />
          </box>
        )}
      </box>
      <box style={{ flexGrow: 1 }} />
      {/* Bottom: CTA + domain */}
      <box
        style={{
          flexDirection: 'row',
          columnGap: 1,
          alignItems: 'center',
          height: 1,
          overflow: 'hidden',
        }}
      >
        <text
          style={{
            fg: brand?.background ?? INVERTED_CTA_FG,
            bg: isHovered ? theme.primary : theme.muted,
            attributes: TextAttributes.BOLD,
          }}
        >
          {` ${card.ctaText} `}
        </text>
        {card.labelText ? (
          <text
            style={{
              fg: theme.muted,
              wrapMode: 'none',
              attributes:
                card.labelVariant === 'domain'
                  ? TextAttributes.UNDERLINE
                  : TextAttributes.BOLD,
            }}
          >
            {card.labelText}
          </text>
        ) : null}
      </box>
    </Button>
  )
}

/**
 * The V2 resting dock (COD-457): `Sponsored · Brand` on the label row, headline
 * and description on the left, a bordered CTA box on the right.
 *
 * Still exactly {@link AD_CARD_HEIGHT} rows, because the landing screen
 * subtracts that from the model picker's budget. Below
 * `MIN_INLINE_WIDTH_WITH_DESTINATION` this delegates to {@link AdCard}
 * verbatim — narrow terminals keep the layout the house-ad width budget was
 * measured against, and expansion still works there.
 *
 * Nothing here depends on hover. Hover tints the border and inverts the CTA
 * box, exactly as the card always did; expansion is a click or the chord.
 */
export const DockAdCard: React.FC<{
  ad: AdResponse
  width: number
  expanded?: boolean
  chordHint?: string
  onToggle?: () => void
  onClick?: (ad: AdResponse, from: DockClickOrigin) => void
  onImpression?: (ad: AdResponse) => void
}> = ({
  ad,
  width,
  expanded = false,
  chordHint,
  onToggle,
  onClick,
  onImpression,
}) => {
  const baseTheme = useTheme()
  const brand = greptileTerminalColors(ad)
  const theme = brand
    ? { ...baseTheme, foreground: brand.ink, muted: brand.ink, primary: brand.ink }
    : baseTheme
  const [isHovered, setIsHovered] = useState(false)
  const [isCtaHovered, setIsCtaHovered] = useState(false)

  const layout = useMemo(
    () => getDockAdLayout(ad, width, { chordHint, collapsed: !expanded }),
    [ad, width, chordHint, expanded],
  )

  useEffect(() => {
    if (layout.mode !== 'dock') return
    onImpression?.(ad)
  }, [ad, onImpression, layout.mode])

  // The narrow fallback renders `AdCard`, which tracks itself.
  const engagement = useAdEngagement(ad.impUrl, {
    placement: 'pinned',
    enabled: layout.mode === 'dock',
    truncated:
      layout.mode === 'dock'
        ? layoutTruncated([
            [ad.title, layout.headline],
            [ad.adText, layout.description],
            [(ad.cta ?? '').trim() || 'Learn more', layout.ctaText],
          ])
        : undefined,
  })

  // Hover is read from the tint state: the children's over/out bubble to the
  // box and React batches an out-then-over into no change at all.
  const { onHover: reportHover } = engagement
  useEffect(() => {
    reportHover(isHovered)
  }, [isHovered, reportHover])

  if (layout.mode === 'card') {
    // The narrow fallback keeps today's card AND today's click semantics: the
    // whole card opens the landing page, and the dock's toggle is reached from
    // the chord instead. Two different meanings for one click at 40 columns
    // would be worse than no expansion affordance at all.
    return (
      <AdCard
        ad={ad}
        width={width}
        onClick={(clicked) => onClick?.(clicked, 'dock')}
        onImpression={onImpression}
      />
    )
  }

  const accentColor = isHovered ? theme.primary : theme.muted

  return (
    // A plain box, NOT a Button. The CTA used to be a Button nested inside the
    // dock's own Button, and OpenTUI mouse events propagate: one press on the
    // CTA opened the advertiser's URL *and* toggled the panel, recording a
    // false expansion. Rather than rely on stopping propagation through the
    // shared Button, the two clickable regions are siblings and never nest.
    // Hover still tints the whole border, because mouse events bubble UP to
    // this box from either child.
    <box
      onMouseOver={() => setIsHovered(true)}
      onMouseOut={() => setIsHovered(false)}
      style={{
        width,
        height: AD_CARD_HEIGHT,
        backgroundColor: brand?.background,
        borderStyle: 'single',
        borderColor: accentColor,
        customBorderChars: BORDER_CHARS,
        paddingLeft: 1,
        paddingRight: 1,
        flexDirection: 'row',
        overflow: 'hidden',
      }}
    >
      {/* The copy block is the toggle. */}
      <Button
        onClick={() => onToggle?.()}
        style={{
          width: layout.copyWidth,
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        <box
          style={{
            height: 1,
            flexDirection: 'row',
            justifyContent: 'space-between',
            overflow: 'hidden',
          }}
        >
          <box style={{ flexDirection: 'row', flexShrink: 1 }}>
            <text style={{ fg: theme.primary, wrapMode: 'none' }}>
              {layout.sponsored}
            </text>
            <text style={{ fg: theme.muted, wrapMode: 'none' }}>
              {DOCK_LABEL_SEPARATOR}
            </text>
            <text
              style={{
                fg: theme.foreground,
                flexShrink: 1,
                wrapMode: 'none',
                attributes:
                  layout.brandVariant === 'domain'
                    ? TextAttributes.UNDERLINE
                    : undefined,
              }}
            >
              {layout.brand}
            </text>
          </box>
          {layout.chordHint ? (
            <text style={{ fg: theme.muted, flexShrink: 0, wrapMode: 'none' }}>
              {layout.chordHint}
            </text>
          ) : null}
          <AdReportButton ad={{ ...ad, surface: 'cli' }} color={theme.muted} />
        </box>
        {layout.headline ? (
          <text
            style={{ fg: theme.foreground, height: 1, wrapMode: 'none' }}
            attributes={TextAttributes.BOLD}
          >
            {layout.headline}
          </text>
        ) : null}
        <text
          style={{ fg: theme.muted, height: layout.descriptionLines }}
        >
          {layout.description}
        </text>
      </Button>
      <box style={{ flexGrow: 1 }} />
      {/* A SIBLING of the toggle, never a child: the CTA opens the landing
          page and must not also expand the panel. */}
      <Button
        onClick={(event?: unknown) => {
          if (!ad.clickUrl) return
          engagement.onClick(event, 'cta')
          void openAdClick(ad, () => onClick?.(ad, 'dock'))
        }}
        onMouseOver={() => setIsCtaHovered(true)}
        onMouseOut={() => setIsCtaHovered(false)}
        style={{
          width: layout.ctaBoxWidth,
          height: 3,
          borderStyle: 'single',
          borderColor: theme.primary,
          customBorderChars: BORDER_CHARS,
          paddingLeft: 1,
          paddingRight: 1,
          flexShrink: 0,
        }}
      >
        <text
          style={{
            fg: isCtaHovered ? brand?.background ?? INVERTED_CTA_FG : theme.primary,
            bg: isCtaHovered ? theme.primary : undefined,
            wrapMode: 'none',
          }}
          attributes={TextAttributes.BOLD}
        >
          {layout.ctaText + INLINE_AD_LINK_SUFFIX}
        </text>
      </Button>
    </box>
  )
}

/**
 * The expanded detail panel (COD-457).
 *
 * Rendered IN FLOW directly above the dock rather than as an absolute overlay
 * — see the PR: nothing else in the CLI positions absolutely, and a panel that
 * mispaints over the transcript is worse than one that shortens it.
 *
 * Returns null when {@link getDockPanelLayout} says the smallest panel would
 * still not fit: a panel that covers the composer is never drawn.
 */
export const DockDetailPanel: React.FC<{
  ad: AdResponse
  width: number
  availableRows: number
  onClose: () => void
  onClick?: (ad: AdResponse, from: DockClickOrigin) => void
}> = ({ ad, width, availableRows, onClose, onClick }) => {
  const baseTheme = useTheme()
  const brand = greptileTerminalColors(ad)
  const theme = brand
    ? { ...baseTheme, foreground: brand.ink, muted: brand.ink, primary: brand.ink }
    : baseTheme
  const [isCtaHovered, setIsCtaHovered] = useState(false)
  const [isCloseHovered, setIsCloseHovered] = useState(false)

  const panel = useMemo(
    () => getDockPanelLayout(ad, { width, availableRows }),
    [ad, width, availableRows],
  )

  // A second drawn copy of the dock's impression: hovering or clicking the
  // panel is engagement with the same ad, on the same record.
  const engagement = useAdEngagement(ad.impUrl, {
    placement: 'pinned',
    enabled: panel.fits,
  })

  if (!panel.fits) return null

  const interiorWidth = Math.max(0, panel.width - 4)

  return (
    <box
      onMouseOver={() => engagement.onHover(true)}
      onMouseOut={() => engagement.onHover(false)}
      style={{
        width: panel.width,
        height: panel.height,
        backgroundColor: brand?.background,
        borderStyle: 'single',
        borderColor: theme.primary,
        customBorderChars: BORDER_CHARS,
        paddingLeft: 1,
        paddingRight: 1,
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      <box
        style={{
          height: 1,
          flexDirection: 'row',
          justifyContent: 'space-between',
          overflow: 'hidden',
        }}
      >
        <text
          style={{ fg: theme.primary, flexShrink: 1, wrapMode: 'none' }}
          attributes={TextAttributes.BOLD}
        >
          {panel.brand}
        </text>
        <box style={{ flexDirection: 'row', flexShrink: 0 }}>
          <text style={{ fg: theme.primary, wrapMode: 'none' }}>
            {DOCK_SPONSORED_LABEL}
          </text>
          <AdReportButton ad={{ ...ad, surface: 'cli' }} color={theme.muted} />
        </box>
      </box>
      <box style={{ height: 1 }} />
      <text
        style={{ fg: theme.foreground, height: 1, wrapMode: 'none' }}
        attributes={TextAttributes.BOLD}
      >
        {panel.headline}
      </text>
      {panel.bodyLines.map((line, index) => (
        <text
          key={`body-${index}`}
          style={{ fg: theme.muted, height: 1, wrapMode: 'none' }}
        >
          {line}
        </text>
      ))}
      {panel.diagram ? (
        <>
          <box style={{ height: 1 }} />
          <text style={{ fg: theme.muted, height: 1, wrapMode: 'none' }}>
            {panel.diagram}
          </text>
        </>
      ) : null}
      {panel.bullets.length > 0 ? (
        <>
          <box style={{ height: 1 }} />
          {panel.bullets.map((bullet, index) => (
            <text
              key={`bullet-${index}`}
              style={{ fg: theme.muted, height: 1, wrapMode: 'none' }}
            >
              {`• ${bullet}`}
            </text>
          ))}
        </>
      ) : null}
      <text style={{ fg: theme.muted, height: 1, wrapMode: 'none' }}>
        {'─'.repeat(interiorWidth)}
      </text>
      <box style={{ height: 1 }} />
      <box style={{ height: 3, flexDirection: 'row', overflow: 'hidden' }}>
        <Button
          onClick={(event?: unknown) => {
            if (!ad.clickUrl) return
            engagement.onClick(event, 'cta')
            void openAdClick(ad, () => onClick?.(ad, 'panel'))
          }}
          onMouseOver={() => setIsCtaHovered(true)}
          onMouseOut={() => setIsCtaHovered(false)}
          style={{
            height: 3,
            borderStyle: 'single',
            borderColor: theme.primary,
            customBorderChars: BORDER_CHARS,
            paddingLeft: 1,
            paddingRight: 1,
            flexShrink: 0,
          }}
        >
          <text
            style={{
              fg: isCtaHovered ? brand?.background ?? INVERTED_CTA_FG : theme.primary,
              bg: isCtaHovered ? theme.primary : undefined,
              wrapMode: 'none',
            }}
            attributes={TextAttributes.BOLD}
          >
            {panel.ctaText + INLINE_AD_LINK_SUFFIX}
          </text>
        </Button>
        <box style={{ flexGrow: 1 }} />
        <box style={{ flexDirection: 'column', flexShrink: 0 }}>
          <box style={{ height: 1 }} />
          <Button
            onClick={onClose}
            onMouseOver={() => setIsCloseHovered(true)}
            onMouseOut={() => setIsCloseHovered(false)}
            style={{ height: 1 }}
          >
            <text
              style={{
                fg: isCloseHovered ? theme.foreground : theme.muted,
                wrapMode: 'none',
              }}
            >
              {DOCK_CLOSE_LABEL}
            </text>
          </Button>
        </box>
      </box>
    </box>
  )
}

/** The panel's own close control. Exported so the tmux capture can assert it. */
export const DOCK_CLOSE_LABEL = '[ Close ]'

/**
 * Rows the composer and its surrounding chrome are never allowed to lose.
 *
 * The dock itself is {@link AD_CARD_HEIGHT}; the rest is the bordered input
 * box plus the hint row beneath it. Deliberately generous: overestimating
 * costs a bullet row, and underestimating covers the input box, which is the
 * one outcome the spec forbids outright.
 */
export const DOCK_COMPOSER_RESERVED_ROWS = AD_CARD_HEIGHT + 6

/**
 * Rows the dock keeps, blank, while it gives way to an end-of-answer card:
 * the collapsed dock's own height at every width and arm (the detail panel
 * collapses when the dock goes blank), so nothing above or below it moves
 * and a resize cannot leave it stale.
 */
export const DOCK_BLANK_ROWS = AD_CARD_HEIGHT

/** The dock's rows while it gives way: blank, its collapsed height. */
export const DockBlankRows: React.FC = () => (
  <box style={{ height: DOCK_BLANK_ROWS, flexShrink: 0 }} />
)

/**
 * How many rows the panel may occupy above the dock at this terminal height.
 *
 * Pure and tested, for the same reason the degradation ladder is: "never
 * covers the composer at 24 rows" cannot be seen in a snapshot of a tall
 * terminal.
 */
export function dockPanelRowBudget(terminalHeight: number): number {
  return Math.max(0, Math.floor(terminalHeight) - DOCK_COMPOSER_RESERVED_ROWS)
}

/**
 * The rotating ad pinned above the chat input box. Rerenders (and fires a new
 * impression) each time the hook rotates `ads[0]`.
 *
 * `arm` is the sticky CLI dock arm (COD-457). `control` renders the card
 * exactly as it did before this issue — same component, same props, same five
 * rows — so the control arm is byte-identical to today by construction rather
 * than by a test that could drift.
 */
export const SingleAdBanner: React.FC<{
  ad: AdResponse
  onClick?: (ad: AdResponse) => void
  onImpression?: (ad: AdResponse) => void
  arm?: CliDockArm
  expanded?: boolean
  chordHint?: string
  /** Rows the panel may occupy above the dock without covering the composer. */
  panelRows?: number
  onToggle?: () => void
  onDockClick?: (ad: AdResponse, from: DockClickOrigin) => void
  onClose?: () => void
}> = ({
  ad,
  onClick,
  onImpression,
  arm = 'control',
  expanded = false,
  chordHint,
  panelRows = 0,
  onToggle,
  onDockClick,
  onClose,
}) => {
  const { terminalWidth } = useTerminalDimensions()
  const width = terminalWidth - 2

  if (arm !== 'expandable') {
    return (
      <box style={{ marginLeft: 1, marginRight: 1 }}>
        <AdCard
          ad={ad}
          width={width}
          onClick={onClick}
          onImpression={onImpression}
        />
      </box>
    )
  }

  return (
    // `flexShrink: 0` is load-bearing, not decoration. Without it the panel is
    // the only flexible thing between a transcript that will not shrink and a
    // composer that must not, so a tall panel gets its bottom border clipped
    // and paints over the dock's label row. Measured at 80x24.
    <box
      style={{
        marginLeft: 1,
        marginRight: 1,
        flexDirection: 'column',
        flexShrink: 0,
      }}
    >
      {expanded ? (
        // Anchored to the dock's right edge, per the mockup.
        <box
          style={{
            flexDirection: 'row',
            justifyContent: 'flex-end',
            flexShrink: 0,
          }}
        >
          <DockDetailPanel
            ad={ad}
            width={Math.min(DOCK_PANEL_MAX_WIDTH, width)}
            availableRows={panelRows}
            onClose={() => onClose?.()}
            onClick={onDockClick}
          />
        </box>
      ) : null}
      <DockAdCard
        ad={ad}
        width={width}
        expanded={expanded}
        chordHint={chordHint}
        onToggle={onToggle}
        onClick={onDockClick}
        onImpression={onImpression}
      />
    </box>
  )
}

/**
 * Up to four ads shown in a row. Still used by the freebuff landing screen,
 * which intentionally fills the space with multiple ads.
 */
export const ChoiceAdBanner: React.FC<ChoiceAdBannerProps> = ({
  ads,
  placementIds,
  onClick,
  onImpression,
}) => {
  const { terminalWidth } = useTerminalDimensions()

  // Available width for cards (terminal minus left/right margin of 1 each)
  const colAvail = terminalWidth - 2

  // Only show as many ads as fit with a healthy minimum width; hide the rest
  const maxVisible =
    placementIds?.length ?? visibleWaitingRoomPlacementIds(terminalWidth).length
  const visibleAds = useMemo(() => {
    const requested = placementIds?.length
      ? orderedRequestedAds(ads, placementIds)
      : ads
    return requested.slice(0, maxVisible)
  }, [ads, maxVisible, placementIds])

  const widths = useMemo(
    () => columnWidths(visibleAds.length, colAvail),
    [visibleAds.length, colAvail],
  )

  return (
    <box
      style={{
        width: '100%',
        flexDirection: 'column',
      }}
    >
      {/* Card columns */}
      <box
        style={{
          marginLeft: 1,
          marginRight: 1,
          flexDirection: 'row',
        }}
      >
        {visibleAds.map((ad, i) => (
          <AdCard
            key={ad.impUrl}
            ad={ad}
            width={widths[i]}
            onClick={onClick}
            onImpression={onImpression}
          />
        ))}
      </box>
    </box>
  )
}

/** Preserve canonical request order and never mount a duplicate slot response. */
export function orderedRequestedAds(
  ads: AdResponse[],
  placementIds: readonly string[],
): AdResponse[] {
  return placementIds.flatMap((placementId) => {
    const ad = ads.find((candidate) => candidate.placementId === placementId)
    return ad ? [ad] : []
  })
}
