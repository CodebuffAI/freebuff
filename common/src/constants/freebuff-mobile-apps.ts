/**
 * The Freebuff phone apps' store listings: the one place a store URL lives.
 * The `/start` handoff, the workspace's "Mobile app" menus, the idle-return
 * prompt and the growth house campaigns all link here.
 *
 * The App Store link names no storefront on purpose: `apps.apple.com/app/…`
 * sends each visitor to their own country's store, where the `/us/` form
 * shows a US listing that a non-US account cannot install from.
 */
import { FREEBUFF_WEB_URL_PROD } from './hosts'

export const FREEBUFF_IOS_APP_STORE_ID = '6808416358'

export const FREEBUFF_IOS_APP_STORE_URL = `https://apps.apple.com/app/freebuff-ai-coding-agent/id${FREEBUFF_IOS_APP_STORE_ID}`

/** The Android app's Play listing (`android_client`, `com.freebuff.app`). */
export const FREEBUFF_ANDROID_PLAY_STORE_URL =
  'https://play.google.com/store/apps/details?id=com.freebuff.app'

/** `/mobile`'s query parameter naming where its visitor came from. */
export const FREEBUFF_MOBILE_LANDING_FROM_PARAM = 'from'
/** The one source `/mobile` counts: a scanned QR code. */
export const FREEBUFF_MOBILE_LANDING_FROM_QR = 'qr'

/**
 * What a QR code encodes: the `/mobile` landing, which sends the phone that
 * scanned it on to its own store. Always production, since a phone cannot open
 * a development host, and marked so the landing can count scans. Kept short:
 * every extra character makes the code denser and harder to scan off a screen.
 */
export const FREEBUFF_MOBILE_QR_URL = `${FREEBUFF_WEB_URL_PROD}/mobile?${FREEBUFF_MOBILE_LANDING_FROM_PARAM}=${FREEBUFF_MOBILE_LANDING_FROM_QR}`
