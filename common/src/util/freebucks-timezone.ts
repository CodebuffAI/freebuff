export const FREEBUCKS_TIMEZONE_HEADER = 'x-fb-timezone'

/** A timezone is a scheduling preference, never proof of country or access. */
export function normalizeFreebucksTimeZone(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 100 || !value.trim())
    return null
  try {
    return new Intl.DateTimeFormat('en', {
      timeZone: value.trim(),
    }).resolvedOptions().timeZone
  } catch {
    return null
  }
}

/** What the reporting process knows about where it runs. */
export type FreebucksTimeZoneRuntime = {
  /** The zone the runtime resolved (`Intl…resolvedOptions().timeZone`). */
  zone: string | undefined
  /** `process.platform`, when there is one (absent in a browser). */
  platform?: string
  /** The process environment, when there is one (absent in a browser). */
  env?: Record<string, string | undefined>
}

const UTC_ZONES = new Set([
  'UTC',
  'UCT',
  'GMT',
  'GMT0',
  'Greenwich',
  'Universal',
  'Zulu',
  'Etc/UTC',
  'Etc/UCT',
  'Etc/GMT',
  'Etc/GMT0',
  'Etc/GMT+0',
  'Etc/GMT-0',
  'Etc/Greenwich',
  'Etc/Universal',
  'Etc/Zulu',
])

/** A zone that means "zero offset", by any of its spellings. */
function isUtcZone(zone: string): boolean {
  return UTC_ZONES.has(zone)
}

/** A fixed-offset `Etc/GMT±N` zone (sign inverted: `Etc/GMT-1` is UTC+1). */
const ETC_OFFSET_ZONE = /^Etc\/GMT[+-]\d{1,2}$/

/**
 * The process runs on a host the user reaches remotely: an SSH session or a
 * cloud/dev container. Such a host's UTC is the image default, not the
 * user's day.
 */
function isRemoteHost(env: Record<string, string | undefined>): boolean {
  return Boolean(
    env.SSH_CONNECTION ||
      env.SSH_CLIENT ||
      env.SSH_TTY ||
      env.CODESPACES ||
      env.REMOTE_CONTAINERS ||
      env.GITPOD_WORKSPACE_ID ||
      env.container,
  )
}

/**
 * The device timezone to report, or null when the runtime's answer is not
 * the user's zone and the header must be omitted (a missing header keeps the
 * account's schedule; a wrong one moves it and costs a refill):
 *
 * - `Etc/Unknown` or nothing: the runtime could not tell.
 * - UTC under a `TZ` that is not itself a UTC name: Bun (the CLI and Desktop
 *   runtime) answers `UTC` for any `TZ` it cannot parse (`TZ=`, offset strings
 *   like `GMT-1`, `:/etc/localtime`, a misspelled name), whatever the OS zone is.
 * - UTC on a remote host (SSH, Codespaces, dev containers): a server's
 *   default, not the zone of the person at the keyboard.
 * - `Etc/GMT±N` on Windows: ICU's answer when "Adjust for daylight saving
 *   time automatically" is off, a fixed offset in place of the named zone
 *   (Europe/Budapest becomes `Etc/GMT-1`). It disagrees with the named zone
 *   the same user's other devices (WSL, a browser, a Mac) report.
 *
 * Never falls back to UTC: unknown is omitted.
 */
export function freebucksDeviceTimeZone(
  runtime: FreebucksTimeZoneRuntime,
): string | null {
  const zone = runtime.zone?.trim()
  if (!zone || zone === 'Etc/Unknown') return null
  const env = runtime.env ?? {}
  if (isUtcZone(zone)) {
    // Bun reads an empty `TZ=` back as undefined, yet the key is present.
    const tzSet = env.TZ !== undefined || 'TZ' in env
    const tz = (env.TZ ?? '').trim().replace(/^:/, '')
    if (tzSet && !isUtcZone(tz)) return null
    if (isRemoteHost(env)) return null
  }
  if (runtime.platform === 'win32' && ETC_OFFSET_ZONE.test(zone)) return null
  return zone
}

function currentRuntime(): FreebucksTimeZoneRuntime {
  let zone: string | undefined
  try {
    zone = Intl.DateTimeFormat().resolvedOptions().timeZone
  } catch {
    zone = undefined
  }
  const proc = (
    globalThis as {
      process?: {
        platform?: string
        env?: Record<string, string | undefined>
      }
    }
  ).process
  return { zone, platform: proc?.platform, env: proc?.env }
}

/** Evaluate on every request so travelling does not require an app restart. */
export function freebucksTimeZoneHeaders(
  runtime: FreebucksTimeZoneRuntime = currentRuntime(),
): Record<string, string> {
  try {
    const zone = freebucksDeviceTimeZone(runtime)
    return zone ? { [FREEBUCKS_TIMEZONE_HEADER]: zone } : {}
  } catch {
    return {}
  }
}
