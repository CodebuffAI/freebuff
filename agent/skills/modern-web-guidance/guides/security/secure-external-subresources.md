# Secure external subresources with Subresource Integrity, CORS, and Referrer Policy

When loading scripts, stylesheets, fonts, or images from third-party CDNs or external origins, verify their cryptographic integrity with Subresource Integrity (`integrity` in HTML and `integrity()` in CSS `url()`), configure cross-origin credential handling (`crossorigin` and `cross-origin()`), and restrict outgoing `Referer` headers (`referrerpolicy` and `referrer-policy()`). For document-level Content Security Policy and outbound connection allowlists, see `security` (via `npx -y modern-web-guidance@latest retrieve "security"`) and `restrict-outbound-connections` (via `npx -y modern-web-guidance@latest retrieve "restrict-outbound-connections"`).

## 1. Generate cryptographic integrity digests for immutable assets

Subresource Integrity (SRI) ensures the browser only executes or renders an external asset if its bytes match the cryptographic hash declared by your application.

- **Compute digests at build or release time, never from live untrusted responses**: Generate integrity hashes during your build or release step from known-good local asset bytes (or copy the official digest published by the package author) and hardcode them into your HTML, CSS, or JavaScript. Never fetch a third-party URL in the browser at runtime to compute its own `integrity` hash, which trusts whatever bytes the remote server returns and defeats SRI.
- **Use `sha384-` by default**: Format integrity metadata as `<algorithm>-<base64-digest>` using `sha384-` (recommended default), `sha512-`, or `sha256-`.
- **Pin external subresources to immutable, versioned URLs**: Always reference third-party assets using immutable, version-pinned or content-addressed URLs (such as `https://cdn.example.com/ui@2.4.0/app.min.js`) rather than mutable floating URLs (`latest/app.min.js`), which expose your site to silent supply-chain changes and break SRI as soon as the remote file updates. If you must load a mutable third-party script that updates in place (such as a vendor analytics tag), omit `integrity` on that URL and restrict it with Content Security Policy (`strict-dynamic` / nonces) or iframe sandboxing instead.
- **Space-separate multiple digests when an endpoint may serve multiple valid payloads**: All browsers that support SRI implement `sha256-`, `sha384-`, and `sha512-`. If a URL may legitimately return one of several known-good payloads (such as during an A/B test, staged CDN rollout, or content-negotiated build), list multiple digests of the same algorithm separated by whitespace (for example, `integrity="sha384-variantA... sha384-variantB..."`). The browser accepts the response if it matches *any* listed digest of the strongest algorithm present.
- **Serve cross-origin subresources with CORS headers**: Browsers can only verify the integrity of a cross-origin response when it is CORS-readable (`Access-Control-Allow-Origin: *` for anonymous requests, or the exact requesting origin with `Access-Control-Allow-Credentials: true` for credentialed requests).

```bash
# Generate a sha384- SRI hash at build time from a known-good local file
printf "sha384-%s\n" "$(openssl dgst -sha384 -binary app.min.js | openssl base64 -A)"
```

```javascript
// Build-time / tooling helper (Node.js 19+, Deno, Bun) to compute an SRI string from known-good local bytes
export async function computeIntegrityMetadata(bytes) {
  const rawBytes =
    typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
  const digestBuffer = await crypto.subtle.digest('SHA-384', rawBytes);
  const binary = Array.from(new Uint8Array(digestBuffer), (b) =>
    String.fromCharCode(b),
  ).join('');
  return `sha384-${btoa(binary)}`;
}
```

## 2. Secure HTML scripts, stylesheets, and preloads

Set a document-level `Referrer-Policy: strict-origin-when-cross-origin` HTTP response header (or include `<meta name="referrer" content="strict-origin-when-cross-origin">` in `<head>`) as a baseline default so any subresource or CSS `url()` that omits a per-request referrer modifier still strips sensitive path and query parameters on cross-origin requests.

