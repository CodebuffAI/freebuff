/**
 * `cliSplash`: the mock sponsor block under the launch header box.
 *
 * Boxed (the default): a 1px sponsor-colour border round an inverse band
 * (lettermark, bold name, "Sponsored") over a tinted body with the headline,
 * the body line, a filled "domain ↗" chip and "hide for today". The one-line
 * variant is an inverse "Sponsored │ Name" chip, the tagline and the domain,
 * for short terminals. Both carry the one disclosure and a hide control.
 * The header's own bottom margin spaces the block from the transcript.
 *
 * MOCK (the local `cliSplash` flag): `sponsorFor('cliSplash')` from common's
 * fixture, nothing fetched or billed; the impression (on insertion), the CTA
 * and "hide for today" go to analytics only (`ads/display-ads-telemetry.ts`).
 *
 * SERVED (flag off, `CLI-Splash` in the policy's `displayPlacementIds`): one
 * served ad (`ads/served-display-ads.ts`) drawn through the same views, with
 * the billed impression on insertion and the billed click before opening its
 * clickUrl. No fill draws nothing. "Hide for today" stays local.
 */
import { sponsorFor } from '@codebuff/common/ads/display-ads/sponsors'
import { TextAttributes } from '@opentui/core'

import { Button } from './button'
import { useNetworkAdOnScreen } from '../ads/ad-screen'
import {
  CLI_DISPLAY_AD_PLACEMENT_IDS,
  cliDisplayAdEnabled,
  cliSponsorColors,
} from '../ads/display-ads'
import {
  useDisplayAdsStore,
  useSplashHiddenToday,
} from '../ads/display-ads-store'
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
import { useTheme } from '../hooks/use-theme'
import { safeOpen } from '../utils/open-url'

import type { CliSponsorColors } from '../ads/display-ads'
import type { DisplaySponsor } from '@codebuff/common/ads/display-ads/served'

export type DisplayAdSplashVariant = 'boxed' | 'line'

/** Rows below which the launch header gets the one-line variant. */
export const SPLASH_BOXED_MIN_ROWS = 28

export function displayAdSplashVariant(
  terminalHeight: number,
): DisplayAdSplashVariant {
  return terminalHeight < SPLASH_BOXED_MIN_ROWS ? 'line' : 'boxed'
}

/** The flagged or served, not-hidden-today block; renders nothing otherwise. */
export function DisplayAdSplash({
  width,
  variant,
  placementId = CLI_DISPLAY_AD_PLACEMENT_IDS.cliSplash,
  enabled = cliDisplayAdEnabled('cliSplash'),
  getServed,
  open = safeOpen,
}: {
  width: number
  variant: DisplayAdSplashVariant
  placementId?: string
  /** Test seam; production reads the settings flag. */
  enabled?: boolean
  /** Test seam for the served fetch. */
  getServed?: GetDisplayAd
  open?: (url: string) => unknown
}) {
  const theme = useTheme()
  const userHidden = useSplashHiddenToday()
  // One ad on screen at a time: our unit gives way (draws and requests
  // nothing) while an ad-network ad is on screen in the chat.
  const networkAdOnScreen = useNetworkAdOnScreen()
  const hidden = userHidden || networkAdOnScreen
  const hide = useDisplayAdsStore((s) => s.hideSplashForToday)
  const mock = enabled ? sponsorFor('cliSplash') : null
  const served = useServedDisplayAd(placementId, !enabled && !hidden, getServed)
  const shownMock = enabled && !hidden && Boolean(mock)
  useCliDisplayAdImpression('cliSplash', mock?.id, shownMock)
  // Inactive (flag on, or hidden today) the served hook holds and asks nothing.
  useServedDisplayImpression(served)
  const sponsor: DisplaySponsor | null = shownMock ? mock : served
  if (!sponsor) return null
  const colors = cliSponsorColors(sponsor.theme, theme)
  const onOpen = () => {
    if (served) recordServedDisplayClick(served)
    else if (mock)
      trackCliDisplayAd(
        { slot: 'cliSplash', sponsorId: mock.id, kind: 'click', action: 'cta' },
        enabled,
      )
    void open(sponsor.url)
  }
  const onHide = () => {
    if (mock)
      trackCliDisplayAd(
        {
          slot: 'cliSplash',
          sponsorId: mock.id,
          kind: 'dismiss',
          action: 'hide_button',
          scope: 'day',
        },
        enabled,
      )
    hide()
  }
  return variant === 'line' ? (
    <DisplayAdSplashLine
      sponsor={sponsor}
      colors={colors}
      width={width}
      placementId={placementId}
      muted={theme.muted}
      onOpen={onOpen}
      onHide={onHide}
    />
  ) : (
    <DisplayAdSplashBoxed
      sponsor={sponsor}
      colors={colors}
      width={width}
      placementId={placementId}
      onOpen={onOpen}
      onHide={onHide}
    />
  )
}

