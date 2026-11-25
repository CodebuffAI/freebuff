# Validate Input After Interaction

## The Problem

Displaying validation errors the moment a user focuses on a field and starts typing is premature and distracting. For example, as a user types an email address (e.g., "user@gm") or a password with complex requirements, the field is technically invalid until completion. Standard `:invalid` styling results in an error state appearing immediately, frustrating the user.

## The Solution

The `:user-invalid` pseudo-class allows you to defer the error state until the user has "committed" to a value (by modifying and blurring the field) or attempted to submit the form. This ensures validation feedback is provided only after the user has finished interacting with the field.

### Implementation Strategy

1.  **HTML Constraint**: DO use standard HTML5 attributes like `type="email"`, `pattern`, and `required` to trigger the browser's built-in validation logic.
2.  **Visual Feedback**: DO use `:user-invalid` to apply error styling only after interaction.
3.  **Positive Reinforcement**: DO optionally use `:user-valid` to give a green "success" indicator once the requirements are met.
4.  **Graceful Recovery**: As soon as the user corrects the input to a valid format, `:user-invalid` stops matching, removing the error state immediately.
5.  **Error Text**: DO show visible error text with the error styling, so the error isn't shown by color alone. DO start each message with an error icon that has a text alternative such as "Error" (the safest choice), or word every message as an error, for example "Please enter a valid email address.", and use the same approach for every error in the form. DO say how to fix the error when you know how, for example "Enter an email address in the format you@example.com."
6.  **Error Link**: DO list the error message in the field's `aria-describedby`, after any hint, only while the field is invalid, so screen readers read it with the field. A reference in the markup would read the hidden message from page load. The script in "Consistent ARIA Experience" does this for each field whose `data-error` attribute is set to its error message's `id`.

## Implementation Guide

### Use Case 1: Email Validation

MANDATORY: Rely on standard HTML5 attributes for email fields. The error message is hidden by default and only revealed when the browser determines the user has left the field in an invalid state.

```html
<form>
  <div class="field">
    <label for="email">Email Address</label>
    <!-- MANDATORY: Place format hints above the input so autocomplete popovers don't cover them during editing -->
    <span id="email-hint" class="hint">Format: you@example.com</span>
    <!-- DO: Use standard HTML validation attributes like type="email" and required -->
    <!-- Set data-error to the error message's id. The aria-invalid script lists that id in aria-describedby while the field is invalid. -->
    <input
      type="email"
      id="email"
      name="email"
      required
      autocomplete="email"
      aria-describedby="email-hint"
      data-error="email-error"
    >
    <div id="email-error" class="error-msg">
      <span role="img" aria-label="Error">❌</span> Enter an email address in the format you@example.com.
    </div>
  </div>
</form>
```

```css
.hint {
  display: block;
  color: #5f6368;
  font-size: 0.85rem;
  margin-bottom: 0.25rem;
}

.error-msg {
  display: none;
  color: #d93025;
  font-size: 0.875rem;
  margin-top: 0.25rem;
}

/*
  DO: Only show error styles after user interaction.
  Use multiple indicators (border/background shift + icon/text) to avoid color-only states.
*/
input:user-invalid {
  border-color: #d93025;
  background-color: #fce8e6;
}

/* DO: Reveal the error message using the adjacent sibling selector */
input:user-invalid + .error-msg {
  display: block;
}

/* DO: Provide a clear success indication on :user-valid */
input:user-valid {
  border-color: #188038;
}
```

### Use Case 2: Password Complexity

MANDATORY: Define the complexity rule using a Regex Lookahead pattern in the `pattern` attribute. The rules list is shown above the input to guide the user, and highlighted if there's an error.

