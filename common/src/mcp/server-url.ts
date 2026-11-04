// Users paste MCP server addresses the way they type them into a browser: `mcp.example.com/sse`,
// `example.com/mcp`, `localhost:3000/mcp`. `new URL` rejects the first two and misreads the last
// as a URL with the scheme `localhost:`, so every surface failed with "not a valid URL".
//
// This only supplies a missing scheme. It never removes or changes one the user typed, so each
// surface's own scheme, host and SSRF checks run unchanged on the result: `javascript:`, `file:`
// and `ftp:` URLs come back as given and are rejected there, as before.

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/** `name:` followed by digits and then the end, a path, a query or a fragment is a port, not a scheme. */
const HOST_WITH_PORT = /^[^\s/:?#]+:\d+(?:[/?#]|$)/
const SCHEME = /^[a-z][a-z0-9+.-]*:/i

/**
 * Trims `raw` and, when it has no scheme, prefixes `https://` — or `http://` for a loopback host,
 * the only place plain HTTP is allowed and where local MCP servers almost always listen.
 * A value that already has a scheme is returned trimmed and otherwise untouched.
 */
export function normalizeMcpServerUrl(raw: string): string {
  const value = raw.trim()
  if (!value) return value
  if (value.startsWith('//')) return `https:${value}`
  if (SCHEME.test(value) && !HOST_WITH_PORT.test(value)) return value

  let hostname: string
  try {
    hostname = new URL(`https://${value}`).hostname
  } catch {
    // Not a URL with any scheme; leave it for the caller's validation to report.
    return value
  }
  return `${LOOPBACK_HOSTS.has(hostname) ? 'http' : 'https'}://${value}`
}
