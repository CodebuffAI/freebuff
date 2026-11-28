# Using and managing icons

## Choosing an Icon Technique

Icon storage and rendering are separate choices. For example, an SVG sprite can supply an icon to the CSS icon system or be referenced with `<use>`.

* **CSS icon system:** Use when CSS should choose when and which icon to show. Use a mask for a single-color icon or a background image for a full-color icon.
* **SVG with `<use>`:** Use to reuse a symbol when its built-in styling options are enough. CSS can't arbitrarily style or animate the referenced SVG's contents, but inherited properties and custom properties can be passed in when the symbol is designed to use them. For example, a path can use `fill="var(--icon-accent, currentColor)"` to let CSS color that part of the icon.
* **Inline SVG:** Use when you need arbitrary styling or animation of the SVG's contents.
* **`<img>` with CSS filters:** Avoid this for recoloring icons. Filters can't reliably apply an arbitrary CSS color value to the image, so recoloring is cumbersome and inflexible.

To decide, ask two questions. Does CSS need to pick or swap the icon (component defaults, state changes, theming)? If yes, use the CSS icon system. Do you need to reach inside the icon beyond color? If yes and you control the icon source, design the symbol with custom properties and use `<use>`; if you do not control the source, inline the SVG. Third-party icon sets rarely expose custom properties, so `<use>` against them gives you color and little else.

Whichever method you choose, make sure that all icons have a contrast of at least 3:1 against their backgrounds in light and dark color schemes. Refer to the Contrast section of `color` (via `npx -y modern-web-guidance@latest retrieve "color"`) for more details.

### Embedded or remote icons

Both the CSS icon system and `<use>` can take icons from a data URI, an individual file, or a sprite. Embedding (data URIs or inline SVG) avoids a request and renders with the first paint, but bloats CSS or HTML and cannot be cached separately, so it suits a small set of icons that appear on every page. Individual files are cached independently and loaded on demand, at the cost of one request each. A sprite is one cacheable request for the whole set, but downloads every icon whether used or not, and `<use>` can only reference a sprite from the same origin. Prefer embedding for a handful of core icons and a sprite or individual files for larger sets.

