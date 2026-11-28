# Web Security

Guidelines for implementing preventative security measures on the web safely and incrementally.

**NOTE**: This skill covers standard web platform defenses, focusing mostly on the browser. Applications still require comprehensive server-side security, authorization models, and input validation.

## Table of Contents

- When to apply this skill
- Phase 1: Quick Wins & Obvious Anti-Patterns
  - 1.1 Secure Contexts
  - 1.2 Avoid Dangerous DOM Sinks
  - 1.3 Secure Cookies
  - 1.4 Clickjacking Protection (Frame-Ancestors & X-Frame-Options)
  - 1.5 Secure Window Messaging (postMessage)
  - 1.6 Secure WebSocket Connections
- Phase 2: Discovery & Data Collection (Prerequisites)
  - 2.1 Inspect the Application
  - 2.2 Deploy Report-Only Policies
  - 2.3 Data Hygiene for Reports
  - 2.4 Automated Discovery via Browser APIs and DevTools
- Phase 3: Interpreting Results & Enforcement
  - Core enforcement
    - 3.1 Analyzing CSP Reports
    - 3.2 Enforcing Content Security Policy (CSP)
    - 3.3 Trusted Types Enforcement
    - 3.4 Cross-Origin Opener Policy (COOP)
    - 3.5 Cross-Origin Resource Policy (CORP)
    - 3.6 Cross-Origin Isolation
    - 3.7 Fetch Metadata (Resource Isolation)
  - Companion policies (deploy in parallel)
    - HTTP Strict Transport Security (HSTS)
    - X-Content-Type-Options
    - Referrer Policy
    - Permissions Policy
    - Subresource Integrity (SRI)
    - Cross-Origin Resource Sharing (CORS)
    - Clear-Site-Data (Logout)

## When to apply this skill

The right starting point depends on the application and whether you can update the codebase directly:

- **Auditing and hardening a codebase directly**: Apply Phase 1 code hygiene, wire up Phase 2 reporting (`Reporting-Endpoints` and `report-to`), and enforce Phase 3 headers (`Content-Security-Policy` with nonces/hashes, `'strict-dynamic'`, `'report-sample'`, `object-src 'none'`, `base-uri 'none'`, `frame-ancestors 'none'` (or `'self'`), and `require-trusted-types-for 'script'`, plus COOP, CORP, Fetch Metadata, HSTS, `X-Content-Type-Options`, `Referrer-Policy`, and `Permissions-Policy`) directly by updating `<script>` tags, cookies, and server middleware in the same pass.
- **Staged rollout on a large production site with unknown third-party dependencies**: Start with Phase 1 quick wins and deploy Phase 2 report-only headers alongside enforced companion policies while collecting violation telemetry, then promote the report-only policies to Phase 3 enforcement.
- **Greenfield app or SaaS template / framework defaults**: Ship Phase 1 hygiene and Phase 3 enforced policies by default, with Phase 2 reporting configured so regressions are captured immediately.

**Focusing on Leverage**: While Phase 1 and 2 establish baseline hygiene and violation visibility, Phase 3 core enforcement represents the highest-leverage security work. Specifically, Injection/XSS mitigation through enforced CSP (§3.2) and Trusted Types (§3.3) addresses the largest practical threat, while companion policies and isolation defenses provide important defense-in-depth.

## Phase 1: Quick Wins & Obvious Anti-Patterns

Before attempting to deploy global security policies, focus on code-level hygiene and immediate fixes that do not risk breaking the application.

### 1.1 Secure Contexts
- **DO**: Deliver resources over HTTPS to protect against both passive and active network attackers.
- **DO**: Serve a header like `Strict-Transport-Security: max-age=31536000; includeSubDomains; preload` to force HTTPS whenever possible.
- **TIP**: In production rollout, start with a short `max-age` (e.g., 300 seconds) and incrementally increase to 1 year. A misconfigured HSTS with a long max-age can render the site permanently inaccessible until the cache expires in every browser that saw it.