```html
<form>
  <div class="field">
    <label for="password">New Password</label>
    <!-- MANDATORY: Place hints and rules above the input so mobile keyboards do not obscure them -->
    <ul id="password-rules" class="rules-list">
      <li>At least 8 characters</li>
      <li>One uppercase letter</li>
      <li>One lowercase letter</li>
      <li>One number</li>
      <li>One special character</li>
    </ul>
    <!-- DO: Use pattern and minlength for complex password validation
         DO: Match all constraints with lookaheads via pattern attribute
     -->
    <!-- Set data-error to the error message's id. The aria-invalid script lists that id in aria-describedby while the field is invalid. -->
    <input
      type="password"
      id="password"
      autocomplete="new-password"
      required
      pattern="(?=.*\d)(?=.*[a-z])(?=.*[A-Z])(?=.*[\W_]).{8,}"
      minlength="8"
      aria-describedby="password-rules"
      data-error="password-error"
    >
    <!-- MANDATORY: Give the password its own error text. Turning the rules list red
         doesn't say what is wrong, and screen readers don't convey the color change. -->
    <div id="password-error" class="error-msg">
      <span role="img" aria-label="Error">❌</span> Password doesn't meet all the requirements listed above.
    </div>
  </div>
</form>
```

```css
/* DO: State the default styling as neutral */
.rules-list { 
  color: #5f6368; 
  margin-bottom: 0.5rem;
}

/* DO: Show invalid state (After interaction): Error */
input:user-invalid {
  border-color: #d93025;
  background-color: #fce8e6;
}

/* DO: Reveal the error message using the adjacent sibling selector */
input:user-invalid + .error-msg {
  display: block;
}

/* DO: Highlight rules list when error is shown using the modern :has() selector */
.field:has(input:user-invalid) .rules-list {
  color: #d93025;
  font-weight: 600;
}

/* DO: Add success indications for :user-valid state */
input:user-valid {
  border-color: #188038;
}

/* DO: Hide rules once satisfied. visibility keeps their space: collapsing the list on
   blur would move the submit button between mousedown and mouseup, and the click
   would be lost. */
.field:has(input:user-valid) .rules-list {
  visibility: hidden;
}
```

## Fallbacking & Browser Support

### Fallbacks & browser support for :user-valid and :user-invalid

Baseline status for :user-valid and :user-invalid: Widely available. It's been Baseline since 2023-11-02.
Supported by: Chrome 119 (Oct 2023), Edge 119 (Nov 2023), Firefox 88 (Apr 2021), and Safari 16.5 (May 2023).

### CSS for Fallback

```css
/* Applies to every field that can be invalid (input, select, textarea). :is() keeps the
   rule working where :user-invalid isn't supported: in a plain selector list, one
   unsupported selector drops the whole rule. */
:is(:user-invalid, .user-invalid-fallback) {
  border-color: #d93025;
  background-color: #fce8e6;
}

:is(:user-invalid, .user-invalid-fallback) + .error-msg {
  display: block;
}
```

### JavaScript Fallback

Use a reusable utility that tracks interaction state using a `WeakMap`. This avoids polluting the DOM with "dirty" classes or data attributes.

