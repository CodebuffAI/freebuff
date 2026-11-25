# Position Aware Tooltips

When building tooltips or popovers with CSS Anchor Positioning, the browser can automatically "flip" the element to a fallback position if it would otherwise overflow the viewport. When this happens, you may want to adjust the style of the positioned content, for instance to reposition an arrow that points from the positioned content to the anchor.

**Anchored Container Queries** solve this by allowing you to query the active positioning state of an element and apply styles accordingly. For general anchored dropdown and flyout positioning with viewport collision flipping (without directional arrow restyling), see `viewport-aware-dropdowns` (via `npx -y modern-web-guidance@latest retrieve "viewport-aware-dropdowns"`).

## The problem

Imagine a tooltip that appears above its anchor by default. It has a "down" arrow at the bottom. If the user scrolls and the tooltip flips to appear *below* the anchor, the arrow is now pointing the wrong way and is on the wrong side of the tooltip.

## The solution: Anchored Container Queries

By setting `container-type: anchored` on your positioned element, you turn it into a query container that knows about its own anchor-positioned state. You can then use the `@container anchored()` query to update its descendants or pseudo-elements.

### 1. Create the tooltip and trigger

Use the Popover API to create a tooltip. Invoking the popover via `popovertarget` automatically establishes an **implicit anchor connection** with the trigger button, so no explicit `anchor-name` or `position-anchor` is required.

```html
<button popovertarget="tooltip" id="anchor" aria-describedby="tooltip">anchor</button>
<div id="tooltip" popover role="tooltip"></div>
```

Reset the popover inset and margin styles for use with anchor positioning, but only if anchor positioning is supported.

```css
@supports (anchor-name: --my-anchor) {
  [popover] {
    inset: auto;
    margin: unset;
  }
}
```

### 2. Set up the container

Apply `container-type: anchored` to the element being positioned. This element must also have `position-try-fallbacks` defined to enable the flipping behavior.

```css
#tooltip {
  position: fixed;
  position-area: block-start;
  position-try-fallbacks: flip-block;

  /* Enable anchored container queries */
  container-type: anchored;
}
```

### 3. Style based on the fallback

Use `@container anchored(fallback: <value>)` to apply styles when a specific fallback is active.

Like all container queries, `@container` can only style **descendants** of the container. A common strategy to create the arrows is with the `::before` and `::after` pseudo-elements, which are treated as descendants and can be styled directly. However, to style the tooltip itself (as seen in step 4), we will add a child element to the tooltip, and create the arrow in its `::before` pseudo-element.

```html
<div id="tooltip" popover role="tooltip">
  <div class="tooltip-content">Tooltip</div>
</div>
```

```css
.tooltip-content::before {
  /* Default "down" arrow for the 'top' position */
  content: "▼" / "";
  position: absolute;
  inset-block-end: 0;
  inset-inline-start: 1rem;
}

/* Update to an "up" arrow when the 'flip-block' fallback (bottom) is active */
@container anchored(fallback: flip-block) {
  .tooltip-content::before {
    content: "▲" / "";
    inset-block-start: 0;
    inset-block-end: auto;
  }
}
```

## 4. Styling the container itself

If you need to change properties on the container itself (like `margin` or `background-color`) when it flips, you should use an **inner wrapper element**.

1. Apply `container-type: anchored` to the outer positioned element.
2. Target the inner element inside the `@container` block.


```css
@container anchored(fallback: flip-block) {
  .tooltip-content {
    border-radius: 0 0 .5rem .5rem;
    margin-block-start: 0.25rem;
  }
}
```

## 5. Styling the inner container (optional)

If the tooltip text is particularly long, use an inner container in the tooltip to ensure that, when visible, the tooltip will always fit between the trigger control and a side of the viewport. As an example, the following code will adhere to this when flipping the tooltip content on the block axis with `position-try: flip-block`.

```html
<button popovertarget="tooltip" id="anchor" aria-describedby="tooltip">anchor</button>
<div id="tooltip" popover role="tooltip">
  <div class="tooltip-content-inner"></div>
</div>
```

```css
.tooltip-content-inner {
  max-block-size: calc(50dvb - var(--trigger-height));
  overflow-block: auto;
} 
```

## Best practices

- **Prefer logical fallbacks**: Use keywords like `flip-block` and `flip-inline` in `position-try-fallbacks` for simpler queries that handle RTL and different writing modes automatically.
- **Use pseudo-elements for arrows**: Tooltip arrows are purely decorative and are perfect candidates for `::before` or `::after`, which can be styled via anchored container queries without extra DOM.

## Accessibility considerations

Using these tooltips may result in controls being obscured when they receive focus, which would result in a fail against WCAG 2.4.11 Focus Not Obscured (Minimum) (Level AA), as focused items cannot be completely obscured. While there may not be generic guidance to completely mitigate against this issue, consider strategies that adjust the position of the tooltip or its presence.

Keyboard navigation does not close a `popover=auto` tooltip, so ensure that tooltips do not obscure interactive elements as they receive focus via keyboard. If the tooltip is likely to obscure an interactive element when it receives focus, either change the position of the tooltip to prevent focus being obscured, or dismiss the tooltip if it is no longer relevant to the user.

## Fallback strategies

Browser support for Anchor position container queries: Limited availability.
Supported by: Chrome 143 (Dec 2025) and Edge 143 (Dec 2025).
Unsupported in: Firefox and Safari.

Positioning the arrow based on the applied fallback is a progressive enhancement, and there is not another way of reacting to the fallback position. To hide the arrow in browsers that don't support anchor position container queries, test for CSS support with `@supports (container-type: anchored)`.

```css
@supports (container-type: anchored) {
  .tooltip-content::before {
    content: "▼" / "";
  }
}
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

Browsers without support for the Popover API also do not support anchor positioning, so the tooltip will appear in the center of the screen.