### 1.2 Avoid Dangerous DOM Sinks
- **DO**: Prefer `textContent` or `innerText` over `innerHTML` when setting text content.
- **DO**: Use `setHTML()` (part of the Sanitizer API; see `sanitize-untrusted-html` (via `npx -y modern-web-guidance@latest retrieve "sanitize-untrusted-html"`)) when available to safely insert untrusted HTML without going through `innerHTML`.
- **DO NOT**: Use `innerHTML` or `setHTMLUnsafe` with untrusted or unsanitized input.
- **DO**: Use DOMParser or create elements programmatically (`document.createElement`) instead of concatenating HTML strings.

**Dangerous sinks to grep for**: `innerHTML`, `outerHTML`, `document.write`, `eval`, `setTimeout` with a string argument, `script.src`.

**Code Pattern:**
```javascript
// Unsafe
element.innerHTML = `Hello, ${untrustedName}!`;

// Safe
element.textContent = `Hello, ${untrustedName}!`;
```

Trusted Types can enforce this pattern at runtime by blocking string assignments to dangerous sinks. Deploying it is a CSP enforcement step with real breakage risk — see §3.3.

### 1.3 Secure Cookies
Ensure session and application cookies are configured securely by default, whether set via `Set-Cookie` headers or framework session configuration (such as Astro or Express session middleware).
- **DO**: Name first-party session cookies with the `__Host-` prefix (`name: '__Host-session'`) when used by a single domain. This requires `Secure` (`secure: true`), `Path=/` (`path: '/'`), and omitting the `Domain` attribute, protecting against same-site and network attackers.
- **DO**: Prefer naming cookies with the `__Secure-` prefix when `__Host-` isn't appropriate. This requires the `Secure` attribute, and protects against network attackers.
- **DO**: Set `HttpOnly` (`httpOnly: true`) on session and authentication cookies so they cannot be read by injected client-side scripts, and explicitly set `SameSite=Lax` (`sameSite: 'lax'`) for standard first-party cookies.
- **DO**: If your application will be embedded as an iframe in third-party contexts, use `SameSite=None; Secure; Partitioned`.
- **DO NOT**: Rely on unpartitioned `SameSite=None` — these are being systematically blocked for tracking prevention.

```http
Set-Cookie: __Host-session_id=value; SameSite=Lax; HttpOnly; Secure; Path=/
Set-Cookie: third_party_var=value; SameSite=None; Secure; Partitioned
```

### 1.4 Clickjacking Protection (Frame-Ancestors & X-Frame-Options)
Clickjacking protection is easy to deploy, carries extremely low risk of breaking legitimate functionality, and provides immediate defense against malicious UI redressing. Choose the policy tier that matches your framing requirements:
- **DO (Default — no framing needed)**: Set `Content-Security-Policy: frame-ancestors 'none'` alongside `X-Frame-Options: DENY` when your pages never need to be embedded in an iframe.
- **DO (Same-origin framing only)**: Set `Content-Security-Policy: frame-ancestors 'self'` alongside `X-Frame-Options: SAMEORIGIN` when your application embeds its own pages in same-origin iframes.
- **DO (Specific cross-origin framing required)**: Set `Content-Security-Policy: frame-ancestors 'self' https://trusted-partner.com` and **omit `X-Frame-Options`** (`X-Frame-Options` cannot express cross-origin allowlists—`ALLOW-FROM` is obsolete and unsupported—and `DENY` or `SAMEORIGIN` would block the embed in any client that evaluates `X-Frame-Options` without `frame-ancestors`).
- **DO (Arbitrary framing explicitly required)**: Only omit both `frame-ancestors` and `X-Frame-Options` on routes designed as publicly embeddable widgets.

```http
# Default (never framed):
Content-Security-Policy: frame-ancestors 'none';
X-Frame-Options: DENY

# Same-origin framing allowed:
Content-Security-Policy: frame-ancestors 'self';
X-Frame-Options: SAMEORIGIN

# Specific cross-origin framing allowed (omit X-Frame-Options):
Content-Security-Policy: frame-ancestors 'self' https://trusted-partner.com;
```

