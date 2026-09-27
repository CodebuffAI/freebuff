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
 * - A TERMINAL THAT CANNOT DRAW THEM DRAWS OURS. Apple Terminal has no
 *   truecolor, so a hex fill there is not "slightly off", it is wrong; the
 *   row falls back to the theme's own surface rather than lying about a
 *   brand.
 */
import {
  getPartnerLineLayout,
  isValidBrandHex,
  PARTNER_LINE_GAP,
} from '@codebuff/common/ads/inline-ad-layout'
import React, { useEffect, useState } from 'react'

import { Button } from './button'
import { useTerminalDimensions } from '../hooks/use-terminal-dimensions'
import { useTheme } from '../hooks/use-theme'
import {
  getPartnerAd,
  recordPartnerClick,
  recordPartnerImpression,
} from '../ads/partner-ads'
import { safeOpen } from '../utils/open-url'
import { supportsTruecolor } from '../utils/theme-system'

import type { AdResponse } from '../hooks/use-gravity-ad'

/**
 * Fetch the held answer for one partner slot.
 *
 * Mounting is what asks, and the module behind `getPartnerAd` holds one
 * answer per placement for half an hour -- so a slash menu opened ten times
 * is one auction and one impression, and a slot with no fill is not asked
 * again on the next keystroke.
 */
export function usePartnerAd(
  placementId: string,
  enabled: boolean,
): AdResponse | null {
  const [ad, setAd] = useState<AdResponse | null>(null)

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    void getPartnerAd(placementId)
      .then((result) => {
        if (!cancelled) setAd(result)
      })
      .catch(() => {
        // An ad that could not be fetched is an ad that is not there. There is
        // no error state to draw inside a row of product chrome.
      })
    return () => {
      cancelled = true
    }
  }, [enabled, placementId])

  useEffect(() => {
    if (ad) recordPartnerImpression(ad)
  }, [ad])

  return enabled ? ad : null
}

/**
 * The row itself, with no fetching in it.
 *
 * Split out so the layout can be rendered from a known creative in a test
 * without a policy, a token or a network -- and so the one interesting
 * question about this format (is the disclosure legible on that fill?) is
 * answerable from a pure input.
 */
export const PartnerAdLineView: React.FC<{
  ad: Pick<AdResponse, 'title' | 'url' | 'brandColor' | 'brandInk'>
  /**
   * The COLUMNS the row will occupy, for truncation. The box itself is always
   * `100%` of its parent: the row sits inside the slash menu, whose own rows
   * are full-width, and a numeric width there would draw a fill one column
   * short of the highlight above it.
   */
  width: number
  onClick?: () => void
}> = ({ ad, width, onClick }) => {
  const theme = useTheme()
  const layout = getPartnerLineLayout(ad, width)
  // A hex fill is drawn only where a hex fill is a colour. Everywhere else
  // the row keeps its shape and takes the theme's raised surface: the ad is
  // still disclosed, still clickable and still where the advertiser bought
  // it, just not in a colour we would be inventing.
  const branded =
    supportsTruecolor() &&
    isValidBrandHex(ad.brandColor) &&
    isValidBrandHex(ad.brandInk)
  const background = branded ? ad.brandColor : theme.surface
  const ink = branded ? ad.brandInk : theme.foreground

  return (
    <Button
      onClick={onClick}
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
      <text style={{ fg: ink, flexShrink: 1, wrapMode: 'none' }}>
        {layout.title}
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
 * A partner row, fetched.
 *
 * Renders nothing until a fill arrives, and nothing ever if none does: a
 * partner slot with no fill is not a gap to fill with something else, it is a
 * row of product chrome that simply is not there.
 */
export const PartnerAdLine: React.FC<{
  placementId: string
  /**
   * Whether this slot may be requested at all right now — ads on for this
   * session, and whatever the caller's own trigger is (a draft about pull
   * requests, the `/review` command being on screen).
   */
  enabled?: boolean
  /**
   * Columns the row will occupy. Defaults to `SingleAdBanner`'s budget, since
   * the composer slot sits directly under that card and has to line up with
   * it; the slash menu passes its own narrower one.
   */
  width?: number
}> = ({ placementId, enabled = true, width }) => {
  const { terminalWidth } = useTerminalDimensions()
  const ad = usePartnerAd(placementId, enabled)
  if (!ad) return null
  return (
    <PartnerAdLineView
      ad={ad}
      width={width ?? Math.max(10, terminalWidth - 2)}
      onClick={() => {
        if (!ad.clickUrl) return
        // The report beside the link, never awaited: a click that waited on
        // our own telemetry before opening the browser would be slower than
        // the ad is worth.
        recordPartnerClick(ad)
        safeOpen(ad.clickUrl)
      }}
    />
  )
}
