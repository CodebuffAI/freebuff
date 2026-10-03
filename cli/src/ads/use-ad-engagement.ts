/**
 * The live wiring for CLI ad engagement (COD-757): one process-wide registry,
 * the fire-and-forget POST to `/api/v1/ads/engagement`, and the hook each ad
 * card calls. The timing rules live in `ad-engagement.ts`.
 */
import { WEBSITE_URL } from '@codebuff/sdk'
import { IS_TEST } from '@codebuff/common/env'
import { useCallback, useEffect, useRef } from 'react'

import { createAdoptionWatcher, type AdoptionWatcher } from './ad-adoption'
import {
  createEngagementRegistry,
  rowsIntersect,
  type ClickRegion,
  type EngagementHandle,
  type EngagementRegistry,
  type OwnerPlacement,
} from './ad-engagement'
import {
  ensureAdTerminalFocusWatch,
  getAdTerminalFocusState,
  getAdTranscriptViewport,
  subscribeAdAgentCommand,
  subscribeAdKeystroke,
  subscribeAdTerminalFocus,
  subscribeAdUserSend,
  timedApiCall,
} from './ad-signals'
import { getIdleTime, subscribeToActivity } from '../utils/activity-tracker'
import { getCliAdRequestUserAgent } from '../utils/ad-client-identity'
import { getAuthToken } from '../utils/auth'
import { clientEnvironmentHeaders } from '../utils/client-environment'
import { logger } from '../utils/logger'

import type { AdEngagement } from '@codebuff/common/types/ad-client-context'

/** How often a transcript card re-measures whether it is inside the viewport. */
export const TRANSCRIPT_VISIBILITY_POLL_MS = 500

/** Fire-and-forget; never retried, never thrown. */
export function postAdEngagement(record: AdEngagement): void {
  if (IS_TEST) return
  try {
    const authToken = getAuthToken()
    if (!authToken) return
    void timedApiCall(() =>
      fetch(`${WEBSITE_URL}/api/v1/ads/engagement`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
          'User-Agent': getCliAdRequestUserAgent(),
          ...clientEnvironmentHeaders(),
        },
        body: JSON.stringify(record),
      }),
    )
      .then((res) => {
        if (!res.ok)
          logger.debug(
            { status: res.status },
            '[ads] Failed to record ad engagement',
          )
      })
      .catch((err) => {
        logger.debug({ err }, '[ads] Failed to record ad engagement')
      })
  } catch (err) {
    logger.debug({ err }, '[ads] Failed to record ad engagement')
  }
}

let registry: EngagementRegistry | null = null

export function adEngagementRegistry(): EngagementRegistry {
  if (registry) return registry
  const created = createEngagementRegistry({
    now: () => performance.now(),
    send: postAdEngagement,
    focus: getAdTerminalFocusState,
    idleMs: getIdleTime,
    countsKeys: true,
    onFlushed: (impUrl) => adoption?.mainRecordSent(impUrl),
  })
  ensureAdTerminalFocusWatch()
  subscribeAdTerminalFocus((focused) => created.terminalFocus(focused))
  subscribeAdUserSend(() => created.messageSent())
  subscribeToActivity(() => created.userInput())
  subscribeAdKeystroke(() => created.keystroke())
  registry = created
  return created
}

/** Test seam: inject a registry with a fake clock and sender, or `null` to rebuild the live one. */
export function setAdEngagementRegistryForTests(
  next: EngagementRegistry | null,
): void {
  registry = next
}

let adoption: AdoptionWatcher | null = null

/** Created on the first click: until then there is nothing to watch for. */
function adAdoptionWatcher(): AdoptionWatcher {
  if (adoption) return adoption
  const created = createAdoptionWatcher({
    now: () => performance.now(),
    send: postAdEngagement,
    status: (impUrl) => adEngagementRegistry().status(impUrl),
  })
  subscribeAdAgentCommand((command) => created.agentCommand(command))
  adoption = created
  return created
}

/**
 * A click on any CLI ad: watch for the agent adopting the clicked vendor
 * (`postClick.packageInstalled`). A landing page outside the tracked vendors
 * arms nothing. Never throws.
 */
export function armAdAdoptionWatch(
  impUrl: string | undefined,
  landingUrl: string | undefined,
): void {
  try {
    if (!impUrl) return
    adAdoptionWatcher().armClick(impUrl, landingUrl)
  } catch {
    // never break a click
  }
}