### 1.5 Secure Window Messaging (postMessage)
If your application communicates with other origins using `window.postMessage`, you must strictly validate the sender and receiver.
- **DO**: Always validate the `event.origin` of incoming messages on the receiver side using strict equality against a list of trusted origins (or use the `Origin` API when comparing against URLs/elements, checking schemeful same-site relationships, or distinguishing opaque sandboxed iframe origins; see `validate-origins` (via `npx -y modern-web-guidance@latest retrieve "validate-origins"`)). Do **not** trust wildcards (`*`), substring checks, or unverified payloads.
- **DO**: Always specify a target origin (rather than the wildcard `*`) when calling `postMessage` to send sensitive data, ensuring only the intended origin can receive it.
- **DO**: Validate and sanitize the properties of incoming message payloads before performing operations or writing them to DOM sinks. Manual JSON serialization is unnecessary as `postMessage` handles object cloning internally.

```javascript
// Receiver (Safe - traditional string check)
window.addEventListener('message', (event) => {
  if (event.origin !== 'https://trusted-origin.com') return;
  const data = event.data;
  if (data && data.action === 'update') {
    // Process data safely
  }
});

// Sender (Safe)
targetWindow.postMessage({ action: 'update' }, 'https://trusted-origin.com');
```

### 1.6 Secure WebSocket Connections
Browsers do **not** enforce CORS on WebSocket handshakes and still attach eligible cookies to upgrade requests (including `SameSite=Lax` and `SameSite=Strict` cookies from same-site subdomains or ports, `SameSite=None` cookies cross-site, and unattributed cookies in browsers without `Lax`-by-default), so WebSocket endpoints require explicit server-side `Origin` validation to prevent Cross-Site WebSocket Hijacking (CSWSH).
- **DO**: Use `wss://` (TLS) for non-local public WebSocket endpoints. Although `https://` Mixed Content blocks public `ws://` connections, `http://` pages and hardcoded `ws://` configurations remain vulnerable; reserve `ws://` for loopback development or explicit Local Network Access exemptions (private IP literals and `.local` mDNS hostnames; see `local-network-access` (via `npx -y modern-web-guidance@latest retrieve "local-network-access"`)).
- **DO**: Strictly validate the `Origin` header against an explicit allowlist of trusted origins inside the WebSocket handshake handler (for example, an HTTP/1.1 `upgrade` or HTTP/2 Extended `CONNECT` handler), rejecting missing or unexpected origins with HTTP `403` before completing the handshake.
- **DO NOT**: Rely on `Sec-Fetch-*` headers instead of `Origin` on WebSocket handshakes — not all browsers send `Sec-Fetch-*` on WebSocket upgrades (so rejecting missing headers breaks connections, while allowing missing headers leaves those browsers unprotected), and `Sec-Fetch-Site: same-site` still permits untrusted subdomains.
- **DO NOT**: Pass authentication tokens or secrets in WebSocket URL query parameters (`wss://example.com/ws?token=...`) or `Sec-WebSocket-Protocol` headers — both leak credentials into server access logs and proxies.
- **DO**: Authenticate WebSocket sessions by pairing strict server-side `Origin` validation with hardened session cookies (§1.3 — note that `__Host-` cookies are host-only and will not be sent to a separate WebSocket subdomain, which requires `__Secure-` with `Domain` or non-cookie auth), or by requiring authentication in the first WebSocket message over `wss://` (closing the socket after a short timeout if unauthenticated).

```javascript
import { WebSocketServer } from 'ws';

// Replace with your application's trusted origin(s)
const ALLOWED_ORIGINS = new Set(['https://app.example.com']);
// Use noServer so `ws` does not register a competing `upgrade` listener that bypasses checks.
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  // Node drops its default socket error handler on `upgrade`; prevent unhandled ECONNRESET crashes.
  socket.on('error', () => {});

  const origin = req.headers.origin;
  if (!origin || !ALLOWED_ORIGINS.has(origin)) {
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    return;
  }

  // Verify the hardened session cookie (§1.3) or enforce first-message auth with a short timeout.
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});
```

