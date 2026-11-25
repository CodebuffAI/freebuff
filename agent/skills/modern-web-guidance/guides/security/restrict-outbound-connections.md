# Restrict outbound network connections with Connection Allowlists

The `Connection-Allowlist` HTTP response header restricts a document or worker to communicating only with an explicit list of network endpoints. Unlike Content Security Policy (CSP)—which requires maintaining separate per-resource directives (`connect-src`, `img-src`, `script-src`, `font-src`, `form-action`) and does not govern speculative or non-Fetch network channels such as `<link rel="dns-prefetch">`, `<link rel="preconnect">`, or WebRTC—`Connection-Allowlist` enforces a single, network-layer allowlist across **all** outbound connections initiated by the context (`fetch()`, `XMLHttpRequest`, subresources, `navigator.sendBeacon()`, `<a ping>`, top-level and frame navigations, resource hints, Speculation Rules, `WebSocket`, `WebTransport`, and WebRTC).

## How to implement

1. **Serialize the allowlist as an RFC 9651 Inner List `(...)`**: Format `Connection-Allowlist` (or `Connection-Allowlist-Report-Only`) as a single parenthesized list of space-separated items. Include the unquoted token `response-origin` to permit the document or worker's own origin, followed by double-quoted `URLPattern` strings for every legitimate external endpoint the context connects or navigates to (APIs, image/font CDNs, and outbound `<a href>`, `<form action>`, OAuth, or payment redirect targets). When building patterns dynamically from configuration or `URL` objects, normalize `ws:`/`wss:` to `http:`/`https:` and strip bare trailing slashes on origin-only URLs (because `new URL('https://api.example.com').href` appends `/`, which restricts `URLPattern` matching to the root path `/` only).
2. **Scope middleware by `Sec-Fetch-Dest` and cover workers**: Browsers only honor `Connection-Allowlist` on document/navigation responses and worker script responses (`Sec-Fetch-Dest` values `document`, `iframe`, `worker`, `sharedworker`, and `serviceworker`). When varying headers by `Sec-Fetch-Dest`, include `Vary: Sec-Fetch-Dest` so shared caches do not serve headerless responses. Serve a matching allowlist on Dedicated and Shared Worker scripts so compromised page scripts cannot exfiltrate data via `worker.postMessage()`. Because a Service Worker performs its own network fetches on cache misses and navigation preloads, configure its `Connection-Allowlist` as a **superset** of the allowlists of all documents it controls.
3. **Always configure violation reporting (`Reporting-Endpoints` and `report-to`) and support staged or dual rollout**: Define a `Reporting-Endpoints` header and append an unquoted `; report-to=<endpoint-name>` parameter after the closing `)` on every `Connection-Allowlist` or `Connection-Allowlist-Report-Only` policy so blocked connection attempts are observable. You can send `Connection-Allowlist-Report-Only` alone during initial rollout, or send **both** `Connection-Allowlist` (enforcing a baseline allowlist) and `Connection-Allowlist-Report-Only` (auditing a stricter candidate allowlist) on the same response. Violation reports are delivered with `"type": "connection-allowlist"` and body `{ url, connection, allowlist, disposition }` (where `connection` is the blocked destination URL or `"webrtc"`, and `disposition` is `"enforce"` or `"report"`).
4. **Account for default redirect and WebRTC blocking, and handle client errors**: By default, `Connection-Allowlist` blocks all `3xx` HTTP redirects (`redirects=block`, even when redirecting between allowlisted or same-origin URLs) and all `RTCPeerConnection` traffic (`webrtc=block`). Append `; redirects=allow` only when trusted endpoints require server-side redirects (the initial request must still match the allowlist), or `; webrtc=allow` when WebRTC is required. On the client, wrap outbound `fetch()` calls in `try...catch` and handle `WebSocket` `error` events so requests rejected with `TypeError` (`net::ERR_NETWORK_ACCESS_REVOKED`) return a handled error state and update UI status instead of causing unhandled rejections.

## Example code

```http
Vary: Sec-Fetch-Dest
Reporting-Endpoints: conn-reports="https://app.example.com/api/security-reports"
Connection-Allowlist: (response-origin "https://api.example.com" "https://realtime.example.com" "https://*.cdn.example.com/*"); report-to=conn-reports
Connection-Allowlist-Report-Only: (response-origin "https://api.example.com/v2/*"); report-to=conn-reports
```

