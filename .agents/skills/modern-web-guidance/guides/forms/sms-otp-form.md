# SMS OTP form verification

Delivering a one-time passcode (OTP) via SMS is a common flow for phone number verification, account recovery, step-up authentication, and payment confirmation. Switching between a browser and an SMS messaging app to memorize or copy-paste a multi-digit code introduces user friction, increases drop-off rates, and leaves users vulnerable to phishing on spoofed domains.

Combining semantic `<form>` markup, `<input autocomplete="one-time-code" inputmode="numeric">`, origin-bound SMS formatting (`@domain #code`), and the WebOTP API (`OTPCredential`) creates a layered, progressively enhanced verification flow:

1. **Automatic extraction and submission**: Browsers supporting the WebOTP API verify the origin against the `@domain #code` line in the SMS, populate the `<input>`, and trigger verification with a single tap.
2. **Origin-bound keyboard autofill**: Browsers and operating systems that support `autocomplete="one-time-code"` (such as Safari on iOS, iPadOS, and macOS) parse the `@domain #code` message and suggest the code in the keyboard autofill bar only when the domain matches.
3. **Frictionless manual entry**: Users entering a code from another device receive a numeric virtual keypad via `inputmode="numeric"` without the usability hazards of `<input type="number">`.

## Security considerations

SMS OTP verifies possession of a phone number and provides convenient step-up verification, but SMS transport and phone numbers can be subject to SIM swapping, number recycling, and interception. Always pair client-side autofill and the WebOTP API with the origin-bound `@domain #code` SMS format so the browser and OS verify that the target domain matches before suggesting or delivering the code. For primary phishing-resistant authentication, prefer passkeys over SMS-based codes (see `passkeys` (via `npx -y modern-web-guidance@latest retrieve "passkeys"`)).

## Semantic form markup

Wrap the verification control in a semantic `<form>` element with `method="POST"` and an explicit `<button type="submit">`. Always use a single `<input>` element rather than splitting digits across multiple boxes.

- **Use `type="text"` with `inputmode="numeric"`**: Never use `type="number"` for OTP codes. A one-time passcode is an identifier string that may contain leading zeros (such as `012345`), not a countable quantity. Using `type="number"` adds increment/decrement spinner buttons, can strip leading zeros, and allows accidental scroll-wheel value changes. Also avoid `type="tel"`, which is a legacy workaround intended for full telephone numbers. Pair `type="text"` with `inputmode="numeric"` to present a digits-only virtual keyboard on mobile devices.
- **Add `autocomplete="one-time-code"`**: Instructs browsers and operating systems to suggest incoming SMS verification codes in the autofill bar when the `<input>` is focused.
- **Place instructional hints above the `<input>`**: Associate a visible `<label>` using `for` and `id`, and place any format instructions (linked via `aria-describedby`) visually **above** the `<input>` so autofill popovers and mobile virtual keyboards never cover the instructions.
- **Do not split digits across multiple `<input>` elements**: Multi-box OTP patterns (six separate `maxlength="1"` inputs) break native `autocomplete="one-time-code"` autofill in many browsers, hinder copy-pasting, and complicate screen reader navigation. If a segmented visual design is required, style a single `<input>` with `letter-spacing` and a monospace font.

```html
<form id="otp-form" action="/verify-otp" method="POST">
  <div class="form-group">
    <label for="otp-input">Verification code</label>
    <!-- Place the hint above the input so autofill popovers and mobile keyboards do not obscure it -->
    <p id="otp-format-hint" class="field-hint">
      Enter the 6-digit code sent to your phone.
    </p>
    <!-- MANDATORY: Use a single input with type="text", inputmode="numeric", and autocomplete="one-time-code" -->
    <input
      type="text"
      id="otp-input"
      name="otp"
      inputmode="numeric"
      autocomplete="one-time-code"
      pattern="\d{6}"
      maxlength="6"
      aria-describedby="otp-format-hint"
      required>
  </div>
  <button type="submit">Verify code</button>
</form>
```

