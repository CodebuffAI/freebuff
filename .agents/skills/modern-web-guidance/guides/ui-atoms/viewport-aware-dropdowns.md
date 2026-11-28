# Viewport-Aware Dropdowns

A revealed action panel or popover button group is a useful pattern for users to access additional functionality while taking up minimal space. This overlay pattern comes with layout complexity, as the panel must remain tethered to a trigger element while adapting to viewport constraints. Traditionally, this required complex JavaScript libraries (like Popper.js or Floating UI) to calculate positions and handle collisions.

CSS Anchor Positioning provides a declarative, performance-optimized way to handle these relationships entirely in CSS, allowing browsers to manage the positioning and overflow logic natively.

> [!NOTE]
> This guide demonstrates anchor-positioning and popover mechanics — it does not prescribe a specific accessible UI pattern. The trigger and panel below are shown as a plain **button-revealing-a-button-group**. If you need a true ARIA menu (`role="menu"` with arrow-key navigation), a combobox, a disclosure widget, or any other named pattern, layer that pattern's full semantics and keyboard contract on top of the positioning techniques shown here.

### 1. Define the Button and Panel Relationship

The first step is to create a trigger button that opens the overlay container using the Popover API.

**MANDATORY Accessibility Distinction:** This pattern explicitly models a **button group revealed inside a popover** rather than a true ARIA menu. Do not apply `role="menu"` or `role="menuitem"` unless you fully implement the corresponding keyboard navigation contract (such as handling spatial arrow-key navigation between items). For the same reason, do not add `aria-haspopup` to the trigger — its value (`menu`, `listbox`, `tree`, `grid`, or the legacy `true`) is a promise that the target exposes a matching role, which this pattern does not.

```html
<button popovertarget="action-panel">
  Open Actions
</button>
<!-- Use the Popover API (`popover="auto"`) for the overlay to ensure it is placed in the top layer and handled accessibly by the browser. -->
<div id="action-panel" popover="auto" class="panel">
  <button class="action-item" type="button">Edit</button>
</div>
```

This creates an *implicit* anchor association between the button and the panel, so that the panel can be positioned relative to the button natively without needing `anchor-name` on the button or `position-anchor` on the panel.

### 2. Positioning with `position-area`

Instead of manual `top`/`left` offsets, use `position-area` to place the target on a 3x3 grid relative to the anchor.

```css
.panel {
  /* 
     Position the panel below the anchor (block-end), 
     aligned to the start of the anchor and spanning to its end (span-inline-end).
  */
  position-area: block-end span-inline-end;
  
  /* Reset insets to allow the grid to take control */
  inset: auto;
}
```

Prefer logical keywords (`span-inline-end`, `block-start`) over physical ones (`left`, `top`) to support RTL and different writing modes automatically.

**MANDATORY**: Do not mix physical and logical keywords in `position-area`.

### 3. Implement Edge-Resilience (Fallbacks)

To prevent the panel from being cut off at the edge of the screen, define "try tactics" that the browser should attempt if the default position overflows.

```css
.panel {
  /* 
     If the panel overflows the bottom, flip it to the top (flip-block).
     If it overflows the inline edges, flip it horizontally (flip-inline).
     If it overflows both (e.g., in a corner), flip on both axes (flip-block flip-inline).
  */
  position-try-fallbacks: flip-block, flip-inline, flip-block flip-inline;
}
```

If your dropdown or flyout includes a directional arrow or border that needs to change style depending on which fallback position was chosen, see `position-aware-tooltips` (via `npx -y modern-web-guidance@latest retrieve "position-aware-tooltips"`). For declarative invocation of dialogs and popovers without JavaScript, see `declarative-dialog-popover-control` (via `npx -y modern-web-guidance@latest retrieve "declarative-dialog-popover-control"`).

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