## Phase 2: Discovery & Data Collection (Prerequisites)

Do not blindly apply strict policies to an existing application. You must first understand the application's constraints by collecting data.

### 2.1 Inspect the Application
Before turning anything on, gather facts:
- **Grep for existing security headers** in server config, middleware, CDN/edge config, and meta tags: `Content-Security-Policy`, `Strict-Transport-Security`, `X-Frame-Options`, `X-Content-Type-Options`, `Permissions-Policy`, `Cross-Origin-*`, `Access-Control-*`, `Timing-Allow-Origin`, `Reporting-Endpoints`.
- **Enumerate inline scripts and styles** in server-rendered templates and static HTML — these will need nonces, hashes, or refactoring.
- **List third-party script origins** loaded by the app (analytics, ads, tag managers, CDNs). These dictate what `script-src` must allow or whether `'strict-dynamic'` is viable.
- **Identify popup-dependent flows**: OAuth, payment gateways, SSO. These constrain COOP choices.
- **Identify cross-origin embeds and embedders**: iframes the app loads, and sites that embed the app. These constrain COEP/CORP/`frame-ancestors`.
- **Enumerate required browser features**: List any features (camera, geolocation, microphone, fullscreen) used by the app or embedded third-party widgets to inform `Permissions-Policy`.
- **Identify dynamic dependencies**: Check if third-party scripts are versioned or if they receive silent updates, determining if `SRI` can be used.
- **Map cross-site integrations**: List all incoming Webhooks, cross-site APIs, or SSO redirect endpoints so `Fetch Metadata` resource isolation policies don't break them.

### 2.2 Deploy Report-Only Policies
Use "Report-Only" headers to identify potential breakages before they happen.
- **DO**: Use report-only headers to dry-run policies without enforcement. Standard report-only headers include:
  - `Content-Security-Policy-Report-Only` for CSP rules.
  - `Cross-Origin-Opener-Policy-Report-Only` for COOP isolation.
  - `Cross-Origin-Embedder-Policy-Report-Only` for COEP isolation.
  - `Document-Policy-Report-Only` for document features.
- **DO**: Define a `Reporting-Endpoints` header so violations have somewhere to go, and reference its name from `report-to`. Recommend setting an endpoint named `default`, which will automatically capture deprecation and crash reports.
- **DO**: Run report-only for long enough to cover real traffic patterns (typically days to weeks), not just synthetic testing.

**Example headers:**
```http
Reporting-Endpoints: default="https://reports.example/default", main-endpoint="https://reports.example/main"
Content-Security-Policy-Report-Only: script-src 'nonce-{RANDOM}' 'strict-dynamic' 'report-sample'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; require-trusted-types-for 'script'; report-to main-endpoint;
```

The `'strict-dynamic'`, `https:`, and `'unsafe-inline'` tokens together form a backwards-compatibility ladder: modern browsers honor `'strict-dynamic'` (nonce-propagating) and ignore the others; older browsers fall back to `https:`; very old browsers fall back to `'unsafe-inline'`. The fallbacks are harmless on any browser that supports a stricter token.

**Managing report false-positives**: Reporting endpoints receive a significant volume of false-positive violation reports caused by client-side middleware, aggressive browser extensions, ancient browsers, web crawlers, or antivirus scanners. When analyzing report-only logs, focus on high-frequency patterns from modern user-agents and filter out noise before making deployment decisions. Specifically:
- **Filter out noise**: Ignore reports sent by old browsers with known bugs triggering spurious violations, reports for markup known to be injected by popular browser extensions or client-side middleware (like identical reports seen across many distinct applications), and reports that do not contain enough information to debug.
- **Ignore low-volume reports**: If a policy is deployed, a low violation volume often indicates a false positive that can be safely ignored.
- **Leverage `'report-sample'`**: Always include `'report-sample'` in your `script-src` directives. This instructs the browser to include the first 40 characters of the violating script or inline code snippet in the violation report, which makes debugging much easier.

