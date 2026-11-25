# Respect Operating System Text Scale

## Overview

Users with visual impairments often configure text scaling at the operating system level (such as Dynamic Type on iOS or Font Size scaling on Android/ChromeOS). By default, mobile browsers ignore these OS-level accessibility settings to prevent legacy, fixed-pixel websites from breaking visually.

Instead of keeping your page static or relying on custom, fragile JavaScript layout calculations, opt into native operating system text scaling using the `<meta name="text-scale">` tag. When active, the browser dynamically scales the root font size (`1rem`) to match the user's OS preference, allowing all relative (`rem`/`em`) font sizes, layouts, and spacing to scale automatically and gracefully.

## Implementation

### 1. Opt Into OS Text Scaling

Place the `<meta name="text-scale">` element inside your document's `<head>`. This signals to supporting browsers that your layout is modern, adaptive, and safe to scale:

```html
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width" />
  
  <!-- Opt this page into OS-level dynamic type and accessibility text scaling -->
  <meta name="text-scale" content="scale" />
  
  <title>Adaptive Accessibility Layout</title>
</head>
```

### 2. Use Relative Typography & Spacing

Define font sizes using relative units (`rem` or `em`) rather than fixed pixels (`px`). Use unitless values for line heights so they scale proportionally with each element's computed font size.

Use relative units for margins and padding where the spacing is coupled to text size or must adapt as text is scaled. Spacing that is independent of text may use fixed units when appropriate, provided that scaling does not cause text clipping, overlap, loss of content, or an unusable layout:

```css
body {
  font-family: system-ui, sans-serif;
  /* Inherits the root font-size, which scales automatically with the OS setting */
  line-height: 1.5;      /* Unitless so it scales proportionally with computed font-size */
  padding: 1.5rem;       /* Scales proportionally to prevent dense crowding at larger scales */
}

h1 {
  font-size: 2.25rem;    /* Scales proportionally to the root base */
  margin-bottom: 1rem;
}
```

Set the base text size on `body` only when the design needs a size different from the inherited browser default; otherwise, let it inherit. Set sizes on specific elements, such as headings, with relative units such as `rem` or `em`. Use `rem` for a size relative to the root font size, and `em` when the size should depend on the parent element's font size. Do not set a custom font size on `:root` or `html`.

#### Fluid Typography

Fluid typography MAY use viewport-relative units such as `vw`, provided that font sizes also include a font-relative component such as `rem` or `em`. For more fluid-scaling techniques, including container query units and `clamp()`, see `fluid-scaling` (via `npx -y modern-web-guidance@latest retrieve "fluid-scaling"`).

Avoid sizing text exclusively with viewport units:

```css
/* ❌ DO NOT DO THIS: The font size does not respond fully to user text scaling */
.heading {
  font-size: 5vw;
}
```

Instead, combine a font-relative value with viewport-relative scaling and use relative minimum and maximum bounds:

```css
.heading {
  font-size: clamp(2rem, 1.25rem + 2vw, 4rem);
}
```

Test that text can be resized to at least 200% of its default size without loss of content or functionality. For fluid typography, a useful rule of thumb is to keep the maximum font size no more than 2.5 times the minimum. Also test reflow at a 320 CSS-pixel viewport width (equivalent to 400% zoom from a 1280 CSS-pixel-wide viewport); content MUST remain available without two-dimensional scrolling, except where essential.

### 3. Use Scalable Responsive Breakpoints

Responsive breakpoints MUST NOT assume that text will remain at its default size. Where a breakpoint is intended to respond to available space for text, prefer content-driven layouts, container queries, or `em`-based media queries rather than fixed pixel thresholds.

Test responsive layouts with operating system text scaling and browser zoom enabled. Text MUST remain readable and content MUST remain visible without overlap, clipping, or horizontal scrolling.

### 4. Ensure Content Wrapping & Flexible Heights

When text scales up, elements require more vertical and horizontal space to prevent truncation or overlap. To keep your components robust, design your layouts to expand dynamically around the content rather than forcing rigid coordinates:

* **Allow Text Containers to Grow**: Text-containing components and containers MUST be able to grow to accommodate scaled text. Avoid fixed `height` or `block-size` values and restrictive `max-height` or `max-block-size` values that can cause clipping or overflow. Prefer content-driven sizing; use `min-height` or `min-block-size` only when a minimum size is needed.
* **Allow Natural Wrapping**: Do not restrict inline-axis text wrapping with `white-space: nowrap` on blocks that contain sentences. Let text reflow to new lines naturally.
* **Employ Flexible Flexbox & Grid wrapping (Optional Example)**: For multi-column card galleries, use reflowing columns like `repeat(auto-fit, minmax(min(100%, 16rem), 1fr))` so items stack vertically if their relative width thresholds are crossed:

```css
/* Card container using min-height to ensure expansion and auto-fit to reflow if needed */
.card {
  padding: 1.5rem;
  border: 1px solid #ccc;
  border-radius: 8px;
  /* Use min-height so the box expands vertically when the font is enlarged */
  min-height: 10rem;
}
```

### 5. DO NOT Override the Root Font Size

When opting in via the `<meta name="text-scale" content="scale">` element, **DO NOT** explicitly set the root `font-size` in your stylesheet. This includes declarations on either `:root` or `html`, and applies to absolute units, relative units, and calculated values.

For example, do not override the root font size with a fixed value:

```css
/* ❌ DO NOT DO THIS: This can prevent the browser from applying text scaling */
html {
  font-size: 16px;
}
```

Do not combine the `<meta name="text-scale" content="scale">` opt-in with `env(preferred-text-scale)` to apply operating system text scaling manually. The browser applies the scale through the meta opt-in, so using both can result in double-scaling:

```css
/* ❌ DO NOT DO THIS: The meta opt-in already applies the operating system text scale */
:root {
  font-size: calc(1rem * env(preferred-text-scale));
}
```

Leave the root font size to the browser. The browser handles the operating system text scale automatically and applies it to content sized relative to the root font size.

## Fallback Strategies

Browser support for <meta name="text-scale">: Limited availability.
Supported by: Chrome 146 (Mar 2026) and Edge 146 (Mar 2026).
Unsupported in: Firefox and Safari.

On browsers where `<meta name="text-scale" content="scale">` is unsupported, the layout degrades gracefully. The page will display the layout at the browser's standard default base font size (typically 16px), and the user can still utilize standard manual page zoom or pinch-to-zoom options.
