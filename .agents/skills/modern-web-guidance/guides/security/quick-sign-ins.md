# Quick sign-ins with immediate UI mode

Navigating an unauthenticated user to a dedicated sign-in page when they click a "Sign in" link, start checkout, save an item to favorites, or reach an article paywall causes context loss and increases user drop-off. Immediate UI mode (`uiMode: 'immediate'` in `navigator.credentials.get()`) enables contextual quick sign-ins by presenting a unified browser account chooser immediately when local passkeys (`publicKey`) or saved passwords (`password: true`) exist on the device.

Unlike standard modal WebAuthn prompts—which always display browser UI and fall back to cross-device QR codes or external security keys—Immediate UI mode fails fast with a `NotAllowedError` if no eligible credentials are locally available on the device. This lets your application authenticate returning users in place with a single tap while seamlessly transitioning users without local credentials to your standard sign-in page, guest checkout, or inline login form.

## Recommended UX patterns and anti-patterns

Trigger Immediate UI mode inside a user-initiated event handler (requiring transient user activation) at moments of clear user intent **right before** navigating away from the current page. If immediate authentication succeeds, complete the user's intent immediately (whether by updating the current page in place or proceeding directly to their authenticated destination). If it fails with `NotAllowedError`, show a sign-in or registration flow with a path to complete the user's intent on completion.

Potential use cases:

- **Header sign-in link or button interception**: Intercept a click on a global "Sign in" link (`event.preventDefault()`) to authenticate returning users immediately, or continue navigating to the dedicated sign-in page on `NotAllowedError`.
- **Dynamic sign-in before checkout**: Authenticate returning shoppers with a single tap when they click "Proceed to checkout" so they land directly on the shipping and payment step, or transition to the standard sign-in or guest checkout screen on fallback.
- **Inline sign-in for micro-actions (Favorite, Like, Bookmark, Save)**: Authenticate in place when a signed-out user clicks a micro-action button and immediately complete the action (for example, toggling `aria-pressed="true"`), or open a fallback login modal or sign-in page with a return URL parameter.
- **In-article soft paywalls**: Authenticate readers in place when they click "Continue reading with your account" on a paywall banner, or expand an inline sign-in or registration form on fallback.

Anti-patterns to avoid:

- **DO NOT use Immediate UI mode on a dedicated sign-in page**: Never attach `uiMode: 'immediate'` to the primary "Sign in" or "Sign in with a passkey" button on your final destination sign-in page. Users reach the dedicated sign-in page specifically when they have no local credentials on the current device, or when they intend to use a cross-device passkey (scanning a QR code with a phone) or an external hardware security key. Because `uiMode: 'immediate'` suppresses cross-device QR code and security key options and immediately throws `NotAllowedError` when no local credentials exist, using it on a dedicated sign-in page traps the user in a dead end where clicking the button does nothing. On a dedicated sign-in page, use Conditional UI (`mediation: 'conditional'` with `autocomplete="username webauthn"`) on form inputs paired with a standard modal `navigator.credentials.get({ publicKey })` button (see `passkey-authentication` (via `npx -y modern-web-guidance@latest retrieve "passkey-authentication"`)).
- **DO NOT use Immediate UI mode for step-up reauthentication**: Never use `uiMode: 'immediate'` to reauthenticate an already signed-in user before sensitive operations (such as changing a password, updating a shipping address, editing saved payment methods, or adding a new passkey). Reauthentication must restrict the prompt to the signed-in user's credentials via a non-empty `allowCredentials` list, which Immediate UI mode rejects with `NotAllowedError`, and omitting `allowCredentials` would let the user inadvertently select a different account than the one currently signed in. For step-up reauthentication, follow `passkey-reauthentication` (via `npx -y modern-web-guidance@latest retrieve "passkey-reauthentication"`).

## Privacy and security constraints

Browsers enforce strict privacy and security rules when `uiMode: 'immediate'` is requested:

