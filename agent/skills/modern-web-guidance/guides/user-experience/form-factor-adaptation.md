# Adapt to the form factor

The same interface runs on phones, laptops, and foldables, with touch, mouse, or keyboard. Size controls for the input, let components adapt to their container, and keep text and controls clear of system UI.

For page-level responsive techniques (dynamic viewport units, aspect ratios, and fluid type), see `responsive-design` (via `npx -y modern-web-guidance@latest retrieve "responsive-design"`).

## Implementation

### Size targets for the input method

Make every control at least 24×24 CSS pixels (WCAG 2.5.8), and at least 44×44 on touch screens, where a fingertip is less precise than a mouse pointer (WCAG 2.5.5). Links inside sentences are exempt. For checkboxes and radios, wrap the input in its `<label>` and size the label. To keep small icons visually compact, extend their hit area with a pseudo-element. Leave enough space around controls so extended hit areas do not overlap each other or reach past the edge of the screen.

```css
:root { --target-size: 24px; }
@media (pointer: coarse) {
  :root { --target-size: 44px; }
}
:where(button, select, textarea, input:not([type="checkbox"], [type="radio"]), [role="button"], nav a, label:has(input[type="checkbox"], input[type="radio"])) {
  min-block-size: var(--target-size);
  min-inline-size: var(--target-size);
}
:where([role="button"], nav a, label:has(input[type="checkbox"], input[type="radio"])) { display: inline-flex; align-items: center; }
.icon-button { position: relative; }
.icon-button::after {
  content: "";
  position: absolute;
  inset: -10px;
}
```

### Let components respond to their container

Use container queries instead of viewport-width media queries for component layout, so a component adapts wherever it is placed. Keep media queries for what a container can't know: the input device (such as `pointer: coarse` for touch screens) and user settings (such as `prefers-color-scheme`).

```css
.product-list {
  /* Name containers so queries inside nested containers target the right ancestor. */
  container: products / inline-size;
}
/* A container query styles the container's descendants, never the container itself. */
@container products (inline-size > 40rem) {
  .product-card { display: grid; grid-template-columns: 10rem 1fr; }
}
```

DO NOT query `height` or `block-size` on an `inline-size` container: it measures only width. Use `container-type: size` only on a container with a definite height.

- For more container query patterns, such as card layouts, see `size-aware-styling` (via `npx -y modern-web-guidance@latest retrieve "size-aware-styling"`).
- To change a component's layout based on what child elements it contains (for example, switching a card to a side-by-side layout when it includes an image), see `content-based-styling` (via `npx -y modern-web-guidance@latest retrieve "content-based-styling"`).

### Keep UI clear of notches and system bars

When drawing edge to edge with `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">`, pad fixed and edge-anchored UI by the safe-area insets.

```css
.bottom-bar {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  padding-bottom: max(0.75rem, env(safe-area-inset-bottom, 0px));
  padding-left: max(0.75rem, env(safe-area-inset-left, 0px));
  padding-right: max(0.75rem, env(safe-area-inset-right, 0px));
}
```

Pad UI anchored to the top edge the same way with `safe-area-inset-top`.

Fixed bars cover the content that scrolls under them, so a focused element can end up hidden behind one. Set `scroll-padding-bottom` (or `scroll-padding-top` for a top bar) on the scroll container to at least the bar's height, including its safe-area padding, so the browser scrolls focused elements clear of the bar (WCAG 2.4.11 Focus Not Obscured (Minimum) requires a focused element to be at least partly visible).

```css
html {
  scroll-padding-bottom: calc(3.5rem + env(safe-area-inset-bottom, 0px));
}
```

### Balance headings and prettify body text

Apply `text-wrap: balance` to short headings (`h1, h2, h3`) and `text-wrap: pretty` to body text (`p, li`) to prevent typographic orphans. For full text-wrapping rules, see `improve-text-layout-and-legibility` (via `npx -y modern-web-guidance@latest retrieve "improve-text-layout-and-legibility"`). DO NOT apply either property to `*`: both incur layout overhead, and `balance` only helps short blocks of text.

### Label icon-only buttons

Give every icon-only button an accessible name using `aria-label`, an `<img alt>`, or visually hidden text, and hide decorative icons with `aria-hidden="true"`. For more accessible naming patterns, see `accessibility` (via `npx -y modern-web-guidance@latest retrieve "accessibility"`).

### Keep content inside its box

Ensure text and controls are never clipped, squished to zero dimensions, or overflowing at any viewport width down to 320 CSS pixels (WCAG 1.4.10). Content that needs a two-dimensional layout to be understood, such as data tables, maps, and diagrams, may scroll horizontally inside its own container while the page doesn't. Make that container keyboard-scrollable with `tabindex="0"`, and give it `role="region"` and an accessible name. For making data tables adapt to smaller viewports, see `responsive-table` (via `npx -y modern-web-guidance@latest retrieve "responsive-table"`).

```css
/* Media never overflows its column. */
img, video { max-inline-size: 100%; block-size: auto; }
/* Long words and URLs wrap instead of widening the page. */
body { overflow-wrap: break-word; }
/* Long URLs and code also wrap inside flex items and table cells. */
:where(a, code) { overflow-wrap: anywhere; }
/* Flex and grid items don't shrink below their content by default. Let non-control items shrink so controls keep their minimum size. */
:where(.toolbar > :not(button, input, select, textarea, a, [role="button"], label)) { min-inline-size: 0; }
.toolbar { display: flex; }
/* The target-size minimum lets controls in a crowded row shrink below their text, so let nav bars and toolbars that are already rows wrap. */
:where(nav, nav ul, .toolbar) { flex-wrap: wrap; }
```

- Use `min-block-size` instead of a fixed `height` on anything that contains text.
- Use `overflow-wrap: break-word` for text, and `anywhere` only on elements that hold long unbroken strings, such as links and code: `anywhere` also lets flex items and table cells shrink below their longest word, which breaks ordinary words mid-word.
- DO NOT truncate headings with `text-overflow: ellipsis`, and do not clip controls with `overflow: hidden` on their parents.
- DO NOT set `overflow-x: hidden` or `clip` on `html` or `body` to stop the page scrolling sideways: content past the edge is cut off and users can't scroll to it. Make the element that is too wide fit instead.
- To allow text and layouts to scale with operating system accessibility settings, see `respect-os-text-scale` (via `npx -y modern-web-guidance@latest retrieve "respect-os-text-scale"`). To size form controls dynamically as users type, see `form-fields-automatically-fit-contents` (via `npx -y modern-web-guidance@latest retrieve "form-fields-automatically-fit-contents"`).

## Fallback strategies

### Text wrapping

Baseline status for text-wrap: balance: Newly available. It's been Baseline since 2024-05-13.
Supported by: Chrome 114 (May 2023), Edge 114 (Jun 2023), Firefox 121 (Dec 2023), and Safari 17.5 (May 2024).

Browser support for text-wrap: pretty: Limited availability.
Supported by: Chrome 117 (Sep 2023), Edge 117 (Sep 2023), and Safari 26 (Sep 2025).
Unsupported in: Firefox.

Browsers without support ignore `text-wrap: balance` and `text-wrap: pretty` and wrap text normally. No fallback is needed.