### 2.3 Data Hygiene for Reports
- **DO NOT**: Include sensitive data (PII, authentication tokens, session identifiers, query strings with secrets) in logs or violation reports. Mask or omit them at the edge before they reach the reporting endpoint.

### 2.4 Automated Discovery via Browser APIs and DevTools
- **Reporting API**: Use `Reporting-Endpoints` in combination with report-only headers (e.g., `Content-Security-Policy-Report-Only`, `Document-Policy-Report-Only`) to have the browser automatically post violations to your server.
- **Browser DevTools**: Use the **Issues Tab** in modern browsers (e.g., Chrome DevTools). It automatically surfaces blocked resources, mixed content, third-party cookie deprecation warnings, and feature policy violations without you having to crawl the codebase manually.

## Phase 3: Interpreting Results & Enforcement

After inspecting the application (or collecting report-only data), enforce your security policies. Phase 3 has two tracks that are enforced together:

- **Core enforcement** — high-leverage XSS and isolation defenses (`Content-Security-Policy`, Trusted Types, COOP, CORP, and Fetch Metadata).
- **Companion policies (deploy in parallel)** — low-risk headers (`Strict-Transport-Security`, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, `Clear-Site-Data`) that should always be enabled alongside core enforcement.

### Core enforcement

#### 3.1 Analyzing CSP Reports

When reviewing CSP violation reports, first separate the noise (per §2.2) from legitimate application issues. For violations that appear to be caused by an incompatibility in your application (usually those where the "Sample" or "Blocked URI" seem like legitimate scripts or assets that might be present in your markup):
- **Code Search**: Search your codebase for the offending script source, URL, or hash to see if it is present in your code, dynamic server templates, or static HTML files.
- **Console Auditing**: Open the page that triggered the violation (the "Document URI" in the report) using the same browser, and check the developer tools/console for CSP violations while exercising as much application functionality as possible (some violations only trigger on specific user interactions).

Once filtered and triaged, analyze the reports against the following common scenarios:

- **Scenario**: Many violations for inline scripts.
  - **Condition**: The app uses a framework that relies on inline scripts.
  - **Decision**: Implement Nonces (server-rendered) or Hashes (static) before enforcing.
- **Scenario**: Violations for third-party analytics scripts.
  - **Condition**: The scripts are required.
  - **Decision**: Use `'strict-dynamic'` with a per-request nonce so the analytics loader can attach its dependencies. Do **not** add the analytics origin to a URL allowlist — domain allowlists are bypassable via open redirects, JSONP, and dependency injection on the listed origin.
- **Scenario**: Trusted Types violations on specific sinks.
  - **Condition**: Legacy code paths still write strings to `innerHTML` etc.
  - **Decision**: Refactor those sinks (per §1.2) or route them through a Trusted Types policy (§3.3) before enforcing.

#### 3.2 Enforcing Content Security Policy (CSP)
When enforcing `Content-Security-Policy`, always keep `Reporting-Endpoints` and `report-to` wired up on the enforced header so any regressions remain visible.

**Mandatory directives to set:**
- `script-src 'nonce-{RANDOM}' 'strict-dynamic' 'report-sample'` (or SHA-256/384/512 script hashes for static HTML) — the core directive of any CSP and the primary mechanism to prevent XSS.
- `object-src 'none'` — blocks plugin-based code execution (`<object>`, `<embed>`).
- `base-uri 'none'` — blocks `<base>` tag hijacking of relative URLs.
- `frame-ancestors 'none'` (or `'self'` when same-origin framing is needed) — prevents clickjacking alongside `X-Frame-Options: DENY` (or `SAMEORIGIN`; see §1.4).
- `require-trusted-types-for 'script'` — enforces Trusted Types runtime checks on DOM XSS sinks (§3.3).
- `report-to <endpoint>` — sends violation reports to the endpoint defined in `Reporting-Endpoints`.
- *Optional*: `form-action 'self'` prevents form submissions to attacker-controlled origins.