Then, on external `<script>`, `<link rel="stylesheet">`, `<link rel="preload">`, and `<link rel="modulepreload">` elements, always set `integrity`, `crossorigin`, and `referrerpolicy` together:

- **`integrity="sha384-..."`**: Blocks execution or application of the resource if the response bytes do not match the expected digest (for a blocked `<link rel="stylesheet">`, `linkElement.sheet` remains `null` and an `error` event fires).
- **`crossorigin="anonymous"`** (recommended default for public CDN assets) or **`crossorigin="use-credentials"`**: Required whenever `integrity` is set on a cross-origin resource. Omitting `crossorigin` causes the browser to fetch the resource in `no-cors` mode (producing an opaque response that cannot be hash-verified) and block the resource.
- **`referrerpolicy="no-referrer"`** (recommended default for third-party CDNs) or **`referrerpolicy="strict-origin-when-cross-origin"`**: Overrides the document referrer policy to prevent leaking any origin or path information in the `Referer` request header to the third-party host.

```html
<!-- Document-level baseline referrer policy in <head> (or via Referrer-Policy HTTP header) -->
<meta name="referrer" content="strict-origin-when-cross-origin" />

<!-- External stylesheet with SRI, anonymous CORS, and no referrer -->
<link
  rel="stylesheet"
  href="https://cdn.example.com/ui@2.4.0/styles.css"
  integrity="sha384-bs0EksOYBbU/g0IAHMXbSyH1Mgw83GKn+EZlSI+VE+zVchXmSbLwhVLrPzsOWnc5"
  crossorigin="anonymous"
  referrerpolicy="no-referrer"
/>

<!-- External script with SRI, anonymous CORS, and no referrer -->
<script
  src="https://cdn.example.com/ui@2.4.0/bundle.min.js"
  integrity="sha384-oqVuAfXRKap7fdgcCY5uykM6+R9GqQ8K/uxy9rx7HNQlGYl1kPzQho1wx4JwY8wC"
  crossorigin="anonymous"
  referrerpolicy="no-referrer"
></script>
```

When fetching external subresources programmatically with `fetch()`, pass the matching `integrity`, `mode`, `credentials`, and `referrerPolicy` options (a digest mismatch rejects the promise with `TypeError`):

```javascript
const response = await fetch('https://cdn.example.com/ui@2.4.0/manifest.json', {
  integrity: 'sha384-oqVuAfXRKap7fdgcCY5uykM6+R9GqQ8K/uxy9rx7HNQlGYl1kPzQho1wx4JwY8wC',
  mode: 'cors',
  credentials: 'omit',
  referrerPolicy: 'no-referrer',
});
```

## 3. Secure CSS images, fonts, and imported stylesheets with `url()` modifiers

CSS `url()` request modifiers (`cross-origin()`, `referrer-policy()`, and `integrity()`) control the fetch mode, referrer header, and Subresource Integrity verification of CSS-loaded resources—including `background-image`, `content`, `mask-image`, `border-image-source`, `filter`, `@font-face` `src`, and `@import` rules—directly from CSS:

| Modifier function | Argument syntax & allowed values | Purpose |
|---|---|---|
| `cross-origin(<ident>)` | **Unquoted keyword**: `anonymous` (recommended default) or `use-credentials` | Fetches the CSS resource using CORS and controls whether credentials are sent. Always include alongside `integrity()` on cross-origin CSS resources. |
| `referrer-policy(<ident>)` | **Unquoted keyword**: `no-referrer` (recommended default for third-party assets), `strict-origin-when-cross-origin`, `origin`, `same-origin`, `strict-origin`, `origin-when-cross-origin`, `no-referrer-when-downgrade`, or `unsafe-url` | Overrides the document referrer policy for this specific CSS request. |
| `integrity("<string>")` | **Quoted string**: `"sha384-<base64>"` (or space-separated digests `"sha384-... sha384-..."`) | Verifies the fetched CSS resource against the expected cryptographic digest before rendering or applying it. |

