# Copy button

Build a button that copies the text of another element (code block, inline value, read-only field) or the current selection. Declare the target with Invoker Commands (`command` + `commandfor`) instead of per-button JavaScript wiring, and write with the Async Clipboard API.

## Implementation

### 1. Markup

```html
<!-- Custom commands MUST start with "--". commandfor is the id of the element whose text is copied. -->
<span class="copy"> <!-- positioning context for the bubble -->
  <!-- aria-label names the content being copied; several bare "Copy" buttons are indistinguishable to screen readers -->
  <button type="button" class="copy-button" command="--copy" commandfor="snippet" aria-label="Copy CSS code">
    <!-- Decorative icon, rendered however the codebase renders icons -->
    <span class="icon" aria-hidden="true"></span>
  </button>
  <!-- The confirmation bubble IS the live region. Keep it empty until a copy, and outside the button:
       a button's children are presentational, so a live region inside one is not reliably announced -->
  <span class="tip" role="status"></span>
</span>
<pre><code id="snippet">…</code></pre>
```

- Use `type="button"` so the button never submits a form.
- Size the button at least 24×24 CSS px with `min-inline-size`/`min-block-size` (not `inline-size`/`block-size`), so content can grow the target but never shrink it.
- Name an icon-only button with `aria-label`. If the button shows visible text, that text is the name; do not add an `aria-label` that differs from it.
- Render the icon with whatever the codebase uses for icons (see `icons` (via `npx -y modern-web-guidance@latest retrieve "icons"`)) and mark it decorative; the button's accessible name comes from `aria-label`, not the icon.

### 2. Copying logic

Put the copy logic in one function so the native and fallback paths share it.

```js
let selectedText = ''; // set by the optional selection popover (step 3)

async function copy(button, target, command = '--copy') {
  // Form controls expose text via .value; innerText (unlike textContent) keeps rendered line breaks
  const text = command === '--copy-selection'
    ? selectedText
    : target.matches('input, textarea') ? target.value : target.innerText.trim();
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    report(button, true); // see Feedback below
  } catch {
    report(button, false); // clipboard access can be denied: show the failure too, not only announce it
  }
}

// `command` events do not bubble: listen in the capture phase on document.
// event.source is the clicked button; event.target is the commandfor element.
document.addEventListener('command', (event) => {
  if (event.command.startsWith('--copy')) copy(event.source, event.target, event.command);
}, true);
```

- **One element for sighted and screen reader users:** `report()` sets `data-copied` (or `data-failed`) on the button and writes the message into the bubble, which is both the visible feedback and the live region. Sighted and screen reader users then get the same message for both outcomes. Keep messages short ("Copied", "Copy failed").
- **Show and hide the bubble with `opacity`,** not `display: none` or `visibility: hidden`, which take it out of the accessibility tree so the text is not announced.
- **Clean up:** after a short timeout, remove the state attributes and clear the bubble's text, so no stale "Copied" is left for screen reader browse mode.
- **Not color alone:** swap the icon (copy to check) on success and use the bubble text for both outcomes.
- **Repeat clicks:** clear the pending timeout and restart the animation instead of stacking timers. DO NOT disable the button while showing feedback: copying is idempotent, and disabling drops keyboard focus, announces a misleading unavailable state, and blocks retrying after a failure.
- **Reduced motion:** under `prefers-reduced-motion: reduce`, replace icon and bubble animations with an opacity fade.

```js
const timers = new WeakMap();

function report(button, ok) {
  const tip = button.nextElementSibling; // the role="status" bubble
  clearTimeout(timers.get(button));
  button.removeAttribute('data-copied');
  button.removeAttribute('data-failed');
  const message = ok ? 'Copied' : 'Copy failed';
  tip.textContent = '';
  void button.offsetWidth; // restart the CSS animation
  button.setAttribute(ok ? 'data-copied' : 'data-failed', '');
  requestAnimationFrame(() => (tip.textContent = message));
  timers.set(button, setTimeout(() => { // 2000ms is an example value
    button.removeAttribute('data-copied');
    button.removeAttribute('data-failed');
    tip.textContent = '';
  }, 2000));
}
```

