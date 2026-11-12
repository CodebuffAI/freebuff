import { createComposerIntentScheduler } from '@codebuff/common/ads/composer-intent-scheduler'
import { useEffect, useRef, useState } from 'react'

import { getComposerIntentAd } from './partner-ads'

import type { AdResponse } from '../hooks/use-gravity-ad'
import type { ComposerIntentScheduler } from '@codebuff/common/ads/composer-intent-scheduler'

/**
 * THE COMPOSER ROW, decided by the server: which composer partner ad, if any,
 * the draft is about (`getComposerIntentAd`). Replaces the keyword triggers
 * the row used to read.
 *
 * Paced by the shared scheduler -- asked only after a 1s idle on a draft of 3+
 * characters, one request in flight, the newest waiting draft sent when it
 * returns. While `enabled` is false (a menu, a form or a review screen owns
 * the input) drafts are not asked about and nothing is drawn, but the
 * scheduler and what it has been told survive, so closing a menu does not
 * re-ask the same draft.
 */
export function useComposerIntentAd(
  draft: string,
  enabled: boolean,
): AdResponse | null {
  const [ad, setAd] = useState<AdResponse | null>(null)
  const scheduler = useRef<ComposerIntentScheduler | null>(null)

  useEffect(() => {
    const next = createComposerIntentScheduler<AdResponse>({
      request: (text) => getComposerIntentAd(text),
      onAnswer: setAd,
    })
    scheduler.current = next
    return () => {
      next.dispose()
      if (scheduler.current === next) scheduler.current = null
    }
  }, [])

  useEffect(() => {
    if (enabled) scheduler.current?.update(draft)
  }, [draft, enabled])

  // Disabled (a menu, a form, or an ad-network ad on screen): a draft waiting
  // for its idle timer is not asked about, a late answer is not shown, and
  // the last row is forgotten, so reopening never redraws a stale row. An
  // answer already asked for stays remembered by the scheduler and is shown
  // again, with no new request, if the same draft is still there.
  useEffect(() => {
    if (enabled) return
    scheduler.current?.update('')
    setAd(null)
  }, [enabled])

  return enabled ? ad : null
}
