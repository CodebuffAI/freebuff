# Local Network Access

When a web application served from a `public` origin (or an intranet `local` origin) connects to a user's private local network (such as a LAN printer, IoT hub, or router at `192.168.1.x` or `device.local`) or to a local companion service running on the user's machine (`127.0.0.1`, `[::1]`, or `localhost`), browsers gate the connection behind a **Local Network Access (LNA)** permission prompt.

Local Network Access splits access into two granular permissions and `Permissions-Policy` tokens based on the IP address space lattice (`public` → `local` → `loopback`), enforcing checks **only** when a request crosses from a *less private* address space into a *more private* address space:
- **`local-network`**: Required when connecting from a `public` origin to the `local` address space (RFC 1918 private IPv4 ranges `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, link-local `169.254.0.0/16` / `fe80::/10`, IPv6 Unique Local Addresses `fc00::/7`, and `.local` mDNS hostnames).
- **`loopback-network`**: Required when connecting from a `public` or `local` origin to the `loopback` address space (`127.0.0.0/8`, `::1/128`, or `localhost`).

Because `localhost` (`127.0.0.1` and `[::1]`) is already in the most private (`loopback`) address space, serving your web app from `http://localhost` during local development will **not** trigger LNA checks by default. To test LNA prompts and permission states locally without deploying to a public server, either override your local dev server's IPv4 and IPv6 address space to `public` using the `--ip-address-space-overrides=127.0.0.1:8080=public,[::1]:8080=public` Chromium flag, or manually toggle **Local network** and **Loopback network** between `Ask`, `Allow`, and `Block` in browser **Site settings**.

**MANDATORY:** Serve any web application that initiates local or loopback network requests from a **Secure Context (`https://`)**. Local Network Access permissions are denied automatically in insecure (`http://`) top-level contexts.

**DO NOT** rely on deprecated Private Network Access (PNA) preflight headers (`Access-Control-Request-Private-Network: true` / `Access-Control-Allow-Private-Network: true`). Local Network Access enforces access via client-side user permission prompts (`local-network` and `loopback-network`) combined with standard CORS headers (`Access-Control-Allow-Origin`) when reading cross-origin responses. PNA preflights were never enforced as a blocking requirement and are not needed as a fallback. Existing servers or device firmware that already return `Access-Control-Allow-Private-Network: true` can keep doing so harmlessly, but do not add PNA handling to new code.

## Implementation Steps

### 1. Pre-Check Granular Permission State and Gate on User Gesture

Never fire local network or loopback requests unconditionally on page load (`DOMContentLoaded`) when the permission state is `'prompt'`, and never initiate the first permission-triggering request from a **Service Worker** or **Shared Worker** (which lack an attached `Document` and will immediately fail if permission is not already `'granted'`).

Instead, query `navigator.permissions.query()` for `'local-network'` or `'loopback-network'` first:
- If `state === 'granted'`, connect automatically.
- If `state === 'prompt'`, display clear UI explaining why the app needs access to the local device or companion app, and trigger the request from an explicit user gesture (such as a button click).
- If `state === 'denied'`, render actionable remediation UI instructing the user how to re-enable Local Network or Loopback access in browser site settings.

```javascript
/**
 * Queries the granular Local Network Access permission for the target space.
 * @param {'local-network' | 'loopback-network'} permissionName
 */
export async function checkNetworkPermission(permissionName) {
  const status = await navigator.permissions.query({ name: permissionName });

  // Keep UI synchronized if the user changes permission in browser site settings
  status.addEventListener('change', () => {
    updatePermissionUI(permissionName, status.state);
  });

  updatePermissionUI(permissionName, status.state);
  return status.state;
}

function updatePermissionUI(permissionName, state) {
  const statusBadge = document.querySelector(`[data-permission-status="${permissionName}"]`);
  const remediationBox = document.querySelector(`[data-remediation="${permissionName}"]`);
  if (statusBadge) {
    statusBadge.textContent = state;
  }
  if (remediationBox) {
    // Show remediation instructions whenever permission is explicitly denied
    remediationBox.hidden = state !== 'denied';
  }
}
```

### 2. Declare `targetAddressSpace` in `fetch()` and `Request`

When an `https://` page requests an `http://` endpoint on the local network or loopback interface, specify `targetAddressSpace: 'local'` or `targetAddressSpace: 'loopback'` in the `fetch()` or `Request` options.

Explicitly setting `targetAddressSpace` does two critical things:
1. **Mixed Content Exemption**: Mixed Content checks run *before* DNS resolution. Declaring `targetAddressSpace: 'local'` (or `'loopback'`) informs the browser ahead of DNS resolution that an `http://` URL (including a custom DNS hostname that resolves to a local IP) targets a local/loopback endpoint and should be exempted from Mixed Content blocking once the user grants the permission.
2. **Address Space Verification**: After DNS resolution, the browser verifies that the resolved IP address actually belongs to the declared `targetAddressSpace`. If a hostname with `targetAddressSpace: 'local'` unexpectedly resolves to a `public` IP address, the browser immediately aborts the request with a `TypeError` network error.

```javascript
/**
 * Connects to a local network device (e.g., LAN printer or IoT hub) over HTTP.
 * Example endpoint URL is illustrative; replace with your device's address.
 */
export async function fetchLocalDeviceStatus(deviceUrl = 'http://192.168.1.100:8080/api/status') {
  const request = new Request(deviceUrl, {
    method: 'GET',
    mode: 'cors',
    // MANDATORY: Declare 'local' when targeting RFC 1918 / .local LAN addresses
    targetAddressSpace: 'local',
  });

  const response = await fetch(request);
  if (!response.ok) {
    throw new Error(`Device responded with HTTP ${response.status}`);
  }
  return response.json();
}

/**
 * Connects to a local companion daemon running on the user's loopback interface.
 * Example loopback port is illustrative; replace with your service's port.
 */
export async function fetchLoopbackDaemon(daemonUrl = 'http://127.0.0.1:45678/health') {
  const request = new Request(daemonUrl, {
    method: 'GET',
    mode: 'cors',
    // MANDATORY: Declare 'loopback' when targeting 127.0.0.1, [::1], or localhost
    targetAddressSpace: 'loopback',
  });

  const response = await fetch(request);
  if (!response.ok) {
    throw new Error(`Companion app responded with HTTP ${response.status}`);
  }
  return response.json();
}
```

### 3. Real-Time Connections with `WebSocket` and `WebTransport`

Local Network Access restrictions also govern `WebSocket` and `WebTransport` connections:

- **`WebSocket`**: The `WebSocket(url, protocols)` constructor only accepts a subprotocol string or array as its second argument—do **not** pass a `{ targetAddressSpace }` options object, which throws a `SyntaxError`. Instead, the browser inspects the `WebSocket` URL before DNS resolution: `ws://` connections initiated from an `https://` page are exempted from Mixed Content blocking when the URL host is syntactically recognizable as local or loopback—specifically a private or loopback IP literal (`ws://192.168.1.100:8080`, `ws://127.0.0.1:8080`, `ws://[::1]:8080`), `localhost` (`*.localhost`), or a `.local` mDNS hostname (`ws://device.local:8080`)—and gated behind the `local-network` or `loopback-network` permission prompt. If a local endpoint is addressed via a custom non-`.local` DNS hostname, connect over `wss://`.
- **`WebTransport`**: Because `WebTransport` strictly requires `https://` (HTTP/3 over QUIC with TLS or `serverCertificateHashes` for local self-signed certificates), it never triggers Mixed Content blocks and does not accept a `targetAddressSpace` option. Instead, the browser automatically verifies the resolved IP address space and gates the `transport.ready` promise behind the `local-network` or `loopback-network` permission prompt.

```javascript
/**
 * Opens a WebSocket connection to a local network device (IP literal, .local, or localhost).
 */
export function openLocalWebSocket(wsUrl = 'ws://192.168.1.100:8080/stream') {
  // Pass only subprotocol string(s) as the second argument (never an options object).
  // Browsers exempt ws:// from Mixed Content when the host is a local/loopback IP literal,
  // .local, or localhost, and gate the connection on 'local-network' or 'loopback-network'.
  const socket = new WebSocket(wsUrl, ['v1.telemetry']);
  return socket;
}

/**
 * Opens a WebTransport session to a local network endpoint using a pinned self-signed certificate hash.
 */
export async function openLocalWebTransport(wtUrl = 'https://192.168.1.100:4433/wt', certSha256Bytes) {
  const transport = new WebTransport(wtUrl, {
    serverCertificateHashes: [
      {
        algorithm: 'sha-256',
        value: certSha256Bytes,
      },
    ],
  });

  // transport.ready resolves only after the user grants the 'local-network' permission
  // and rejects with WebTransportError if the permission is denied.
  await transport.ready;
  return transport;
}
```

### 4. Delegate Access to Cross-Origin Iframes via `Permissions-Policy`

By default, `local-network` and `loopback-network` have a default allowlist of `'self'`, blocking cross-origin `<iframe>` embeds from making local or loopback requests. To allow an embedded cross-origin `<iframe>` (such as a hardware setup widget or an SSO frame that communicates with a local agent) to initiate local or loopback requests, explicitly delegate the granular permissions in the `allow` attribute and/or HTTP `Permissions-Policy` header:

```html
<!-- Delegate granular local-network and loopback-network permissions to the embedded iframe -->
<iframe
  src="https://setup.partner.example.com/device-bridge"
  allow="local-network; loopback-network"
  title="Local Device Bridge">
</iframe>
```

Send the `Permissions-Policy` header on the **top-level (embedding) document's** response, not on the iframe's response:

```http
Permissions-Policy: local-network=(self "https://setup.partner.example.com"), loopback-network=(self "https://setup.partner.example.com")
```

## Fallback Strategies

Browser support for Local network access: Limited availability.
Supported by: Chrome 145 (Feb 2026) and Edge 145 (Feb 2026).
Unsupported in: Firefox and Safari.

If your Baseline target does not support Local Network Access permissions and `targetAddressSpace` options, implement **feature detection with progressive fallback**:

1. **Permission Query Fallback**: Wrap `navigator.permissions.query({ name: permissionName })` in a `try / catch`. If the browser throws a `TypeError` because `'local-network'` or `'loopback-network'` is an unrecognized `PermissionName`, treat the state as `'prompt'` so the request still runs on an explicit user click (the connection attempt itself triggers the browser prompt where LNA is supported).
2. **DO NOT** query the legacy combined permission name `{ name: 'local-network-access' }`. In older Chrome versions this query crashes the renderer process, and `try / catch` cannot prevent it. Newer Chrome versions treat `'local-network-access'` only as a legacy alias for the granular permissions.
3. **Graceful Rejection Handling**: Always wrap `fetch()`, `WebSocket` error events, and `transport.ready` in error handlers that catch `TypeError` / connection failures and present clear remediation steps (checking that the local device is powered on, connected to the same network, and allowed in browser permissions).

```javascript
/**
 * Cross-browser permission check for the granular LNA permissions.
 * Never falls back to querying 'local-network-access', which crashes older Chrome versions.
 * @param {'local-network' | 'loopback-network'} permissionName
 */
export async function queryLnaPermissionSafe(permissionName) {
  if (!navigator.permissions?.query) {
    return 'prompt';
  }
  try {
    const status = await navigator.permissions.query({ name: permissionName });
    return status.state;
  } catch {
    // Unrecognized permission name; proceed on user gesture
    return 'prompt';
  }
}
```
