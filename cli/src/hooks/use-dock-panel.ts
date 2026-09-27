/**
 * The sponsor dock's expandable detail panel (COD-457).
 *
 * Owns three things the dock renderer deliberately does not: the sticky
 * experiment arm fetched once per CLI session, the open/closed state with its
 * seven collapse methods, and the telemetry — which is telemetry and ONLY
 * telemetry. Expanding fires no impression and no click, and nothing here may
 * ever be settled against.
 */
import { WEBSITE_URL } from '@codebuff/sdk'
import { AnalyticsEvent } from '@codebuff/common/constants/analytics-events'
import {
  claimDockExpansion,
  dockDwellMs,
  DOCK_ACCIDENTAL_CLICK_MS,
} from '@codebuff/common/ads/ad-event-hygiene'
import { useCallback, useEffect, useRef, useState } from 'react'

import { getAuthToken } from '../utils/auth'
import { logger } from '../utils/logger'
import { trackEvent } from '../utils/analytics'

import type {
  DockClickOrigin,
  DockCollapseMethod,
  DockExpandMethod,
} from '@codebuff/common/ads/ad-event-hygiene'
import type { CliDockArm } from '@codebuff/common/util/ad-experiment'
import type { AdResponse } from './use-gravity-ad'

/** The chord, and the hint the dock prints for it on a wide collapsed dock. */
export const DOCK_CHORD_HINT = '⌃O details'

/**
 * The arm THIS CLI PROCESS resolved, for the life of the process.
 *
 * Module-level rather than hook state because the ad request has to report it
 * and `useGravityAd` runs before `useDockPanel` in the tree. It is genuinely
 * per-session state — the policy is fetched once — so a module scope is the
 * accurate scope rather than a shortcut around the ordering.
 *
 * The server recomputes the arm from the CURRENT env mode on every request,
 * which mislabels traffic at exactly the moments that matter: at a
 * shadow -> on flip, sessions still rendering the control dock get logged as
 * `expandable`, and a rollback does the reverse. Reporting what the client
 * actually cached is the only value that describes what the user saw.
 *
 * `null` means "not resolved yet" — the first ad request can precede the
 * policy fetch — and is deliberately distinct from `'control'`, so the server
 * falls back to its own assignment rather than being told a guess.
 */
let sessionDockArm: CliDockArm | null = null

export function getSessionDockArm(): CliDockArm | null {
  return sessionDockArm
}

/**
 * The PARTNER placements this session was told it may request, or `null`
 * while the policy is unresolved.
 *
 * Null and empty are different answers and the partner rows read both: null
 * means "ask the policy", `[]` means "this deal is not live for this
 * session, draw nothing". Collapsing them would make a client that had not
 * yet fetched the policy behave like one that had been refused, and it would
 * never recover -- the rows mount long before the dock's first rotation.
 */
let sessionPartnerPlacementIds: readonly string[] | null = null

export function getSessionPartnerPlacementIds(): readonly string[] | null {
  return sessionPartnerPlacementIds
}

/** The one in-flight policy fetch, so concurrent askers share an answer. */
let policyRequest: Promise<CliDockArm> | null = null

/**
 * Resolve the ad policy once per process, for whoever asks first.
 *
 * The dock hook used to be the only caller and could simply fetch in an
 * effect. The partner rows need the same body (they cannot request a slot the
 * policy has not named) and mount on a keystroke, so the fetch is shared
 * here rather than raced: two fetches would be two assignments of a sticky
 * arm, which is the one thing a sticky assignment must not do.
 */
export function resolveAdPolicy(): Promise<CliDockArm> {
  if (policyRequest) return policyRequest
  const request = fetchDockArm().then((arm) => {
    // Recorded before any render so the very next ad request reports the arm
    // this session will actually draw.
    sessionDockArm = arm
    return arm
  })
  // A policy resolved with no credentials is not this session's policy: it is
  // the answer for a logged-out process, which asks for nothing and is told
  // nothing. Memoizing it would pin the session to it through the login that
  // usually follows.
  if (getAuthToken()) policyRequest = request
  return request
}

/**
 * Forget this session's policy.
 *
 * Called on an account change (the partner rows notice one, since they hold
 * ads per account) and by tests. Production otherwise resolves the policy
 * exactly once per process: a second fetch could hand the same user a
 * different arm mid-session, which is the one thing a sticky assignment must
 * not do.
 */
