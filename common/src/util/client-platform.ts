/** A native app's platform, which `message_sent` reports as its surface.
 * Optional for older clients; never infer a browser from missing metadata.
 * Analytics only: client-supplied attribution is not an authorization signal.
 */
export type MobileClientPlatform = 'ios' | 'android'
export type WorkspaceClientPlatform = MobileClientPlatform | 'desktop'

export function mobileClientPlatform(
  value: unknown,
): MobileClientPlatform | undefined {
  return value === 'ios' || value === 'android' ? value : undefined
}

/** Hosted Desktop explicitly identifies itself; older Desktop owns its own events. */
export function workspaceClientPlatform(
  value: unknown,
): WorkspaceClientPlatform | undefined {
  return value === 'desktop' ? value : mobileClientPlatform(value)
}

/**
 * Whether a request's User-Agent is a phone: the iOS app (URLSession's
 * `<App>/<build> CFNetwork/…`), the Android app (OkHttp's default
 * `okhttp/…`), or a phone browser. Shipped apps send no other marker on their
 * catalog request. Display defaults only, never authorization.
 */
export function phoneUserAgent(userAgent: string | null | undefined): boolean {
  if (!userAgent) return false
  return (
    /\bCFNetwork\//.test(userAgent) ||
    /^okhttp\//i.test(userAgent) ||
    /\b(iPhone|iPod)\b/.test(userAgent) ||
    /\bAndroid\b.*\bMobile\b/.test(userAgent)
  )
}

/** `message_sent`'s surface: a native app's platform, else the send's own. */
export function messageSentSurface<Surface extends string>(
  surface: Surface,
  platform: unknown,
) {
  return mobileClientPlatform(platform) ?? surface
}

/** A native app's version header (COD-1719): `1.1.6`, or `1.1.6 (23)` with its build. */
export const FREEBUFF_APP_VERSION_HEADER = 'x-freebuff-app-version'

export type MobileAppVersion = { appVersion?: string; appBuild?: string }

const VERSION = '[0-9A-Za-z.+_-]{1,40}'
const BUILD = '[0-9A-Za-z.]{1,20}'
const VERSION_HEADER = new RegExp(`^(${VERSION})(?: \\((${BUILD})\\))?$`)
/** The apps' own issue-report agent: `Freebuff iOS 1.1.6 (23); iOS 18.1; iPhone`. */
const APP_AGENT = new RegExp(`^Freebuff (?:iOS|Android) (${VERSION}) \\((${BUILD})\\)`)
/** URLSession's default, which shipped iOS builds send: `Freebuff/23 CFNetwork/… Darwin/…`. */
const URLSESSION_AGENT = /^Freebuff\/([0-9][0-9.]{0,19}) CFNetwork\//

/**
 * A native app's version and build, from `X-Freebuff-App-Version` when it
 * sent one, else what its User-Agent says. Shipped iOS builds send only
 * URLSession's agent, which names the build (`CFBundleVersion`) and not the
 * version; shipped Android builds send OkHttp's, which names neither.
 * Analytics only: a client claim, never an authorization signal.
 */
export function mobileAppVersion(input: {
  appVersionHeader?: string | null
  userAgent?: string | null
}): MobileAppVersion {
  const header = input.appVersionHeader?.trim().match(VERSION_HEADER)
  if (header)
    return { appVersion: header[1], ...(header[2] ? { appBuild: header[2] } : {}) }
  const agent = input.userAgent?.trim() ?? ''
  const app = agent.match(APP_AGENT)
  if (app) return { appVersion: app[1], appBuild: app[2] }
  const session = agent.match(URLSESSION_AGENT)
  return session ? { appBuild: session[1] } : {}
}
