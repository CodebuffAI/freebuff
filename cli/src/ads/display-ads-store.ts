/**
 * What the user has hidden of the mock CLI display ads.
 *
 * - `cliSplash`: "hide for today" writes the local day to settings.json
 *   (`displayAdSplashHiddenOn`), so a relaunch the same day stays clean and
 *   the next day draws the block again.
 * - `cliStatusline` (and its `/deals` list): × on the row, or `/deals off`,
 *   hides both for this process only. `/deals on` brings them back.
 */
import { create } from 'zustand'

import { loadSettings, saveSettings } from '../utils/settings'

/** The local calendar day as `YYYY-MM-DD`. */
export function localDay(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

interface DisplayAdsState {
  /** `localDay()` the splash block was hidden on, or null. */
  splashHiddenOn: string | null
  statuslineHidden: boolean
  hideSplashForToday: () => void
  setStatuslineHidden: (hidden: boolean) => void
}

export const useDisplayAdsStore = create<DisplayAdsState>((set) => ({
  splashHiddenOn: null,
  statuslineHidden: false,
  hideSplashForToday: () => {
    const day = localDay()
    saveSettings({ displayAdSplashHiddenOn: day })
    set({ splashHiddenOn: day })
  },
  setStatuslineHidden: (statuslineHidden) => set({ statuslineHidden }),
}))

/** The saved day, read from settings.json on first use (once per process). */
let savedSplashDay: string | null | undefined

/** Whether the splash block is hidden today. */
export function useSplashHiddenToday(today: string = localDay()): boolean {
  const hiddenOn = useDisplayAdsStore((s) => s.splashHiddenOn)
  savedSplashDay ??= loadSettings().displayAdSplashHiddenOn ?? null
  return (hiddenOn ?? savedSplashDay) === today
}