**Enforced Header Example (CSP with reporting):**
```http
Reporting-Endpoints: main-endpoint="https://reports.example/main"
Content-Security-Policy: script-src 'nonce-{RANDOM}' 'strict-dynamic' 'report-sample'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; require-trusted-types-for 'script'; report-to main-endpoint;
```

HTML for nonce-based CSP:
```html
<script nonce="{RANDOM}" src="https://example.com/script.js"></script>
```

**Server / Middleware Per-Request Nonce Generation:**
In server-rendered or SSR middleware (such as Node.js, Express, or Astro middleware), generate a fresh cryptographic nonce on every request, attach it to `Content-Security-Policy`, and pass the nonce into your template/SSR rendering context so only trusted template `<script>` tags receive it:

```javascript
const bytes = new Uint8Array(16);
crypto.getRandomValues(bytes);
const nonce = btoa(String.fromCharCode(...bytes));

const csp = [
  `script-src 'nonce-${nonce}' 'strict-dynamic' 'report-sample'`,
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'", // or "frame-ancestors 'self'" if same-origin framing is needed
  "require-trusted-types-for 'script'",
  'report-to main-endpoint',
].join('; ');

headers.set('Reporting-Endpoints', 'main-endpoint="https://reports.example/main"');
headers.set('Content-Security-Policy', csp);

// Pass the per-request nonce into your template/SSR rendering context (or replace an
// explicit placeholder token in a static template before interpolating any user data):
res.locals.nonce = nonce; // e.g., <script nonce="<%= nonce %>" src="/app.js"></script>
```

For static/cached HTML (SPAs) where a per-response nonce is not possible, use hash-based CSP: compute the `sha256-` hash of each script and list the hashes in `script-src` alongside `'strict-dynamic' 'report-sample'`.

**Avoid**:
- Broad scheme or domain allowlists (such as `https:` alone or `script-src https://cdn.example.com` without `'strict-dynamic'`) as the primary `script-src` protection — they are easily bypassed by open redirects, JSONP endpoints, and dependency injection on the allowed origin.
- Rewriting already-rendered HTML with a regular expression (such as `html.replace(/<script\b.../gi, ...)`) to stamp CSP nonces onto every `<script>` tag — post-processing rendered HTML cannot distinguish developer-authored `<script>` tags from untrusted `<script>` tags introduced via reflected or stored HTML injection, authorizing attacker-injected scripts under `script-src 'nonce-...'`.

#### 3.3 Trusted Types Enforcement
Trusted Types enforces source-level guidance at runtime by blocking raw string assignments to dangerous DOM XSS sinks (`innerHTML`, `outerHTML`, `document.write`, `script.src`, `script.textContent`) unless they pass through a named policy.

- **DO**: Enforce Trusted Types in your `Content-Security-Policy` header by including the `require-trusted-types-for 'script'` directive.
- **DO**: Sanitize any HTML sink assignments through a named `trustedTypes.createPolicy(...)` instance rather than assigning raw strings (or prefer `element.setHTML()` directly, which sanitizes HTML without needing a Trusted Types policy).
- **DO NOT**: Create a pass-through policy (such as `createHTML: (s) => s`) that returns unsanitized input unchanged, as this neutralizes Trusted Types protection.
- **DO**: Consult the dedicated `trusted-types` (via `npx -y modern-web-guidance@latest retrieve "trusted-types"`) guide for full implementation details, including `trusted-types` policy allowlisting and rollout strategies.

```javascript
const htmlPolicy = window.trustedTypes?.createPolicy('app-html', {
  createHTML(input) {
    return String(input)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  },
});
```

#### 3.4 Cross-Origin Opener Policy (COOP)

Lowest-risk of the three. Deploy if the app is **not** an OAuth provider, payment processor, or otherwise expected to be reached from an opener.

- **DO**: Use `Cross-Origin-Opener-Policy: same-origin-allow-popups` — prevents a malicious opener from mounting XS-leaks attacks while still allowing OAuth and payment flows that *the app itself* initiates.
- **DO NOT**: Jump straight to `same-origin` unless you have explicitly verified that no integrations rely on cross-origin `window.opener` access.