If a page renders thousands of icons at once, benchmark the actual page and assets. In a stress test, inline SVG had a small performance advantage at that scale, but results depend on the browser and implementation. [Cloud Four's SVG icon stress test](https://cloudfour.com/thinks/svg-icon-stress-test/)

## Primary Approach: CSS-Driven Icon Engine

Icons are design tokens: each icon is a custom property holding an image, and any element can display one by setting `--icon-start` or `--icon-end`. The engine combines three CSS capabilities:

* **Registered custom properties (`@property`)** keep `--icon-start` and `--icon-end` from inheriting, so an icon set on a component does not cascade into its children.
* **Container style queries (`@container style(...)`)** detect when an element has an icon assigned and render it, with no class or markup changes.
* **CSS masks and `currentColor`** render the icon in a pseudo-element that follows the element's text color. Size, color, spacing and vertical offset are read from inheritable `--icon-style-*` properties with sensible fallbacks, so a whole subtree can be restyled from an ancestor. The `--icon-style-` prefix keeps these settings from colliding with the icon tokens themselves, which also live under `--icon-*`.

### Defining icon design tokens

Define SVG icons and any `--icon-style-*` overrides as reusable custom properties using inline SVG data URIs or root-relative URLs (e.g., `url("/icons/trash.svg")`). When an icon is loaded from an external SVG file, use a root-relative URL or an embedded data URI. A relative URL used through a custom property can resolve relative to the stylesheet where the icon is used, rather than the stylesheet where the custom property is defined. If those stylesheets are in different directories, the URL may resolve to the wrong file.

To keep a URL relative to the stylesheet that defines the icon token, a registered property is meant to help: the computed value of a registered `<url>` or `<image>` is resolved against the stylesheet that declared it. DO NOT rely on registering the token as `<image>` with the URL in `initial-value`. Chrome and Safari resolve `initial-value` URLs against the document, so it only works in Firefox. Chrome also resolves values declared on `:root` against the document unless the syntax starts with `<url>`.

When relative URLs are unavoidable, such as stylesheets in different directories, register the token with a syntax that starts with `<url>` and declare the actual URL on `:root`. This resolves against the declaring stylesheet in every browser:

```css
@property --icon-caret {
  /* The syntax must start with <url>. A syntax that starts with <image> resolves against the document in Chrome. */
  syntax: "<url> | <image> | none";
  inherits: true;
  initial-value: none;
}

:root {
  /* Declared here, the URL resolves against this stylesheet */
  --icon-caret: url("icons/caret.svg");
}
```

Each icon now lives in two places, and there is much more boilerplate, so this is only worth it when a project has stylesheets in different directories and a manageable number of icons. Past a dozen or so icons, register the `--icon-*` tokens (excluding `--icon-style-*`) from a script with `CSS.registerProperty`, using the same syntax, instead of writing each `@property` by hand. Registered properties are global and do not work in shadow roots, so this may not fit every project. If root-relative URLs or data URIs are an option, they are simpler and work everywhere.

```css
:root {
  /* Optional: override the built-in fallbacks (1em, currentColor, 0.3em, -0.02em) */
  --icon-style-size: 1em;
  --icon-style-spacing: 0.4em;
  --icon-trash: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2'%3E%3Cpath d='M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0-1 14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2L4 6h16Z'/%3E%3C/svg%3E");
  --icon-favorite: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='currentColor'%3E%3Cpath d='M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z'/%3E%3C/svg%3E");
}
```

### Rendering icons from tokens

An element displays an icon by setting `--icon-start` (leading) or `--icon-end` (trailing) to one of the tokens above. Two pieces of CSS turn that assignment into a rendered icon.

First, register `--icon-start` and `--icon-end` with `@property`. The `"*"` syntax accepts any value, and `inherits: false` is the important part: without it, an icon set on a button would inherit into every descendant, and each of them would render the icon too.

```css
@property --icon-start {
  syntax: "*";
  inherits: false;
}

@property --icon-end {
  syntax: "*";
  inherits: false;
}
```

Second, a container style query detects when the property is set on an element and renders the icon in a pseudo-element. Because the pseudo-element does not inherit `--icon-start` (it was registered as non-inheriting), the first declaration forwards the value explicitly with `inherit`. The remaining declarations handle sizing, masking, alignment and spacing. Because the fill defaults to `currentColor`, the icon adopts the element's text color and follows its transitions.

```css
/* Style query for elements configuring a start icon */
@container style(--icon-start) {
  ::before {
    --icon-start: inherit; /* Forward the value inside the query block */
    content: "" / var(--icon-style-alt, "");
    display: inline-block;
    width: var(--icon-style-size, 1em);
    height: var(--icon-style-size, 1em);
    background-color: var(--icon-style-color, currentColor);
    mask: var(--icon-start) no-repeat center / contain;
    /* Center on the cap height, nudged slightly up for optical balance */
    vertical-align: calc(0.5cap - var(--icon-style-size, 1em) / 2 + var(--icon-style-voffset, -0.02em));
    flex: none;
    pointer-events: none;
    forced-color-adjust: none;
  }

  /* Automatically add spacing ONLY if the element has other text or sibling content */
  :where(:not(.icon, :empty))::before {
    margin-inline-end: var(--icon-style-spacing, 0.3em);
  }
}
```

Each declaration earns its place:

* **`vertical-align`**: `middle` aligns to half the x-height, which sits visibly low for most icon sets. Centering on `0.5cap` keeps the icon's center fixed as `--icon-style-size` grows, and the small negative `--icon-style-voffset` compensates for the eye weighting the space above an icon more than the space below.
* **`flex: none`**: An empty pseudo-element has a zero minimum size, so inside a flex button it is the first thing to shrink when the label is long, potentially to nothing. Icon size is a design decision, not something layout pressure should negotiate.
* **`pointer-events: none`**: Keeps the icon from trapping clicks or becoming the `event.target`.
* **`forced-color-adjust: none`**: In forced-colors mode the browser otherwise replaces `background-color`, making a masked icon disappear. The mask fill is preserved, and `currentColor` still follows the forced text color.
* **`content: "" / var(--icon-style-alt, "")`**: Alternative text for generated content lets an icon-only control take its accessible name from the icon via `--icon-style-alt` (see Icon-Only Controls below). The default empty alt keeps decorative icons hidden from assistive technology.

For a trailing icon, follow the same pattern with `--icon-end` and `::after` instead of `--icon-start` and `::before`. Use `mask: var(--icon-end)` and apply spacing with `margin-inline-start` instead of `margin-inline-end`.

### Standalone and icon-only elements

For standalone icons or icon-only buttons, apply `.icon` directly to the empty element (the button itself for an icon-only control) and set its icon with `--icon`. Here, `--icon` is the higher-level property; the `.icon:empty` rule maps it to `--icon-start` for a leading icon:

```css
.icon:empty {
  --icon-start: var(--icon);
}
```

## Usage Examples

### Component defaults in the stylesheet

The main benefit of icons as custom properties is that they participate in the cascade. Set an icon on a selector and every matching element gets it, with no markup changes:

```css
.button-delete {
  --icon-start: var(--icon-trash);
}

a[href^="http"]:not([href*="example.com"]) {
  --icon-end: var(--icon-external);
}
```

```html
<button class="button-delete">Delete item</button>
```

### Changing icons with state

Because the icon is just a property, a state change is an ordinary CSS override. There is no second element to show or hide and no class to toggle:

```css
.button-expand {
  --icon-start: var(--icon-caret-right);
}

.button-expand[aria-expanded="true"] {
  --icon-start: var(--icon-caret-down);
}
```

The same applies to presentation: set `--icon-style-size`, `--icon-style-color` or `--icon-style-spacing` on a container such as a toolbar and every icon inside it updates.

### One-off icons with inline styles

An element that no component rule covers can set the same property inline, for example `<button style="--icon-start: var(--icon-trash)">`. Treat this as the escape hatch rather than the default: once the same icon appears on the same kind of element more than once, move it into a stylesheet rule.

### Icon-Only Controls

Icon-only buttons use the `.icon` class and `--icon` described above. Give the button an accessible name with `aria-label`, or let the icon supply one through `--icon-style-alt`; without either, the CSS-generated icon is decorative. For standalone informative icons, expose the `.icon` element with `role="img"` and `aria-label`:

```css
.button-close {
  --icon: var(--icon-close);
  --icon-style-alt: "Close";
}
```

```html
<!-- Icon-only interactive control, icon and name from the stylesheet -->
<button class="icon button-close"></button>

<!-- Icon-only interactive control, named via aria-label -->
<button class="icon" style="--icon: var(--icon-trash);" aria-label="Delete item"></button>

<!-- Standalone informative icon -->
<span class="icon" style="--icon: var(--icon-favorite);" role="img" aria-label="Favorite"></span>
```

## Working with SVG directly

When the CSS icon system is not the right fit, use inline SVG and `<use>` together rather than as alternatives. Inline the SVG the first time an icon appears on a page and reference it with `<use href="#id">` for every repeat; the local reference costs no request and has no cross-origin restriction. Reserve an external sprite (`<use href="/icons.svg#id">`) for icons shared across many pages.

With `<use>`, the referenced content is cloned into a shadow tree, so page CSS cannot select its elements. What does reach it is inheritance: `color`, `currentColor`, and any custom property. Beyond SVG presentation attributes, modern CSS can change many geometry attributes as well, so an icon you control can expose exactly the hooks you need, for example `stroke-width="var(--icon-stroke, 2)"` or even `d: var(--icon-path, path(…))` on a particular path.

Browser support for the css.properties.d capability: Limited availability.
Supported by: Chrome 52 (Jul 2016), Edge 79 (Jan 2020), and Firefox 97 (Feb 2022).
Unsupported in: Safari.

CSS `d` is not supported in Safari, so use this customization only when that support gap is acceptable. If you do not control the icon, inline it.

`<use>` gotchas worth knowing:

* The `viewBox` must be on the `<symbol>` or referenced `<svg>`; the outer `<svg>` wrapping `<use>` does not pick it up from the reference, so set `width` and `height` on the wrapper and keep the `viewBox` with the symbol.
* Styles do not cross the boundary in either direction: `<style>` inside an external sprite does not apply to the page, and page stylesheets do not apply inside the referenced tree. Only inherited properties and custom properties pass through.
* External references are same-origin only; cross-origin sprites fail silently.
* Sprites inlined into the document share the page's `id` namespace, so namespace symbol ids to avoid collisions.

Mark decorative SVGs with `aria-hidden="true"` and give the containing control its own accessible name, as with the CSS icon system.

## Fallback Strategies

### Registered Custom Properties

Baseline status for Registered custom properties: Newly available. It's been Baseline since 2024-07-09.
Supported by: Chrome 85 (Aug 2020), Edge 85 (Aug 2020), Firefox 128 (Jul 2024), and Safari 16.4 (Mar 2023).

Without `@property`, `--icon-start` and `--icon-end` behave as ordinary inheriting custom properties, so an icon set on an element would also render on its descendants. Prevent this by resetting the properties on children inside the style query (`@container style(--icon-start) { * { --icon-start: initial; } }`), the same approach the Safari workaround below uses.

### Container Style Queries

Baseline status for Container style queries: Newly available. It's been Baseline since 2026-05-19.
Supported by: Chrome 111 (Mar 2023), Edge 111 (Mar 2023), Firefox 151 (May 2026), and Safari 18 (Sep 2024).

To support browsers without Container Style Queries, use classes or component selectors as fallback hooks. Keep icon selection in custom properties; inline-style selectors alone miss icons assigned through CSS rules.

```css
:where(.icon-start, .icon:empty)::before {
  content: image-set(linear-gradient(transparent 0 100%), var(--icon-start)) / var(--icon-style-alt, "");
  /* icon styles */
}

:where(.icon-start)::before {
  --icon-start: inherit;
}

:where(.icon:empty)::before {
  --icon-start: var(--icon);
}

:where(.icon-start:not(.icon, :empty))::before {
  margin-inline-end: var(--icon-style-spacing, 0.3em);
}
```

For trailing icons, use the same class-hook fallback with `.icon-end`, `--icon-end`, and `::after` instead of `.icon-start`, `--icon-start`, and `::before`. Apply spacing to non-empty content with `margin-inline-start` instead of `margin-inline-end`.

This `image-set()` pattern makes `content` invalid when the custom property is unset, so it falls back to `none` and the pseudo-element disappears without adding or removing a class. It does not remove the pseudo-element's other styles or prevent conflicts with other `::before` or `::after` rules, so use these hooks only where those pseudo-elements are available for icons.

### Safari Browser Workarounds

Safari has two rendering bugs affecting icons: WebKit [#301609](https://bugs.webkit.org/show_bug.cgi?id=301609) can prevent them from appearing until user interaction, and [#320220](https://bugs.webkit.org/show_bug.cgi?id=320220) also affects their rendering. The workaround below addresses both:

```css
@keyframes webkit-301609 {}

@supports ((-webkit-nbsp-mode: normal) or (-webkit-touch-callout: none) or (font: -apple-system-body)) and (content-visibility: auto) {
  @layer webkit-301609-fix {
    ::before, ::after {
      animation: webkit-301609 0s;
    }
  }
}
```

The `@supports` query targets Safari only, and `@layer` reduces animation conflicts.

WebKit bug #325900 can prevent a direct override of `--icon-start` from taking effect in some cases, such as changing the icon on hover. This affects the workaround for non-inheriting registered properties. For Safari, register `--icon-start` as inheriting and reset it on descendants inside the style query:

```css
@supports ((-webkit-nbsp-mode: normal) or
           (-webkit-touch-callout: none) or
           (font: -apple-system-body)) and (content-visibility: auto) {
  /* Override previous declaration */
  @property --icon-start {
    syntax: "*";
    inherits: true;
  }

  @layer webkit-325900-fix {
    @container style(--icon-start) {
      * {
        --icon-start: initial;
      }
    }
  }
}
```

The reset prevents the icon value from propagating to descendants. Keeping it in a layer lets unlayered icon declarations take precedence over the reset.
