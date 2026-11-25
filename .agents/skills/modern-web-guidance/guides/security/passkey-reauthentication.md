# Passkey Reauthentication

This delta-focused guide details how to implement step-up authentication or re-verification for a signed-in user before they perform sensitive account changes (e.g. passwords updates, financial transfers).

## Delta Flow Architecture

Unlike regular authentication, passkey reauthentication constrains passkey dialog prompts strictly to the logged-in user's pre-registered credentials to prevent account-mixing or passkey spoofing during active sessions.

## Server-Side

### Options Generation Delta

Create an endpoint that populates the allowed credentials parameters specifically for the active, known user:

**Constrain Credentials**: Populate the `allowCredentials` options array with specific `PublicKeyCredentialDescriptor` records mapping all registered credential IDs for the signed-in user. Leaving this empty or omitting it regresses to discoverable credentials, violating session safety.

```javascript
// Node.js step-up options generation example
router.post("/api/reauth/options", enforceActiveSession, async (req, res) => {
  const userPasskeys = await db.findCredentialsByUserId(req.user.id);

  const options = {
    challenge: serverGeneratedBase64UrlChallenge, // Random challenge stored in user session
    rpId: "example.com",
    // Enforce allowance strictly limited to the user's credentials list
    allowCredentials: userPasskeys.map((cred) => ({
      type: "public-key",
      id: cred.id,
      transports: cred.transports, // Speeds up resolution by indicating platform transports
    })),
  };
  return res.json(options);
});
```

### Verification Endpoint Delta

Verify the assertion returned by the client:

**Verify Account Ownership**: The verification endpoint MUST explicitly verify that the resulting authenticated credential ID returned by the client resolves to a stored credential record whose associated user ID strictly matches the active signed-in user (`storedCredential.passkeyUserId === req.user.id`). If a valid passkey of a _different_ user is returned, authentication MUST be rejected immediately.

## Client-Side Flow Deltas

Applications choose from two reauthentication interfaces depending on the transaction UI:

### A. Button Flow (No Input Fields)

Trigger reauthentication when a user presses a "Verify Identity" or "Proceed with Transaction" button. When signaling an unknown credential on HTTP `404`, always pass `rpId: publicKey.rpId` from the server's request options—**DO NOT** derive `rpId` from `window.location.hostname` on the client.

```html
<button id="reauth-btn" data-testid="reauth-button">Confirm Transaction</button>
```

```javascript
let reauthAbortController = new AbortController();

async function triggerButtonReauth() {
  // Abort any background suggestion flows to avoid passkey prompt collisions
  reauthAbortController.abort();
  reauthAbortController = new AbortController();

  const optionsResponse = await fetch("/api/reauth/options", {
    method: "POST",
  });
  const optionsJSON = await optionsResponse.json();
  const publicKey =
    PublicKeyCredential.parseRequestOptionsFromJSON(optionsJSON);

  try {
    const credential = await navigator.credentials.get({
      publicKey,
      signal: reauthAbortController.signal,
    });

    if (credential) {
      const encodedCredential = credential.toJSON();
      const verifyResponse = await fetch("/api/reauth/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(encodedCredential),
      });

      if (verifyResponse.ok) {
        showTransactionSuccessUI();
      } else if (verifyResponse.status === 404 && PublicKeyCredential.signalUnknownCredential) {
        await PublicKeyCredential.signalUnknownCredential({
          rpId: publicKey.rpId, // Always use the server-provided rpId; DO NOT use window.location.hostname
          credentialId: encodedCredential.id
        });
      }
    }
  } catch (err) {
    if (err.name === "NotAllowedError") {
      console.log("User cancelled reauthentication.");
    }
  }
}

document
  .getElementById("reauth-btn")
  .addEventListener("click", triggerButtonReauth);
```

## Fallback Strategies

### Passkey feature detection fallback

Baseline status for the api.PublicKeyCredential.getClientCapabilities_static capability: Newly available. It's been Baseline since 2025-02-06.
Supported by: Chrome 133 (Feb 2025), Edge 133 (Feb 2025), Firefox 135 (Feb 2025), and Safari 17.4 (Mar 2024).

Load `webauthn-polyfills` so `PublicKeyCredential.getClientCapabilities()` is available whenever `PublicKeyCredential` is supported:

```js
// With a bundler (`npm install webauthn-polyfills`):
import 'webauthn-polyfills';
```

Without a bundler, serve the package from your own origin, or import it from a CDN such as `https://esm.sh/webauthn-polyfills@0.1.7` (pin the exact version). For third-party URLs, add Subresource Integrity: the `integrity` attribute on the `<script>` tag, or an import map's `integrity` field for `import` statements.

### Signal API Synchronization Fallback

Browser support for Web authentication signal methods: Limited availability.
Supported by: Chrome 132 (Jan 2025), Edge 132 (Jan 2025), and Safari 26 (Sep 2025).
Unsupported in: Firefox.

The WebAuthn Signal API (`webauthn-signals`) is a progressive optimization used to keep password managers in sync with the server credential state.

- **Fallback Experience**: Gate calls behind `if (PublicKeyCredential.signalUnknownCredential)`. If unsupported, the background verification sync is bypassed gracefully without throwing browser exceptions.

### Easy JSON Serialization Fallback

Baseline status for the api.PublicKeyCredential.parseRequestOptionsFromJSON_static capability: Newly available. It's been Baseline since 2025-03-31.
Supported by: Chrome 129 (Sep 2024), Edge 129 (Sep 2024), Firefox 119 (Oct 2023), and Safari 18.4 (Mar 2025).

Load `webauthn-polyfills` so `PublicKeyCredential.parseRequestOptionsFromJSON()` and `PublicKeyCredential.prototype.toJSON()` are available whenever `PublicKeyCredential` is supported:

```js
// With a bundler (`npm install webauthn-polyfills`):
import 'webauthn-polyfills';
```

Without a bundler, serve the package from your own origin, or import it from a CDN such as `https://esm.sh/webauthn-polyfills@0.1.7` (pin the exact version). For third-party URLs, add Subresource Integrity: the `integrity` attribute on the `<script>` tag, or an import map's `integrity` field for `import` statements.
