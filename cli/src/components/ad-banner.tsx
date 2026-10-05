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
import { safeOpen } from '../utils/open-url'
import React, { useState, useMemo, useEffect } from 'react'

import { layoutTruncated } from '../ads/ad-engagement'
import { useAdEngagement } from '../ads/use-ad-engagement'

import { Button } from './button'
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
 * ({@link ChoiceAdBanner}). Manages its own hover state and
 * fires its impression on mount and on ad rotation (deduped per impUrl in the
 * ads hook, so remounts and scroll churn don't double-count).
 */
export const AdCard: React.FC<{
  ad: AdResponse
  width: number
  variant?: 'card' | 'inline'
  onClick?: (ad: AdResponse) => void
  onImpression?: (ad: AdResponse) => void
}> = ({ ad, width, variant = 'card', onClick, onImpression }) => {
  const theme = useTheme()
  const [isHovered, setIsHovered] = useState(false)

  useEffect(() => {
    onImpression?.(ad)
  }, [ad, onImpression])

  // Laid out before the early return below, so the engagement hook can judge
  // truncation from exactly what is drawn.
  const inlineLayout =
    variant === 'inline' ? getInlineAdLayout(ad, width) : null
  const card = variant === 'inline' ? null : getCardAdLayout(ad, width)
  // An inline card scrolls with the transcript and is measured; the dock and
  // the landing screen's columns sit outside any scrollbox.
  const engagement = useAdEngagement(ad.impUrl, {
    placement: variant === 'inline' ? 'measured' : 'pinned',
    truncated: inlineLayout
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
  })

  const buttonProps = {
    ref: engagement.ref,
    onClick: (event?: unknown) => {
      if (!ad.clickUrl) return
      engagement.onClick(event)
      onClick?.(ad)
      safeOpen(ad.clickUrl)
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

  if (inlineLayout) {
    const accentColor = isHovered ? theme.primary : theme.muted
    return (
      <Button
        {...buttonProps}
        style={{
          width,
          height: INLINE_AD_CARD_HEIGHT,
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
          <text style={{ fg: theme.muted, flexShrink: 0, wrapMode: 'none' }}>
            {INLINE_AD_DISCLOSURE}
          </text>
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
          <text style={{ fg: theme.muted, flexShrink: 0 }}>{'  Ad'}</text>
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
          <text style={{ fg: theme.muted, flexShrink: 0 }}>{'  Ad'}</text>
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
            fg: INVERTED_CTA_FG,
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
  const theme = useTheme()
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
          onClick?.(ad, 'dock')
          safeOpen(ad.clickUrl)
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
            fg: isCtaHovered ? INVERTED_CTA_FG : theme.primary,
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
  const theme = useTheme()
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
        <text style={{ fg: theme.primary, flexShrink: 0, wrapMode: 'none' }}>
          {DOCK_SPONSORED_LABEL}
        </text>
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
            onClick?.(ad, 'panel')
            safeOpen(ad.clickUrl)
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
              fg: isCtaHovered ? INVERTED_CTA_FG : theme.primary,
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
