/**
 * How a sponsored file tool tells, on Windows, that a path names what it
 * appears to name (COD-642).
 *
 * Win32 does not open the spelling it is given. It strips a trailing `.` or
 * space from every component, resolves an 8.3 short name (`GITHUB~1`) to the
 * long one, reads `name::$DATA` as `name`, and follows reparse points that
 * Node's `lstat` does not report as links (a junction onto a volume GUID path,
 * for one). Each of those can make a name that passed a check land on another
 * file. The rules below make the spelling and the destination agree before
 * anything is opened, and are applied only where the platform is Windows.
 */

import fs from 'node:fs'
import path from 'node:path'

/** A component Win32 would reinterpret rather than open as spelled. */
export function sponsoredWindowsSegmentRefusal(segment: string): string | null {
  if (/[. ]$/.test(segment)) {
    return 'A sponsored run may not name a path whose component ends in a dot or a space, which Windows strips.'
  }
  if (segment.includes(':')) {
    return 'A sponsored run may not name a Windows alternate data stream.'
  }
  if (/~\d/.test(segment)) {
    return 'A sponsored run may not name a Windows 8.3 short name, which can alias another file.'
  }
  return null
}

/** Strip the `\\?\` prefix Windows APIs may add, so two spellings compare. */
function withoutVerbatimPrefix(target: string): string {
  if (target.startsWith('\\\\?\\UNC\\')) return `\\\\${target.slice(8)}`
  if (target.startsWith('\\\\?\\')) return target.slice(4)
  return target
}

/**
 * Where Windows itself says `target` is: every link, junction and mount point
 * followed and every short name expanded, by the final path of an open handle.
 */
export function windowsNativePath(target: string): string {
  return withoutVerbatimPrefix(fs.realpathSync.native(target))
}

/** NTFS compares names case-insensitively, so the comparison does too. */
export function sameWindowsPath(a: string, b: string): boolean {
  const normal = (value: string) =>
    path.win32
      .normalize(withoutVerbatimPrefix(value))
      .replace(/[\\/]+$/, '')
      .toLowerCase()
  return normal(a) === normal(b)
}

/**
 * `target`, relative to `nativeRoot`, as Windows resolves it: the deepest
 * EXISTING ancestor through {@link windowsNativePath}, then the part that does
 * not exist yet put back. Null when that lands outside the root.
 */
export function windowsNativeRelative(
  nativeRoot: string,
  target: string,
): string | null {
  const tail: string[] = []
  let existing = target
  for (;;) {
    try {
      fs.lstatSync(existing)
      break
    } catch {
      const parent = path.dirname(existing)
      if (parent === existing) return null
      tail.unshift(path.basename(existing))
      existing = parent
    }
  }
  const resolved = path.join(windowsNativePath(existing), ...tail)
  const relative = path.win32.relative(nativeRoot, resolved)
  if (relative.startsWith('..') || path.win32.isAbsolute(relative)) return null
  return relative
}