```css
/* Optional: Style a single input to visually space digits without splitting the DOM element */
#otp-input {
  font-family: ui-monospace, monospace;
  font-size: 1.25rem; /* Example value: must be at least 1rem (16px) to prevent mobile browser auto-zoom */
  letter-spacing: 0.35em;
  min-height: 48px;
  padding: 0.5rem 0.75rem;
  box-sizing: border-box;
}
```

## Origin-bound SMS message format

For both the WebOTP API and Safari's domain-bound `autocomplete="one-time-code"` autofill to verify that the code belongs to your website, your backend SMS service must format the **last line** of the text message with the origin domain prefixed by `@` and the OTP prefixed by `#`:

```text
Your verification code is 123456.

@example.com #123456
```

Enforce the following formatting rules on the outgoing SMS message:

- **Include human-readable text first**: Always start the SMS with a clear human-readable sentence containing the code so users typing it manually on another device can read it easily.
- **Place `@<domain> #<otp>` on the very last line**: The `@` character must be the first character of the final line, with no trailing lines or signature text after it.
- **Use only the host domain**: Do not include a URL scheme (`https://` or `http://`), port (`:8080`), or path (`/verify`) in the `@domain` token.
- **Separate tokens with a single space**: Place exactly one space between `@<domain>` and `#<otp>`, and never include whitespace inside the domain or between `#` and the code.

## Integrating the WebOTP API into your verification flow

The WebOTP API (`OTPCredential`) requires a Secure Context (`https://` in production, or `http://localhost` during local development). Instead of pasting a disconnected `DOMContentLoaded` script that queries the DOM and calls `form.submit()`, integrate `navigator.credentials.get()` directly into the lifecycle and submission handler of your verification UI:

- **Tie the request lifecycle to the active OTP step**: Start listening for the OTP when the verification input is rendered and active (for example, when the OTP step mounts after the user requests an SMS code, and again whenever the user clicks a "Resend code" button).
- **Manage an `AbortController` across all exit paths**: Pass an `AbortSignal` (`signal: ac.signal`) to `navigator.credentials.get()`. Call `ac.abort()` whenever:
    - The user manually submits the form (or submits a code filled via `autocomplete="one-time-code"`).
    - A new SMS code is requested ("Resend code"), aborting the previous controller before creating a new one.
    - The verification component, dialog, or route unmounts.
- **Trigger the application's submission handler (`form.requestSubmit()`)**: When `navigator.credentials.get()` resolves with `otp`, set `otpInput.value = otp.code` and call `form.requestSubmit()` (or invoke your verification function directly). Do **NOT** call `form.submit()`, because `form.submit()` bypasses `submit` event listeners (`event.preventDefault()` / `fetch()` handlers) and skips native constraint validation.

```javascript
const otpForm = document.getElementById('otp-form');
const otpInput = document.getElementById('otp-input');

let otpAbortController = null;

function stopSmsOtpListener() {
  if (otpAbortController) {
    otpAbortController.abort();
    otpAbortController = null;
  }
}

async function startSmsOtpListener() {
  // Feature-detect WebOTP support
  if (!otpInput || !('OTPCredential' in window)) {
    return;
  }

  // Cancel any previous pending WebOTP request (e.g., when re-sending an SMS code)
  stopSmsOtpListener();
  const ac = new AbortController();
  otpAbortController = ac;

  try {
    const otp = await navigator.credentials.get({
      otp: { transport: ['sms'] },
      signal: ac.signal,
    });

    if (!otp) return;
    otpInput.value = otp.code;

    // Trigger standard form submission so submit event listeners and validation run
    if (otpForm) {
      otpForm.requestSubmit();
    }
  } catch (err) {
    // Expected when aborted by manual submission, resend, unmount, or user dismissal
    if (err && err.name === 'AbortError') {
      return;
    }
    console.error('WebOTP verification error:', err);
  }
}

otpForm.addEventListener('submit', async (event) => {
  // MANDATORY: Abort any in-flight WebOTP request when the form is submitted
  stopSmsOtpListener();

  // Application-specific submission logic (e.g., AJAX fetch or native POST)
  event.preventDefault();
  const formData = new FormData(otpForm);
  // await fetch(otpForm.action, { method: 'POST', body: formData });
});

// Start listening when the OTP verification step becomes active
startSmsOtpListener();
```