/** Mouse modifiers as OpenTUI reports them on the click's mouse-up. */
export function clickModifier(event: unknown): boolean | undefined {
  if (!event || typeof event !== 'object') return undefined
  const { modifiers, button } = event as {
    modifiers?: { shift?: boolean; alt?: boolean; ctrl?: boolean }
    button?: number
  }
  if (!modifiers && typeof button !== 'number') return undefined
  return Boolean(
    modifiers?.shift || modifiers?.alt || modifiers?.ctrl || button === 1,
  )
}

type MeasurableNode = {
  screenY: number
  height: number
  isDestroyed?: boolean
}

export type AdEngagementBinding = {
  /** Attach to the card's outermost box; only a `measured` card reads it. */
  ref: (node: MeasurableNode | null) => void
  onHover: (hovering: boolean) => void
  onClick: (event?: unknown, region?: ClickRegion) => void
}

/**
 * Track one drawn copy of an ad. `enabled: false` while the component draws
 * something that tracks itself (the dock's narrow fallback renders `AdCard`).
 */
export function useAdEngagement(
  impUrl: string | undefined,
  options: {
    placement: OwnerPlacement
    truncated?: boolean
    enabled?: boolean
  },
): AdEngagementBinding {
  const { placement, truncated } = options
  const enabled = options.enabled ?? true
  const handleRef = useRef<EngagementHandle | null>(null)
  const nodeRef = useRef<MeasurableNode | null>(null)

  useEffect(() => {
    if (!enabled || !impUrl) return
    let handle: EngagementHandle | null = null
    try {
      handle = adEngagementRegistry().mount(impUrl, placement)
    } catch {
      handle = null
    }
    handleRef.current = handle
    if (!handle) return

    let interval: ReturnType<typeof setInterval> | null = null
    let first: ReturnType<typeof setTimeout> | null = null
    if (placement === 'measured') {
      const measure = () => {
        try {
          const node = nodeRef.current
          const visible =
            node && !node.isDestroyed
              ? rowsIntersect(
                  { top: node.screenY, height: node.height },
                  getAdTranscriptViewport(),
                )
              : undefined
          handle?.tracker.setVisible(handle.token, visible)
        } catch {
          // unmeasurable is unknown
        }
      }
      // after the first layout pass, then on a slow poll: streaming content
      // moves the card without any event the card itself receives
      first = setTimeout(measure, 0)
      interval = setInterval(measure, TRANSCRIPT_VISIBILITY_POLL_MS)
      ;(interval as { unref?: () => void }).unref?.()
    }

    return () => {
      if (first) clearTimeout(first)
      if (interval) clearInterval(interval)
      if (handleRef.current === handle) handleRef.current = null
      try {
        if (handle) adEngagementRegistry().unmount(handle)
      } catch {
        // never break an unmount
      }
    }
  }, [impUrl, placement, enabled])

  useEffect(() => {
    if (truncated === undefined) return
    try {
      handleRef.current?.tracker.truncated(truncated)
    } catch {
      // a measurement must never break the card
    }
  }, [impUrl, enabled, truncated])

  const ref = useCallback((node: MeasurableNode | null) => {
    nodeRef.current = node
  }, [])

  // OpenTUI bubbles over/out from a card's children, so moving between two
  // children emits out-then-over in one dispatch. The out is held for a
  // microtask and cancelled by the over, or one hover would count as two.
  const leaveGenerationRef = useRef(0)
  const onHover = useCallback((hovering: boolean) => {
    const apply = (value: boolean) => {
      const handle = handleRef.current
      if (!handle) return
      try {
        handle.tracker.hover(handle.token, value)
      } catch {
        // never break a hover
      }
    }
    const generation = ++leaveGenerationRef.current
    if (hovering) {
      apply(true)
      return
    }
    queueMicrotask(() => {
      if (leaveGenerationRef.current === generation) apply(false)
    })
  }, [])

  const onClick = useCallback((event?: unknown, region?: ClickRegion) => {
    const handle = handleRef.current
    if (!handle) return
    try {
      const modifier = clickModifier(event)
      handle.tracker.click({
        ...(modifier !== undefined ? { modifier } : {}),
        ...(region ? { region } : {}),
      })
    } catch {
      // never break a click
    }
  }, [])

  return { ref, onHover, onClick }
}
