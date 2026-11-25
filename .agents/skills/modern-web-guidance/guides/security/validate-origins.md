# Compare and validate web origins and sites

While comparing `event.origin` against a fixed, port-normalized string literal (such as `event.origin === 'https://app.example.com'`) works for simple allowlists, manual string comparisons and regular expressions break down when validating arbitrary URLs, DOM link elements, cross-subdomain redirects, or sandboxed messages:

- **Prefix and substring spoofing:** Checking `url.startsWith('https://app.example.com')` is bypassed by `'https://app.example.com.attacker.example'`.
- **Unnormalized URLs:** Full URLs with paths, query strings, or explicit default ports (`'https://app.example.com:443/path'`) do not match `'https://app.example.com'` under string equality without first parsing and normalizing.
- **Public Suffix List mistakes:** Splitting hostnames on `.` to check same-site relationships fails on multi-label public suffixes (such as `.co.uk` or shared hosting domains like `.github.io`) and ignores scheme mismatches (`http:` vs. `https:`).
- **Opaque `"null"` origin collisions:** Sandboxed iframes (`<iframe sandbox="allow-scripts">`) and `data:` URLs serialize `event.origin` to the literal string `"null"`. Comparing two serialized runtime origins with `originA === originB` falsely equates two unrelated opaque contexts (`"null" === "null"`).

The **`Origin` API** (`Origin.from()`, `isSameOrigin()`, `isSameSite()`, and `opaque`) provides structured, spec-compliant origin and schemeful same-site comparisons backed by the browser's URL parser and Public Suffix List.

## Choosing the right comparison for your scenario

- **Use `isSameOrigin()` for strict privilege boundaries:** Require an exact `(scheme, host, port)` match when handling cross-window `postMessage` commands (such as an embedded checkout or auth popup) or deciding whether to attach credentials. Even a different subdomain (`https://blog.example.com` vs. `https://app.example.com`) is a different origin and must be rejected so a vulnerability on one subdomain cannot control another.
- **Use `isSameSite()` for cross-subdomain navigation and link classification:** Allow any subdomain or port sharing the same scheme and registrable domain when validating post-login redirect URLs (`?returnTo=https://billing.example.co.uk/orders`) or classifying links as internal vs. external. `isSameSite()` rejects both `http:` scheme downgrades and sibling tenants on shared public suffixes (`.co.uk`, `.github.io`).
- **Use `origin.opaque` and `Origin.from(event)` for opaque or sandboxed contexts:** Reject `data:` URLs for redirects (`origin.opaque === true`), or pin the opaque `Origin` extracted via `Origin.from(event)` when communicating with a specific `<iframe sandbox="allow-scripts">` widget whose serialized `event.origin` is `"null"`.

## 1. Verify Exact Origins for Privileged Actions (`Origin.from()` and `isSameOrigin()`)

Use `Origin.from()` to extract an `Origin` object and compare it against a trusted `Origin` using `isSameOrigin()`:

- **Both sides must be `Origin` instances:** `isSameOrigin(other)` and `isSameSite(other)` only accept an `Origin` object—passing a raw string throws a `TypeError`.
- **Supported `Origin.from()` inputs:**
  - Serialized URL strings (for example, `'https://app.example.com:443/path'`). Note that any invalid URL string—for instance `'example'`, or the `'null'` string serialized by `event.origin` for opaque origins—causes `Origin.from()` to throw a `TypeError`.
  - Platform objects that define origin-extraction steps in the HTML specification: `Origin`, `URL`, `HTMLAnchorElement` (`<a>`), `HTMLAreaElement` (`<area>`), same-origin `Window` or `WorkerGlobalScope` (`Origin.from(self)`), and browser-dispatched `MessageEvent` instances (`Origin.from(event)`).
  - Objects such as `Location`, `WorkerLocation`, `Document`, `Request`, and `Response` do **not** define origin-extraction steps and throw a `TypeError` if passed directly to `Origin.from()`—pass `self` (for the current context) or `request.url` / `response.url` instead.
- **Handle both browser-dispatched and synthetic `MessageEvent` instances:** Real browser `postMessage` events carry an internal origin extracted by `Origin.from(event)`, whereas synthetic `new MessageEvent('message', { origin })` events created in unit tests only populate the `event.origin` string and throw on `Origin.from(event)`. Falling back to `Origin.from(event.origin)` inside a `try...catch` handles both cleanly while still rejecting invalid or `"null"` strings.