### 3. Copy the current selection (optional)

Add this only for long prose where users want a floating button on selection. Skip it for code blocks, inline values, and fields.

- Use a `popover="manual"` element (not light-dismissed, so the selection survives) containing a button with `command="--copy-selection" commandfor="<container id>"`.
- Show it on `selectionchange` (debounced; wait for `pointerup` while dragging) only when the selection is non-collapsed and inside the container. A triple-click ends at the start of the next element, so do not require the end node to be inside: clip the range's end to the container and accept it when the clipped text equals the selected text. Copy and position from the clipped range, using its `getBoundingClientRect()`: centered on the inline axis and above the selection on the block axis, so it never covers selected text. Only enable the popover when `matchMedia('(pointer: fine)').matches`: touch browsers already offer Copy in their native selection menu, which the popover would duplicate and collide with.
- Assign the selected text to `selectedText` when showing the popover; `copy()` reads that saved string for `--copy-selection`; interacting with the button can collapse the live selection.
- Call `preventDefault()` on the popover's `pointerdown` to keep the selection. This also stops the button from taking focus on click or tap, so `:focus-within` cannot tell you that a press is in progress. Set a flag on the popover's `pointerdown` and, while it is set, do not hide the popover even if the selection collapses (some touch browsers clear it anyway). Clear the flag and re-check when the copy feedback ends (and on `pointercancel`). Otherwise, hide it on `Escape`, and when the selection collapses unless keyboard focus is inside the popover (re-check when focus leaves it).
- DO NOT hide the popover when the copy feedback timeout ends: a keyboard user's focus is on its button, and hiding it drops focus to the page, so the next `Tab` starts from the top. If `Escape` hides it while focus is inside, first move focus to the container: set `tabindex="-1"` on it just before the move and remove it on `blur`. Do not leave it in the markup, because a focusable container makes `Tab` skip the copy button in Firefox after a click in the text.

### 4. Repeated copyable elements (optional)

When a page repeats copyable elements (code blocks, list rows, token or ID cells), a visible button on each one adds noise. Keep the button hidden until the element is hovered, reveal it for keyboard users too, and never make it hover-only.

```css
/* Touch devices (no hover): the button stays visible, so keep it in flow where it cannot cover content */
.copyable { display: flex; align-items: start; gap: .5rem; }
.copyable .copy { flex: none; order: 1; }

/* Only hide where hover exists; the overlay is then revealed on demand */
@media (hover: hover) {
  .copyable { display: block; position: relative; }
  .copyable .copy { position: absolute; inset-block-start: .5rem; inset-inline-end: .5rem; } /* .copy is the bubble's positioning context, so move it, not the button */
  .copyable .copy-button { opacity: 0; transition: opacity .15s; }
  .copyable:hover .copy-button,
  .copyable:focus-within .copy-button,
  .copyable .copy-button:focus-visible,
  .copyable .copy-button[data-copied],
  .copyable .copy-button[data-failed] { opacity: 1; }
}
```

- Hide with `opacity` only. `display: none` and `visibility: hidden` remove the button from the tab order, so keyboard users could never reach it.
- Reveal on `:focus-within` of the container, as well as `:hover`, so the button shows when focus is on it or on focusable content in the block (such as a scrollable `<pre tabindex="0">`).
- Keep it visible on `(hover: none)` devices, where there is no hover to reveal it. Lay it out in flow beside the content there so it never covers it.
- Keep it visible while feedback shows (`data-copied` / `data-failed`), so the state does not vanish when the pointer leaves.
- Keep the button's 24×24 px minimum size and its accessible name; a hidden-by-opacity button is still announced by screen readers.
- DO NOT add `aria-hidden`, `inert` or `hidden` to the button to "hide" it, and do not toggle them on hover. Screen reader users (VoiceOver included) must be able to reach it with no hover, and focus moving onto it (including a screen reader cursor that moves focus) is what makes it visible.
- Add `padding-inline-end` on the `<pre>` so the button clears the code at rest. On a horizontally scrolling `<pre>`, that padding is only reached at the end of the scroll range, so long lines can pass under the button while scrolling. Give the button a mostly opaque background and a visible border so it stays legible over code, rather than reserving a permanent margin that narrows the code area on small screens.