Follow these CSS syntax and security rules when authoring `url()` modifiers:

- **Quote the URL string inside `url("...")`**: Request modifiers are only valid when the URL inside `url(...)` is a quoted `<string>` (unquoted URLs cannot use modifiers).
- **Specify each modifier type at most once per `url()`**: You can combine `cross-origin()`, `referrer-policy()`, and `integrity()` in any order inside `url("..." ...)`, but repeating the same modifier type twice (such as two `integrity()` modifiers) is invalid. To supply multiple hashes, space-separate them inside a single `integrity("sha384-... sha384-...")` string.
- **Always pair cross-origin `integrity()` with `cross-origin(anonymous)`**: While `@font-face` `src` and `mask-image` already fetch in anonymous `cors` mode by default, `background-image`, `content`, `border-image-source`, and `@import` default to `no-cors` mode (producing an opaque response that cannot be hash-verified) and external SVG `filter` defaults to `same-origin` mode (blocking cross-origin URLs outright). Including `cross-origin(anonymous)` (or `cross-origin(use-credentials)`) ensures consistent CORS verification across every CSS property.
- **Place modifiers inside `url("...")` in `@import` and `@font-face` rules**: Keep `cross-origin()`, `referrer-policy()`, and `integrity()` inside `url("..." ...)`, while keeping font descriptors like `format("woff2")` and `tech(...)` outside `url(...)`.

```css
@import url(
  "https://cdn.example.com/theme@1.2.0/tokens.css"
  cross-origin(anonymous)
  referrer-policy(no-referrer)
  integrity("sha384-bs0EksOYBbU/g0IAHMXbSyH1Mgw83GKn+EZlSI+VE+zVchXmSbLwhVLrPzsOWnc5")
);

@font-face {
  font-family: "BrandSans";
  src: url(
    "https://cdn.example.com/fonts@1.0.0/brand-sans.woff2"
    cross-origin(anonymous)
    referrer-policy(no-referrer)
    integrity("sha384-oqVuAfXRKap7fdgcCY5uykM6+R9GqQ8K/uxy9rx7HNQlGYl1kPzQho1wx4JwY8wC")
  ) format("woff2");
  font-display: swap;
}

.verified-graphic {
  background-image: url(
    "https://cdn.example.com/media@1.0.0/badge.svg"
    cross-origin(anonymous)
    referrer-policy(no-referrer)
    integrity("sha384-Iw/0p59dP96nGTzHvf2XIfqcBwBW7RM6JfOij8uZxyg5azfNaOOUW8SQy6H/hU91")
  );
}
```

## Fallback strategies

Browser support for cross-origin() for url(): Limited availability.
Supported by: Chrome 150 (Jun 2026), Edge 150 (Jul 2026), and Safari 26.2 (Dec 2025).
Unsupported in: Firefox.

Browser support for referrer-policy() for url(): Limited availability.
Supported by: Chrome 150 (Jun 2026), Edge 150 (Jul 2026), and Safari 26.2 (Dec 2025).
Unsupported in: Firefox.

Browser support for integrity() for url(): Limited availability.
Supported by: Chrome 150 (Jun 2026) and Edge 150 (Jul 2026).
Unsupported in: Firefox and Safari.

If your Baseline target does not yet support CSS `url()` request modifiers (`cross-origin()`, `referrer-policy()`, or `integrity()`), combine document-level policies with cascading CSS declarations so subresources remain functional and protected:

