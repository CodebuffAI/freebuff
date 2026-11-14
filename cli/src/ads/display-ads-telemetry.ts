/**
 * Analytics for the CLI's mock display-ad units (`CLI-Splash`,
 * `CLI-Statusline`, `CLI-Deals`); event names and fields are common's
 * `ads/display-ads/telemetry.ts`.
 *
 * ANALYTICS ONLY, through the CLI's ordinary `trackEvent` (PostHog + the Axiom
 * mirror). No ad was served, so this never calls `/api/v1/ads/impression` or
 * `/api/v1/ads/click` and never writes a ledger row; every event carries
 * `mock_creative: true` and `billable: false`. Impressions are on insertion
 * (`viewability: 'insertion'`): a terminal has no viewport, the same rule the
 * CLI's served ads use.
 *
 * Fires only while the unit's flag is on: callers pass the `enabled` they drew
 * under (the settings flag in production, the test seam in tests).
 */
import {
  buildDisplayAdEvent,
  type DisplayAdAction,
  type DisplayAdEventKind,
} from '@codebuff/common/ads/display-ads/telemetry'
import { useEffect, useRef } from 'react'

import { trackEvent } from '../utils/analytics'
import { logger } from '../utils/logger'

import type { SponsorId } from '@codebuff/common/ads/display-ads/sponsors'
import type { AnalyticsEvent } from '@codebuff/common/constants/analytics-events'

export type CliDisplayAdSlot = 'cliSplash' | 'cliStatusline' | 'deals'

type Track = (event: AnalyticsEvent, properties: Record<string, unknown>) => void

const defaultTrack: Track = (event, properties) => void trackEvent(event, properties)
let track: Track = defaultTrack

/** Test seam: capture events instead of sending them; no argument restores the default. */
export function setCliDisplayAdTrackerForTests(next?: Track): void {
  track = next ?? defaultTrack
}

export function trackCliDisplayAd<K extends DisplayAdEventKind>(
  input: {
    kind: K
    slot: CliDisplayAdSlot
    sponsorId: SponsorId
    action: DisplayAdAction<K>
    position?: number
    scope?: 'session' | 'day'
  },
  enabled: boolean,
): void {
  if (!enabled) return
  try {
    const event = buildDisplayAdEvent({
      ...input,
      surface: 'cli',
      ...(input.kind === 'impression' ? { viewability: 'insertion' } : {}),
    })
    if (event) track(event.event, event.properties)
  } catch (error) {
    // Telemetry must never interfere with drawing a unit or running /deals.
    logger.debug({ error }, '[display-ads] Failed to track event')
  }
}

/** `display_ads.impression` once per mount, on insertion. */
export function useCliDisplayAdImpression(
  slot: CliDisplayAdSlot,
  sponsorId: SponsorId | undefined,
  enabled: boolean,
  position?: number,
): void {
  const fired = useRef(false)
  useEffect(() => {
    if (!enabled || !sponsorId || fired.current) return
    fired.current = true
    trackCliDisplayAd(
      { kind: 'impression', slot, sponsorId, action: 'view', position },
      enabled,
    )
  }, [slot, sponsorId, enabled, position])
}
