# Creating Toast Notifications

Toast notifications are transient status messages. Unlike menus, they should not close when a user interacts with other parts of the page. The popover="manual" state is ideal because it lacks "light-dismiss" behavior and allows multiple notifications to coexist.

## When to use

Toast notifications must be used to provide non-critical, supplemental information about the results of an interaction, or an event (e.g. an email has been received). An example may include confirming that a form submission was successful. Notifications that require immediate attention should instead use an alternative component. Examples include inline banners, dialogs or modal dialogs. These examples surface information in a way that is easier to identify for everyone. Toasts should be used sparingly, as making them accessible to everyone means addressing complex considerations, and is the reason why some companies have opted to no longer use them, and instead, utilize the alternative aforementioned components.

## Implementation guidelines

Prefer persistent toast notifications that remain present until they are dismissed, except for frequent, low importance events, where the friction persistence creates outweighs the value of the information provided. In those cases, do evaluate whether toasts actually add to the user experience in general — in some cases it may be preferable to not have them at all. If using a pattern that does dismiss toasts after a short period of time, check whether focus is on a control in the toast before dismissal. If the user is focused on a control inside the toast, pause dismissal until focus has left the toast.

* **MANDATORY:** Use popover="manual" so the notification stays visible until explicitly closed or timed out by a script.
* **MANDATORY:** Ensure that the information in the toast can be identified by other means, so that if it is part of a pattern that disappears after a short period of time, people can still identify the information without the toast being present.
* **DO** use a container to manage the stacking of multiple toasts. Since popovers in the Top Layer ignore parent z-index, you must position them individually or within a common layout group.
* **DO** add toast notifications consistently to the same container in the page, so that people using assistive technologies can consistently locate them.
* **DO** make the container a region, with an accessible name, so that it can be easily identified using a screen reader. For example: `<div role="region" aria-label="Notifications"></div>`.
* **DO** use `ariaNotify()` to announce the content present in toasts that are displayed. This ensures that people using screen readers, who cannot see the screen, are aware of the presence of toast messages
* **DO** ensure that only the toast's visible text is announced as part of the `ariaNotify()` and not the names of any controls. If actions are available in the toast (aside from a close control), append "Actions available" to the end of the announcement.
* **DO** provide an explicit "Close" button within the toast using popovertargetaction="hide".
* **DO** ensure that a toast's dismiss button is keyboard-focusable (without automatically stealing focus when the toast appears), so keyboard users can navigate to the toast region and dismiss notifications.
* **DO** manage focus when a user manually dismisses a currently focused toast: move focus to the next remaining toast in the stack, or—if no toasts remain—return focus to the user's prior focus location (or the control that triggered the toast).
* **DO** declare `transition-behavior: allow-discrete` as a separate property after `transition` (rather than inside the `transition` shorthand) to animate entry and exit from the Top Layer without older browsers ignoring the `transition` declaration.
* **DO** provide a non-animated version using the `prefers-reduced-motion` media query
* **DO** ensure that toast messages scale in size, and that all toast content remains visible when resizing text up to 200% to adhere to WCAG 1.4.4 Resize Text (Level AA)
* **DO** ensure that all toast content remains visible when adjusting text styling and spacing with CSS to adhere to 1.4.12 Text Spacing (Level AA)
* **DO** ensure that all toast content remains visible, or can be accessed still, when using a viewport sized to 320 by 256 CSS pixels to adhere to 1.4.10 Reflow (Level AA)

* **DON'T** surface toasts in scenarios where focus redirection may be used at the same time. The focus redirection may cancel out the toast announcements, resulting in people missing information.
* **DON'T** use toasts in modal dialogs. Content outside of the dialog will be inert and unavailable to assistive technologies. Placing the toast in a modal dialog, separate from the existing toast container makes it difficult to locate, and may lead to people not being able to locate it.
* **DON'T** surface toast notifications in the background while a modal dialog is open. It's likely the notification will be missed. Instead, suppress the notification until the modal dialog is dismissed.
* **DON'T** include controls in toast notifications that perform actions not already permanently available outside the toast notifications. Controls in toasts should be used sparingly, and only provided as a shortcut for actions already available via the UI.

## Optional: Usability & accessibility improvements

* **Surface previous toasts**: Provide a way for people to access a list of past toast messages. This can help people who may encounter difficulty in remembering what the toast informed them, or reduce anxiety for people who inadvertently dismissed a toast message.
* **Customize toast notifications**: Provide a way for people to customize which toast notifications are provided. This can help to ensure that information provided to people is relevant, reducing distractions and confusion.
* **Use an alternative way to communicate toasts are present**: It is recommended that there are multiple ways to communicate that a toast has been made visible. An example of this may be a brief sound effect (which could be turned off). This will help people using screen magnification software, who may otherwise find it difficult to identify that toasts are present.

## Fallback strategies

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

### Fallbacks & browser support for ariaNotify()

Baseline status for ariaNotify(): Newly available. It's been Baseline since 2026-09-14.
Supported by: Chrome 141 (Sep 2025), Edge 141 (Oct 2025), Firefox 150 (Apr 2026), and Safari 27 (Sep 2026).