export function resetAdPolicySession(): void {
  sessionDockArm = null
  sessionPartnerPlacementIds = null
  policyRequest = null
}

/**
 * The policy fetch is best-effort by design: a CLI that cannot reach the
 * policy route must still show ads, so every failure — network, non-200,
 * unparseable body, an arm string we do not recognise — lands on control. An
 * experiment that fails open into its own treatment arm is not an experiment.
 *
 * The partner list fails the same way, to nothing at all: an older server, an
 * unreachable one and a deal that is not live must all leave this client
 * drawing no partner row rather than requesting a slot it was never offered.
 */
export async function fetchDockArm(
  fetchImpl: typeof fetch = fetch,
  websiteUrl: string = WEBSITE_URL,
): Promise<CliDockArm> {
  const authToken = getAuthToken()
  if (!authToken) return 'control'
  try {
    const response = await fetchImpl(`${websiteUrl}/api/v1/ads/policy`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${authToken}` },
    })
    if (!response.ok) return 'control'
    const data = (await response.json()) as {
      dockArm?: unknown
      partnerPlacementIds?: unknown
    }
    sessionPartnerPlacementIds = Array.isArray(data?.partnerPlacementIds)
      ? data.partnerPlacementIds.filter(
          (id): id is string => typeof id === 'string' && id.length > 0,
        )
      : []
    return data?.dockArm === 'expandable' ? 'expandable' : 'control'
  } catch (err) {
    logger.debug({ err }, '[ads] Failed to fetch dock policy')
    sessionPartnerPlacementIds = []
    return 'control'
  }
}

export type DockPanelState = {
  arm: CliDockArm
  expanded: boolean
  /** True only when the arm is expandable — what the keyboard resolver reads. */
  expandable: boolean
  toggle: (method: DockExpandMethod) => void
  collapse: (method: DockCollapseMethod) => void
  /**
   * The dock metadata for a CTA click, to be sent WITH the click
   * acknowledgement. Emits no event of its own — see the note on the return.
   */
  clickContext: (from: DockClickOrigin) => DockClickContext
}

/**
 * What a dock CTA click adds to the canonical click event.
 *
 * Deliberately a value, not an event. This used to emit its own
 * `ads.clicked` client-side while `/api/v1/ads/click` emitted the canonical
 * server-side one, so every dock click was counted twice — and only the
 * duplicate carried the dock fields, and only when the acknowledgement
 * happened to succeed. These ride the ack instead, so one click stays one
 * event and the metadata lands on the row that is actually authoritative.
 */
export type DockClickContext = {
  from: DockClickOrigin
  dwellMs: number
  /**
   * A LABEL, never a filter: suppressing the click would under-report an
   * advertiser's delivery, and settlement is not this hook's to decide.
   */
  accidental: boolean
}

/** The telemetry seam. Injected in tests rather than mocked, per docs/testing.md. */
export type DockTracker = (
  event: AnalyticsEvent,
  properties: Record<string, unknown>,
) => void

export const defaultDockTracker: DockTracker = (event, properties) => {
  try {
    trackEvent(event, properties)
  } catch (err) {
    // Telemetry must never interfere with rendering an ad.
    logger.debug({ err, event }, '[ads] Failed to track dock event')
  }
}

export function useDockPanel(options: {
  ad: AdResponse | null | undefined
  enabled?: boolean
  /**
   * Whether a panel would actually FIT on this terminal right now, from
   * `getDockPanelLayout(...).fits`. False refuses the expansion outright
   * rather than parking the hook in an open state that renders nothing: on an
   * 18-21 row terminal the budget leaves fewer rows than the smallest panel
   * needs, and accepting the toggle there made the dock look broken — the
   * chord hint vanished and Escape was needed to clear an invisible state.
   */
  canExpand?: boolean
  fetchArm?: () => Promise<CliDockArm>
  now?: () => number
  track?: DockTracker
}): DockPanelState {
  const enabled = options.enabled ?? true
  const now = options.now ?? Date.now
  const trackRef = useRef<DockTracker>(options.track ?? defaultDockTracker)
  trackRef.current = options.track ?? defaultDockTracker
  const track: DockTracker = useCallback(
    (event, properties) => trackRef.current(event, properties),
    [],
  )
  const [arm, setArm] = useState<CliDockArm>('control')
  const [expanded, setExpanded] = useState(false)

  const openedAtRef = useRef(0)
  /**
   * The ad the panel was opened ON, snapshotted beside `openedAtRef`.
   *
   * `adRef` has already advanced to the INCOMING ad by the time the rotation
   * effect collapses, so reporting from it attributed the outgoing ad's dwell
   * to the new ad's `imp_url` — and to `undefined` when the ad simply went
   * away. Collapse telemetry reads this instead.
   */
  const openedAdRef = useRef<AdResponse | null>(null)
  const expansionsFiredRef = useRef(new Set<string>())
  const adRef = useRef<AdResponse | null | undefined>(options.ad)
  adRef.current = options.ad
  const canExpandRef = useRef(options.canExpand ?? true)
  canExpandRef.current = options.canExpand ?? true

  // Once per CLI session. A second fetch could hand the same user a different
  // arm mid-session, which is the one thing a sticky assignment must not do.
  const fetchArmRef = useRef(options.fetchArm)
  fetchArmRef.current = options.fetchArm
  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    void (async () => {
      const resolved = await (fetchArmRef.current?.() ?? resolveAdPolicy())
      if (cancelled) return
      // Recorded before the render so the very next ad request reports the
      // arm this session will actually draw. `resolveAdPolicy` already did
      // this for itself; an INJECTED arm has nobody else to do it.
      sessionDockArm = resolved
      setArm(resolved)
    })()
    return () => {
      cancelled = true
    }
  }, [enabled])

  const collapse = useCallback(
    (method: DockCollapseMethod) => {
      setExpanded((wasOpen) => {
        if (!wasOpen) return false
        const ad = openedAdRef.current
        track(AnalyticsEvent.ADS_DOCK_COLLAPSED, {
          imp_url: ad?.impUrl,
          provider: ad?.provider,
          placement_id: ad?.placementId,
          method,
          dwell_ms: dockDwellMs(openedAtRef.current, now()),
        })
        return false
      })
    },
    [now, track],
  )

  const toggle = useCallback(
    (method: DockExpandMethod) => {
      setExpanded((wasOpen) => {
        if (wasOpen) {
          const opened = openedAdRef.current
          track(AnalyticsEvent.ADS_DOCK_COLLAPSED, {
            imp_url: opened?.impUrl,
            provider: opened?.provider,
            placement_id: opened?.placementId,
            // The chord toggling shut is its own collapse method; a click on
            // the dock body while open is the "outside the panel" case.
            method: method === 'key' ? 'key' : 'outside',
            dwell_ms: dockDwellMs(openedAtRef.current, now()),
          })
          return false
        }
        const ad = adRef.current
        if (!ad) return false
        // Refuse rather than open something that cannot be drawn.
        if (!canExpandRef.current) return false
        openedAtRef.current = now()
        openedAdRef.current = ad
        // Deduped per impUrl per app session: opening the same ad ten times is
        // one expansion, and an expansion is never an impression.
        if (claimDockExpansion(expansionsFiredRef.current, ad.impUrl)) {
          track(AnalyticsEvent.ADS_DOCK_EXPANDED, {
            imp_url: ad.impUrl,
            provider: ad.provider,
            placement_id: ad.placementId,
            method,
          })
        }
        return true
      })
    },
    [now, track],
  )

  // Collapse on rotation and on the ad going away. The user opened THIS ad's
  // details, not the next one's. Keyed on `impUrl`, which is what the ads hook
  // rotates; the panel opening never makes the hook rotate sooner.
  const lastImpUrlRef = useRef<string | undefined>(options.ad?.impUrl)
  useEffect(() => {
    const impUrl = options.ad?.impUrl
    if (impUrl === lastImpUrlRef.current) return
    const hadAd = lastImpUrlRef.current !== undefined
    lastImpUrlRef.current = impUrl
    if (!hadAd) return
    collapse(impUrl === undefined ? 'gone' : 'rotate')
  }, [options.ad?.impUrl, collapse])

  const clickContext = useCallback(
    (from: DockClickOrigin): DockClickContext => {
      const dwellMs =
        from === 'panel' ? dockDwellMs(openedAtRef.current, now()) : 0
      return {
        from,
        dwellMs,
        accidental: from === 'panel' && dwellMs < DOCK_ACCIDENTAL_CLICK_MS,
      }
    },
    [now],
  )

  const expandable = enabled && arm === 'expandable'
  return {
    arm,
    expanded: expandable && expanded,
    expandable,
    toggle,
    collapse,
    clickContext,
  }
}