interface ViewProps {
  sponsor: DisplaySponsor
  colors: CliSponsorColors
  width: number
  placementId: string
  onOpen: () => void
  onHide: () => void
}

export function DisplayAdSplashBoxed({
  sponsor,
  colors,
  width,
  placementId,
  onOpen,
  onHide,
}: ViewProps) {
  return (
    <box
      id={placementId}
      style={{
        width,
        marginTop: 1,
        border: true,
        borderColor: colors.border,
        flexDirection: 'column',
        backgroundColor: colors.tint,
      }}
    >
      <Button
        onClick={onOpen}
        style={{
          width: '100%',
          height: 1,
          paddingLeft: 1,
          paddingRight: 1,
          flexDirection: 'row',
          justifyContent: 'space-between',
          backgroundColor: colors.fill,
        }}
      >
        <text style={{ fg: colors.ink, wrapMode: 'none', flexShrink: 1 }}>
          <span bg={colors.ink} fg={colors.fill}>
            <b>{` ${sponsor.lettermark} `}</b>
          </span>
          <b>{` ${sponsor.name}`}</b>
        </text>
        <text style={{ fg: colors.ink, wrapMode: 'none', flexShrink: 0 }}>
          Sponsored
        </text>
      </Button>
      <box
        style={{
          flexDirection: 'column',
          paddingLeft: 1,
          paddingRight: 1,
          paddingTop: 1,
        }}
      >
        <text
          style={{ fg: colors.tintText, wrapMode: 'word' }}
          attributes={TextAttributes.BOLD}
        >
          {sponsor.copy.headline}
        </text>
        <text style={{ fg: colors.tintMuted, wrapMode: 'word' }}>
          {sponsor.copy.body}
        </text>
        <box
          style={{
            flexDirection: 'row',
            justifyContent: 'space-between',
            marginTop: 1,
          }}
        >
          <Button onClick={onOpen} style={{ flexShrink: 0 }}>
            <text style={{ wrapMode: 'none' }}>
              <span bg={colors.fill} fg={colors.ink}>
                <b>{` ${sponsor.domain} ↗ `}</b>
              </span>
            </text>
          </Button>
          <Button onClick={onHide} style={{ flexShrink: 0 }}>
            <text style={{ fg: colors.tintMuted, wrapMode: 'none' }}>
              hide for today
            </text>
          </Button>
        </box>
      </box>
    </box>
  )
}

export function DisplayAdSplashLine({
  sponsor,
  colors,
  width,
  placementId,
  muted,
  onOpen,
  onHide,
}: ViewProps & { muted: CliSponsorColors['tintMuted'] }) {
  return (
    <box
      id={placementId}
      style={{
        width,
        height: 1,
        marginTop: 1,
        flexDirection: 'row',
        justifyContent: 'space-between',
        overflow: 'hidden',
      }}
    >
      <Button
        onClick={onOpen}
        style={{ flexDirection: 'row', flexShrink: 1, overflow: 'hidden' }}
      >
        <text style={{ wrapMode: 'none', flexShrink: 0 }}>
          <span bg={colors.fill} fg={colors.ink}>
            <b>{` Sponsored │ ${sponsor.name} `}</b>
          </span>
        </text>
        <text style={{ fg: colors.tintText, wrapMode: 'none', flexShrink: 1 }}>
          {` ${sponsor.copy.tagline}`}
        </text>
        <text style={{ fg: colors.fill, wrapMode: 'none', flexShrink: 0 }}>
          {` ${sponsor.domain} ↗`}
        </text>
      </Button>
      <Button onClick={onHide} style={{ flexShrink: 0, paddingLeft: 1 }}>
        <text style={{ fg: muted, wrapMode: 'none' }}>hide for today</text>
      </Button>
    </box>
  )
}