#### 3.5 Cross-Origin Resource Policy (CORP)

Set CORP explicitly on each response based on whether it should be embeddable in other contexts. Two core benefits: it protects resources from malicious cross-origin reads, and ensures compatibility when pages request stronger client-side isolation.

- **DO**: Default to `Cross-Origin-Resource-Policy: same-origin` for app-internal responses (such as HTML documents, internal endpoints, authenticated data, user session JSON, and restricted internal scripts).
- **DO**: Use `same-site` for endpoints utilized across subdomains of the same eTLD+1.
- **DO**: Provide `cross-origin` exclusively for resources created for generic embedding or widely cached delivery (e.g., static shared assets or public CDNs).

#### 3.6 Cross-Origin Isolation

Highest deployment breakage risk. You only need to deploy this infrastructure if the application requires features relying on `SharedArrayBuffer` (e.g., WebAssembly multi-threading or shared memory architectures). If not required, skip this policy group.

- **DO (Cross-browser default — COOP + COEP)**: Serve the document with `Cross-Origin-Opener-Policy: same-origin` coupled with `Cross-Origin-Embedder-Policy: require-corp` (or `Cross-Origin-Embedder-Policy: credentialless` where supported). Under `require-corp`, every cross-origin subresource (images, scripts, styles, media) MUST explicitly opt in via either a `Cross-Origin-Resource-Policy` header (`cross-origin` or `same-site`) or CORS (`crossorigin` attribute paired with `Access-Control-Allow-Origin`), and any embedded cross-origin `<iframe>` must both send `Cross-Origin-Resource-Policy` (`cross-origin` or `same-site`) and enforce COEP, or the browser will block it.

```http
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
Cross-Origin-Resource-Policy: same-origin
```

Browser support for Document-Isolation-Policy: Limited availability.
Supported by: Chrome 137 (May 2025) and Edge 137 (May 2025).
Unsupported in: Firefox and Safari.

- **DO (Alternative where supported — Document-Isolation-Policy)**: Where supported, you can serve `Document-Isolation-Policy: isolate-and-credentialless` on the document requiring `SharedArrayBuffer` to isolate at the document level without severing cross-origin `window.opener` popup references or requiring embedded third-party iframes to deploy COEP, while stripping cookies and credentials from non-CORS cross-origin subresource requests. Use `Document-Isolation-Policy: isolate-and-require-corp` instead if you need to block cross-origin subresources lacking explicit CORP or CORS opt-in.

#### 3.7 Fetch Metadata (Resource Isolation)
Server-side enforcement that uses `Sec-Fetch-*` request headers to reject suspicious cross-site requests. Requires the cross-site integration mapping from §2.1 before enforcing.

- **DO**: Implement a server-side resource isolation policy that checks `Sec-Fetch-*` headers and rejects `cross-site` requests for non-navigational endpoints.
- **DO**: Reject disallowed requests *before* authentication or authorization checks, so the response does not leak timing information about whether a resource or session exists.
- **DO**: Include `Vary: Sec-Fetch-Dest, Sec-Fetch-Mode, Sec-Fetch-Site` to prevent intermediate caches (CDNs) from serving cached responses to attackers.
- **CAUTION**: `same-site` trusts every subdomain under your eTLD+1. If any subdomain hosts user-generated content, a legacy app, or otherwise untrusted code, drop `same-site` from the allowlist and accept only `same-origin` and `none`.
- **CAUTION**: Misconfiguring these checks will block legitimate API requests coming from cross-site integrations, SSO handlers, or Webhooks. Ensure you log and test your `Sec-Fetch-*` constraints beforehand.
- **CAUTION**: Fetch Metadata middleware does not cover WebSocket handshakes; validate `Origin` in your WebSocket handshake handler (see §1.6).

