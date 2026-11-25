# Passkey Management

This guide details how to enable users to view, rename, and delete their registered passkeys while keeping saved credentials and user profile details synchronized between the server and the user's password managers using the Signal API.

## Server-Side Operations

Your backend database layer and endpoints MUST support common CRUD actions for registered credentials as well as updating user profile details. Decoupled from framework-specific libraries, the server exposes endpoints to:

1.  **List all user credentials**: Fetch all `StoredPasskeyCredential` records matching the signed-in user's ID, and return them alongside the server's configured `rpId` and the user's `passkeyUserId` so the client never has to guess `rpId` from `window.location.hostname`. Ensure every credential `id` and user `passkeyUserId` is stored and returned as a valid unpadded Base64URL string (`[A-Za-z0-9_-]`, no `=` padding, and `length % 4 !== 1`)—including in prototype seed data and mock backends (for example, `Buffer.from('cred-1').toString('base64url')` or `'dGVzdC1jcmVkLTE'`, never arbitrary human-readable placeholders like `'passkey-1'` or `'cred_yubikey_01'`).
2.  **Update credential names**: Accept a new custom nickname for a specific credential ID and persist the update on the server.
3.  **Delete credentials**: Remove a specific credential ID from the database.
4.  **Update user account details**: Accept updated `name` (username) and `displayName` values for the signed-in user's profile and return the updated user profile alongside the server's `rpId` and Base64URL `passkeyUserId` so the client can synchronize them with the passkey provider.

```javascript
// Node.js routing example for credential CRUD and user profile rename
const RP_ID = 'example.com'; // Predefined server RP ID (example value; must match registration rp.id)

router.get('/api/credentials', checkUserAuthenticated, async (req, res) => {
  const credentials = await db.findCredentialsByUserId(req.user.id);
  return res.json({
    rpId: RP_ID,
    userId: req.user.passkeyUserId, // Valid unpadded Base64URL string
    credentials,
  });
});

router.put('/api/credential/:id', checkUserAuthenticated, async (req, res) => {
  const { id } = req.params;
  const { name } = req.body;
  const cred = await db.findCredentialById(id);
  if (!cred || cred.passkeyUserId !== req.user.id) {
    return res.status(404).json({ error: 'Credential not found.' });
  }
  cred.name = name;
  await db.saveCredential(cred);
  return res.json(cred);
});

router.delete('/api/credential/:id', checkUserAuthenticated, async (req, res) => {
  const { id } = req.params;
  const cred = await db.findCredentialById(id);
  if (!cred || cred.passkeyUserId !== req.user.id) {
    return res.status(404).json({ error: 'Credential not found.' });
  }
  await db.deleteCredential(id);
  return res.json({ success: true });
});

router.put('/api/user', checkUserAuthenticated, async (req, res) => {
  const { name, displayName } = req.body;
  const updatedUser = await db.updateUser(req.user.id, { name, displayName });
  return res.json({
    ...updatedUser,
    rpId: RP_ID,
    userId: updatedUser.passkeyUserId,
  });
});
```

## Client-Side Management UI

Render a dedicated settings panel allowing users to easily audit and manage their registered authentication options and account profile details:

