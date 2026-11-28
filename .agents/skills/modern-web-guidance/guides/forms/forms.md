# Forms

## 1. Semantic Structure and Form Element

### Guidelines

- **DO** use the `<form>` element to wrap interactive controls for data collection.
- **DO** wrap search forms and filtering controls in a `<search>` element.
- **DO** give `<form>` elements an accessible name via `aria-labelledby` (pointing to the form's heading) when a page has multiple forms.
- **DO** use `method="POST"` for sensitive data and mutations; use `method="GET"` for idempotent requests (e.g., search).
- **DO** specify the `action` attribute for the destination URL.
- **DO** specify a `name` attribute for every form control to identify data on submission.
- **DO** use semantic tags like `<button type="submit">`, `<textarea>`, `<select>`, and specific `<input>` types.
- **DO** explicitly set `type="button"` on secondary or helper buttons so they don't default to type="submit".
- **DO** use `<fieldset>` and `<legend>` (with `<legend>` as the first child) to group related controls. **DON'T** use `<fieldset>` for visual styling without a `<legend>`
- **DO** use actionable language on submit buttons (e.g., "Save changes").

- **DON'T** nest `<form>` elements inside other `<form>` elements.
- **DON'T** use `GET` for sensitive data (it exposes data in history/logs).
- **DON'T** use generic `<div>`, `<span>`, or `<a>` elements for form controls.
- **DON'T** use `type="button"` for primary submission buttons.
- **DON'T** disable textarea resizing without alternate layout provisions.
- **DON'T** use CSS to visually reorder form controls away from their DOM/keyboard `Tab` order.
- **DON'T** auto-submit a form when a user changes `<select>`, radio buttons, or checkbox without an explicit submit action.

### Code Example

```html
<search>
  <form action="/search" method="GET">
    <label for="q">Search query</label>
    <input type="search" id="q" name="q">
  
    <fieldset>
      <legend>Search filters</legend>
      <input type="checkbox" id="exact" name="exact" value="true">
      <label for="exact">Exact match only</label>
      <input type="checkbox" id="archived" name="archived" value="true">
      <label for="archived">Include archived results</label>
    </fieldset>

    <button type="submit">Search</button>
  </form>
</search>
```

### Selection Control Decision Matrix

| Options Count | Choice Type | Recommended Element | Usability & Accessibility Logic |
| :--- | :--- | :--- | :--- |
| **1** | Binary toggle (Yes/No) | `<input type="checkbox">` | **Reversible State**: Can be checked and unchecked with space unlike a radio button, which gets stuck once checked. |
| **2–5** | Single (Exclusive) | `<input type="radio">` | **Zero-click scanning**: All choices are immediately visible. Faster scan time. |
| **6+** | Single (Exclusive) | `<select>` | **Space conservation**: Use only when vertical space is premium or the list is long. |
| **10+ / Dynamic** | Single (Exclusive) | `<input list="id">` (`<datalist>`) | **Fuzzy Search**: Prevents scrolling fatigue in massive sets (e.g., countries). |
| **2+** | Multi-select | `<input type="checkbox">` | **Standard semantics**: Native non-exclusive toggles. |

**Single-Sentence Mental Model**: "Expose 2 to 5 mutually exclusive options as visible radio buttons when choices are fewer than six; use `<select>` only when space is constrained or the list is long."

## 2. Accessible Labeling and State

### Guidelines

- **DO** always associate `<label>` with its input using `for` and `id`.
- **DO** place `<label>` elements before text inputs, `<textarea>`, and `<select>` controls in the DOM and stack them visually above the control for faster scanning.
- **DO** place `<label>` elements inline immediately after `<input type="checkbox">` and `<input type="radio">` controls for consistent alignment.
- **DO** use visible labels and keep critical format instructions (e.g., `3-12 characters`) in the label or persistent helper text; do not rely on `placeholder` alone.
- **DO** ensure the vertical margin between a label and its input is less than the margin between form groups (**Gestalt Proximity Rule**).
- **DO** set `aria-invalid="true"` on form controls that fail custom validation, and clear it once resolved.
- **DO** use `aria-describedby` to link inputs with help text or error messages.
- **DO** define the `lang` attribute on `<html>` for proper device translation.
- **DO** use non-color visual cues (icons, text) to communicate state (don't rely on color alone).
- **DO** indicate clearly which fields are required both visually in the label and programmatically with the `required` attribute.
- **DO** use `aria-live` for dynamic error announcements.
  
- **DON'T** use `aria-label` when a visible `<label>` can be used or override visible text with a mismatched `aria-label`.

### Code Example

```html
<div class="field">
  <label for="username">Username: <span aria-hidden="true">*</span></label>
  <input type="text" id="username" name="username" aria-describedby="user-help" required>
  <span id="user-help" class="hint">3-12 characters.</span>
</div>

<style>
  .field {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.25rem;
  margin-block-end: 1.5rem;
  }

  input:focus-visible {
    outline: 3px solid #0b57d0;
    outline-offset: 2px;
  }
</style>
```

## 3. Autofill and Input Hints

### Guidelines

- **DO** use the `autocomplete` attribute to specify expected data (e.g., `email`, `tel`, `current-password`, `new-password`).
- **DO** use `inputmode` to optimize on-screen keyboards (e.g., `inputmode="numeric"` for PINs).
- **DO** use `enterkeyhint` to set the Enter key label (e.g., `next`, `done`).
- **DO** turn off text correction on fields that hold identifiers rather than prose: `autocorrect="off"` (plus `autocapitalize="none"` and `spellcheck="false"`) on usernames, emails, URLs, codes, and search inputs. Leave the defaults on for free-text fields like messages and comments.
- **DO** use single-field inputs for complex numbers (credit cards, phones) to help autofill.
- **DO** use a single `<input type="text" inputmode="numeric" autocomplete="one-time-code">` and the WebOTP API for SMS one-time passcode verification. See guide `sms-otp-form` (via `npx -y modern-web-guidance@latest retrieve "sms-otp-form"`).

- **DON'T** use `type="number"` for credit cards, ZIP codes, or one-time passcodes (causes UI scroll issues and removes leading zeros).
- **DON'T** split a single value (such as a 6-digit OTP, phone number, or credit card) across multiple `<input>` boxes that auto-advance focus on keypress. Instead, use `type="text"` with `inputmode="numeric"` (`type=number` adds spinner buttons). If needed, styling can convey a similar UI. JS can set a `--value-length` CSS variable for higher fidelity styling that resembles these inputs, without their usability and accessibility issues.
- **DON'T** block copy-and-paste (`paste` events) or disable `autocomplete` on passwords, verification codes, or other authentication fields.

### Code Example

```html
<label for="zip">ZIP Code:</label>
<input type="text" id="zip" name="zip" autocomplete="postal-code" inputmode="numeric" pattern="\d{5}" enterkeyhint="next">

<label for="username">Username:</label>
<input type="text" id="username" name="username" autocomplete="username" autocorrect="off" autocapitalize="none" spellcheck="false" enterkeyhint="done">
```

## 4. Constraints and Validation

### Guidelines

- **DO** use native constraints: `required`, `minlength`, `maxlength`, `pattern`.
- **DO** use CSS pseudo-classes `:user-invalid` for non-intrusive styling.
- **DO** use the ValidityState API (`setCustomValidity`) for custom messaging and write clear error messages that explain how to fix the issue.
- **DO** move focus to the first invalid field (or an error summary) when a form submission fails validation.

- **DON'T** use the raw `:invalid` CSS pseudo-class alone for error styling to ensure empty required fields are not marked as invalid before the user interacts with the form.
- **DON'T** disable submit buttons to block validation; let users submit and highlight errors. However, **DO** disable the button *after* a valid submission is clicked to prevent double-posts.
- **DON'T** trigger validation errors or `aria-live` error announcements on every keystroke while the user is typing (validate on submit or `blur`, and clear errors on `input` once resolved).

### Code Example

```html
<label for="code">Activation Code (4 digits):</label>
<input type="text" id="code" name="code" required pattern="\d{4}">

<script>
  const input = document.getElementById('code');
  input.addEventListener('invalid', () => {
    input.setCustomValidity('Please enter exactly 4 digits.');
  });
  input.addEventListener('input', () => {
    input.setCustomValidity('');
  });
</script>
```

### Validation Event Timing Matrix

| Event Trigger | Phase | Action Allowed | UX / Accessibility Logic |
| :--- | :--- | :--- | :--- |
| **`input`** | Active Typing | **Clear** existing errors only. | **Non-intrusive**: Do not yell at the user before they finish typing. |
| **`blur` / `focusout`** | Exiting Field | **Run** check (if edited) and show error. | **Contextual validation**: Validate once the user indicates they are "done" with a field. |
| **`submit`** | Final Attempt | **Block** and route focus. | **Final gatekeeper**: Intercepts bad payloads and moves keyboard and screen reader focus to the first invalid field or an error summary. |

**Single-Sentence Mental Model**: "Validate on `blur` (if edited) to avoid premature warnings while typing, and reset error states on `input` as soon as the user fixes the value, and route the focus to the first error or summary on `submit`."

**Security vs UX Scale**: Client-side validation is for User Experience; Server-side validation is for Security. Never treat browser constraints as a data integrity defense.

## 5. Responsive Design and Typography

### Guidelines

- **DO** use single-column layouts for scanning.
- **DO** set `font: inherit` and `font-size: max(1rem, 1em)` on form controls to scale with larger containers while staying at least `1rem`(16px) to prevent iOS zoom.
- **DO** expand clickable areas for mobile tap targets using padding tricks.
- **DO** ensure tap targets are at least `48px`.
- **DO** use units relative to root (`rem`) and unitless `line-height`.
- **DO** use CSS logical properties (e.g., `margin-inline-start`) for RTL support.

### Code Example

```css
.form-group {
  margin-block-end: 1.5rem;
}

/* Expand clickable tap area without layout shift */
label {
  display: inline-block;
  padding: 10px 0;
  margin: -10px 0;
}

input {
  font: inherit;
  font-size: max(1rem, 1em);
  padding: 0.75rem;
  min-height: 48px;
  box-sizing: border-box;
}

@media (pointer: coarse) {
  input {
    min-height: 52px;
  }
}
```

## 6. Styling Form Controls

### Guidelines

- **DO** use `accent-color` for quick branding of native radios/checkboxes.
- **DO** use `appearance: none` for custom dropdown arrows without breaking semantics.
- **DO** ensure inputs are clearly visible with adequate border contrast (e.g., `#767676` or darker on white backgrounds).
- **DO** maintain a visible `:focus-visible` indicator on all controls. Never disable focus outlines (`outline:none`) without providing a high-contrast alternative.
- **DO** hide inputs visually using the canonical `.visually-hidden` recipe (`clip-path: inset(50%)` with 1px dimensions) — NOT `display: none`, which removes them from the accessibility tree.

### Code Example

```html
<div class="checkbox-container">
  <input type="checkbox" id="sub" name="sub" class="visually-hidden">
  <label for="sub" class="checkbox-label">Subscribe</label>
</div>

<style>
  .visually-hidden {
    position: absolute;
    clip-path: inset(50%);
    overflow: hidden;
    width: 1px;
    height: 1px;
    margin: -1px;
    padding: 0;
    border: 0;
    white-space: nowrap;
  }
  .checkbox-label::before {
    content: "";
    display: inline-block;
    width: 1.25rem;
    height: 1.25rem;
    border: 2px solid #767676;
  }
  input:focus-visible + .checkbox-label::before {
    outline: 2px solid #0b57d0;
  }
</style>
```

## 7. JavaScript and AJAX

### Guidelines

- **DO** check `KeyboardEvent.isComposing` before treating the `Enter` key as a submit action in chat or text inputs to ensure IME text composition is not interrupted. See guide `ime-safe-enter-submit` (via `npx -y modern-web-guidance@latest retrieve "ime-safe-enter-submit"`).
- **DO** prevent default navigation on form submit for AJAX (`e.preventDefault()`).
- **DO** use `ValidityState` interfaces for real-time validation checks.
- **DO** announce AJAX submission results via `role="status"` or `aria-live`.
- **DO** use `aria-expanded` and `aria-controls` for dynamic UI reveals.

- **DON'T** block page submission if JS fails; ensure server-side fallback.

### Code Example

```js
form.addEventListener('submit', (e) => {
  e.preventDefault();
  const data = new FormData(form);
  // fetch('/submit', { method: 'POST', body: data });
});
```

## 8. Identity, Payments, and Advanced Security

### Guidelines

- **DO** use `autocomplete="new-password"` for sign-up and `autocomplete="current-password"` for sign-in.
- **DO** allow pasting into password fields.
- **DO** provide an accessible toggle `<button type="button">` with `aria-pressed` allowing users to unmask password input.
- **DO** indicate exact amounts on pay buttons (e.g., "Pay $100").
- **DO** use `autocomplete="cc-number"`, `cc-exp`, `cc-csc`.
- **DO** use HTTPS for all pages.
- **DO** implement cryptographically secure anti-CSRF tokens for mutating actions (POST/PUT/DELETE).
- **DO** sanitize user input (e.g., via DOMPurify) before injecting it into the DOM to prevent XSS.
- **DO** implement spam protection for open forms using accessible CAPTCHAs (e.g., invisible reCAPTCHA) or honeypot fields hidden from assistive tech (`tabindex="-1"` and `aria-hidden="true"`)

- **DON'T** utilize HTTP `GET` for endpoints executing state changes.
- **DON'T** use inline JavaScript (e.g., `onclick="..."`) directly within form markup to satisfy strict Content Security Policies (CSP).

### Code Example

```html
<form method="post">
  <input type="hidden" name="csrf_token" value="secure_token_abc123">

  <h1>Sign up</h1>

  <div class="form-group">        
    <label for="name">Full name</label>
    <input id="name" name="name" autocomplete="name" required pattern="[\p{L}\.\- ]+">
  </div>

  <div class="form-group">        
    <label for="email">Email</label>
    <input id="email" name="email" type="email" autocomplete="username" required>
  </div>

  <div class="form-group">
    <label for="password">Password</label>
    <button id="toggle-password" type="button" aria-pressed="false" aria-label="Show password" aria-describedby="toggle-warning">
      <img class="icon-eye" src="/icons/eye.svg" alt="" width="20" height="20">
      <img class="icon-eye-off" src="/icons/eye-off.svg" alt="" width="20" height="20">
    </button>
    <span id="toggle-warning" class="visually-hidden">Warning: this will display your password on the screen.</span>
    <input id="password" name="password" type="password" autocomplete="new-password" minlength="8" aria-describedby="password-constraints" required>
    <div id="password-constraints">Eight or more characters.</div>
  </div>

  <button id="sign-up" type="submit">Sign up</button>
</form>
```


## 9. Address Collection

### Guidelines

- **DO** use a single field for names.
- **DO** use `autocomplete="street-address"`.
- If the site has users in different countries, **DO** use the `<textarea>` element for addresses, to accommodate different address formats in different geographical regions. If the form uses separate inputs for address parts (e.g. Street, City), **DO** use `autocomplete` values `address-line1`, `address-line2`, etc.
- **DO** make postal codes optional.
- **DO** provide a "Same as shipping address" checkbox when collecting both shipping and billing addresses (and scope `autocomplete` with `shipping` or `billing` inside a `<fieldset>`).

- **DON'T** split name inputs into rigid variables ("First", "Last") for global audiences.
- **DON'T** enforce Latin-only characters for names and usernames.

### Code Example

```html
<!-- Accessible Address Form with Autofill -->
<form action="/save-address" method="POST">
  <div class="form-group">
    <label for="full-name">Full name</label>
    <input type="text" id="full-name" name="full_name" maxlength="100" required autocomplete="name">
  </div>

  <div class="form-group">
    <label for="address">Address</label>
    <textarea id="address" name="address" required autocomplete="street-address" maxlength="300"></textarea>
  </div>

  <button type="submit">Save Address</button>
</form>
```


## 10. Usability Testing and Analytics

### Guidelines

- **DO** test forms across multiple devices, browsers, and screen sizes.
- **DO** test keyboard-only navigation (using `Tab`, `Shift+Tab`, `Space`, `Enter`, and Arrow keys) and verify visual focus.
- **DO** emulate various impairments (visual, motor) using browser tools.
- **DO** use analytics to monitor form completion rates and bounce points.
- **DO** track discrete events (e.g., field focus, click) to find micro-friction points.

- **DON'T** rely solely on automated tools (Lighthouse) for usability; test with real users.
- **DON'T** track sensitive personal data in standard event labels.

### Code Example

```html
<form action="/submit" method="POST" id="track-form">
  <label for="postal-code">ZIP or postal code</label>
  <input type="text" id="postal-code" name="postal-code" autocomplete="postal-code" maxlength="20" required>
  <button type="submit" id="submit-btn">Submit</button>
</form>

<script>
  const trackForm = document.getElementById('track-form');
  const trackBtn = document.getElementById('submit-btn');
  
  trackBtn.addEventListener('click', () => {
    console.log('Analytics Event: Submit clicked');
  });
</script>
```

## 11. Multi-Page Forms

### Guidelines

- **DO** clearly display progress through a multi-page form with clear labels and accessible progress indicators (e.g., `aria-current="step"` or `<progress>`).
- **DO** allow users to navigate backwards and forwards between pages without losing previously entered data.
- **DO** move focus to the new step's heading (`tabindex="-1"`) or first input when transitioning between steps dynamically without a full page reload.
- **DO** use context-specific `enterkeyhint` values (e.g., `"previous"`, `"next"`) to guide navigation via on-screen keyboards.
- **DO** design layouts so that the mobile keyboard does not obscure inputs or buttons (e.g., by placing them in the upper half of the viewport when focused or using CSS scroll-padding).

- **DON'T** leave inactive wizard steps in the keyboard `Tab` order or accessibility tree (use `hidden`, `display: none`, or `inert` on non-active steps).

### Code Example

```html
<nav aria-label="Progress">
  <ol class="progress-tracker">
    <li class="step-done">Step 1: Account (completed)</li>
    <li class="step-active" aria-current="step">Step 2: Shipping</li>
    <li class="step-todo">Step 3: Payment</li>
  </ol>
</nav>

<button type="button" onclick="history.back()" enterkeyhint="previous">Previous</button>
<button type="submit" enterkeyhint="next">Next</button>
```
