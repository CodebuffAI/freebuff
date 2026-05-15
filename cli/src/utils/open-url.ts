import os from 'os'
import { spawn } from 'child_process'

import open from 'open'

import { getCliEnv } from './env'
import { logger } from './logger'

/**
 * Safely open a URL in the user's default browser.
 *
 * On headless Linux (no DISPLAY or WAYLAND_DISPLAY), calling `open()` spawns
 * `xdg-open` which can crash the entire process — even inside a try/catch —
 * because the child process may trigger fatal signals. This wrapper detects
 * headless environments and skips the call entirely.
 *
 * @returns `true` if the browser was (likely) opened, `false` if skipped.
 */
export async function safeOpen(url: string): Promise<boolean> {
  if (os.platform() === 'win32') {
    try {
      const subprocess = spawn(
        'rundll32.exe',
        ['url.dll,FileProtocolHandler', url],
        {
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
        },
      )
      subprocess.unref()
      return true
    } catch (err) {
      logger.error(err, 'Failed to open browser with Windows URL handler')
      return false
    }
  }

  if (os.platform() === 'linux') {
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
    await open(url)
    return true
  } catch (err) {
    logger.error(err, 'Failed to open browser')
    return false
  }
}
