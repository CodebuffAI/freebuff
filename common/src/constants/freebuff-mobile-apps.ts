/**
 * The Freebuff phone apps' store listings: the one place a store URL lives.
 * The `/start` handoff, the workspace's "Mobile app" menus, the idle-return
 * prompt and the growth house campaigns all link here.
 *
 * The App Store link names no storefront on purpose: `apps.apple.com/app/…`
 * sends each visitor to their own country's store, where the `/us/` form
 * shows a US listing that a non-US account cannot install from.
 */
export const FREEBUFF_IOS_APP_STORE_ID = '6808416358'

export const FREEBUFF_IOS_APP_STORE_URL = `https://apps.apple.com/app/freebuff-ai-coding-agent/id${FREEBUFF_IOS_APP_STORE_ID}`

/** The Android app's Play listing (`android_client`, `com.freebuff.app`). */
export const FREEBUFF_ANDROID_PLAY_STORE_URL =
  'https://play.google.com/store/apps/details?id=com.freebuff.app'