- **Transient user activation is required**: You MUST call `navigator.credentials.get({ uiMode: 'immediate' })` inside a user-initiated event handler (such as a `click` listener on a `<button>` or `<a>` element) to prevent silent credential probing. Never invoke it automatically on page load (`DOMContentLoaded`). Calling the API does not consume the transient activation.
- **Do not pass a non-empty `allowCredentials` list**: Do **NOT** populate `publicKey.allowCredentials` when `uiMode: 'immediate'` is specified. Browsers immediately reject any Immediate UI mode request with a non-empty `allowCredentials` list by throwing `NotAllowedError` so relying parties cannot probe for specific credential IDs to infer prior visits or track users across sessions.
- **Do not pass an `AbortSignal` (`signal`)**: Do **NOT** set the `signal` property on `navigator.credentials.get()` when `uiMode: 'immediate'` is specified, as browsers disallow programmatic dismissal of the immediate login dialog. If your page also runs a background Conditional UI (`mediation: 'conditional'`) request, call `abort()` on that Conditional UI `AbortController` before invoking Immediate UI mode, and omit `signal` from the immediate request itself.
- **Incognito and private browsing sessions**: Requests made in Incognito or private browsing windows always reject with `NotAllowedError` so private sessions remain indistinguishable from sessions without local credentials.

## Server-side setup

### Options generation endpoint

Expose an endpoint that generates discoverable WebAuthn request options for unauthenticated visitors:

1. **Include the server's predefined `rpId`**: Set `rpId` explicitly in the request options (matching the RP ID used during passkey registration) so the client can pass `publicKey.rpId` directly to Signal API calls.
2. **Generate a session-bound challenge**: Create a cryptographically random challenge buffer, store it in the server session, and encode it as Base64URL.
3. **Persist user verification preference**: Set `userVerification: 'preferred'` and store `expectedUserVerification: 'preferred'` in the session.
4. **Omit `allowCredentials`**: Do not include a non-empty `allowCredentials` list in the options for Immediate UI mode, as browsers reject non-empty allowlists with `NotAllowedError`.

```javascript
// Server-side options generation example (/api/login/options)
router.post('/api/login/options', (req, res) => {
  const options = {
    challenge: serverGeneratedBase64UrlChallenge, // High-entropy random challenge stored in session
    rpId: 'example.com',
    userVerification: 'preferred',
  };

  req.session.challenge = options.challenge;
  req.session.expectedUserVerification = 'preferred';
  return res.json(options);
});
```

### Dual credential verification endpoints

Because `navigator.credentials.get({ password: true, publicKey, uiMode: 'immediate' })` can resolve with either a passkey (`PublicKeyCredential`) or a saved password (`PasswordCredential`), provide verification handlers for both credential types:

1. **WebAuthn assertion verification (`/api/login/verify`)**: Verify the assertion against the session challenge and stored public key. If the credential ID is not found in the database, return HTTP status `404` so the client can notify the password manager via `PublicKeyCredential.signalUnknownCredential()`.
2. **Password verification (`/api/login/password`)**: Verify the `username` (`cred.id`) and `password` (`cred.password`) against the user database and establish an authenticated session.

## Client-side implementation

### Unified credential request

1. **Request both passkeys and passwords**: Decode the server options using `PublicKeyCredential.parseRequestOptionsFromJSON()` and call `navigator.credentials.get()` inside a user-initiated click handler with `password: true`, `publicKey`, and `uiMode: 'immediate'` (without passing `signal`).
2. **Branch verification by `cred.type`**:
    - If `cred.type === 'public-key'`, serialize the assertion with `cred.toJSON()` and POST it to your WebAuthn verification endpoint. When the server responds with HTTP `404`, call `PublicKeyCredential.signalUnknownCredential({ rpId: publicKey.rpId, credentialId: encoded.id })`. Always use `publicKey.rpId` from the server's request options—**DO NOT** derive or fall back to `window.location.hostname` on the client, as the server's configured RP ID may be a registrable parent domain (such as `example.com` on `shop.example.com`) or use Related Origin Requests.
    - If `cred.type === 'password'`, POST `{ username: cred.id, password: cred.password }` to your password verification endpoint.
