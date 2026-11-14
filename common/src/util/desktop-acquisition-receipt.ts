/** Public, noncredential receipt syntax shared by delivery and Desktop. HMAC verification is server-only. */
export const DESKTOP_RECEIPT_PLATFORMS = [
  'mac-arm64',
  'mac-intel',
  'windows',
  'windows-arm64',
  'windows-baseline',
  'linux',
  'linux-arm64',
  'linux-appimage',
  'linux-arm64-appimage',
] as const
export type DesktopReceiptPlatform = (typeof DESKTOP_RECEIPT_PLATFORMS)[number]
export const DESKTOP_RECEIPT_MAX_AGE_SECONDS = 30 * 24 * 60 * 60
const UUID =
  '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'
const TOKEN = new RegExp(
  `^v1\\.(${UUID})\\.([0-9a-z]{6,10})\\.(${DESKTOP_RECEIPT_PLATFORMS.join('|')})\\.([A-Za-z0-9_-]{43})$`,
)

export function parseDesktopAcquisitionReceipt(value: unknown) {
  if (typeof value !== 'string' || value.length > 180) return null
  const match = TOKEN.exec(value)
  if (!match || match[0] !== value) return null
  const issued_at = Number.parseInt(match[2]!, 36)
  if (
    !Number.isSafeInteger(issued_at) ||
    issued_at <= 0 ||
    issued_at.toString(36) !== match[2]
  )
    return null
  return {
    acquisition_id: match[1]!,
    issued_at,
    platform: match[3]! as DesktopReceiptPlatform,
    token: value,
  }
}

export function extractDesktopAcquisitionReceipt(filename: unknown) {
  if (typeof filename !== 'string') return null
  const name = filename.split(/[\\/]/).pop() ?? ''
  const marker = name.lastIndexOf('--fb_')
  if (marker < 0) return null
  const token = name
    .slice(marker + 5)
    .replace(/(?: \([0-9]+\))?\.(?:exe|app|zip|AppImage|deb)$/, '')
  return parseDesktopAcquisitionReceipt(token)
}
