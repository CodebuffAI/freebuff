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

/** `message_sent`'s surface: a native app's platform, else the send's own. */
export function messageSentSurface<Surface extends string>(
  surface: Surface,
  platform: unknown,
) {
  return mobileClientPlatform(platform) ?? surface
}
