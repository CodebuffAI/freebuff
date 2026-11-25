# Installing web applications

Use the Web Install API to give users an explicit, in-page way to install a web
application. Installation is always completed through browser-controlled consent
UI; websites cannot silently install an app.

Use either the HTML `<install>` element or the JavaScript
`navigator.install()` method.

## Choose which install approach to use: HTML element or JavaScript method

Decide to use either the HTML `<install>` element or the JavaScript
`navigator.install()` method based on the following considerations.

* `<install>` element:
  * Pros:
    * The browser provides the install control, ensuring a consistent and
      trustworthy installation experience.
    * Installing another app does not trigger a separate permission prompt
      before the installation confirmation dialog.
    * No JavaScript is required to trigger the installation.
  * Cons:
    * Visual customization of the button is restricted.
    * The number of `<install>` elements on a page is capped by user-agent
      anti-spam limits, making `navigator.install()` a better fit for large app
      catalogs.

* JavaScript `navigator.install()` method:

  * Pros:
    * The installation UI can be fully customized to match the look and feel of
      the website.
    * The number of installation UI elements is not limited by the browser.
  * Cons:
    * Requires JavaScript to trigger the installation.
    * Installing another app triggers an initial `web-app-installation`
      permission prompt before the installation confirmation dialog.

## Prepare the web app

The app being installed must have a web app manifest. Give the manifest a stable
`id` so the browser can keep the app's identity separate from its launch URL.
For installation of the current app, link the manifest from the document.

```html
<!-- The current document's manifest is used by the no-argument install APIs. -->
<link rel="manifest" href="/manifest.webmanifest">
```

```json
{
  "id": "/",
  "name": "Example application",
  "short_name": "Example",
  "start_url": "/",
  "display": "standalone",
  "icons": [
    {
      "src": "/icons/app-192.png",
      "sizes": "192x192",
      "type": "image/png"
    },
    {
      "src": "/icons/app-512.png",
      "sizes": "512x512",
      "type": "image/png"
    }
  ]
}
```

Keep the manifest URL stable. For current-document installation, the manifest
must explicitly declare an `id` that is same-origin with the document. When
offering a different app by manifest URL, the manifest must be reachable over
HTTPS without credentials or redirects (CORS headers are not required), return a
JSON MIME `Content-Type` (such as `application/manifest+json`), and share the
same origin as that app's `start_url`.

## Use the HTML `<install>` element

The `<install>` element renders a user-agent-controlled button. Prefer it when
the browser's standard label and presentation are appropriate, because the
browser-owned control gives users a trustworthy installation affordance.

```html
<!-- No attributes installs the current document's linked web app. -->
<install></install>
```

To offer another web app (including a cross-origin app from an app catalog or
suite launcher), provide its manifest URL. The target `manifest` URL and its
`start_url` must share the same origin, and the manifest must be reachable
without credentials or redirects and return a JSON MIME `Content-Type`:

```html
<install manifest="https://app.example/manifest.webmanifest"></install>
```

Prefer declaring an explicit, stable `id` in the target manifest. If the target
manifest does not declare an `id`, you must supply its computed manifest ID in
the `manifestid` attribute so the browser can verify the expected app identity:

```html
<install
  manifest="https://app.example/manifest.webmanifest"
  manifestid="https://app.example/"
></install>
```

When a manifest omits `id`, the browser computes its fallback ID by resolving
the manifest's `start_url` against the manifest URL (not the installing page)
and stripping any URL fragment while keeping query parameters. For example, a
manifest at `https://app.example/catalog/manifest.webmanifest` with no `id` and
`"start_url": "../launch?source=catalog"` has a computed ID of
`https://app.example/launch?source=catalog`. Supplying `manifestid` checks that
computed identity; it does not override the manifest or keep the identity stable
if `start_url` later changes.

The `manifestid` attribute can either be absolute or relative. Relative values
are resolved against the installing document's base URL, and the resulting URL
must match the target manifest's processed ID.

Do not imitate, overlay, or transform the browser-controlled element. Its
presentation and activation restrictions protect users from deceptive
installation prompts.

### Handle installation success and errors

Listen for the `installresult` event to handle installation success and errors
and use the `event.result` property to determine the outcome:

* `"success"`: the app was installed, or the user approved an action (such as
  opening) for an already-installed app. Pages cannot distinguish between these
  two cases.
