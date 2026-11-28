# Declarative Dialog and Popover Control

Use the Invoker Commands API to toggle the visibility of `<dialog>` and `[popover]` elements directly from HTML buttons, eliminating the need for custom JavaScript event listeners.

By applying the `commandfor` (target ID) and `command` (action) attributes to a `<button>`, the browser automatically handles open/close state changes, focus management, and accessibility bindings (such as `aria-expanded`). This declarative approach is recommended because it removes brittle boilerplate code, ensures interactions are functional immediately upon HTML parsing, and guarantees a robust, natively accessible user experience.

## Implementing Declarative Popovers

Popovers can be toggled open and closed using a single button.

```html
<!-- MANDATORY: The commandfor attribute links the invoker to the ID of the target element so the browser knows what to control. -->
<!-- MANDATORY: The command attribute specifies the action to perform. Use 'toggle-popover' to handle both open and close states automatically. -->
<button commandfor="my-popover" command="toggle-popover">
  Toggle Popover
</button>

<!-- MANDATORY: The target element must have the popover attribute to be controlled as a popover. -->
<div id="my-popover" popover>
  <p>Popover content goes here.</p>
</div>
```

If you need to control opening and closing with separate buttons, you can use the `show-popover` and `hide-popover` commands.

**IMPORTANT:** Do NOT combine `popovertarget` and `commandfor` on the same `<button>`, for the same popover. This will double-toggle it, breaking functionality.

```html
<!-- MANDATORY: Use 'show-popover' to explicitly open the popover. It will not close the popover if clicked again. -->
<button commandfor="my-explicit-popover" command="show-popover">
  Show Popover
</button>

<div id="my-explicit-popover" popover="manual">
  <p>This popover is explicitly opened and closed by separate buttons.</p>

  <!-- MANDATORY: Use 'hide-popover' to explicitly close the targeted popover. -->
  <button commandfor="my-explicit-popover" command="hide-popover">
    Hide Popover
  </button>
</div>
```

Hiding a popover, using a button inside the popover itself, will result in a loss of focus as the button will be hidden and won't retain focus. In this situation, provide additional scripting to return focus to the trigger/show control, so that people can continue to navigate from where they were previously.

## Implementing Declarative Modal Dialogs

Unlike popovers, modal dialogs typically use separate buttons for opening and closing. Use the `show-modal` command specifically when you need to open a dialog as a modal.

```html
<!-- MANDATORY: Use command="show-modal" to trigger the dialog as a modal, trapping focus and preventing interaction with the rest of the page. -->
<!-- MANDATORY: The commandfor attribute connects this button to the dialog ID. -->
<button commandfor="confirm-dialog" command="show-modal">
  Open Confirmation
</button>

<dialog id="confirm-dialog">
  <p>Are you sure you want to proceed?</p>

  <!-- MANDATORY: Use command="close" to dismiss the dialog safely. -->
  <!-- type="button" keeps this working if the dialog content is later wrapped in a <form>. -->
  <button type="button" commandfor="confirm-dialog" command="close">
    Cancel
  </button>
</dialog>
```

MANDATORY: Any button with `commandfor` and `command` that is inside a `<form>` (including the common `<form method="dialog">` wrapper) MUST set an explicit `type`: `type="button"` to run the command. Do not put a `command="close"` button inside `<form method="dialog">`— pick one strategy. A button with `type="submit"` will submit the form, and not also run the command. A command button with no `type` inside a `<form>` or with a `form` attribute does nothing, so older browsers which don't support commands don't submit the form by accident.

## Fallback strategies

Baseline status for Invoker commands: Newly available. It's been Baseline since 2025-12-12.
Supported by: Chrome 135 (Apr 2025), Edge 135 (Apr 2025), Firefox 144 (Oct 2025), and Safari 26.2 (Dec 2025).

Because Invoker Commands and Popovers are not yet universally supported, you MUST use polyfills as fallbacks for older browsers.

### Polyfilling Invoker Commands