Baseline status for ariaNotify(): Newly available. It's been Baseline since 2026-09-14.
Supported by: Chrome 141 (Sep 2025), Edge 141 (Oct 2025), Firefox 150 (Apr 2026), and Safari 27 (Sep 2026).

Use an ARIA live region, ensuring that the container is present in the page on load, and then add the messages to the live region container when relevant.

```html
<!-- Pre-populated hidden live region container -->
<div id="notification" aria-live="assertive"></div>
```

This content will be present in the DOM, and can be read by a screen reader after the message has been announced. Therefore, in order to provide context to this region, when the live region has content, add in text immediately before the container to provide context to the announcement. This will help people understand the purpose of the content if they identify it when reading the page.

```html
<p class="inclusively-hidden">Screen reader announcements</p>
<!-- Pre-populated hidden live region container -->
<div id="notification" aria-live="assertive">
  Dynamic announcement injected into the existing container.
</div>
```

### Fallbacks & browser support for Anchor positioning

Browser support for Anchor positioning: Limited availability.
Supported by: Chrome 157 (Nov 2026), Edge 157 (Nov 2026), and Safari 27 (Sep 2026).
Unsupported in: Firefox.

Without CSS Anchor Positioning, tethered elements such as `[popover]` overlays fall back to their default user-agent placement (centered in the viewport for popovers). Depending on whether spatial tethering is required for your use case, either conditionally load the polyfill or gate your positioning rules with `@supports`.

#### Option 1: Polyfill (`@oddbird/css-anchor-positioning`)

When the positioned element must stay spatially tethered to its trigger in unsupported browsers, conditionally load the `@oddbird/css-anchor-positioning` package.

**MANDATORY:** Feature-detect support via `CSS.supports("anchor-name: --a")` (or `"anchorName" in CSSStyleDeclaration.prototype`), and load the polyfill **only** when native support is missing — do NOT load it unconditionally.

With a bundler or import map:

```js
// MANDATORY: Feature-detect anchor positioning support before loading the polyfill.
if (!CSS.supports("anchor-name: --a")) {
  import("@oddbird/css-anchor-positioning");
}
```

Without a bundler, import from a CDN inside a `<script type="module">`:

```html
<!-- MANDATORY: Conditionally install the anchor positioning polyfill -->
<script type="module">
  if (!CSS.supports("anchor-name: --a")) {
    import("https://unpkg.com/@oddbird/css-anchor-positioning");
  }
</script>
```

**Polyfill caveats:**
- **No implicit anchors:** The polyfill does not support implicit anchor associations (such as those created by `popovertarget`, `commandfor`, `interestfor`, or `showPopover({ source })`). You **MUST** set a unique explicit `anchor-name` on each trigger and a matching `position-anchor` on the positioned element.
- **No `position-area` with `position-try-fallbacks`:** `position-area` with `position-try-fallbacks` is not supported by the polyfill. When using the polyfill on elements needing fallbacks, position elements using `anchor()` functions on inset properties (`top`, `left`, `right`, `bottom`) with `inset: auto` instead of `position-area`.
- **Do not wrap polyfilled rules in `@supports`:** Browsers without native anchor positioning evaluate `@supports (position-area: ...)` and `@supports (anchor-name: --a)` to `false` and discard the block before the polyfill can process it.

```css
.trigger {
  /* MANDATORY: Each trigger and positioned element pair must share a unique anchor name. */
  anchor-name: --my-trigger;
}

[popover].anchored-overlay {
  position-anchor: --my-trigger;
  /* MANDATORY: Use anchor() on inset properties rather than position-area when using the polyfill on elements needing position-try-fallbacks. */
  inset: auto;
  top: anchor(bottom);
  left: anchor(left);
  margin: 0;
}
```

#### Option 2: Progressive enhancement with `@supports` (no polyfill)

If you do not ship the polyfill, **DO NOT** set `inset: auto` or `margin: 0` unconditionally on a `[popover]` element that relies on `position-area` or `anchor()`. In browsers without anchor positioning, `inset: auto` overrides the user-agent centering (`inset: 0; margin: auto`) while `position-area` is ignored, leaving the popover stranded at `(0, 0)` or overlapping its trigger.

Instead, gate `inset: auto` and `margin: 0` inside `@supports` for the specific positioning feature used (for example, `@supports (position-area: block-end)` or `@supports (top: anchor(bottom))`) so unsupported browsers retain the default centered popover placement, or provide a matching `@supports not (...)` fallback layout (such as a fixed bottom sheet):

```css
@supports (position-area: block-end) {
  [popover].anchored-overlay {
    inset: auto;
    margin: 0;
    position-area: block-end span-inline-end;
    position-try-fallbacks: flip-block, flip-inline, flip-block flip-inline;
  }
}

@supports not (position-area: block-end) {
  /* Optional: override default popover centering with a fixed bottom bar */
  [popover].anchored-overlay {
    position: fixed;
    inset: auto 0 0 0;
    width: auto;
    margin: 0;
  }
}
```

#### sibling-index()

* **Guidance:** If sibling-index() is not supported, use the `+` operator to add margin manually. I.e. `popover + popover { margin-top: 1rem }`

#### transition-behavior

* **Guidance:** If transition-behavior is not supported, use JavaScript to add animation via classes as the toast element transitions in and out.