```javascript
const UserInvalidFallback = (() => {
  const dirtyState = new WeakMap();

  const updateState = (input) => {
    // validity.valid gives the current state without firing an 'invalid' event, as checkValidity() does.
    const isValid = input.validity.valid;

    // Update both visual and ARIA state
    input.classList.toggle('user-invalid-fallback', !isValid);
    input.classList.toggle('user-valid-fallback', isValid);

    input.setAttribute('aria-invalid', isValid ? 'false' : 'true');
    linkError(input, !isValid);
  };

  // List the error message (the id in data-error) in aria-describedby only while it's
  // shown: text that aria-describedby references is announced even when it's hidden.
  const linkError = (input, shown) => {
    const errorId = input.dataset.error;
    if (!errorId) return;
    const ids = (input.getAttribute('aria-describedby') || '').split(/\s+/).filter((id) => id && id !== errorId);
    if (shown) ids.push(errorId);
    if (ids.length) input.setAttribute('aria-describedby', ids.join(' '));
    else input.removeAttribute('aria-describedby');
  };

  const handleEvent = (event) => {
    const input = event.target;

    if (event.type === 'reset') {
      const controls = input.elements || [];
      for (const control of controls) {
        dirtyState.delete(control);
        control.classList.remove('user-invalid-fallback');
        control.classList.remove('user-valid-fallback');
        if (control.matches('input, select, textarea')) control.setAttribute('aria-invalid', 'false');
        if (control.dataset?.error) linkError(control, false);
      }
      return;
    }

    if (!input.checkValidity) return;

    // A submit attempt counts as interaction: the browser fires 'invalid' on each failing
    // field, including required fields the user never touched, so flag them all.
    if (event.type === 'invalid') {
      dirtyState.set(input, { hasInteracted: true, hasBlurred: true });
      updateState(input);
      return;
    }

    if (event.type === 'input' || event.type === 'change') {
      const state = dirtyState.get(input) || { hasInteracted: false, hasBlurred: false };
      state.hasInteracted = true;
      dirtyState.set(input, state);
      if (state.hasBlurred) {
        updateState(input);
      }
    } else if (event.type === 'blur') {
      const state = dirtyState.get(input) || { hasInteracted: false, hasBlurred: false };
      state.hasBlurred = true;
      dirtyState.set(input, state);
      if (state.hasInteracted) {
        updateState(input);
      }
    }
  };

  const init = (root = document) => {
    if (CSS.supports('selector(:user-invalid)')) return;

    // Firefox and Safari expose an empty required field as invalid from page load.
    root.querySelectorAll('input, select, textarea').forEach((el) => {
      if (!el.hasAttribute('aria-invalid')) el.setAttribute('aria-invalid', 'false');
    });

    root.addEventListener('blur', handleEvent, true); // Capture phase
    root.addEventListener('input', handleEvent);
    root.addEventListener('change', handleEvent);
    root.addEventListener('invalid', handleEvent, true); // invalid doesn't bubble
    root.addEventListener('reset', handleEvent, true); // Capture resets
  };

  return { init };
})();

// Initialize for a specific form
const form = document.querySelector('#demo-form');
UserInvalidFallback.init(form);
```

## Other Considerations

1.  **Accessibility**:
    *   MANDATORY: Use `aria-describedby` to link the rules list to the input.
    *   DO NOT: Hide rules lists entirely until the input is valid; users need to know what to type!
2.  **Pattern Attribute Limits**: MANDATORY: The `pattern` attribute performs a full match (implied `^...$`). Ensure your password regex accounts for the entire string.
3.  **Validation Strictness**: DO note that the browser's default `type="email"` validation is quite permissive (e.g., `user@localserver` might pass). If you need stricter validation, you may need to use a more robust validation library or a custom validation function alongside `type="email"`.
4.  **Focus Management**: MANDATORY: If a user submits the form with an invalid field, the browser will automatically focus the first invalid field. Your `:user-invalid` styles will apply immediately because a submission attempt counts as an interaction.
5. **Consistent ARIA Experience**: Native `:user-invalid` does not automatically sync with ARIA attributes. Add the following JavaScript to keep `aria-invalid` in sync with the visual state:

* Set `aria-invalid="false"` until `:user-invalid` matches, rather than leaving it unset. Firefox and Safari expose an empty `required` field as invalid from page load, and Chromium doesn't expose an empty `required` field as invalid after interaction unless `aria-invalid="true"` is set.
* Link each field to its error message by setting the field's `data-error` attribute to the error message's `id` (`data-error="email-error"` for `<div id="email-error">`), and let the script list that `id` in `aria-describedby` only while the field is invalid. Don't reference the error from `aria-describedby` in the markup: the error element is always in the page, and text that `aria-describedby` references is announced even when it's hidden.
* Announce an error that appears when the user leaves or changes a field through one polite live region for the page, a moment later so it doesn't talk over the next field. Don't make each error message a live region: a live region that is shown, rather than changed, isn't announced reliably. After a failed submit, move focus to the first invalid field so that its error is announced instead.

