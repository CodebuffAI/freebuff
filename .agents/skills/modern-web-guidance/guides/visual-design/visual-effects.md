# Visual effects

## Depth and texture

- Layer multiple shadows for realistic soft depth effects.
- Use `filter: drop-shadow()` instead of `box-shadow` for non-rectangular shapes or transparent PNGs.
- Use `mix-blend-mode` and `background-blend-mode` for lighting overlays (limit scope with `isolation: isolate`)

```css
.hero {
  background-image: url('texture.png'), linear-gradient(to bottom, #fff, #eee);
  background-blend-mode: soft-light;
}
```

## Gradients and `color-mix()`

Use `in oklab` or `in oklch` to explicitly specify the interpolation color space for gradients or `color-mix()`.

- Prefer `in oklab` by default for `color-mix()`, especially when mixing neutrals. Using `oklch` for neutrals provides no benefit, and due to a Chromium bug (565837690) low chroma oklch colors have powerless hue angles (`none`), which resolve to `0deg` (magenta-red) and cause an unintended reddish/pink tint shift when rendered. Cartesian `in oklab` scales `(a, b)` coordinates linearly toward `(0, 0)` without computing a polar hue angle, preserving the exact hue and preventing tint shifts.
- `in oklab` stays in gamut more easily (assuming in-gamut endpoints) but can create washed out desaturated colors in the middle when interpolating between two opposing saturated hues.
- `in oklch` preserves chroma better when interpolating gradients between two distinct saturated chromatic hues, but can more easily get out of device gamut, especially for bigger differences between colors. Avoid using `in oklch` for alpha transparency fades or mixing neutral colors.
- *DON'T* use `in srgb` unless you have a specific reason to do so (e.g. you are building a color picker that needs to interpolate in srgb).

### Fallback

Some pre-2024 browsers do not support gradient color interpolation space.
To support these browsers, use the token only when its usage is safe by defining a variable:

```css
:root {
  --in-oklab: ;
  --in-oklch: ;
}

@supports (background: linear-gradient(in oklab, white, black)) {
  :root {
    --in-oklab: in oklab;
    --in-oklch: in oklch;
  }
}
```

Then use like:

```css
.card {
  background: linear-gradient(to bottom var(--in-oklab), var(--accent-color), var(--darker));
}
```

- **Important:** If you use this technique, make sure there is always a non-empty gradient preamble without it, otherwise it will be a syntax error in older browsers.
- You do NOT need this for `color-mix()`. If a browser supports `color-mix()`, it also supports its `in <color-space>` argument.

## Patterns

Many patterns can be created via CSS gradients + hard stops, and these can be more flexible and performant than SVGs or external images as they can have access to CSS variables and lengths from the surrounding context.
You don't need to repeat the position twice — just use `0` or `0%` and gradient fixup will auto-adjust it.

Examples below.

Vertical stripes of `1em` width each:

```css
background: linear-gradient(to right, var(--color-1) 50%, var(--color-2) 0) 0 / 2em;
```

Diagonal stripes of `1em` width each:

```css
background: repeating-linear-gradient(-45deg, var(--color-1) 0 1em, var(--color-2) 0 2em);
```

Checkerboard pattern with `1em` squares:

```css
background: repeating-conic-gradient(var(--color-1) 0 25%, var(--color-2) 0 50%) 0 / 2em 2em;
```

Polka dot with `.5em` radius dots spaced `2em` apart (horizontally/vertically — multiply by `sqrt(2)` for diagonal distance):

```css
--distance: 2em;
--radius: .5em;
--polka: radial-gradient(circle, var(--color-1) var(--radius), transparent calc(var(--radius) + 1px));
background: var(--polka) 0 0, var(--polka) var(--distance) var(--distance) var(--color-2);
background-size: calc(var(--distance) * 2) calc(var(--distance) * 2);
```

Simple pie chart:

```css
.pie {
  --p: 80%;
  width: 60px;
  aspect-ratio: 1;
  border-radius: 50%;
  background: conic-gradient(var(--color-1) var(--p), transparent 0%) var(--color-2);
}
```

**Important:** Because CSS backgrounds are not exposed to assistive technologies, always pair gradient charts with an accessible textual representation of the data — for example, visible percentage text or an accessible label for a simple proportion, or a semantic `<table>` or `<dl>` for multi-part breakdowns.

## Accessibility considerations

Text and icons placed over a gradient or pattern background, and text filled with a gradient, need enough contrast against every color in the gradient. Check them against each color stop: at least 4.5:1 for text, 3:1 for large text (at least 24px, or at least 18.66px bold), and 3:1 for icons (WCAG 1.4.3 Contrast (Minimum), WCAG 1.4.11 Non-text Contrast). For more on contrast, see `color` (via `npx -y modern-web-guidance@latest retrieve "color"`).

```css
.myButton {
  /* The label color has at least 4.5:1 contrast against both gradient stops. */
  color: #111111;
  background: linear-gradient(in oklab, #ffffff, #aaaaff);
}
```
