/**
 * A PARTNER placement drawn in a terminal: one row, the advertiser's colour.
 *
 * Desktop draws this deal as a pill with the advertiser's logo in it. A
 * terminal has no images, no rounded corners and no gradients, so the row is
 * the only thing left that reads as "a piece of the product wearing somebody
 * else's brand": their fill, their ink, their headline, their domain, and the
 * disclosure.
 *
 * THREE THINGS THIS FILE IS RESPONSIBLE FOR, and they are all about honesty:
 *
 * - THE DISCLOSURE IS NOT CONDITIONAL. It is drawn at every width, and the
 *   layout gives up the domain before it gives up the word "Ad". A line of
 *   somebody's brand colour inside our chrome with no label on it is the one
 *   state this format may never have.
 * - THE COLOURS COME FROM THE REVIEWED CREATIVE, never from a table here. A
 *   rebrand, or a second partner, must not need a CLI release.
 * - Greptile uses an indexed green on terminals without truecolor. Other
 *   partner deals retain their existing theme fallback.
 */
import {
  getPartnerLineLayout,
  isValidBrandHex,
  PARTNER_LINE_GAP,
} from '@codebuff/common/ads/inline-ad-layout'
import { TextAttributes } from '@opentui/core'
import { greptileTerminalColors } from '../ads/partner-brand'
import React, { useEffect, useImperativeHandle, type Ref } from 'react'

import { Button } from './button'
import { useTheme } from '../hooks/use-theme'
import { layoutTruncated } from '../ads/ad-engagement'
import {
  recordPartnerClick,
  recordPartnerImpression,
} from '../ads/partner-ads'
import { useAdEngagement } from '../ads/use-ad-engagement'
import { safeOpen } from '../utils/open-url'
import { supportsTruecolor } from '../utils/theme-system'

import type { AdResponse } from '../hooks/use-gravity-ad'

/**
 * The row itself, with no fetching in it.
 *
 * Split out so the layout can be rendered from a known creative in a test
 * without a policy, a token or a network -- and so the one interesting
 * question about this format (is the disclosure legible on that fill?) is
 * answerable from a pure input.
 */
export const PartnerAdLineView: React.FC<{
  ad: Pick<AdResponse, 'title' | 'url' | 'brandColor' | 'brandInk' | 'partnerBrand'>
  /**
   * The COLUMNS the row will occupy, for truncation. The box itself is always
   * `100%` of its parent: the row sits inside the slash menu, whose own rows
   * are full-width, and a numeric width there would draw a fill one column
   * short of the highlight above it.
   */
  width: number
  /** The mouse-up event, when there was one (modifiers for engagement). */
  onClick?: (event?: unknown) => void
  onHover?: (hovering: boolean) => void
  selected?: boolean
}> = ({ ad, width, onClick, onHover, selected = false }) => {
  const theme = useTheme()
  const layout = getPartnerLineLayout(ad, width - (selected ? 2 : 0))
  const greptile = greptileTerminalColors(ad)
  const branded =
    supportsTruecolor() &&
    isValidBrandHex(ad.brandColor) &&
    isValidBrandHex(ad.brandInk)
  const background = greptile?.background ?? (branded ? ad.brandColor : theme.surface)
  const ink = greptile?.ink ?? (branded ? ad.brandInk : theme.foreground)

  return (
    <Button
      onClick={onClick}
      onMouseOver={onHover ? () => onHover(true) : undefined}
      onMouseOut={onHover ? () => onHover(false) : undefined}
      style={{
        width: '100%',
        height: 1,
        paddingLeft: 1,
        paddingRight: 1,
        flexDirection: 'row',
        justifyContent: 'space-between',
        backgroundColor: background,
        overflow: 'hidden',
      }}
    >
      <text style={{ fg: ink, flexShrink: 1, wrapMode: 'none' }}
        attributes={(greptile ? TextAttributes.BOLD : 0) | (selected ? TextAttributes.UNDERLINE : 0)}>
        {selected ? '› ' : ''}{layout.title}
        {layout.label ? (
          <span>{`${' '.repeat(PARTNER_LINE_GAP)}${layout.label}`}</span>
        ) : null}
      </text>
      {/* `theme.muted` is set against OUR surfaces and vanishes on an
          arbitrary brand fill, so the disclosure inherits the advertiser's own
          ink. It is the one part of this row that may never be hard to read. */}
      <text style={{ fg: ink, flexShrink: 0, wrapMode: 'none' }}>
        {layout.disclosure}
      </text>
    </Button>
  )
}

/**
 * A served partner fill, drawn and measured.
 *
 * COD-757 engagement, like every other CLI ad. Both partner rows sit outside
 * the transcript (above the composer, inside the slash menu), so they are on
 * screen for exactly as long as they are mounted. The row remounts against
 * the same held fill on every menu open: the registry keeps one record per
 * impression, and a click on a later redraw still reaches it as a click-only
 * merge record.
 */
export const PartnerAdRow: React.FC<{
  ad: AdResponse
  width: number
  selected?: boolean
  activateRef?: Ref<() => void>
  /** Test seams; production reports through the one CLI click path. */
  reportClick?: (ad: AdResponse) => void
  open?: (url: string) => void
}> = ({ ad, width, selected, activateRef, reportClick = recordPartnerClick, open = safeOpen }) => {
  const engagement = useAdEngagement(ad.impUrl, {
    placement: 'pinned',
    truncated: layoutTruncated([
      [ad.title, getPartnerLineLayout(ad, width).title],
    ]),
  })
  useEffect(() => { recordPartnerImpression(ad) }, [ad])
  const activate = (event?: unknown) => {
    if (!ad.clickUrl) return
    engagement.onClick(event)
    reportClick(ad)
    open(ad.clickUrl)
  }
  // Keyboard and mouse use the same activation, including engagement/billing.
  useImperativeHandle(activateRef, () => activate)
  return (
    <PartnerAdLineView
      ad={ad}
      width={width}
      selected={selected}
      onHover={engagement.onHover}
      onClick={activate}
    />
  )
}