```javascript
// List the field's error message (the id in data-error) in aria-describedby only while
// it's shown: text that aria-describedby references is announced even when it's hidden.
const linkError = (el, shown) => {
  const errorId = el.dataset.error;
  if (!errorId) return;
  const ids = (el.getAttribute('aria-describedby') || '').split(/\s+/).filter((id) => id && id !== errorId);
  if (shown) ids.push(errorId);
  if (ids.length) el.setAttribute('aria-describedby', ids.join(' '));
  else el.removeAttribute('aria-describedby');
};

// One polite live region for the page announces an error that appears when the user
// leaves or changes a field. Run this once the form is in the page.
const announcer = document.createElement('div');
announcer.setAttribute('aria-live', 'polite');
announcer.classList.add('visually-hidden');
document.body.append(announcer);
let announceTimer;
let announcedField;

// Text as a screen reader reads it: icons' text alternatives in, aria-hidden text out.
const spokenText = (node) => {
  const copy = node.cloneNode(true);
  copy.querySelectorAll('[aria-hidden="true"]').forEach((n) => n.remove());
  copy.querySelectorAll('[role="img"][aria-label]').forEach((n) => n.replaceWith(`${n.getAttribute('aria-label')}: `));
  return copy.textContent.replace(/\s+/g, ' ').trim();
};
const announceError = (el) => {
  const error = document.getElementById(el.dataset.error);
  if (!error) return;
  const label = el.labels?.[0] ? `${spokenText(el.labels[0])}: ` : '';
  clearTimeout(announceTimer);
  announcer.textContent = '';
  announcedField = el;
  // Wait until the screen reader has announced the field that receives focus next.
  announceTimer = setTimeout(() => { announcer.textContent = label + spokenText(error); }, 500);
};

// Sync aria-invalid with the CSS :user-invalid state. Only form fields are synced, and
// an aria-invalid="true" that this script didn't set (for example from a server check)
// is left alone.
const flagged = new WeakSet();
// Fields whose current error has been announced, or read out by focus after a failed
// submit. A field can become invalid while the user types, so this is tracked separately.
const announced = new WeakSet();
const syncAria = (el, announce = false) => {
  if (!el.matches?.('input, select, textarea')) return;
  const invalid = el.matches(':user-invalid');
  if (invalid) {
    if (announce && !announced.has(el)) {
      announceError(el);
      announced.add(el);
    }
    el.setAttribute('aria-invalid', 'true');
    linkError(el, true);
    flagged.add(el);
  } else if (flagged.has(el) || el.getAttribute('aria-invalid') !== 'true') {
    el.setAttribute('aria-invalid', 'false');
    linkError(el, false);
    flagged.delete(el);
    announced.delete(el);
    // Clear a fixed field's announcement so it isn't found later when reading the page.
    if (announcedField === el) {
      clearTimeout(announceTimer);
      announcer.textContent = '';
    }
  }
};

// Start every field at aria-invalid="false".
document.querySelectorAll('input, select, textarea').forEach((el) => syncAria(el));

// Update on blur (to show and announce an error) and input (to clear it)
document.addEventListener('blur', (e) => syncAria(e.target, true), true);
document.addEventListener('input', (e) => {
  if (e.target.hasAttribute('aria-invalid')) syncAria(e.target);
});

// Checkboxes, radio buttons and other controls that commit on 'change' can become
// :user-invalid without losing focus, so update on change too.
document.addEventListener('change', (e) => syncAria(e.target, true), true);

// A failed submit fires 'invalid' on each failing field, including required fields the
// user never touched, so update those too. 'invalid' doesn't bubble. Focus moving to the
// first invalid field announces its error, so these aren't announced.
document.addEventListener('invalid', (e) => {
  announced.add(e.target);
  syncAria(e.target);
}, true);

// Reset clears :user-invalid after the 'reset' event, so update each field afterwards.
document.addEventListener('reset', (e) => {
  setTimeout(() => [...e.target.elements].forEach((el) => syncAria(el)));
}, true);
```

Hide the live region with the `.visually-hidden` utility:

```css
/* Hides content visually but keeps it in the accessibility tree */
.visually-hidden:where(:not(:focus-within, :active)) {
  position: absolute !important;
  clip-path: inset(50%) !important;
  overflow: hidden !important;
  width: 1px !important;
  height: 1px !important;
  margin: -1px !important;
  padding: 0 !important;
  border: 0 !important;
  white-space: nowrap !important;
}
```