## Fallbacks and browser support

### Invoker Commands

Baseline status for Invoker commands: Newly available. It's been Baseline since 2025-12-12.
Supported by: Chrome 135 (Apr 2025), Edge 135 (Apr 2025), Firefox 144 (Oct 2025), and Safari 26.2 (Dec 2025).

If your Baseline target does not include Invoker Commands, keep the same markup and add a click listener that calls the same `copy()` function. This is a short, robust fallback (progressive enhancement of the same experience):

```js
// Detect on the interface, not an instance
if (!('CommandEvent' in window)) {
  // Resolve the target from commandfor, as the browser does for command events
  document.addEventListener('click', (event) => {
    // Respect handlers that already canceled the button's activation.
    if (event.defaultPrevented) return;
    const button = event.target.closest('button[command^="--copy"]');
    if (!button) return;
    const target = document.getElementById(button.getAttribute('commandfor'));
    if (target) copy(button, target, button.getAttribute('command')); // a missing target would throw inside copy()
  });
}
```

Register only one of the two paths so a click never copies twice.

### Async Clipboard

Baseline status for the api.Clipboard.writeText capability: Widely available. It's been Baseline since 2020-03-24.
Supported by: Chrome 66 (Apr 2018), Edge 79 (Jan 2020), Firefox 63 (Oct 2018), Safari 13.1 (Mar 2020), and Safari iOS 13.4 (Mar 2020).

`navigator.clipboard` is only available in secure contexts (`https:` or `localhost`), and the write is rejected when permission is denied. `copy()` already covers both: a missing `navigator.clipboard` throws inside the `try`, so the failure message is shown and announced. Serve the page over HTTPS: that is the real fix.

Only as a last resort, when you cannot control the protocol of the host page (for example a component embedded on third-party sites), fall back to the deprecated `document.execCommand('copy')` so copying still works for the user. It must run synchronously inside the user's click handler, so use it only when `navigator.clipboard` is missing or the write rejects:

```js
function legacyCopy(text) {
  const previousFocus = document.activeElement;
  const field = Object.assign(document.createElement('textarea'), { value: text });
  field.setAttribute('readonly', '');
  field.style.cssText = 'position:fixed;inset-block-start:0;opacity:0';
  document.body.append(field);
  field.select();
  try {
    return document.execCommand('copy');
  } finally {
    field.remove();
    // Selecting the temporary field can move focus; restore it even if copying fails.
    previousFocus?.focus({ preventScroll: true });
  }
}

// In copy(), replace the plain write with:
try {
  await navigator.clipboard.writeText(text);
} catch {
  if (!legacyCopy(text)) throw new Error('Copy failed'); // reaches the existing failure path
}
```

Only the optional selection button (step 3) uses Popover.

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

### Repeated announcements (VoiceOver)

VoiceOver skips a message identical to the previous one from the same region, even if the region was emptied in between. Track the last message in a variable (not by reading the bubble, which is cleared) and, when a message repeats, append a no-break space (`\u00A0`) so it differs. It is not read aloud. One page-wide value is the simplest way to track it: a message from another button's bubble gets the space too, which is harmless. Do not use `ariaNotify()` for this.

```js
let lastMessage = '';

// In report(), replace `const message` with `let message`, then:
if (message === lastMessage) message += '\u00A0'; // differs from the last one, so it is announced
lastMessage = message;
```

