# Dialog

## Overview

Use the native `<dialog>` element for modal and non-modal dialogs. It provides the accessibility semantics, focus handling, top-layer rendering and `Esc` handling that custom overlays have to rebuild by hand.

## Choose the overlay type

Pick the first rule that matches. If unsure, use Rule 1.

### Rule 1: The overlay interrupts the user and blocks the page (default)

Use for confirmations, forms, sign-in, destructive actions, and any "modal", "dialog", "lightbox" or "popup" request that does not say otherwise.

Use `<dialog>` opened as a modal, declaratively with `command="show-modal"` (see `declarative-dialog-popover-control` (via `npx -y modern-web-guidance@latest retrieve "declarative-dialog-popover-control"`)) or from script with `showModal()`.

```html
<button type="button" command="show-modal" commandfor="confirm">Delete</button>

<!-- MANDATORY: no role="dialog" or aria-modal; the native modal already provides them -->
<dialog id="confirm" aria-labelledby="confirm-title">
  <h1 id="confirm-title">Delete this item?</h1>
  <form method="dialog">
    <button value="cancel" autofocus>Cancel</button>
    <button value="delete">Delete</button>
  </form>
</dialog>
```

The browser provides: inert page, focus containment, top layer, `::backdrop`, `Esc` and back-gesture dismissal, and focus return to the invoker.

- **DON'T** add `role="dialog"`, `aria-modal`, a focus trap, `inert` toggling or an `Esc` handler.
- **DON'T** open it with `show()` or the `open` attribute.
- **DO** stop the page scrolling behind it with the CSS below. See `prevent-page-scroll-under-modal-dialog` (via `npx -y modern-web-guidance@latest retrieve "prevent-page-scroll-under-modal-dialog"`) for the details.
- **DON'T** lock scrolling with `overflow: hidden` or `position: fixed` on `html` or `body`.

```css
/* MANDATORY (both rules): without them, scrolling over the backdrop or inside the dialog scrolls the page behind it */
dialog:modal {
  overscroll-behavior: contain; /* stops scroll gestures in the dialog chaining to the page */
}
dialog::backdrop {
  overflow: hidden; /* ::backdrop is not a scroll container by default, so it would ignore overscroll-behavior */
  overscroll-behavior: contain;
}
```

Not for menus or tooltips: see Rule 3.

### Rule 2: The user keeps working in the page while the panel is open

Use for find bars, inspectors, palettes and compose panes that are still dialogs semantically.

Use `<dialog popover>` for a top-layer panel with popover dismissal (`auto` light-dismisses, `manual` does not). Use `dialog.show()` only when the panel must not be in the top layer.

```html
<button type="button" popovertarget="find">Find</button>
<dialog id="find" popover="manual" aria-labelledby="find-title">
  <h2 id="find-title">Find</h2>
  <input type="search" aria-label="Search">
  <button type="button" popovertarget="find" popovertargetaction="hide">Close</button>
</dialog>
```

The page stays interactive and is not made inert.

- **DO** include a visible close button.
- **DON'T** use `showModal()`, which blocks the page.

Not for blocking confirmations: see Rule 1.

### Rule 3: The overlay is not a dialog

Use for menus, dropdowns, tooltips, hovercards and toasts.

Use a semantic element with the `popover` attribute, not `<dialog>`.

```html
<button type="button" popovertarget="menu">Actions</button>
<ul id="menu" popover>
  <li><a href="/rename">Rename</a></li>
</ul>
```

## Choose how it can be dismissed

The default depends on how the dialog is opened. If `closedby` is absent or invalid, `showModal()` behaves as `closerequest` and any other way of opening behaves as `none`.

- **Esc and back gesture only (modal default):** set nothing, or `closedby="closerequest"`.
- **Also click outside to close:** use `closedby="any"`.
- **Only the developer closes it (for example a form with unsaved changes):** use `closedby="none"` and add a confirmation path. See Closing below.

## Guidelines

### Accessible name and initial focus

- **DO** name every dialog with `aria-labelledby` pointing at its heading, or `aria-label` when there is no visible title.
- **DO** put `autofocus` on the primary control or first field.
- **DO** put `autofocus` on the safe action (such as Cancel or Keep) in a destructive confirmation.
- **DON'T** write code to return focus on close. The browser returns it to the invoker.

### Opening

- **DO** open declaratively with `command="show-modal"` and `commandfor` on a `<button>`. See `declarative-dialog-popover-control` (via `npx -y modern-web-guidance@latest retrieve "declarative-dialog-popover-control"`).
- **DO** use `dialog.showModal()` when opening from script.

### Closing

- **DO** close with `<form method="dialog">` buttons or `command="close"`.
- **DO** choose `closedby` deliberately: `any` (light dismiss and `Esc`), `closerequest` (`Esc` only, the modal default) or `none` (developer-controlled close only).
- **DO** use `command="request-close"` or `requestClose()` for Cancel buttons that must honor unsaved-changes logic. They fire `cancel` first and ignore `closedby`.
- **DO** treat `closedby` as progressive enhancement. `Esc` and the mobile back gesture already close modals without it.

### Hooking into close

