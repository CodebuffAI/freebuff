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

/**
 * A short download code stands in for the receipt in an installer's name, so
 * a download reads `Freebuff-Setup-k7m2qx.exe` instead of carrying ~100
 * characters of token. freebuff.com keeps the receipt it stands for, and the
 * first launch trades the code back for it. 32 symbols with no 0/1/l/o, so a
 * random byte maps to one without bias and a retyped name stays unambiguous.
 */
export const DESKTOP_INSTALLER_CODE_ALPHABET =
  'abcdefghijkmnpqrstuvwxyz23456789'
export const DESKTOP_INSTALLER_CODE_LENGTH = 6
const CODE = `[a-km-np-z2-9]{${DESKTOP_INSTALLER_CODE_LENGTH}}`
const CODE_PATTERN = new RegExp(`^${CODE}$`)
const CODE_NAME = new RegExp(
  `^Freebuff-(?:Setup-|Installer-)?(${CODE})(?: \\([0-9]{1,9}\\))?\\.(?:exe|dmg|AppImage)$`,
)

export function isDesktopInstallerCode(value: unknown): value is string {
  return typeof value === 'string' && CODE_PATTERN.test(value)
}

/** The name a code-carrying installer downloads under, by its asset's extension. */
export function desktopInstallerCodeName(assetName: string, code: string) {
  if (!isDesktopInstallerCode(code)) return null
  if (assetName.endsWith('.exe')) return `Freebuff-Setup-${code}.exe`
  if (assetName.endsWith('.dmg')) return `Freebuff-Installer-${code}.dmg`
  if (assetName.endsWith('.AppImage')) return `Freebuff-${code}.AppImage`
  return null
}

/** The code in a downloaded installer's name, allowing a browser's ` (1)` duplicate suffix. */
export function extractDesktopInstallerCode(filename: unknown) {
  if (typeof filename !== 'string') return null
  const name = filename.split(/[\\/]/).pop() ?? ''
  return CODE_NAME.exec(name)?.[1] ?? null
}
