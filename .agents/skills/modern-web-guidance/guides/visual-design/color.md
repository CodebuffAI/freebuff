# Color

## Accessible color

**Don't use color alone to indicate the presence of a user interface component or its state**: Use iconography and/or shape to help differentiate. Do not denote success/errors ONLY with color. Use icons or text (WCAG 1.4.1 Use of Color).

```html
<!-- Good: Denotes state without colors alone -->
<div class="error-msg">
  <span aria-hidden="true">❌</span>
  <span>The password entered was invalid.</span>
</div>
```

### Contrast

- **Minimum contrast standards**: Maintain 4.5:1 for normal text and 3:1 for large text (at least 24px, or at least 18.66px bold) or icons (WCAG 1.4.3 Contrast (Minimum) for text, WCAG 1.4.11 Non-text Contrast for icons).
- **Ensure non-text contrast standards**: Maintain a minimum contrast ratio of 3:1 for user interface component boundaries and states (WCAG 1.4.11 Non-text Contrast).
  - This includes visual elements (borders, backgrounds, box-shadows, underlines) that form the boundary or indicate the presence of a UI component (e.g., input field borders).
  - This also includes visual elements indicating active states within a component (e.g., checkbox checkmarks, switch thumbs or custom focus indicators).
  - **Caveat**: Meeting 3:1 non-text contrast can challenge minimalistic designs. Soft gradients or subtle inset/outset shadows can soften visual boundaries while satisfying accessibility requirements.
- **Use `prefers-contrast` only when warranted**: Reach for `@media (prefers-contrast: more)` when the design uses low-contrast accents (e.g., subtle borders, muted secondary text) that need to be reinforced; most sites that already meet baseline contrast won't need it. It strengthens colors that already meet the minimums above; it doesn't fix a default that fails them, because it only reaches users who have turned on the setting.

### Light and dark color schemes

- **Support light and dark color schemes**: Honor `@media (prefers-color-scheme: dark)` and pair it with the `color-scheme` CSS property so form controls, scrollbars, and other UA-rendered surfaces match.
See `dark-mode` (via `npx -y modern-web-guidance@latest retrieve "dark-mode"`) for more details.

### Forced Colors Mode

- **Support Forced Colors Mode**: In Forced Colors Mode (High Contrast on Windows), the browser overrides author colors with system keywords, removes `box-shadow`, `text-shadow`, and gradient backgrounds, and may also remove `border-image`. `url()` background images can't be relied on either: they may be removed, or kept in their own colors, which may not contrast with the system colors. Define system color fallbacks for color tokens using `@media (forced-colors: active)`.
- **Use `forced-color-adjust: none` only where color is essential information** (syntax highlighter, color picker swatch). **DON'T** use `forced-color-adjust: none` just to preserve aesthetics. Where the element contains text, set both its text and background colors to a pair that meets the minimums above, because a transparent background shows what is behind it, usually the user's system `Canvas` color, which can be light or dark.
- **Don't rely on `background-image`, `box-shadow`, or `border-image` to convey borders, separators, or state**: In forced colors they disappear or keep their own colors, which may not contrast with the system colors (and they often disappear in print too). If you must, ensure there's an alternative in forced colors mode, such as `outline` or `border` with system color keywords (`CanvasText`, `LinkText`, `ButtonText`, `Highlight`, `GrayText`, etc.).

## Generating tints

Before generating tints dynamically, check if you can use an existing, predefined, design token. This allows much more designer control and ensures consistency.

If you need to generate lighter or darker colors dynamically:
- **DO NOT** just adjust the lightness channel in `oklch`/`oklab` or `lch`/`lab`, e.g. `oklab(from var(--primary) 0.9 a b)`. While that is theoretically the correct way, browsers do not yet implement gamut mapping, so the resulting color is unpredictable.
- You can use `color-mix()` to mix with white or black (default to `in oklab` unless you have a reason to use a different color space for mixing). This keeps the color safely in gamut, but tends to over-desaturate colors and produce washed out tints and shades. Never use `in oklch` when mixing with neutrals. `oklch` confers no benefit in that case and due to a Chromium bug (565837690) low-chroma colors (`chroma < 0.02`) are treated as having powerless hue that resolves to `0deg` (magenta-red) in Chromium, producing an unintended reddish or pink tint.
- You MAY combine lightness adjustment with any of the other methods (e.g. `color-mix(in oklab, oklch(from var(--primary) 0.9 c h), white 30%)`) for a balance between the two, but avoid going above 30% for the lightness adjustment.