* `"aborted"`: the user canceled the installation or a browser condition
  prevented the installation from completing.
* `"invalid-data"`: the `manifest` or `manifestid` attribute values, manifest
  response, or required manifest fields are invalid.

```html
<install></install>
<p id="install-status" role="status"></p>

<script type="module">
  const installButton = document.querySelector("install");
  const installStatus = document.querySelector("#install-status");

  installButton.addEventListener("installresult", (event) => {
    switch (event.result) {
      case "success":
        installStatus.textContent = "The app was installed or opened.";
        break;
      case "aborted":
        installStatus.textContent =
          "Installation was canceled or could not complete.";
        break;
      case "invalid-data":
        installStatus.textContent =
          "Installation could not start because the app data is invalid.";
        break;
    }
  });
</script>
```

## Use the JavaScript `navigator.install()` method

Use `navigator.install()` in a secure context (HTTPS) when custom page UI is
necessary. Keep the button hidden until a supported installation mechanism is
available. Call `navigator.install()` directly from the click handler so the
call retains the required transient user activation.

```html
<button id="install-app" type="button" hidden>Install app</button>
<p id="install-status" role="status"></p>

<script type="module">
  const installButton = document.querySelector("#install-app");
  const installStatus = document.querySelector("#install-status");
  const supportsWebInstall =
    typeof Navigator.prototype.install === "function";

  if (supportsWebInstall) {
    installButton.hidden = false;
  }

  installButton.addEventListener("click", async () => {
    if (installButton.getAttribute("aria-disabled") === "true") {
      return;
    }
    // Use aria-disabled instead of disabled so activating the button does not drop focus.
    installButton.setAttribute("aria-disabled", "true");

    try {
      // MANDATORY: Call during the click handler; delayed calls lose user activation.
      await navigator.install();
      installStatus.textContent = "The app was installed or opened.";
      installButton.hidden = true;
    } catch (error) {
      if (error.name === "AbortError") {
        // Cancellation is an expected user choice; keep the button available to retry.
        installStatus.textContent = "Installation was canceled or could not complete.";
      } else {
        installStatus.textContent = "Installation could not start.";
        // Surface invalid manifests and unexpected platform failures to developers.
        console.error(error);
      }
    } finally {
      installButton.removeAttribute("aria-disabled");
    }
  });
</script>
```

Calling `navigator.install()` with no arguments installs the current document's
linked app and requires the manifest to declare an `id`.

To offer another app (including a cross-origin app, provided the target
`manifest` URL and its `start_url` share the same origin and the manifest is
served over HTTPS with a JSON MIME `Content-Type`), pass its manifest URL:

```js
await navigator.install({
  manifest: "https://app.example/manifest.webmanifest",
});
```

Prefer declaring an explicit, stable `id` in the target manifest. If that
manifest does not declare an `id`, also pass the target web app's computed
manifest ID (`start_url` resolved against the manifest URL without fragments)
so the browser can verify the expected identity:

```js
await navigator.install({
  manifest: "https://app.example/manifest.webmanifest",
  manifestId: "https://app.example/",
});
```

The `manifestId` option can either be absolute or relative. Relative values are
resolved against the installing document's base URL, and the resulting URL must
match the target manifest's processed ID.

### Handle installation success and errors

The `navigator.install()` method returns a promise that resolves when the
installation completes or when the user approves an action (such as opening) for
an already-installed app. Pages cannot distinguish between these two cases.

The promise rejects with the following errors if the installation fails or is
canceled:

* `AbortError`:
  * The user aborted the installation.
  * The permission was denied.
  * The environment doesn't support installation.
  * Multiple concurrent installation attempts.
  * A page navigation occurred during the installation process.
* `DataError`:
  * Missing linked manifest, invalid or unreachable manifest URL, redirect, or non-JSON `Content-Type` header.
  * Missing required manifest fields, or `start_url` is not same-origin with `manifest`.
  * The manifest omits `id` and no `manifestId` was provided, or `manifestId` does not match the manifest's processed ID.
* `NotAllowedError`:
  * Missing transient user activation.
* `TypeError`:
  * An options argument omits `manifest`, or `manifest` or `manifestId` is empty or cannot be parsed as a URL.
