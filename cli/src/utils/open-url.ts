import fs from 'fs'
import os from 'os'

import open from 'open'
import { isWsl, powerShellPathFromWsl } from 'wsl-utils'

import { getCliEnv } from './env'
import { logger } from './logger'

/**
 * Safely open a URL in the user's default browser.
 *
 * On headless Linux (no DISPLAY or WAYLAND_DISPLAY), calling `open()` spawns
 * `xdg-open` which can crash the entire process — even inside a try/catch —
 * because the child process may trigger fatal signals. This wrapper detects
 * headless environments and skips the call entirely. WSL is exempt: there
 * `open()` goes through powershell.exe, which needs no display.
 *
 * On WSL, `open()` spawns powershell.exe from the Windows mount. If Windows
 * interop is disabled (no access to /mnt/c), that spawn fails with ENOENT.
 * Under Bun the failure is delivered before the `open()` promise resolves and
 * cannot be caught from here — not by try/catch, and not by an 'error'
 * listener attached afterward — so the only reliable defense is checking that
 * powershell.exe exists before calling `open()`. `wsl-utils` is what `open`
 * itself uses to build the path, so the check matches its behavior exactly.
 *
 * Only `http:` / `https:` URLs are opened. Several callers pass a URL someone
 * else wrote — an ad's click URL, an advertiser CTA, a link in an agent's UI
 * widget — and the OS opener hands any other scheme (`file:`, `smb:`,
 * `ms-msdt:`, an app's custom handler) to whatever program registered it.
 *
 * @returns `true` if the browser was (likely) opened, `false` if skipped.
 */
export async function safeOpen(url: string): Promise<boolean> {
  if (!isOpenableWebUrl(url)) {
    logger.warn(
      { scheme: describeScheme(url) },
      'Refusing to open a URL that is not http(s).',
    )
    return false
  }
  if (isWsl) {
    const powershellPath = await powerShellPathFromWsl()
    if (!fs.existsSync(powershellPath)) {
      logger.warn(
        { powershellPath },
        'WSL detected but powershell.exe is not accessible (Windows interop disabled?). Skipping browser open.',
      )
      return false
    }
  } else if (os.platform() === 'linux') {
    const env = getCliEnv()
    const hasDisplay = Boolean(env.DISPLAY || env.WAYLAND_DISPLAY)
    if (!hasDisplay) {
      logger.warn(
        'No display server detected (DISPLAY / WAYLAND_DISPLAY unset). Skipping browser open.',
      )
      return false
    }
  }

  try {
    const subprocess = await open(url)
    // With the default `wait: false`, spawn failures can surface on the
    // child's 'error' event after the promise resolves; without a listener
    // they become uncaught exceptions that kill the process.
    subprocess.once('error', (err) => {
      logger.error(err, 'Failed to open browser')
    })
    return true
  } catch (err) {
    logger.error(err, 'Failed to open browser')
    return false
  }
}

/**
 * `true` for an absolute `http:` / `https:` URL with no control characters or
 * whitespace (which the OS opener could split into extra arguments).
 * @internal exported for tests
 */
export function isOpenableWebUrl(url: unknown): url is string {
  if (typeof url !== 'string' || url.length === 0 || url.length > 8192) {
    return false
  }
  if (/[\s\x00-\x1f\x7f-\x9f]/.test(url)) return false
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  return parsed.protocol === 'https:' || parsed.protocol === 'http:'
}

function describeScheme(url: unknown): string {
  if (typeof url !== 'string') return typeof url
  const match = /^([a-z][a-z0-9+.-]{0,31}):/i.exec(url)
  return match ? match[1]!.toLowerCase() : 'none'
}
