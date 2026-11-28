# Teaser

## Overview

To fade out the end of a container's content (e.g., a teaser for payment-walled text), use CSS Masking with a linear gradient, NOT a semi-transparent overlay which imposes design constraints on the background and interaction.

- This is for content that is truncated at the source, not just presentationally via CSS. To hint that a scroll container has more content to scroll to, see `scrollability-affordance-hints` (via `npx -y modern-web-guidance@latest retrieve "scrollability-affordance-hints"`) instead. For a few lines of plain text that only need an ellipsis, use `line-clamp` instead.
- This is for block content. For handling single line overflow, see `single-line-overflow` (via `npx -y modern-web-guidance@latest retrieve "single-line-overflow"`).

## Choosing a treatment

- Use a **fade** when the content continues elsewhere.
- Add a **blur** on top of the fade for payment-walled content, where the reader should see that there is more text but not be able to read it.

A mask or blur only changes how the content is painted. The content is still in the DOM, the accessibility tree, find-in-page, and copy and paste.

- DO NOT leave links or controls in the faded part: they stay focusable while they are unreadable.
- Put the call to action (e.g. a subscribe button) after the masked element, not inside it, so it is not faded too.

## Fading the end of the teaser

```css
.teaser {
  /* Size the fade in lines (3lh is an example value), not as a percentage:
     a percentage grows with the content, so a long excerpt would be mostly faded */
  mask-image: linear-gradient(to top, transparent, black 3lh);
}
```

- If CSS cuts the excerpt off instead of the markup, limit it with `max-block-size` and `overflow: clip`, so the teaser does not become a scroll container. The same mask applies.
- For vertical writing modes, point the gradient in the block direction (`to left` for `vertical-rl`, `to right` for `vertical-lr`). Do not repeat the entire gradient; instead set a CSS variable with the direction.

## Optional: blur the end of the faded text

Draw the blur with a pseudo-element over the end of the teaser. A mask on the pseudo-element ramps the blur in gradually, so there is no visible line where it starts.

MANDATORY: Put the pseudo-element on a parent of the faded element, not on the faded element itself. A `backdrop-filter` inside a masked element does not blur that element's text.

```html
<div class="teaser-blur">
  <div class="teaser">…</div>
</div>
```

```css
.teaser-blur {
  position: relative;
}

/* Starts fading before the blur starts: see below */
.teaser-blur .teaser {
  mask-image: linear-gradient(to top, transparent, black 9lh);
}

.teaser-blur::after {
  /* Example value: a small radius is enough, because the text also fades out */
  --blur: 0.1em;
  /* How far the pseudo-element extends past the text */
  --bleed: calc(2 * var(--blur));
  content: "";
  position: absolute;
  inset-inline: calc(-1 * var(--bleed));
  inset-block-end: calc(-1 * var(--bleed));
  /* Example value: how much of the text is blurred. Make it shorter than the fade. */
  block-size: calc(5lh + var(--bleed));
  backdrop-filter: blur(var(--blur));
  /* Ramps the blur in from the end of the text */
  mask-image: linear-gradient(to top, black 5lh, transparent);
}
```

- MANDATORY: Extend the pseudo-element past the text on the inline sides and at the end. `backdrop-filter` only paints inside its element, so without this bleed the blurred text is cut off in a straight line at the edges of the text.
- The bleed must be at least as large as the blur radius. A blur spreads further than its radius, so the snippet uses twice the radius.

Keep the fade on `.teaser`. The blurred text then fades into the background instead of ending at a hard edge.

- MANDATORY: Start fading the text before the blur starts, so the fade is longer than the blur (the snippet fades over 9lh and blurs over 5lh).
  - Blurred text looks heavier than crisp text at the same opacity. If both start at the same point, the text gets more prominent where the blur begins, then fades.
  - The blur only has the already-faded text to work with, so the fade cannot be so long that the blurred part is nearly transparent.
- Keep the blur radius small. The mask cross-fades sharp text with blurred text, so a large radius shows a ghost of the sharp text through the blur.
- To make the blur radius itself grow toward the end of the text, instead of cross-fading, stack 4–6 overlay elements over the end of the teaser.
  - Give each a larger `backdrop-filter: blur()` radius than the one before (e.g. `1px`, `2px`, `4px`, `8px`).
  - Give each a `mask-image` band that overlaps its neighbours, so the steps blend.
  - This costs one element and one compositing pass per step. DO NOT use an SVG filter (`backdrop-filter: url(…)`) to avoid the extra elements.

## Fallback strategies

### Fallbacks & browser support for masks

Baseline status for Masks: Widely available. It's been Baseline since 2023-12-07.
Supported by: Chrome 120 (Dec 2023), Edge 120 (Dec 2023), Firefox 53 (Apr 2017), and Safari 15.4 (Mar 2022).

No fallback is needed. DO NOT add `-webkit-mask-image` declarations.

### Fallbacks & browser support for the `lh` unit

Baseline status for lh unit: Widely available. It's been Baseline since 2023-11-21.
Supported by: Chrome 109 (Jan 2023), Edge 109 (Jan 2023), Firefox 120 (Nov 2023), and Safari 16.4 (Mar 2023).

No fallback is needed.

### Fallbacks & browser support for `backdrop-filter`

Baseline status for backdrop-filter: Newly available. It's been Baseline since 2024-09-16.
Supported by: Chrome 76 (Jul 2019), Edge 79 (Jan 2020), Firefox 103 (Jul 2022), and Safari 18 (Sep 2024).

The blur is progressive enhancement: without `backdrop-filter`, the text is not blurred but still fades out. No fallback is needed.

`backdrop-filter` does not apply SVG filter references (`url(…)`) in Safari and Firefox, so an SVG-based blur renders no blur at all there.