## Cross-origin iframe verification

Receiving an SMS OTP inside a cross-origin `<iframe>` is restricted by default and is primarily used for embedded payment confirmation flows (such as 3D Secure verification where `shop.example` embeds an issuer challenge from `bank.example`). Supporting WebOTP inside a cross-origin `<iframe>` requires three coordinated configurations:

1. **Bind both origins on the last line of the SMS**: List the top-level embedding domain first (`@shop.example`), followed by `#<otp>`, followed by a space and the embedded iframe domain (`@bank.example`):

```text
Your verification code is 123456.

@shop.example #123456 @bank.example
```

2. **Send the `Permissions-Policy` HTTP response header**: Delegate `otp-credentials` to the cross-origin iframe origin in the parent document's HTTP headers:

```http
Permissions-Policy: otp-credentials=(self "https://bank.example")
```

3. **Add `allow="otp-credentials"` to the `<iframe>` element**: Explicitly grant the permission policy on the `<iframe>` tag in the embedding page and include a descriptive `title` attribute for screen readers:

```html
<iframe
  src="https://bank.example/verify"
  allow="otp-credentials"
  title="Payment verification">
</iframe>
```

Inside the `<iframe>` document served by `https://bank.example`, run the same `<form>` markup and `navigator.credentials.get({ otp: { transport: ['sms'] }, signal: ac.signal })` verification lifecycle shown above.

## Fallback strategies

### WebOTP API fallback

Browser support for WebOTP: Limited availability.
Supported by: Chrome 93 (Aug 2021), Edge 93 (Sep 2021), and Safari 27 (Sep 2026).
Unsupported in: Firefox.

If your target browsers do not support the WebOTP API (`OTPCredential`), do not load a third-party JavaScript polyfill, as reading incoming SMS messages requires operating-system-level integration. Instead, rely on the three-tier progressive enhancement built into the `<input>` markup:

- **Progressive enhancement experience**: Guard the `navigator.credentials.get({ otp: { transport: ['sms'] } })` call behind `if ('OTPCredential' in window)`. When `OTPCredential` is unavailable:
    1. Browsers that support `autocomplete="one-time-code"` (such as Safari on iOS 14+, iPadOS, and macOS with iCloud SMS relay) parse the `@domain #code` SMS and present the code in the system keyboard autofill bar when the `<input>` is focused.
    2. All other browsers fall back to manual entry in the single `<input type="text" inputmode="numeric" pattern="\d{6}" maxlength="6" required>`, displaying a numeric keypad on mobile devices and submitting via the `<button type="submit">`.

### Permissions Policy fallback

Browser support for Permissions policy: Limited availability.
Supported by: Chrome 108 (Nov 2022) and Edge 108 (Dec 2022).
Unsupported in: Firefox and Safari.

If the browser does not support delegating `otp-credentials` via `Permissions-Policy` and `<iframe allow="otp-credentials">`, the embedded verification `<form>` inside the cross-origin `<iframe>` degrades gracefully to `autocomplete="one-time-code"` keyboard suggestions and manual numeric input without throwing unhandled exceptions.

### Inputmode and AbortController support

Baseline status for inputmode: Widely available. It's been Baseline since 2021-12-07.
Supported by: Chrome 66 (Apr 2018), Edge 79 (Jan 2020), Firefox 95 (Dec 2021), Safari 12.1 (Mar 2019), and Safari iOS 12.2 (Mar 2019).

Baseline status for AbortController and AbortSignal: Widely available. It's been Baseline since 2019-03-25.
Supported by: Chrome 66 (Apr 2018), Edge 16 (Oct 2017), Firefox 57 (Nov 2017), Safari 12.1 (Mar 2019), and Safari iOS 12.2 (Mar 2019).

Both the HTML `inputmode` attribute and `AbortController` (`AbortSignal`) are supported across modern browsers and require no polyfill or fallback code.