```javascript
// Replace with your application's trusted origin(s)
const TRUSTED_ORIGIN = Origin.from('https://app.example.com');

function extractOrigin(candidate) {
  try {
    return Origin.from(candidate);
  } catch (err) {
    // Synthetic new MessageEvent('message', { origin }) objects in tests lack an
    // internal browser origin; fall back to parsing candidate.origin if it is a URL.
    if (typeof MessageEvent !== 'undefined' && candidate instanceof MessageEvent) {
      return Origin.from(candidate.origin);
    }
    throw err;
  }
}

export function isTrustedSameOrigin(candidate) {
  try {
    return extractOrigin(candidate).isSameOrigin(TRUSTED_ORIGIN);
  } catch {
    // Rejects invalid URLs, "null" strings, or unsupported objects
    return false;
  }
}

window.addEventListener('message', (event) => {
  if (!isTrustedSameOrigin(event)) return;

  // Safe to process privileged commands from the verified origin
});
```

## 2. Validate Cross-Subdomain Redirects and Links (`isSameSite()`)

When validating redirect targets (such as `?returnTo=` parameters) or internal links across subdomains of the same registrable domain (for example, `https://app.example.co.uk` and `https://billing.example.co.uk:8443`), use `isSameSite()`:

- `isSameSite()` performs a **schemeful same-site** comparison: `https://sub.example.com` and `http://sub.example.com` are **not** same-site because their schemes differ.
- `isSameSite()` uses the browser's built-in **Public Suffix List**, so distinct tenants on shared public suffixes (such as `https://tenant-a.github.io` and `https://tenant-b.github.io`, or `https://a.co.uk` and `https://b.co.uk`) evaluate to `false`.

```javascript
// Replace with your application's primary origin
const APP_ORIGIN = Origin.from('https://app.example.co.uk');

export function isAllowedSameSiteUrl(candidateUrlOrElement) {
  try {
    return extractOrigin(candidateUrlOrElement).isSameSite(APP_ORIGIN);
  } catch {
    return false;
  }
}

// true: same scheme (https) and same registrable domain (example.co.uk)
isAllowedSameSiteUrl('https://billing.example.co.uk:8443/checkout');

// false: scheme downgrade (http vs. https) is rejected by schemeful same-site
isAllowedSameSiteUrl('http://billing.example.co.uk/checkout');
```

## 3. Distinguish and Pin Opaque Origins (`origin.opaque` and `Origin.from(event)`)

Sandboxed iframes (`<iframe sandbox="allow-scripts">`), `data:` URLs, and `new Origin()` produce **opaque origins** (`origin.opaque === true`). While their string serialization is always `"null"`, `Origin.from(event)` extracts the sender's actual underlying opaque origin from a browser-dispatched `MessageEvent`:

- Two messages sent from the **same** sandboxed iframe yield `Origin` objects that are `isSameOrigin()` with each other (`true`).
- Messages sent from **different** sandboxed iframes—or separate `Origin.from('data:...')` / `new Origin()` calls—yield distinct opaque origins that evaluate `isSameOrigin()` to `false`, preventing `"null" === "null"` spoofing across unrelated opaque contexts.
- `new Origin()` creates a fresh, unique opaque origin that matches nothing except itself, which is useful as a default deny-all sentinel before an expected peer origin is pinned once on initialization.

```javascript
// Initialize with a unique opaque sentinel that matches no other origin
let pinnedSandboxOrigin = new Origin();
let isSandboxPinned = false;

export function handleSandboxedWidgetMessage(event, expectedWidgetWindow) {
  try {
    const senderOrigin = Origin.from(event);

    // Pin the opaque origin only once on initialization from the expected sandboxed iframe
    if (!isSandboxPinned && event.source === expectedWidgetWindow && event.data?.type === 'init') {
      pinnedSandboxOrigin = senderOrigin;
      isSandboxPinned = true;
    }

    // Subsequent messages from the SAME sandboxed iframe match pinnedSandboxOrigin;
    // messages from any other sandboxed iframe (also event.origin === "null") return false.
    return senderOrigin.isSameOrigin(pinnedSandboxOrigin);
  } catch {
    return false;
  }
}
```

## Best practices