- **DO** read `dialog.returnValue` in a `close` listener to learn which button was used, then reset it with `dialog.returnValue = ''`. `Esc` and other close requests set no value, and browsers differ on whether they clear the previous one, so without the reset a stale value can leak. Treat `''` as "dismissed without choosing".
- **DO** use `cancel` to intercept `Esc` and `request-close`, but do not rely on `preventDefault()` for repeated `Esc` presses without user activation.
- **DO** use `closedby="none"` with an explicit confirmation step for dirty forms.
- **DO** tell the user why the dialog stayed open when `cancel` is prevented: show a visible message and reference it with `aria-describedby` from the control that receives focus (such as Discard), so a screen reader reads it when focus moves. Without it, focus moving to a new button announces only that button's name.
- **DON'T** let the confirmation move controls under the pointer. Reserve the message's space (hide it with `visibility`, not `display` or `hidden`) and add the destructive button where existing buttons do not move (for example first in a right-aligned row), so a second click at the same spot cannot discard the user's changes.

### Non-modal dialogs

- **DO** use `<dialog popover>` (`auto` or `manual`) for a top-layer panel, and `dialog.show()` when you do not want the top layer.
- **DO** include a visible close button in every non-modal dialog.

### Backdrop and styling

- **DO** style `::backdrop` and use `dialog:modal` to target modal-only styles.
- **DO** leave animation to `animate-to-from-top-layer` (via `npx -y modern-web-guidance@latest retrieve "animate-to-from-top-layer"`), dragging to `drag` (via `npx -y modern-web-guidance@latest retrieve "drag"`), and reparenting to `persistent-top-layer-ui` (via `npx -y modern-web-guidance@latest retrieve "persistent-top-layer-ui"`).
- **DON'T** set `display` on `dialog` unconditionally. It overrides the closed state. Scope it with `dialog[open]`.

### Accessibility

- **DON'T** add `role="dialog"`, `aria-modal`, a manual focus trap or `inert` toggling to a native modal.
- **DO** use a native `<button>` with an accessible name for close controls.
- **DO** use one consistent heading level for dialog titles.
- **DO** use a level-1 heading for the main heading in modal dialogs, as it's the first heading in scope.
- **DO** Ensure that non-modal dialogs are displayed where there is no or minimal content. To adhere to WCAG 2.4.11, ensure that focused elements are completely obscured by the non-modal dialog.

## Fallback strategies

### `closedby` (`dialog-closedby`)

Browser support for <dialog closedby>: Limited availability.
Supported by: Chrome 134 (Mar 2025), Edge 134 (Mar 2025), and Firefox 141 (Jul 2025).
Unsupported in: Safari.

Without `closedby`, a modal still closes with `Esc` and the back gesture; only click-outside is lost, so this is graceful degradation. `closedby="none"` is ignored the same way: `Esc` fires `cancel` and then closes the dialog. Keep the unsaved-changes guard in a `cancel` handler, not in `closedby="none"` alone, so it also protects where `closedby` is missing. If your Baseline target requires light dismiss, add this where `closedby` is missing:

```js
if (!('closedBy' in HTMLDialogElement.prototype)) {
  // Test the pointer position, not event.target: the <dialog> is also the target for its own
  // padding and the gaps between its children, so a target check would close on those clicks
  const outside = (e, dialog) => {
    const r = dialog.getBoundingClientRect();
    return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
  };
  for (const dialog of document.querySelectorAll('dialog[closedby="any"]')) {
    let pressedOutside = false;
    dialog.addEventListener('pointerdown', (e) => { pressedOutside = outside(e, dialog); });
    // Require the press and the release outside, so a text-selection drag that ends on the backdrop does not dismiss
    dialog.addEventListener('pointerup', (e) => { if (pressedOutside && outside(e, dialog)) dialog.close(); });
  }
}
```

### `overscroll-behavior`

Browser support for overscroll-behavior: Limited availability.
Supported by: Chrome 144 (Jan 2026), Edge 144 (Jan 2026), and Firefox 150 (Apr 2026).
Unsupported in: Safari.

Treat scroll containment as progressive enhancement. Do not feature-detect it: `@supports` reports the property as supported even where non-scrollable containers ignore it. Where it is not enforced, the dialog still contains scroll whenever its own content overflows, and `showModal()` still makes the page inert. Do not fall back to `overflow: hidden` or `position: fixed` on `html` or `body`, which removes the root scrollbar and shifts the layout.

### Invoker Commands (`command` / `commandfor`)

Baseline status for Invoker commands: Newly available. It's been Baseline since 2025-12-12.
Supported by: Chrome 135 (Apr 2025), Edge 135 (Apr 2025), Firefox 144 (Oct 2025), and Safari 26.2 (Dec 2025).

If your Baseline target does not include Invoker Commands, keep the same markup and conditionally load the polyfill (the same experience, as progressive enhancement). Detect on the interface and never load it unconditionally:

```js
// MANDATORY: feature detect on HTMLButtonElement.prototype and load only when native support is missing
if (!('commandForElement' in HTMLButtonElement.prototype)) {
  import('invokers-polyfill'); // npm install invokers-polyfill
}
```

Only Rules 2 and 3 use Popover.

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
