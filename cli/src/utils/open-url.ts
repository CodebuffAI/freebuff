import os from 'os'
import { spawn, type ChildProcess } from 'child_process'

import open from 'open'

import { getCliEnv } from './env'
import { logger } from './logger'

export function getWindowsOpenUrlCommand(url: string): {
  command: string
  args: string[]
} {
  return {
    command: 'rundll32.exe',
    args: ['url.dll,FileProtocolHandler', url],
  }
}

export async function openUrlWithWindowsHandler(
  url: string,
  spawnUrlHandler: typeof spawn = spawn,
): Promise<boolean> {
  const { command, args } = getWindowsOpenUrlCommand(url)

  return new Promise((resolve) => {
    let subprocess: ChildProcess
    try {
      subprocess = spawnUrlHandler(command, args, {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      })
    } catch (err) {
      logger.error(err, 'Failed to spawn Windows URL handler')
      resolve(false)
      return
    }

    let settled = false
    const finish = (success: boolean) => {
      if (settled) return
      settled = true
      resolve(success)
    }

    subprocess.once('error', (err) => {
      logger.error(err, 'Failed to open browser with Windows URL handler')
      finish(false)
    })
    subprocess.once('spawn', () => {
      subprocess.unref()
      finish(true)
    })
  })
}

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
    return openUrlWithWindowsHandler(url)
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
