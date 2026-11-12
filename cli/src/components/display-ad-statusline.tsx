/**
 * `cliStatusline`: the mock sponsor row at the bottom of the Freebuff footer.
 *
 * One full-width row in the sponsor's fill with its ink: an inverse
 * "Ad │ Name" chip (ink background, fill text), the tagline, a "/deals" hint
 * and × to hide it for this session (`/deals off` does the same). As the row
 * narrows it gives up the tagline, then the hint; the chip and × always draw.
 *
 * MOCK (the local `cliStatusline` flag): `sponsorFor('cliStatusline')` from
 * common's fixture; the impression (on insertion), the row click and × go to
 * analytics only (`ads/display-ads-telemetry.ts`).
 *
 * SERVED (flag off, `CLI-Statusline` in the policy's `displayPlacementIds`):
 * one served ad (`ads/served-display-ads.ts`) in the same row, billed
 * impression on insertion, billed click before opening its clickUrl. No fill
 * draws nothing. × stays local (this session only).
 */
import { sponsorFor } from '@codebuff/common/ads/display-ads/sponsors'
import { useRef } from 'react'

import { Button } from './button'
import {
  CLI_DISPLAY_AD_PLACEMENT_IDS,
  cliDisplayAdEnabled,
  cliSponsorColors,
} from '../ads/display-ads'
import { useNetworkAdOnScreen } from '../ads/ad-screen'
import { useDisplayAdsStore } from '../ads/display-ads-store'
import {
  trackCliDisplayAd,
  useCliDisplayAdImpression,
} from '../ads/display-ads-telemetry'
import {
  recordServedDisplayClick,
  useServedDisplayAd,
  useServedDisplayImpression,
  type GetDisplayAd,
} from '../ads/served-display-ads'
import { getSessionDisplayPlacementIds } from '../hooks/use-dock-panel'
import { useTheme } from '../hooks/use-theme'
import { safeOpen } from '../utils/open-url'

import type { CliSponsorColors } from '../ads/display-ads'
import type { DisplaySponsor } from '@codebuff/common/ads/display-ads/served'

export const DEALS_HINT = '/deals'

export function DisplayAdStatusline({
  placementId = CLI_DISPLAY_AD_PLACEMENT_IDS.cliStatusline,
  enabled = cliDisplayAdEnabled('cliStatusline'),
  getServed,
  open = safeOpen,
  dealsLive,
}: {
  /** Test seam: whether CLI-Deals is announced (else read off the policy). */
  dealsLive?: boolean
  placementId?: string
  /** Test seam; production reads the settings flag. */
  enabled?: boolean
  /** Test seam for the served fetch. */
  getServed?: GetDisplayAd
  open?: (url: string) => unknown
}) {
  const theme = useTheme()
  const userHidden = useDisplayAdsStore((s) => s.statuslineHidden)
  // One ad on screen at a time: our unit gives way (draws and requests
  // nothing) while an ad-network ad is on screen in the chat.
  const networkAdOnScreen = useNetworkAdOnScreen()
  const hidden = userHidden || networkAdOnScreen
  const setHidden = useDisplayAdsStore((s) => s.setStatuslineHidden)
  const mock = enabled ? sponsorFor('cliStatusline') : null
  // Inactive (flag on, or hidden) the served hook holds and asks nothing.
  const served = useServedDisplayAd(placementId, !enabled && !hidden, getServed)
  const shownMock = enabled && !hidden && Boolean(mock)
  useCliDisplayAdImpression('cliStatusline', mock?.id, shownMock)
  useServedDisplayImpression(served)
  const sponsor: DisplaySponsor | null = shownMock ? mock : served
  // A row once drawn keeps its one row, blank, while it gives way to an
  // ad-network ad, so the transcript above does not move each time the dock
  // changes supplier. Hiding it (×, /deals off) gives the row back.
  const drewRef = useRef(false)
  if (userHidden) drewRef.current = false
  if (!sponsor) {
    return networkAdOnScreen && drewRef.current ? (
      <box style={{ height: 1, flexShrink: 0 }} />
    ) : null
  }
  drewRef.current = true
  return (
    <DisplayAdStatuslineView
      sponsor={sponsor}
      colors={cliSponsorColors(sponsor.theme, theme)}
      placementId={placementId}
      // The hint points at /deals: a served row shows it only when CLI-Deals
      // is served too, else /deals would answer "No deals are available."
      showDealsHint={
        shownMock ||
        (dealsLive ??
          (getSessionDisplayPlacementIds() ?? []).includes(
            CLI_DISPLAY_AD_PLACEMENT_IDS.deals,
          ))
      }
      onOpen={() => {
        if (served) recordServedDisplayClick(served)
        else if (mock)
          trackCliDisplayAd(
            {
              slot: 'cliStatusline',
              sponsorId: mock.id,
              kind: 'click',
              action: 'row',
            },
            enabled,
          )
        void open(sponsor.url)
      }}
      onHide={() => {
        if (mock)
          trackCliDisplayAd(
            {
              slot: 'cliStatusline',
              sponsorId: mock.id,
              kind: 'dismiss',
              action: 'hide_button',
              scope: 'session',
            },
            enabled,
          )
        setHidden(true)
      }}
    />
  )
}

export function DisplayAdStatuslineView({
  sponsor,
  colors,
  placementId,
  showDealsHint = true,
  onOpen,
  onHide,
}: {
  showDealsHint?: boolean
  sponsor: DisplaySponsor
  colors: CliSponsorColors
  placementId: string
  onOpen: () => void
  onHide: () => void
}) {
  return (
    <box
      id={placementId}
      style={{
        width: '100%',
        height: 1,
        flexDirection: 'row',
        justifyContent: 'space-between',
        backgroundColor: colors.fill,
        overflow: 'hidden',
      }}
    >
      <Button
        onClick={onOpen}
        style={{ flexDirection: 'row', flexShrink: 1, overflow: 'hidden' }}
      >
        <text style={{ wrapMode: 'none', flexShrink: 0 }}>
          <span bg={colors.ink} fg={colors.fill}>
            <b>{` Ad │ ${sponsor.name} `}</b>
          </span>
        </text>
        <text style={{ fg: colors.ink, wrapMode: 'none', flexShrink: 1 }}>
          {` ${sponsor.copy.tagline}`}
        </text>
      </Button>
      <box style={{ flexDirection: 'row', flexShrink: 0 }}>
        {showDealsHint && (
          <text style={{ fg: colors.ink, wrapMode: 'none' }}>
            <b>{` ${DEALS_HINT} `}</b>
          </text>
        )}
        <Button onClick={onHide} style={{ paddingLeft: 1, paddingRight: 1 }}>
          <text style={{ fg: colors.ink, wrapMode: 'none' }}>×</text>
        </Button>
      </box>
    </box>
  )
}