```javascript
const ALLOWLIST_DESTS = new Set(['document', 'iframe', 'worker', 'sharedworker', 'serviceworker']);

// Normalize a config URL or URLPattern string for Connection-Allowlist:
// - Rewrites ws:// and wss:// to http:// and https:// (WebSocket matching rule).
// - Strips a bare trailing slash on origin-only URLs (e.g. from new URL(...).href)
//   so all subpaths on the origin are permitted instead of only "/".
export function normalizeAllowlistPattern(rawPattern) {
  const trimmed = String(rawPattern).trim().replace(/^ws(s?):\/\//i, 'http$1://');
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new Error(`Pattern must include an http:// or https:// scheme: ${rawPattern}`);
  }
  if (/[\s,]/.test(trimmed)) {
    throw new Error(`Pattern must be a single URLPattern without spaces or commas: ${rawPattern}`);
  }
  if (/[()]/.test(trimmed)) {
    throw new Error(`Custom regex groups are rejected by Connection-Allowlist: ${rawPattern}`);
  }
  return trimmed.replace(/^(https?:\/\/[^/?#]+)\/$/i, '$1');
}

// Build an RFC 9651 Inner List value for Connection-Allowlist or Connection-Allowlist-Report-Only.
export function buildConnectionAllowlistHeader({
  allowSelf = true,
  patterns = [],
  reportTo,
  redirects = 'block',
  webrtc = 'block',
} = {}) {
  const items = allowSelf ? ['response-origin'] : [];
  for (const pattern of patterns) {
    const raw = String(pattern).trim();
    if (raw === 'response-origin') {
      if (!items.includes('response-origin')) items.push('response-origin');
      continue;
    }
    const normalized = normalizeAllowlistPattern(raw);
    items.push(`"${normalized.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
  }
  let header = `(${items.join(' ')})`;
  if (redirects === 'allow') header += '; redirects=allow';
  if (webrtc === 'allow') header += '; webrtc=allow';
  if (reportTo) {
    const endpointToken = String(reportTo).trim().replace(/^"+|"+$/g, '');
    header += `; report-to=${endpointToken}`;
  }
  return header;
}

// Server or middleware helper applying Connection-Allowlist and Reporting-Endpoints
// on document and worker responses.
export function setConnectionAllowlistHeaders(res, options = {}) {
  const {
    secFetchDest = 'document',
    patterns = ['https://api.example.com', 'https://realtime.example.com', 'https://*.cdn.example.com/*'],
    reportOnlyPatterns,
    reportEndpointName = 'conn-reports',
    reportEndpointUrl = 'https://app.example.com/api/security-reports',
    redirects = 'block',
    webrtc = 'block',
    reportOnly = false,
  } = options;

  const setHeader = (name, value) =>
    typeof res.setHeader === 'function' ? res.setHeader(name, value) : res.headers.set(name, value);

  if (typeof res.appendHeader === 'function') {
    res.appendHeader('Vary', 'Sec-Fetch-Dest');
  } else if (typeof res.headers?.append === 'function') {
    res.headers.append('Vary', 'Sec-Fetch-Dest');
  } else {
    setHeader('Vary', 'Sec-Fetch-Dest');
  }
  if (secFetchDest && !ALLOWLIST_DESTS.has(String(secFetchDest).toLowerCase())) return;

  setHeader('Reporting-Endpoints', `${reportEndpointName}="${reportEndpointUrl}"`);
  setHeader(
    reportOnly ? 'Connection-Allowlist-Report-Only' : 'Connection-Allowlist',
    buildConnectionAllowlistHeader({ allowSelf: true, patterns, reportTo: reportEndpointName, redirects, webrtc }),
  );

  if (!reportOnly && Array.isArray(reportOnlyPatterns)) {
    setHeader(
      'Connection-Allowlist-Report-Only',
      buildConnectionAllowlistHeader({
        allowSelf: true,
        patterns: reportOnlyPatterns,
        reportTo: reportEndpointName,
        redirects,
        webrtc,
      }),
    );
  }
}

// Client-side helper that catches blocked outbound requests gracefully without unhandled rejections.
export async function fetchWithPolicyHandling(url, { statusElement, ...fetchOptions } = {}) {
  try {
    const response = await fetch(url, fetchOptions);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.text();
    if (statusElement) {
      statusElement.textContent = `Allowed: Loaded ${url} (${body.length} bytes).`;
    }
    return { ok: true, body, error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (statusElement) {
      statusElement.textContent = `Blocked: Request to ${url} was rejected by the outbound connection policy (${message}).`;
    }
    return { ok: false, body: null, error };
  }
}
```

## Best practices

- **DO** format `Connection-Allowlist` as a single RFC 9651 Inner List `(...)` of space-separated items. If a non-empty `Connection-Allowlist` header fails top-level Structured Field parsing (for example, omitting `(...)` or using single quotes `'...'`), the browser fails closed with an empty allowlist and blocks **all** outbound network connections. Use `Connection-Allowlist: ()` when you intentionally want to revoke all network access after load (local schemes `data:`, `blob:`, `about:`, and `filesystem:` remain permitted).
- **DO** omit the trailing slash on origin-wide URL patterns (`"https://api.example.com"`) or use an explicit wildcard (`"https://api.example.com/*"`) so subpaths like `/v1/users` are permitted. Strip trailing slashes added by `new URL(origin).href` before serializing patterns.
- **DO** allowlist `WebSocket` (`ws://` and `wss://`) endpoints using `"http://..."` and `"https://..."` patterns in `Connection-Allowlist`, because the browser normalizes WebSocket schemes to HTTP/HTTPS before matching.
- **DO** include expected external navigation targets (`<a href>`, `<form action>`, OAuth/SSO providers, payment checkouts) in a restricted document's allowlist, and remember that the default `redirects=block` blocks even same-origin `3xx` redirects unless `; redirects=allow` is specified.
- **DO NOT** wrap `response-origin` or inner-list parameter values (`; report-to=conn-reports`, `; redirects=allow`, `; webrtc=allow`) in quotes, or separate items inside `(...)` with commas.
- **DO NOT** use custom regular expression groups such as `(\d+)` or relative paths such as `"/api/*"` inside URL patterns; the browser's network-service parser rejects regex groups and patterns without a scheme and hostname.
- **DO NOT** rely on the experimental `<iframe connectionAllowlist="...">` attribute or `Allow-Connection-Allowlist-From` embedded enforcement header in production yet, as embedded enforcement is not enabled by default in shipping browsers.

## Fallback strategy

Browser support for Connection allowlists: Limited availability.
Supported by: Chrome 152 (Aug 2026) and Edge 152 (Aug 2026).
Unsupported in: Firefox and Safari.

Because `Connection-Allowlist` is enforced at the browser network layer via an HTTP response header, it cannot be polyfilled in client-side JavaScript. If your Baseline target includes browsers that do not yet support `Connection-Allowlist`, **pair `Connection-Allowlist` with a `Content-Security-Policy` (CSP) header** (and a `<meta http-equiv="Content-Security-Policy">` element for document-level fetch and subresource restrictions when HTTP response headers cannot be configured):

- **Additive defense-in-depth**: Supporting browsers enforce both policies simultaneously—`Connection-Allowlist` blocks non-CSP exfiltration channels (`dns-prefetch`, `preconnect`, WebRTC, and redirects), while CSP restricts `fetch()`, subresources, and `<form action>` navigations in browsers without `Connection-Allowlist`.
- **Cover `form-action` and `worker-src` explicitly**: In CSP, `default-src` does **not** fall back for `<form action>` submissions; always include `form-action` explicitly. Include `worker-src 'self'` (excluding `blob:`) so restricted pages cannot spawn `blob:` SharedWorkers to bypass document-level restrictions.
- **Map allowed origins to per-resource CSP directives**: Unlike `Connection-Allowlist` (which uses a single endpoint list and does not govern inline markup), `default-src 'self'` in CSP restricts each resource type (`connect-src`, `img-src`, `style-src`, `font-src`, `script-src`) and blocks inline `<style>` and `<script>` blocks unless authorized via hashes or nonces.
- **Include `wss://` in CSP `connect-src`**: While `Connection-Allowlist` matches `wss://` connections against `"https://..."` patterns, CSP `connect-src` in cross-browser environments should explicitly list `wss://` origins when WebSockets are used.

```http
Content-Security-Policy: default-src 'self'; connect-src 'self' https://api.example.com https://realtime.example.com wss://realtime.example.com; img-src 'self' https://*.cdn.example.com data: blob:; form-action 'self'; worker-src 'self'; object-src 'none'; base-uri 'self'; report-to conn-reports
```

```html
<!-- Document-level fallback when HTTP response headers cannot be set on static hosting -->
<meta
  http-equiv="Content-Security-Policy"
  content="default-src 'self'; connect-src 'self' https://api.example.com https://realtime.example.com wss://realtime.example.com; img-src 'self' https://*.cdn.example.com data: blob:; form-action 'self'; worker-src 'self'; object-src 'none'; base-uri 'self'"
/>
```