1.  **Display saved list**: Fetch list from your endpoint and render individual credential rows. If the response is empty, render a helpful empty-state message (e.g., "No passkeys found").
2.  **Map AAGUID Metadata**: For each passkey, lookup its `aaguid` property against your local registry to render its provider details. See [Determine the passkey provider from AAGUID](#aaguid) section for more details.
3.  **Per-Item UI Requirements**: Every row inside the list container MUST render:
    *   **Provider Icon**: AAGUID-derived image or data URI.
    *   **Provider/Custom Name**: AAGUID-derived name or user-renamed string.
    *   **Registration Date**: The database-persisted raw epoch timestamp `registeredAt` formatted to a human-readable date for client display.
    *   **Last Used Date**: The database-persisted raw epoch timestamp `lastUsedAt` formatted to a human-readable date (if present) for client display.
    *   **Rename Button**: Triggers a rename action to update the credential's custom nickname on the server (`PUT /api/credential/:id`). Note: Renaming an individual passkey's nickname is a server-side label change and does NOT invoke `signalCurrentUserDetails()`.
    *   **Delete Button**: Triggers deletion of the credential (`DELETE /api/credential/:id`) and synchronizes the remaining credential IDs via `signalAllAcceptedCredentials()`.
4.  **User Account Rename UI**:
    *   Provide a control allowing the user to update their account username (`name`) or `displayName` (`PUT /api/user`), and immediately synchronize the updated user details with the password manager via `PublicKeyCredential.signalCurrentUserDetails()`.
5.  **Conditional "Create Passkey" Button**:
    *   Offer a prominent "Create passkey" registration trigger button on the management page. Before rendering this UI element, the page MUST feature-detect capabilities using `PublicKeyCredential.getClientCapabilities()` to verify platform authenticator is supported. If passkeys are unsupported, hide this button and gracefully encourage standard MFA enrollments instead.
    *   Allow registering a security key by omitting `authenticatorSelection.authenticatorAttachment` on `navigator.credentials.create()` call.

## Signal API Synchronization

The Signal API lets the application communicate credential states to password managers, keeping the user's synced vaults and your backend database in lockstep.

> [!IMPORTANT]
> Browsers strictly validate Base64URL encoding and string length (`length % 4 !== 1`, characters strictly `[A-Za-z0-9_-]`, no `=` padding) in native code. Passing arbitrary human-readable placeholder or mock IDs (such as `'passkey-1'`, `'cred:01'`, or unencoded strings like `'cred_yubikey_01'`) throws `TypeError: Invalid base64url string for allAcceptedCredentialIds` on page load. Always encode mock/test IDs as genuine unpadded Base64URL strings (for example, `'dGVzdC1jcmVkLTE'` or `Buffer.from('cred-1').toString('base64url')`) and validate format before invoking the Signal API.

*   **Use the Server-Provided `rpId` (DO NOT Use `window.location.hostname`)**:
    *   Always pass the `rpId` returned by your backend API (matching the `rp.id` used when registering passkeys). **DO NOT** derive `rpId` from `window.location.hostname` on the client: when credentials are registered to a registrable parent domain (for example, `example.com` while the settings page is served on `accounts.example.com`) or shared via Related Origin Requests (`/.well-known/webauthn`), `window.location.hostname` will not match the credential's RP ID, causing password manager synchronization to silently target the wrong RP ID or throw a `SecurityError`.
*   **Feature Detection & Parameter Encoding Rule**:
    *   Always feature-detect Signal API methods before invoking them (`if (PublicKeyCredential.signalAllAcceptedCredentials)` and `if (PublicKeyCredential.signalCurrentUserDetails)`).
    *   All `userId` and credential ID parameters passed to Signal API methods (`signalAllAcceptedCredentials`, `signalCurrentUserDetails`) MUST be **valid unpadded Base64URL-encoded strings**. Validate `userId` and `allAcceptedCredentialIds` before calling the API so malformed IDs are skipped safely rather than throwing on load.
*   **Initiating Page Load Sync**:
    *   The application MUST invoke `signalAllAcceptedCredentials()` automatically when the management page loads (for example, inside a `DOMContentLoaded` event listener, module initialization, or framework component mount hook such as `useEffect`).
*   **Management Updates Sync**:
    *   The application MUST invoke `signalAllAcceptedCredentials()` immediately within your delete credential click handler post-fetch.
    *   The application MUST invoke `signalCurrentUserDetails()` immediately within your user account rename (`name` or `displayName`) click handler post-fetch.
*   **Non-Fatal Error Handling (`console.warn`)**:
    *   Signal API calls perform passive background synchronization and MUST NOT break the UI or emit `console.error` when synchronization fails. Wrap Signal API calls in `try...catch` and log failures with `console.warn` instead of `console.error` so passive sync issues do not trigger Lighthouse Best Practices failures (`errors-in-console`) on page load.

```javascript
// Client-side management synchronization ES module
import { listFetch, renameCredentialFetch, updateUserFetch, deleteFetch } from './api.js';

// Valid unpadded Base64URL: non-empty, [A-Za-z0-9_-] only, no '=' padding, length % 4 !== 1
function isValidBase64Url(value) {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length % 4 !== 1 &&
    /^[A-Za-z0-9_-]+$/.test(value);
}

async function syncAcceptedCredentials(rpId, userId, currentCredentialsList) {
  if (!window.PublicKeyCredential || !PublicKeyCredential.signalAllAcceptedCredentials) return;
  const credentialIds = currentCredentialsList.map(c => c.id); // Array of Base64URL credential ID strings
  if (!rpId || !isValidBase64Url(userId) || !credentialIds.every(isValidBase64Url)) {
    console.warn('SignalAllAcceptedCredentials skipped: server rpId and valid unpadded Base64URL userId and credential IDs are required.');
    return;
  }

  try {
    await PublicKeyCredential.signalAllAcceptedCredentials({
      rpId, // Always use the server-provided rpId; DO NOT use window.location.hostname
      userId, // Base64URL-encoded user ID from the server
      allAcceptedCredentialIds: credentialIds
    });
  } catch (e) {
    // Use console.warn instead of console.error so passive sync failures do not fail Lighthouse errors-in-console
    console.warn('SignalAllAcceptedCredentials sync warning:', e);
  }
}

async function loadManagementPanel() {
  const response = await listFetch();
  const { rpId, userId, credentials } = await response.json();
  
  renderUI(credentials);
  // Sync accepted credentials on initial load using server-provided rpId and userId
  await syncAcceptedCredentials(rpId, userId, credentials);
}

async function performDelete(credentialId) {
  const response = await deleteFetch(credentialId);
  if (response.ok) {
    const updatedResponse = await listFetch();
    const { rpId, userId, credentials } = await updatedResponse.json();
    
    renderUI(credentials);
    // Sync remaining accepted credentials after deletion
    await syncAcceptedCredentials(rpId, userId, credentials);
  }
}

// Renaming a passkey's nickname updates the server record only
async function performCredentialRename(credentialId, newCredentialName) {
  const response = await renameCredentialFetch(credentialId, { name: newCredentialName });
  if (response.ok) {
    const updatedResponse = await listFetch();
    const { credentials } = await updatedResponse.json();
    renderUI(credentials);
  }
}

// Renaming the user's account username or displayName triggers signalCurrentUserDetails
async function performUserRename(updatedName, updatedDisplayName) {
  const response = await updateUserFetch({ name: updatedName, displayName: updatedDisplayName });
  if (response.ok && window.PublicKeyCredential && PublicKeyCredential.signalCurrentUserDetails) {
    const { rpId, userId } = await response.json();
    if (!rpId || !isValidBase64Url(userId)) {
      console.warn('SignalCurrentUserDetails skipped: server rpId and valid unpadded Base64URL userId are required.');
      return;
    }
    try {
      await PublicKeyCredential.signalCurrentUserDetails({
        rpId, // Always use the server-provided rpId; DO NOT use window.location.hostname
        userId, // Base64URL-encoded user ID from the server
        name: updatedName, // Updated username
        displayName: updatedDisplayName // Updated display name
      });
    } catch (e) {
      // Use console.warn instead of console.error for passive background sync
      console.warn('SignalCurrentUserDetails sync warning:', e);
    }
  }
}

window.addEventListener('DOMContentLoaded', loadManagementPanel);
```

## Determine the passkey provider from AAGUID {: #aaguid }

An AAGUID (Authenticator Attestation Globally Unique Identifier) is a 128-bit identifier that represents the model of the authenticator, not a specific instance. It is included in the authenticator data during passkey registration and can be used to determine which passkey provider (e.g. Google Password Manager, iCloud Keychain, 1Password) created a credential.

AAGUID should only be used to help users with passkey management. It can be modified unless cryptographically attested, which platform passkeys currently don't support.

### 1. AAGUID Registry

A community-maintained JSON mapping of AAGUIDs to provider names and icons is available at:

```
https://raw.githubusercontent.com/passkeydeveloper/passkey-authenticator-aaguids/refs/heads/main/combined_aaguid.json
```

Each entry has the following schema:

```json
{
  "<aaguid-uuid>": {
    "name": "Provider Name",
    "icon_light": "data:image/png;base64,...",
    "icon_dark": "data:image/png;base64,..."
  }
}
```

### 2. Using AAGUID After Registration

After verifying a registration response, read the `aaguid` from the registration result and look it up against the registry to populate the credential's `name` and `providerIcon`:

Before looking up the AAGUID in the registry, check if it equals `'00000000-0000-0000-0000-000000000000'`. If so, skip the registry lookup and set `name` to a fallback (e.g. device name from user-agent, or "Unknown passkey provider") and `providerIcon` to `undefined`. Only look up the registry for non-zeroed AAGUIDs.

```javascript
import aaguids from './aaguids.json' with { type: 'json' };

const { aaguid } = registrationInfo;
if (aaguid === '00000000-0000-0000-0000-000000000000') {
  // use the device name as the passkey provider based on
  // the information derived from the user agent string,
  // or just say "Unknown passkey provider"
} else {
  const provider = aaguids[aaguid];
  const credential = {
    // ...other fields
    aaguid,
    name: provider?.name || 'Unknown passkey provider',
    providerIcon: provider?.icon_light,
  };
}
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

Before rendering the "Create passkey" button, call `PublicKeyCredential.getClientCapabilities()` to verify platform authenticator support, and hide the button when unsupported:

```javascript
async function isPasskeySupported() {
  if (!window.PublicKeyCredential || !PublicKeyCredential.getClientCapabilities) {
    return false;
  }
  try {
    const capabilities = await PublicKeyCredential.getClientCapabilities();
    return Boolean(capabilities.passkeyPlatformAuthenticator);
  } catch {
    return false;
  }
}

const createButton = document.getElementById('create-passkey');
if (!(await isPasskeySupported())) {
  createButton.hidden = true;
}
``` 

### Signal API Synchronization Fallback

Browser support for Web authentication signal methods: Limited availability.
Supported by: Chrome 132 (Jan 2025), Edge 132 (Jan 2025), and Safari 26 (Sep 2025).
Unsupported in: Firefox.

The WebAuthn Signal API (`webauthn-signals`) is a progressive enhancement that synchronizes server-side credential deletions and account profile updates with the user's password manager. Because synchronization communicates directly with the browser or OS passkey provider, no polyfill is available if your Baseline target does not support `webauthn-signals`. Gate calls behind static feature detection on `PublicKeyCredential` so unsupported browsers skip background synchronization safely while server-side passkey listing, renaming, deletion, and user profile updates continue to work normally without throwing browser exceptions:

```javascript
if (window.PublicKeyCredential && PublicKeyCredential.signalAllAcceptedCredentials) {
  try {
    await PublicKeyCredential.signalAllAcceptedCredentials({
      rpId, // Server-provided RP ID (never window.location.hostname)
      userId, // Valid unpadded Base64URL user ID
      allAcceptedCredentialIds: credentialIds, // Valid unpadded Base64URL credential IDs
    });
  } catch (e) {
    console.warn('SignalAllAcceptedCredentials sync warning:', e);
  }
}

if (window.PublicKeyCredential && PublicKeyCredential.signalCurrentUserDetails) {
  try {
    await PublicKeyCredential.signalCurrentUserDetails({
      rpId, // Server-provided RP ID (never window.location.hostname)
      userId, // Valid unpadded Base64URL user ID
      name: updatedName,
      displayName: updatedDisplayName,
    });
  } catch (e) {
    console.warn('SignalCurrentUserDetails sync warning:', e);
  }
}
```

