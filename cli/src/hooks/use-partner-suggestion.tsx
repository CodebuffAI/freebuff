import React, {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useAdExpired } from '../ads/ad-expiry-clock'
import { CLI_PARTNER_PLACEMENT_IDS, getPartnerAd } from '../ads/partner-ads'
import { PartnerAdRow } from '../components/partner-ad-line'
import {
  suggestionWindow,
  type SuggestionItem,
} from '../components/suggestion-menu'
import type { AdResponse } from './use-gravity-ad'

export const PARTNER_REVIEW_ITEM_ID = 'partner:review'

/** A filled ad is a real menu position. No fill leaves the command list unchanged. */
export function usePartnerSuggestion({
  items,
  selectedIndex,
  setSelectedIndex,
  maxVisible,
  enabled,
  fetchAd = getPartnerAd,
}: {
  items: SuggestionItem[]
  selectedIndex: number
  setSelectedIndex: (index: number) => void
  maxVisible: number
  enabled: boolean
  fetchAd?: typeof getPartnerAd
}) {
  const [fill, setAd] = useState<AdResponse | null>(null)
  // Shown too long (`ad-expiry-clock.ts`): the row comes out of the menu.
  const expired = useAdExpired(fill?.impUrl)
  const ad = expired ? null : fill
  const activate = useRef<(() => void) | null>(null)
  const menuItems = useMemo(() => {
    const reviewIndex = items.findIndex((item) => item.id === 'review')
    if (!enabled || !ad || reviewIndex < 0) return items
    const result = [...items]
    result.splice(reviewIndex + 1, 0, {
      id: PARTNER_REVIEW_ITEM_ID,
      label: '',
      description: '',
      activate: () => activate.current?.(),
      render: (selected, width) => (
        <PartnerAdRow
          ad={ad}
          width={width}
          selected={selected}
          activateRef={activate}
        />
      ),
    })
    return result
  }, [items, ad, enabled])

  const { start, visibleCount } = suggestionWindow(
    menuItems.length,
    selectedIndex,
    maxVisible,
  )
  const reviewVisible = menuItems
    .slice(start, start + visibleCount)
    .some((item) => item.id === 'review')
  useEffect(() => {
    if (!enabled || !reviewVisible) return
    let cancelled = false
    void fetchAd(CLI_PARTNER_PLACEMENT_IDS.slashReview)
      .then((fill) => {
        if (!cancelled) setAd(fill)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [enabled, reviewVisible, fetchAd])

  // Disabled (an ad-network ad on screen, a form, the menu closed): forget
  // the fill, so reopening never re-inserts a stale row. A late answer is
  // already cancelled above; `getPartnerAd` keeps it, so asking again on
  // reopen makes no second request.
  useEffect(() => {
    if (!enabled) setAd(null)
  }, [enabled])

  // A late fill must not move the highlight onto the ad or another command.
  const previous = useRef({ items, menuItems, selectedIndex })
  useLayoutEffect(() => {
    const before = previous.current
    if (items === before.items && menuItems !== before.menuItems) {
      const id = before.menuItems[before.selectedIndex]?.id
      const next = menuItems.findIndex((item) => item.id === id)
      setSelectedIndex(next >= 0 ? next : Math.max(0, before.selectedIndex - 1))
    }
    previous.current = { items, menuItems, selectedIndex }
  }, [items, menuItems, selectedIndex, setSelectedIndex])
  return menuItems
}
