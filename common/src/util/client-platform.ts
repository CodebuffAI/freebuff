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
