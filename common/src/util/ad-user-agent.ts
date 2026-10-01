/**
 * The shared user agent passed to ad providers for device-type classification.
 * Keep this shared by every native client so one surface cannot accidentally
 * fall back to a runtime UA such as `Bun/<version>`. Compare the number
 * against the current stable Chrome, not the date below.
 *
 * Last bumped: 2026-08-18 (Chrome 151, then current stable). Revisit roughly
 * every six months.
 */
const AD_CHROME_VERSION = '151.0.0.0'

const AD_USER_AGENTS: Record<string, string> = {
  darwin: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${AD_CHROME_VERSION} Safari/537.36`,
  win32: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${AD_CHROME_VERSION} Safari/537.36`,
  linux: `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${AD_CHROME_VERSION} Safari/537.36`,
}

export function getAdUserAgent(platform: string = process.platform): string {
  const platformKey =
    platform === 'macos'
      ? 'darwin'
      : platform === 'windows'
        ? 'win32'
        : platform
  return AD_USER_AGENTS[platformKey] ?? AD_USER_AGENTS.linux
}

/**
 * Whether a user agent is one an ad network will read as a browser.
 *
 * Deliberately a shape test rather than an allowlist: the question is only
 * "will the provider's device classifier recognise this", and every string it
 * recognises starts with the `Mozilla/` token. A native runtime UA
 * (`Bun/1.3.14`) and a product UA (`Freebuff-CLI/0.0.140`) both fail it, which
 * is the point — they are the two ways we have actually leaked a non-browser
 * UA to Gravity.
 */
export function isBrowserLikeAdUserAgent(
  candidate: string | undefined | null,
): boolean {
  return typeof candidate === 'string' && /^Mozilla\//i.test(candidate.trim())
}

/**
 * The single rule for what user agent we present to an ad provider, shared by
 * the auction and the impression pixel.
 *
 * It exists because those two disagreed: the auction and the impression
 * pixel described the same impression with different user agents. Routing
 * both call sites through here makes them agree by construction.
 *
 * Preference order is submitted → request header → synthesized, and anything
 * that is not browser-like is replaced rather than passed through, so builds
 * already installed on user machines are corrected server-side the moment this
 * deploys instead of waiting for a client update.
 */
/**
 * The user agent Gravity sees, on the auction and on its impression pixel.
 * Gravity is the exception to the browser-like rule below: at their request
 * (2026-09-04) they receive the real client UA (`Codebuff-CLI/<v>`). The
 * header wins whenever it has content (including `Bun/<v>` from old builds);
 * a missing or blank one falls back to the browser-like UA.
 */
export function resolveGravityUserAgent(params: {
  requestHeader?: string | null
  fallback?: string
}): string | undefined {
  return params.requestHeader?.trim() || params.fallback
}

export function resolveAdProviderUserAgent(params: {
  /** Browser-like UA the client sent in the request body, when it sends one. */
  submitted?: string | null
  /** The caller's own HTTP `User-Agent` header. */
  requestHeader?: string | null
  /** Client OS, so the synthesized fallback matches the real device. */
  os?: string
}): string {
  const { submitted, requestHeader, os } = params
  const candidate = submitted?.trim() || requestHeader?.trim()
  return isBrowserLikeAdUserAgent(candidate)
    ? (candidate as string)
    : getAdUserAgent(os)
}