1. **Prefer HTML `<link rel="stylesheet">` over CSS `@import` when cross-browser SRI is required**: Because `subresource-integrity` and `referrer-policy` on `<link rel="stylesheet">` are widely available across all browsers, load external stylesheets with `<link rel="stylesheet" href="..." integrity="sha384-..." crossorigin="anonymous" referrerpolicy="no-referrer">` instead of `@import` whenever integrity verification must be enforced in every browser.
2. **Rely on the document-level `Referrer-Policy` header or `<meta name="referrer">` from Step 2**: In browsers that do not support `referrer-policy()` inside CSS `url()`, the document-level `Referrer-Policy: strict-origin-when-cross-origin` header or `<meta name="referrer" content="strict-origin-when-cross-origin">` element automatically strips sensitive path and query parameters on cross-origin CSS requests.
3. **Cascade separate CSS declarations for progressive enhancement**: Browsers that do not recognize a modifier inside `url("..." ...)` discard the entire declaration at CSS parse time. Declare a plain `url("...")` first, followed by a `cross-origin()` and `referrer-policy()` declaration (for browsers that support those two modifiers but not `integrity()`), followed by the full declaration including `integrity("sha384-...")`:
   - **Never put an unverified `url()` inside the same comma-separated `@font-face` `src` list**: Writing `src: url("font.woff2" cross-origin(anonymous) integrity("sha384-...")), url("font.woff2");` in a single `src` descriptor bypasses Subresource Integrity at runtime—if a CDN serves a tampered font that fails the `integrity()` check, the browser treats it as a load failure and automatically falls back to the second comma-separated `url("font.woff2")`. Using **separate** `src:` declarations ensures supporting browsers overwrite the unverified declaration at CSS parse time and block tampered fonts at runtime.

```css
@font-face {
  font-family: "BrandSans";
  /* 1. Parse-time fallback for browsers without url() modifier support */
  src: url("https://cdn.example.com/fonts@1.0.0/brand-sans.woff2") format("woff2");
  /* 2. Parse-time fallback for browsers supporting cross-origin() and referrer-policy() */
  src: url(
    "https://cdn.example.com/fonts@1.0.0/brand-sans.woff2"
    cross-origin(anonymous)
    referrer-policy(no-referrer)
  ) format("woff2");
  /* 3. Full protection in browsers supporting cross-origin(), referrer-policy(), and integrity() */
  src: url(
    "https://cdn.example.com/fonts@1.0.0/brand-sans.woff2"
    cross-origin(anonymous)
    referrer-policy(no-referrer)
    integrity("sha384-oqVuAfXRKap7fdgcCY5uykM6+R9GqQ8K/uxy9rx7HNQlGYl1kPzQho1wx4JwY8wC")
  ) format("woff2");
  font-display: swap;
}

.verified-graphic {
  background-image: url("https://cdn.example.com/media@1.0.0/badge.svg");
  background-image: url(
    "https://cdn.example.com/media@1.0.0/badge.svg"
    cross-origin(anonymous)
    referrer-policy(no-referrer)
  );
  background-image: url(
    "https://cdn.example.com/media@1.0.0/badge.svg"
    cross-origin(anonymous)
    referrer-policy(no-referrer)
    integrity("sha384-Iw/0p59dP96nGTzHvf2XIfqcBwBW7RM6JfOij8uZxyg5azfNaOOUW8SQy6H/hU91")
  );
}
```

4. **Feature-detect CSS `url()` modifier support in JavaScript with `CSS.supports()`**:

```javascript
export function getCssUrlModifierSupport() {
  const supportsCrossOriginAndReferrer =
    typeof CSS !== 'undefined' &&
    typeof CSS.supports === 'function' &&
    CSS.supports(
      'background-image',
      'url("https://example.com/a.svg" cross-origin(anonymous) referrer-policy(no-referrer))',
    );

  const supportsUrlIntegrity =
    typeof CSS !== 'undefined' &&
    typeof CSS.supports === 'function' &&
    CSS.supports(
      'background-image',
      'url("https://example.com/a.svg" cross-origin(anonymous) referrer-policy(no-referrer) integrity("sha384-Iw/0p59dP96nGTzHvf2XIfqcBwBW7RM6JfOij8uZxyg5azfNaOOUW8SQy6H/hU91"))',
    );

  return { supportsCrossOriginAndReferrer, supportsUrlIntegrity };
}
```
