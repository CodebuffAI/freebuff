/** Request origin, independent of the product surface (chat/cloud/desktop).
 * Optional for older clients; never infer a browser from missing metadata.
 * Analytics only: client-supplied attribution is not an authorization signal.
 */
export type MobileClientPlatform = 'ios' | 'android'

export function clientPlatformProperties(
  value: unknown,
): { client_platform?: MobileClientPlatform } {
  return value === 'ios' || value === 'android' ? { client_platform: value } : {}
}