3. **Handle `NotAllowedError` when no local credentials exist**: Catch `NotAllowedError` (thrown immediately when no local passkeys or saved passwords exist on the device, or when the user dismisses the chooser) and transition to your standard sign-in flow (such as opening an inline sign-in dialog or navigating to `/signin` with a return URL). When revealing an inline fallback sign-in form or dialog in place, move focus to its first interactive control and announce the state change via a polite live region (`role="status"`).
4. **Restore focus and announce in-place sign-in completion**: When in-place authentication or fallback form submission hides the sign-in trigger or inline form, restore focus to the originating action control (or to a surviving authenticated control in the header) so keyboard focus does not drop to `document.body`, and announce the authenticated state in a status live region (`role="status"`).

```javascript
let isAuthenticating = false;

async function authenticateWithImmediateUi() {
  const optionsResponse = await fetch('/api/login/options', { method: 'POST' });
  if (!optionsResponse.ok) {
    throw new Error('Failed to fetch authentication options');
  }
  const optionsJSON = await optionsResponse.json();
  const publicKey = PublicKeyCredential.parseRequestOptionsFromJSON(optionsJSON);

  // MANDATORY: Request both password and publicKey with uiMode: 'immediate' and NO signal parameter
  const cred = await navigator.credentials.get({
    password: true,
    publicKey,
    uiMode: 'immediate',
  });

  if (!cred) {
    throw new DOMException('No credential returned', 'NotAllowedError');
  }

  if (cred.type === 'public-key') {
    const encoded = cred.toJSON();
    const verifyResponse = await fetch('/api/login/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(encoded),
    });

    if (verifyResponse.status === 404) {
      if (PublicKeyCredential.signalUnknownCredential) {
        await PublicKeyCredential.signalUnknownCredential({
          rpId: publicKey.rpId, // Always use the server-provided rpId; DO NOT use window.location.hostname
          credentialId: encoded.id, // Base64URL-encoded credential ID string
        });
      }
      throw new Error('Passkey credential is no longer recognized by the server');
    }

    if (!verifyResponse.ok) {
      throw new Error('Passkey verification failed');
    }
    return await verifyResponse.json();
  }

  if (cred.type === 'password') {
    const verifyResponse = await fetch('/api/login/password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: cred.id,
        password: cred.password,
      }),
    });

    if (!verifyResponse.ok) {
      throw new Error('Password verification failed');
    }
    return await verifyResponse.json();
  }

  throw new Error(`Unsupported credential type: ${cred.type}`);
}

// Example: Intercepting an inline micro-action (Favorite button) or Header Sign-in click
const favoriteButton = document.getElementById('favorite-btn');

favoriteButton.addEventListener('click', async (event) => {
  event.preventDefault();
  if (isAuthenticating) return;

  // If already signed in, toggle the micro-action state immediately
  if (document.body.dataset.signedIn === 'true') {
    const nextPressed = favoriteButton.getAttribute('aria-pressed') !== 'true';
    favoriteButton.setAttribute('aria-pressed', String(nextPressed));
    return;
  }

  isAuthenticating = true;
  try {
    const user = await authenticateWithImmediateUi();
    // Complete the user's intended action immediately, restore focus so hiding
    // sign-in UI does not drop focus to document.body, and announce status
    document.body.dataset.signedIn = 'true';
    favoriteButton.setAttribute('aria-pressed', 'true');
    updateHeaderUserState(user);
    favoriteButton.focus();
  } catch (err) {
    if (err.name === 'NotAllowedError') {
      // No local credentials available or user dismissed dialog:
      // reveal fallback sign-in UI (moving focus to its first input) or redirect with return URL
      showFallbackSignInUi({ returnAction: 'favorite', returnFocusEl: favoriteButton });
      return;
    }
    console.error('Authentication error:', err);
  } finally {
    isAuthenticating = false;
  }
});
```

## Fallback strategies

### Immediate UI mode fallback

