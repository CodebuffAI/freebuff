/**
 * The offer cards `/deals` prints into the transcript (slot `deals`, flagged
 * with `cliStatusline`).
 *
 * Each card is a sponsor-colour header band (number, lettermark, bold name,
 * "Sponsored") over a tinted body line with a filled "Open ↗" chip, one blank
 * row between cards and around the list, then the usage hint.
 *
 * MOCK (`sponsorsFor('deals')` from common's fixture): each card's
 * impression (on insertion, with its 1-based position) and clicks go to
 * analytics only (`ads/display-ads-telemetry.ts`).
 *
 * SERVED (`/deals` passes the one served `CLI-Deals` ad, position 1, no mocks
 * mixed in): billed impression on insertion, billed click before opening its
 * clickUrl (`ads/served-display-ads.ts`).
 */
import { sponsorsFor } from '@codebuff/common/ads/display-ads/sponsors'

import { Button } from './button'
import {
  CLI_DISPLAY_AD_PLACEMENT_IDS,
  cliDisplayAdEnabled,
  cliSponsorColors,
} from '../ads/display-ads'
import {
  trackCliDisplayAd,
  useCliDisplayAdImpression,
} from '../ads/display-ads-telemetry'
import {
  isCliServedSponsor,
  recordServedDisplayClick,
  useServedDisplayImpression,
  type CliDisplaySponsor,
  type CliServedSponsor,
} from '../ads/served-display-ads'
import { useTerminalDimensions } from '../hooks/use-terminal-dimensions'
import { useTheme } from '../hooks/use-theme'
import { safeOpen } from '../utils/open-url'

import type { PlacedSponsor } from '@codebuff/common/ads/display-ads/sponsors'

export const DEALS_FOOTER_HINT = '/deals use 1   /deals off'

const MAX_CARD_WIDTH = 72

export function DisplayAdDeals({
  sponsors = sponsorsFor('deals'),
  placementId = CLI_DISPLAY_AD_PLACEMENT_IDS.deals,
  open = safeOpen,
  enabled = cliDisplayAdEnabled('cliStatusline'),
}: {
  sponsors?: CliDisplaySponsor[]
  placementId?: string
  open?: (url: string) => unknown
  /** The flag `/deals` printed this under; false sends no analytics. */
  enabled?: boolean
}) {
  const theme = useTheme()
  const { terminalWidth } = useTerminalDimensions()
  const width = Math.max(24, Math.min(MAX_CARD_WIDTH, terminalWidth - 6))
  return (
    <box
      id={placementId}
      style={{ flexDirection: 'column', marginTop: 1, marginBottom: 1, gap: 1 }}
    >
      {sponsors.map((sponsor, i) => {
        const colors = cliSponsorColors(sponsor.theme, theme)
        const onOpen = (action: 'header' | 'cta') => {
          if (isCliServedSponsor(sponsor)) recordServedDisplayClick(sponsor)
          else
            trackCliDisplayAd(
              { kind: 'click', slot: 'deals', sponsorId: sponsor.id, action, position: i + 1 },
              enabled,
            )
          void open(sponsor.url)
        }
        return (
          <box key={sponsor.id} style={{ width, flexDirection: 'column' }}>
            {isCliServedSponsor(sponsor) ? (
              <ServedDealImpression sponsor={sponsor} />
            ) : (
              <DealImpression sponsor={sponsor} position={i + 1} enabled={enabled} />
            )}
            <Button
              onClick={() => onOpen('header')}
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
                {`${i + 1}  `}
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
                width: '100%',
                paddingLeft: 1,
                paddingRight: 1,
                flexDirection: 'row',
                justifyContent: 'space-between',
                backgroundColor: colors.tint,
              }}
            >
              <text
                style={{ fg: colors.tintText, wrapMode: 'word', flexShrink: 1 }}
              >
                <b>{sponsor.copy.headline}</b>
                <span fg={colors.tintMuted}>{`  ${sponsor.domain}`}</span>
              </text>
              <Button
                onClick={() => onOpen('cta')}
                style={{ flexShrink: 0, paddingLeft: 1 }}
              >
                <text style={{ wrapMode: 'none' }}>
                  <span bg={colors.fill} fg={colors.ink}>
                    <b>{' Open ↗ '}</b>
                  </span>
                </text>
              </Button>
            </box>
          </box>
        )
      })}
      <text style={{ fg: theme.muted, wrapMode: 'none' }}>
        {DEALS_FOOTER_HINT}
      </text>
    </box>
  )
}

/** Renders nothing; the billed impression of a served card, on insertion. */
function ServedDealImpression({
  sponsor,
}: {
  sponsor: CliServedSponsor
}) {
  useServedDisplayImpression(sponsor)
  return null
}

/** Renders nothing; reports one card's impression when the list is inserted. */
function DealImpression({
  sponsor,
  position,
  enabled,
}: {
  sponsor: PlacedSponsor
  position: number
  enabled: boolean
}) {
  useCliDisplayAdImpression('deals', sponsor.id, enabled, position)
  return null
}