MANDATORY: Feature detect support by checking for the `commandForElement` property on the `HTMLButtonElement` prototype. Do NOT check the window or document object. You MUST dynamically import the polyfill only when the native feature is missing. DO NOT unconditionally load the polyfill.
Mandatory: Listen for the 'command' event directly on the target element because the native 'command' event does not bubble.

**Option 1: Using a bundler**
Install the polyfill via npm (`npm install invokers-polyfill`). This approach is for projects using a bundler (like Vite or Webpack) or import maps. For all other setups, use the CDN option below.

```javascript
// MANDATORY: Feature detect 'commandForElement' on HTMLButtonElement.prototype.
// Conditionally load the invokers-polyfill only in browsers lacking native support.
if (!('commandForElement' in HTMLButtonElement.prototype)) {
  import('invokers-polyfill');
}
```

**Option 2: Using a CDN**
For projects without a bundler, dynamically import the polyfill directly from a CDN inside a `<script type="module">`.

```html
<script type="module">
  // MANDATORY: Feature detect 'commandForElement' on HTMLButtonElement.prototype.
  // Conditionally load the invokers-polyfill from a CDN only in browsers lacking native support.
  if (!('commandForElement' in HTMLButtonElement.prototype)) {
    import('https://esm.run/invokers-polyfill');
  }
</script>
```

**Invokers Polyfill Limitations**
MANDATORY: This polyfill does not handle the ARIA states (e.g., `aria-expanded`) of the command button the way native browsers do. You are strongly encouraged to handle these states yourself to ensure your site is fully accessible.

```javascript
// 2. Manually manage ARIA states in your listener
document.getElementById('action-target').addEventListener('command', (event) => {
  const command = event.command;
  const target = event.target;
  const source = event.source; // The button that triggered the command

  if (command === '--spin') {
    const isSpun = target.classList.toggle('is-spun');
    
    // Polyfill tip: Manually update ARIA to match the new state
    source?.setAttribute('aria-pressed', isSpun);
  }
});
```

### Fallbacks & browser support for Popover

Baseline status for Popover: Newly available. It's been Baseline since 2025-01-27.
Supported by: Chrome 116 (Aug 2023), Edge 116 (Aug 2023), Firefox 125 (Apr 2024), Safari 17 (Sep 2023), and Safari iOS 18.3 (Jan 2025).

The Popover API is mostly **progressive enhancement**, but its defining behaviors — top-layer promotion, light-dismiss, and `popovertarget` invocation — have no CSS-only equivalent. Older browsers need a polyfill, or a manual fallback if you would rather not ship one.

**Polyfill:** To support the `popover` attribute in older browsers, conditionally load [`@oddbird/popover-polyfill`](https://github.com/oddbird/popover-polyfill). **MANDATORY:** Feature detect by checking for the `popover` property on `HTMLElement.prototype`, and load the polyfill **only** when native support is missing — do NOT load it unconditionally.

With a bundler or import map:

```js
// MANDATORY: Feature detect 'popover' on HTMLElement.prototype.
if (!Object.hasOwn(HTMLElement.prototype, "popover")) {
  import("@oddbird/popover-polyfill");
}
```

If not using a package manager, import from a CDN, e.g. `"https://unpkg.com/@oddbird/popover-polyfill@latest/dist/popover.min.js"`.

Caveats when using the polyfill:
- Do NOT use the `popover` IDL attribute for any code that may run before the polyfill is fully loaded. It will not be mirrored as an attribute, the popover will not be picked up by the polyfill, and the property will be shadowing the accessor the polyfill adds forever. Use `setAttribute()`/`removeAttribute()` instead.
- **Styling caveat:** The polyfill cannot define the real `:popover-open` pseudo-class, so it applies a `.\:popover-open` class instead. **MANDATORY:** Combine the two with `:is()` or `:where()`, otherwise browsers that lack `:popover-open` discard the entire rule:

```css
[popover]:is(:popover-open, .\:popover-open) {
  display: block;
}
```

To prevent popovers from showing before the polyfill loads, hide them with CSS:

```css
@supports not selector(:popover-open) {
  [popover]:not(.\:popover-open) {
    display: none;
  }
}
```