- **Progressive enhancement experience**: Treat `uiMode: 'immediate'` as a progressive enhancement. Do not infer support from a browser's name or version; the only reliable support signal is the `capabilities.immediateGet` runtime check via `PublicKeyCredential.getClientCapabilities()`. **MANDATORY**: Always check `capabilities.immediateGet` before calling `navigator.credentials.get({ uiMode: 'immediate' })`—browsers that do not recognize `uiMode: 'immediate'` ignore the unknown dictionary key and open a blocking modal passkey and QR code dialog. When `capabilities.immediateGet` is falsy, or when `navigator.credentials.get()` rejects with `NotAllowedError`, fall back to your application's standard sign-in experience (such as opening an inline sign-in modal or navigating to the dedicated sign-in page with a return URL parameter), so users in unsupported browsers see your existing sign-in flow unchanged:

```javascript
async function isImmediateUiSupported() {
  if (!window.PublicKeyCredential || !PublicKeyCredential.getClientCapabilities) {
    return false;
  }
  try {
    const capabilities = await PublicKeyCredential.getClientCapabilities();
    return Boolean(capabilities?.immediateGet);
  } catch {
    return false;
  }
}

async function authenticateWithImmediateUi() {
  // MANDATORY: Check immediateGet support so unsupported browsers do not open a modal QR dialog
  const supported = await isImmediateUiSupported();
  if (!supported) {
    // Throw NotAllowedError so the caller's single catch path treats "unsupported" like "no local credentials"
    throw new DOMException('Immediate UI mode is not supported', 'NotAllowedError');
  }
  // Proceed with fetching options and calling navigator.credentials.get({ password: true, publicKey, uiMode: 'immediate' })
}
```

### Client capabilities detection fallback

Baseline status for the api.PublicKeyCredential.getClientCapabilities_static capability: Newly available. It's been Baseline since 2025-02-06.
Supported by: Chrome 133 (Feb 2025), Edge 133 (Feb 2025), Firefox 135 (Feb 2025), and Safari 17.4 (Mar 2024).

Always install `'webauthn-polyfills'` and import it in your client module so `PublicKeyCredential.getClientCapabilities()` is available whenever `PublicKeyCredential` is supported:

```javascript
import 'webauthn-polyfills';
```

### Password credentials fallback

Browser support for Password credentials: Limited availability.
Supported by: Chrome 60 (Jul 2017) and Edge 79 (Jan 2020).
Unsupported in: Firefox and Safari.

Passing `password: true` alongside `publicKey` in `navigator.credentials.get()` allows supporting browsers to include saved passwords from the browser's password manager in the unified immediate account chooser.

- **Fallback experience**: Browsers that do not support `PasswordCredential` ignore the `password: true` option or fall back via the `capabilities.immediateGet` feature check to the standard sign-in form, where `<input autocomplete="username webauthn">` and `<input type="password" autocomplete="current-password">` provide native password autofill.

### Easy JSON serialization fallback

Baseline status for the api.PublicKeyCredential.parseRequestOptionsFromJSON_static capability: Newly available. It's been Baseline since 2025-03-31.
Supported by: Chrome 129 (Sep 2024), Edge 129 (Sep 2024), Firefox 119 (Oct 2023), and Safari 18.4 (Mar 2025).

Always install `'webauthn-polyfills'` and import it in the client bundle so `PublicKeyCredential.parseRequestOptionsFromJSON()` and `PublicKeyCredential.prototype.toJSON()` work consistently across browsers supporting `PublicKeyCredential`:

```javascript
import 'webauthn-polyfills';
```

### Signal API synchronization fallback

Browser support for Web authentication signal methods: Limited availability.
Supported by: Chrome 132 (Jan 2025), Edge 132 (Jan 2025), and Safari 26 (Sep 2025).
Unsupported in: Firefox.

The WebAuthn Signal API (`webauthn-signals`) is a progressive enhancement that removes stale passkeys from the user's password manager when the server responds with HTTP `404`.

- **Fallback experience**: Gate calls behind `if (PublicKeyCredential.signalUnknownCredential)`. When unsupported, skip the signal call gracefully and display a clear message guiding the user to sign in with an alternative method.
