/**
 * `/deals`: the offer list behind the `cliStatusline` sponsor row (see
 * `components/display-ad-deals.tsx`).
 *
 *   /deals            print the offer cards
 *   /deals use <n>    open offer n in the browser (also `/deals <n>`)
 *   /deals off        hide the statusline row and the list for this session
 *   /deals on         bring them back
 *
 * MOCK, while the `cliStatusline` display-ad flag is on: `use <n>`, `off` and
 * `on` report analytics only (`ads/display-ads-telemetry.ts`): a click on
 * CLI-Deals, and a dismiss / restore of the CLI-Statusline row they hide.
 *
 * SERVED, flag off: available when the policy announced `CLI-Deals` (or
 * `CLI-Statusline`, for `off`/`on`) in `displayPlacementIds`. The list is the
 * one served `CLI-Deals` ad in position 1 (billed impression on insertion);
 * `use 1` on a card printed this session records the billed click and opens
 * its clickUrl, and on one not yet printed prints the list instead. `off`/`on` stay
 * local. Nothing announced, or no fill: "No deals are available."
 */
import {
  sponsorFor,
  sponsorsFor,
} from '@codebuff/common/ads/display-ads/sponsors'
import { createElement } from 'react'

import {
  CLI_DISPLAY_AD_PLACEMENT_IDS,
  cliDisplayAdEnabled,
} from '../ads/display-ads'
import { useDisplayAdsStore } from '../ads/display-ads-store'
import { trackCliDisplayAd } from '../ads/display-ads-telemetry'
import {
  announcedDisplayPlacements,
  getDisplayAd,
  recordServedDisplayClick,
  wasServedDisplayAdDrawn,
  type GetDisplayAd,
} from '../ads/served-display-ads'
import { DisplayAdDeals } from '../components/display-ad-deals'
import { safeOpen } from '../utils/open-url'

import type { ContentBlock } from '../types/chat'

export const DEALS_UNAVAILABLE = 'No deals are available.'
export const DEALS_HIDDEN =
  'Deals are hidden for this session. /deals on shows them again.'
export const DEALS_OFF =
  'Deals hidden for this session. /deals on shows them again.'
export const DEALS_ON = 'Deals are back on.'

export interface DealsCommandDeps {
  enabled?: boolean
  open?: (url: string) => unknown
  /** The served fetch (test seam). */
  getServed?: GetDisplayAd
  /** The display ids the policy announced (test seam). */
  announced?: () => Promise<readonly string[]>
}

type DealsResult = string | ContentBlock[]

/** What `/deals <args>` adds to the transcript: a line, or the cards. */
export async function handleDealsCommand(
  args: string,
  {
    enabled = cliDisplayAdEnabled('cliStatusline'),
    open = safeOpen,
    getServed = getDisplayAd,
    announced = announcedDisplayPlacements,
  }: DealsCommandDeps = {},
): Promise<DealsResult> {
  if (enabled) return handleMockDeals(args, enabled, open)
  return handleServedDeals(args, { open, getServed, announced })
}

async function handleServedDeals(
  args: string,
  {
    open,
    getServed,
    announced,
  }: Required<Pick<DealsCommandDeps, 'open' | 'getServed' | 'announced'>>,
): Promise<DealsResult> {
  const ids = await announced()
  const dealsLive = ids.includes(CLI_DISPLAY_AD_PLACEMENT_IDS.deals)
  const rowLive = ids.includes(CLI_DISPLAY_AD_PLACEMENT_IDS.cliStatusline)
  if (!dealsLive && !rowLive) return DEALS_UNAVAILABLE
  const store = useDisplayAdsStore.getState()
  const [verb = '', arg = ''] = args.trim().toLowerCase().split(/\s+/)
  // Hiding a served unit is local only: no billed dismiss exists for it.
  if (verb === 'off') {
    store.setStatuslineHidden(true)
    return DEALS_OFF
  }
  if (verb === 'on') {
    store.setStatuslineHidden(false)
    return DEALS_ON
  }
  if (store.statuslineHidden) return DEALS_HIDDEN
  if (!dealsLive) return DEALS_UNAVAILABLE
  const sponsor = await getServed(CLI_DISPLAY_AD_PLACEMENT_IDS.deals)
  if (!sponsor) return DEALS_UNAVAILABLE
  const pick = verb === 'use' ? arg : verb
  if (pick) {
    if (Number(pick) !== 1) return 'Usage: /deals, /deals use 1, /deals off'
    // Only a card already printed (its impression recorded on insertion) may
    // be clicked: the click acknowledges the view first, and an undrawn card
    // must never bill one. Otherwise print the list instead.
    if (wasServedDisplayAdDrawn(sponsor)) {
      recordServedDisplayClick(sponsor)
      void open(sponsor.url)
      return `Opening ${sponsor.domain} (sponsored) in your browser.`
    }
  }
  return [
    {
      type: 'html',
      render: () =>
        createElement(DisplayAdDeals, {
          sponsors: [sponsor],
          open,
          enabled: false,
        }),
    },
  ]
}

function handleMockDeals(
  args: string,
  enabled: boolean,
  open: (url: string) => unknown,
): DealsResult {
  const store = useDisplayAdsStore.getState()
  const [verb = '', arg = ''] = args.trim().toLowerCase().split(/\s+/)
  const row = sponsorFor('cliStatusline')
  if (verb === 'off') {
    if (row && !store.statuslineHidden)
      trackCliDisplayAd(
        {
          kind: 'dismiss',
          slot: 'cliStatusline',
          sponsorId: row.id,
          action: 'deals_off',
          scope: 'session',
        },
        enabled,
      )
    store.setStatuslineHidden(true)
    return DEALS_OFF
  }
  if (verb === 'on') {
    if (row && store.statuslineHidden)
      trackCliDisplayAd(
        {
          kind: 'restore',
          slot: 'cliStatusline',
          sponsorId: row.id,
          action: 'deals_on',
          scope: 'session',
        },
        enabled,
      )
    store.setStatuslineHidden(false)
    return DEALS_ON
  }
  if (store.statuslineHidden) return DEALS_HIDDEN
  const sponsors = sponsorsFor('deals')
  const pick = verb === 'use' ? arg : verb
  if (pick) {
    const n = Number(pick)
    const sponsor = Number.isInteger(n) ? sponsors[n - 1] : undefined
    if (!sponsor) {
      return `Usage: /deals, /deals use <1-${sponsors.length}>, /deals off`
    }
    trackCliDisplayAd(
      {
        kind: 'click',
        slot: 'deals',
        sponsorId: sponsor.id,
        action: 'deals_use',
        position: n,
      },
      enabled,
    )
    void open(sponsor.url)
    return `Opening ${sponsor.domain} (sponsored) in your browser.`
  }
  return [
    {
      type: 'html',
      render: () => createElement(DisplayAdDeals, { sponsors, open, enabled }),
    },
  ]
}