- **DO** convert both sides of a comparison to `Origin` instances via `Origin.from()` before calling `isSameOrigin(other)` or `isSameSite(other)`.
- **DO** pass a browser-dispatched `MessageEvent` directly to `Origin.from(event)` when you need to preserve opaque origin identity, and use `Origin.from(self)` (rather than `Location` or `Document`, which throw `TypeError`) to obtain the current execution context's `Origin`.
- **DO** wrap `Origin.from()` calls on untrusted or runtime inputs in a `try...catch` block so invalid URLs, `"null"` strings, or unsupported objects safely return `false` instead of throwing an uncaught `TypeError`.
- **DO NOT** compare two runtime `event.origin` or `url.origin` strings directly without first rejecting `"null"` (`origin !== 'null'`), as two unrelated opaque origins both serialize to `"null"`.
- **DO NOT** validate origins or sites with `startsWith()`, `includes()`, `endsWith()`, or naive `.split('.')` hostname slicing.

## Fallback strategy

Browser support for Origin: Limited availability.
Supported by: Chrome 145 (Feb 2026), Edge 145 (Feb 2026), and Safari 26.5 (May 2026).
Unsupported in: Firefox.

If your Baseline target includes browsers that do not yet support the `Origin` interface, feature-detect `'Origin' in globalThis` and fall back to parsing URLs with `new URL()`:

- **Same-origin fallback (tuple origins):** Extract the URL string (using `event.origin` for `MessageEvent` objects or `candidate.href` for link elements), parse both the candidate and trusted URLs with `new URL()`, reject `"null"` opaque origins (`candidateUrl.origin !== 'null'`), and compare `candidateUrl.origin === trustedUrl.origin`. Because an opaque origin is never same-origin with a tuple origin like `'https://app.example.com'`, immediately rejecting `'null'` matches `Origin.isSameOrigin()`.
- **Same-site fallback (caveat):** The `URL` interface does not expose the browser's Public Suffix List. In browsers without `Origin`, only perform suffix matching against an explicit, known private registrable domain that you control (verifying both `protocol` and an exact or dot-prefixed `hostname` match), or use a maintained Public Suffix List library.
- **Opaque / sandboxed iframe fallback:** Browsers without `Origin` do not expose distinct opaque origin identities on `MessageEvent` (`event.origin` is always `"null"`). If you intentionally accept messages from a known sandboxed `<iframe sandbox="allow-scripts">`, verify `event.source === expectedWidgetWindow` (or communicate over a dedicated `MessageChannel` `MessagePort` transferred to the iframe on initialization) rather than comparing `event.origin`.

```javascript
// Replace with your trusted reference URL and known registrable domain
const TRUSTED_URL = 'https://app.example.com';
const TRUSTED_SITE_DOMAIN = 'example.com';

function extractUrlString(candidate) {
  if (typeof candidate === 'string') return candidate;
  if (typeof MessageEvent !== 'undefined' && candidate instanceof MessageEvent) {
    return candidate.origin;
  }
  if (candidate === globalThis) {
    return globalThis.location?.href ?? '';
  }
  return candidate?.href ?? '';
}

function extractOrigin(candidate) {
  try {
    return Origin.from(candidate);
  } catch (err) {
    if (typeof MessageEvent !== 'undefined' && candidate instanceof MessageEvent) {
      return Origin.from(candidate.origin);
    }
    throw err;
  }
}

export function checkSameOriginWithFallback(candidate) {
  try {
    if ('Origin' in globalThis) {
      return extractOrigin(candidate).isSameOrigin(Origin.from(TRUSTED_URL));
    }
    const candidateUrl = new URL(extractUrlString(candidate));
    const trustedUrl = new URL(TRUSTED_URL);
    return candidateUrl.origin !== 'null' && candidateUrl.origin === trustedUrl.origin;
  } catch {
    return false;
  }
}

export function checkSameSiteWithFallback(candidate) {
  try {
    if ('Origin' in globalThis) {
      return extractOrigin(candidate).isSameSite(Origin.from(TRUSTED_URL));
    }
    const candidateUrl = new URL(extractUrlString(candidate));
    const trustedUrl = new URL(TRUSTED_URL);
    return (
      candidateUrl.origin !== 'null' &&
      candidateUrl.protocol === trustedUrl.protocol &&
      (candidateUrl.hostname === TRUSTED_SITE_DOMAIN ||
        candidateUrl.hostname.endsWith(`.${TRUSTED_SITE_DOMAIN}`))
    );
  } catch {
    return false;
  }
}
```