```javascript
app.use((req, res, next) => {
  res.setHeader('Vary', 'Sec-Fetch-Dest, Sec-Fetch-Mode, Sec-Fetch-Site');

  const site = req.get('Sec-Fetch-Site');
  const mode = req.get('Sec-Fetch-Mode');
  const dest = req.get('Sec-Fetch-Dest');

  if (!site) return next(); // Fallback for legacy browsers

  if (['same-origin', 'same-site', 'none'].includes(site)) return next();

  // Allow standard navigate GET requests (link clicks)
  if (site === 'cross-site' && mode === 'navigate' && req.method === 'GET' && !['object', 'embed'].includes(dest)) {
    return next();
  }

  res.status(403).send('Forbidden');
});
```

### Companion policies (deploy in parallel)

These carry significantly lower breakage risk than the core enforcement track. They can be deployed alongside — or before — the CSP and isolation rollouts.

#### HTTP Strict Transport Security (HSTS)
- **DO**: `Strict-Transport-Security: max-age=31536000; includeSubDomains; preload` to force HTTPS.
- **TIP**: In production rollout, start with a short `max-age` (e.g., 300 seconds) and incrementally increase to 1 year. A misconfigured HSTS with a long max-age can render the site permanently inaccessible until the cache expires in every browser that saw it.

#### X-Content-Type-Options
- **DO**: Set `X-Content-Type-Options: nosniff` to block MIME-type sniffing.
- **DO**: Ensure the server serves correct `Content-Type` headers for all resources (`application/javascript` for scripts, `application/json` for APIs, `text/html` for documents, etc.) so the browser can strictly enforce the `nosniff` constraint.

#### Referrer Policy
- **DO**: Use `Referrer-Policy: strict-origin-when-cross-origin` as a safe default.

#### Permissions Policy
- **DO**: Disable unused browser features (camera, geolocation, microphone) for the page and iframes using Structured Fields syntax.
- **DO**: When delegating features to an iframe, use the `allow` attribute in HTML *in addition* to the header.
- **CAUTION**: Unintentionally blocking a delegated feature will cause silent failures in third-party widgets (like embedded video players or payment gateways). Audit third-party dependencies before blocking.

```http
Permissions-Policy: camera=(), geolocation=(), microphone=()
```

```html
<iframe src="https://trusted-video.com/player" allow="fullscreen"></iframe>
```

#### Subresource Integrity (SRI)
- **DO**: Use the `integrity` attribute with a cryptographic hash (preferring `sha384`, `sha512`, or `sha256`) when loading third-party scripts and stylesheets, combined with `crossorigin="anonymous"` (see `secure-external-subresources` (via `npx -y modern-web-guidance@latest retrieve "secure-external-subresources"`) for securing HTML and CSS subresources with SRI, CORS, and Referrer Policy).
- **DO**: Ensure the server/CDN sends an appropriate `Access-Control-Allow-Origin` header so the browser can compute the hash.
- **DO NOT**: Use SRI for dynamic or unversioned assets — silent updates will cause script execution to fail. SRI is strictly for immutable, versioned assets.

```html
<script src="https://cdn.example.com/lib@1.0.0.js" integrity="sha384-oqVu...Y8wC" crossorigin="anonymous"></script>
```

#### Cross-Origin Resource Sharing (CORS)
CORS is a permission grant, not a defense — it tells the browser which cross-origin reads to allow. The risk is misconfiguring it as too permissive.

- **DO**: Validate the `Origin` header on the server and set `Access-Control-Allow-Origin` dynamically to specific origins (rather than wildcard `*`).
- **DO NOT**: Use wildcard `*` for `Access-Control-Allow-Origin` if `Access-Control-Allow-Credentials: true` is required — the browser will reject the response.
- **DO**: Handle preflight (`OPTIONS`) requests by returning appropriate headers before processing data.

```http
Access-Control-Allow-Origin: https://trusted-app.com
Access-Control-Allow-Credentials: true
```

#### Clear-Site-Data (Logout)
- **DO**: Send `Clear-Site-Data: "cookies", "storage", "cache"` on logout endpoints to ensure complete session termination; omitting any of these directives leaves active session cookies, Web Storage state, or cached authenticated pages behind.

```http
Clear-Site-Data: "cookies", "storage", "cache"
```
