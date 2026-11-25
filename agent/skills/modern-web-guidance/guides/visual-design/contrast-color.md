# Ensure text readability with dynamic background colors

When building reusable UI components (like badges, buttons, headers, or footers) or supporting customizable themes, ensuring text remains readable against a variable background color can be challenging. The `contrast-color()` CSS function resolves to `black` (`rgb(0, 0, 0)`) or `white` (`rgb(255, 255, 255)`), maximizing the contrast ratio (targeting at least 4.5:1 WCAG AA contrast) against the specified solid `<color>` value.

## Determine optimal text color

When an element has a variable or dynamically injected background color, you can rely on the browser to compute the safest text color.

MANDATORY: Set the `color` property using the `contrast-color()` function, passing the background color (or its custom property) as the argument.

```css
.badge {
  /* Define the background color as a custom property */
  --badge-bg: #e02424;
  background-color: var(--badge-bg);
  /* MANDATORY: Dynamic contrasting color */
  color: contrast-color(var(--badge-bg));
}
```

DO NOT: Use `contrast-color()` for `background-color`. It is specifically designed for foreground colors (like text or borders) to contrast against a given background color.

## Integrate with theming

Because `contrast-color()` accepts any valid `<color>` value, including CSS custom properties, it is especially powerful within design systems. By centralizing your background themes as variables, you ensure that foreground content automatically updates its contrast whenever the theme shifts, even to user-specified colors.

DO: Reference shared background variables inside `contrast-color()` to guarantee synchronization across your application.

```css
.theme-card {
  background-color: var(--theme-surface-color);
  color: contrast-color(var(--theme-surface-color));
}

.theme-container[data-theme="light"] {
  --theme-surface-color: #f4f4f4;
}
.theme-container[data-theme="dark"] {
  --theme-surface-color: #1a1a1a;
}
.theme-container[data-theme="custom"] {
  --theme-surface-color: var(--user-custom-theme);
}
```

DO NOT: Hard-code a separate text color for each interaction state when the background is dynamic. Doing so reintroduces the very mismatch `contrast-color()` exists to prevent.

## Fallback strategies

Baseline status for contrast-color(): Newly available. It's been Baseline since 2026-04-10.
Supported by: Chrome 147 (Apr 2026), Edge 147 (Apr 2026), Firefox 146 (Dec 2025), and Safari 26 (Sep 2025).

To support browsers without `contrast-color()`, you must provide a fallback. If the background color is known and fixed, use a hard-coded contrasting color. For variable background colors (such as theme custom properties where the runtime color is unknown), choose one of the five fallback strategies from the table below based on your UI requirements and browser support targets.

| Strategy | Best For... | Considerations |
| :--- | :--- | :--- |
| **Calculate contrast with `color(xyz)`** | Automated, CSS-only contrast calculation, ensures compliance with WCAG 1.4.3 Contrast (Minimum). | Highest quality CSS-only fallback. |
| **Text Shadow** | Quick readability boost on any background. | Can look "dirty" or "glowy"; may not fit all designs. |
| **Text Stroke** | Preserving font weight while ensuring edge contrast. | Use `paint-order` to avoid thinning letterforms, if available. |
| **Translucent Overlay** | Ensuring a minimum contrast area behind the text. | Changes the look of the background color under the text, requires a separate text element. |
| **SVG Filters** | Reactive contrast that updates as the background changes. | Requires a separate text element; hacky implementation. |

### Recommended: Calculate contrast with `color(xyz)`

In order to adhere to WCAG's 1.4.3 Contrast (Minimum) guideline, calculate the contrasting color using Relative Color Syntax in the CIE XYZ D65 color space, which uses relative luminance as the `y` value. Note that `white` is `color(xyz 0.9505 1 1.089)`, as this is the D65 white point.

Baseline status for Relative colors: Newly available. It's been Baseline since 2024-09-16.
Supported by: Chrome 125 (May 2024), Edge 125 (May 2024), Firefox 128 (Jul 2024), and Safari 18 (Sep 2024).

```css
--wcag-y-threshold: 0.17913;
--y: max(0, sign(var(--wcag-y-threshold) - y));
color: color(from var(--color) xyz-d65 calc(var(--y) * 0.9505) var(--y) calc(var(--y) * 1.089));
```

### Alternative CSS Fallbacks

DO: Select the fallback that best matches your design constraints if RCS is not sufficient or supported.

#### Option 1: Text Stroke

Baseline status for Text stroke and fill  (compatibility prefixes): Widely available. It's been Baseline since 2017-04-05.
Supported by: Chrome 4 (Jan 2010), Edge 15 (Apr 2017), Firefox 49 (Sep 2016), Safari 3 (Oct 2007), and Safari iOS 2 (Jul 2008).

```css
.badge--stroke {
  -webkit-text-stroke: 4px black;
}
```
  
#### Option 2: Text Stroke with `paint-order` to preserve letterforms

Baseline status for paint-order: Widely available. It's been Baseline since 2024-03-22.
Supported by: Chrome 123 (Mar 2024), Edge 123 (Mar 2024), Firefox ≤66, and Safari ≤12.

```css
.badge--stroke {
  -webkit-text-stroke: 4px black;
  paint-order: stroke fill;
}
```

#### Option 3: Translucent background overlay

```css
.badge--overlay {
  position: relative;
  color: #fff;
  overflow: hidden;
}
.badge--overlay::before {
  content: "";
  position: absolute;
  inset: 0;
  background-color: rgb(0 0 0 / 0.4);
  z-index: 0;
}
.badge--overlay span {
  position: relative;
  z-index: 1;
}
```

#### Option 4: Text Shadow

```css
.badge--shadow {
  text-shadow: 0 1px 3px rgb(0 0 0 / 0.8);
}
```

#### Option 5: SVG Filters

Baseline status for SVG filters: Widely available. It's been Baseline since 2015-07-29.
Supported by: Chrome 5 (May 2010), Edge 12 (Jul 2015), Firefox 3 (Jun 2008), and Safari 6 (Jul 2012).

1. Load this SVG filter definition. It must be added directly to the HTML document if you need to support Safari versions affected by [this WebKit bug](https://bugs.webkit.org/show_bug.cgi?id=320118), which prevents external and data url references for filters. Otherwise, it should be loaded from an external file, either an SVG file or inlined in CSS.

```html
<!-- Technique from https://miunau.com/posts/dynamic-text-contrast-in-css/ -->
<svg xmlns="http://www.w3.org/2000/svg" version="1.1" height="0" style="display: none;">
  <defs>
    <filter id="contrast-filter" color-interpolation-filters="sRGB">
      <feColorMatrix type="matrix"
        values="0.2126 0.7152 0.0722 0 0
          0.2126 0.7152 0.0722 0 0
          0.2126 0.7152 0.0722 0 0
          0 0 0 1 0"/>
      <feMorphology operator="dilate" radius="2"/>
      <feComponentTransfer>
        <feFuncR type="linear" slope="-255" intercept="128"/>
        <feFuncG type="linear" slope="-255" intercept="128"/>
        <feFuncB type="linear" slope="-255" intercept="128"/>
      </feComponentTransfer>
      <feComposite operator="in" in2="SourceGraphic"/>
    </filter>
  </defs>
</svg>
```

2. Wrap the text in a `<span>`.

```html
<div class="badge--svg">
  <span>Badge content</span>
</div>
```

3. Apply the filter to the `<span>`.

```css
.badge--svg span{
  color: var(--badge-bg);
  filter: url(#contrast-filter);
}
```