* `InvalidStateError`:
  * The API was called from a detached document, subframe, or fenced frame.
* `SecurityError`:
  * The `web-app-installation` Permissions Policy is disabled or the document is sandboxed.

## Fallback strategies

The Web Install API is a progressive enhancement. Browsers without either modern
entry point still provide their own installation UI when they support installing
web apps.

### Web app manifest fallback

Browser support for Web app manifest: Limited availability.
Supported by: Chrome 53 (Aug 2016), Edge 79 (Jan 2020), Safari 17 (Sep 2023), and Safari iOS 15.4 (Mar 2022).
Unsupported in: Firefox.

Browsers that do not use web app manifests can still present the application as
a normal website. Treat installation and standalone display as enhancements; do
not block access to core functionality when manifest-based installation is
unavailable.

### `<install>` fallback

<install> is not natively supported by any major browser yet.

The `<install>` element supports fallback child content for browsers that do not
render the browser-controlled install button. Use fallback content to link to a
maintained installation help page when the product provides one.

```html
<install>
  <!-- Rendered only when the browser does not provide the install control. -->
  <a href="/install-help">How to install this app</a>
</install>
```

If browser-specific instructions would be inaccurate or difficult to maintain,
leave the element empty. It then renders no non-functional replacement in an
unsupported browser.

For a custom install button, render it separately with `hidden` and reveal it
only when `navigator.install()` is supported or a `beforeinstallprompt` event
has been captured. Do not put an always-visible imitation of the
browser-controlled install button inside the fallback content.

### `navigator.install()` fallback

navigator.install() is not natively supported by any major browser yet.

When `navigator.install()` is unavailable, use the `beforeinstallprompt` event
as a fallback for installing the current app. Unlike `navigator.install()`, this
event cannot install a different app.

### `beforeinstallprompt` fallback

Browser support for beforeinstallprompt: Limited availability.
Supported by: Chrome 76 (Jul 2019) and Edge 79 (Jan 2020).
Unsupported in: Firefox and Safari.

Capture the event, prevent its automatic prompt, and reveal the custom install
button only after the browser confirms that prompting is possible. Use one click
handler that selects `navigator.install()` when available and otherwise uses the
captured event. The event is single-use, so discard it before awaiting the
user's choice and hide the button unless a new `beforeinstallprompt` event fires.

```js
const installButton = document.querySelector("#install-app");
const installStatus = document.querySelector("#install-status");
const supportsWebInstall =
  typeof Navigator.prototype.install === "function";
let deferredInstallPrompt;

if (supportsWebInstall) {
  installButton.hidden = false;
}

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;

  // Prefer navigator.install() when both mechanisms are available.
  if (!supportsWebInstall) {
    installButton.hidden = false;
  }
});

installButton.addEventListener("click", async () => {
  if (installButton.getAttribute("aria-disabled") === "true") {
    return;
  }
  // Use aria-disabled instead of disabled so activating the button does not drop focus.
  installButton.setAttribute("aria-disabled", "true");

  try {
    if (supportsWebInstall) {
      // Call directly from this handler to preserve transient user activation.
      await navigator.install();
      installStatus.textContent = "The app was installed or opened.";
      installButton.hidden = true;
    } else if (deferredInstallPrompt) {
      // Save and clear the single-use event before awaiting the user's choice.
      const promptEvent = deferredInstallPrompt;
      deferredInstallPrompt = undefined;
      await promptEvent.prompt();
      const { outcome } = await promptEvent.userChoice;

      installStatus.textContent =
        outcome === "accepted"
          ? "The app was installed."
          : "Installation canceled.";
      if (!deferredInstallPrompt) {
        installButton.hidden = true;
      }
    }
  } catch (error) {
    if (error.name === "AbortError") {
      // Cancellation is an expected user choice; keep the button available to retry.
      installStatus.textContent = "Installation was canceled or could not complete.";
    } else {
      installStatus.textContent = "Installation could not start.";
      console.error(error);
    }
  } finally {
    installButton.removeAttribute("aria-disabled");
  }
});
```

Do not show a non-functional install button in browsers that support neither
mechanism. Hiding the button is graceful degradation: users can still use any
installation affordance provided by their browser. Do not replace the hidden
button with browser-specific step-by-step instructions unless the product has a
tested, maintained onboarding flow for those browsers.