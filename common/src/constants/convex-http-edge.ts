import { FREEBUFF_WEB_URL_PROD } from './hosts'

/**
 * Platform Convex's prod HTTP-action origin (`harmless-tapir-303`), which is
 * being retired (COD-742). Already public: browser bundles carry it.
 */
export const PLATFORM_CONVEX_SITE_URL_PROD =
  'https://harmless-tapir-303.convex.site'

/**
 * Platform Convex's prod client URL (`harmless-tapir-303`, the
 * `ConvexReactClient` / `ConvexHttpClient` address). A public deployment URL,
 * not a secret, so it is a constant rather than an env var: until COD-742 it
 * reached freebuff-web only through `convex deploy --cmd` at build time, so
 * pausing Convex would have left freebuff-web unable to build. Read through
 * freebuff/web's `platformConvexUrl()`, which keeps the env override for dev,
 * staging, CI and tests.
 */
export const PLATFORM_CONVEX_URL_PROD =
  'https://harmless-tapir-303.convex.cloud'

/** Where non-`/api/` Convex paths live on freebuff.com. */
export const CONVEX_HTTP_EDGE_PREFIX = '/api/edge'

/** The freebuff.com base that non-`/api/` Convex HTTP paths hang off. */
export const CONVEX_HTTP_EDGE_BASE_URL_PROD = `${FREEBUFF_WEB_URL_PROD}${CONVEX_HTTP_EDGE_PREFIX}`

/**
 * The freebuff.com path a Convex HTTP path is served at
 * (docs/convex-http-edge.md). Paths already under `/api/` keep their path, so
 * repointing is a host swap; the rest move under {@link CONVEX_HTTP_EDGE_PREFIX}.
 */
export function edgePathForConvexPath(convexPath: string): string {
  return convexPath.startsWith('/api/')
    ? convexPath
    : `${CONVEX_HTTP_EDGE_PREFIX}${convexPath}`
}

/**
 * The URL a server we own should call for the Convex httpAction at
 * `convexPath`, given the `*.convex.site` origin it is configured with.
 *
 * Prod Convex maps to the freebuff.com edge route, which proxies to the same
 * httpAction. Any other origin (a dev or local deployment) is called directly,
 * as before: a dev deployment must never be reached through prod freebuff.com,
 * and the edge's own upstream (`NEXT_PUBLIC_CONVEX_SITE_URL`) is read by the
 * proxy itself, never through this, so it cannot loop.
 */
export function convexHttpUrl(convexSiteUrl: string, convexPath: string): string {
  const origin = convexSiteUrl.replace(/\/+$/, '')
  return origin === PLATFORM_CONVEX_SITE_URL_PROD
    ? `${FREEBUFF_WEB_URL_PROD}${edgePathForConvexPath(convexPath)}`
    : `${origin}${convexPath}`
}
