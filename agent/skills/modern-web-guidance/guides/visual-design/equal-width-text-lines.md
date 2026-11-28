# Equal-Width Text Lines

Poster-style lockups where each line is scaled so it spans the container's full width can create visually striking headings.
Using `text-fit`, the browser scales each line during layout, so it stays correct on resize, copy changes, and font load.

For a single line filling its container (e.g. a heading or pull quote), apply `text-fit` to that element directly; this guide covers multi-line lockups.

## Basic implementation

Note: Line breaks in a lockup are either **forced** (each line is its own block) or **free** (the browser wraps). This is a continuum: a lockup can be all forced, all free, or a mix.

For forced lines:
- Wrap each line in a `<span>` with `display: block`.
- Apply `white-space: nowrap` to each forced line `<span>`.

Implementation guidelines:
- Use `text-fit: grow per-line-all <percentage>` on the heading itself.
- Use `per-line-all`, not `per-line`. `per-line` skips the last line and any line ending in a forced break, so with one block per line it scales nothing.
- `grow` cannot be combined with `shrink`. Either set the base `font-size` to a maximum or a minimum depending on what would be a better fallback or easier to calculate, and set `text-fit` to `shrink` or `grow` accordingly. If you don’t have a reason to use `shrink`, prefer `grow` + setting `font-size` to a minimum, as it's safer for most cases.
- Always limit growth or shrinkage with the percentage (e.g. `300%`) as a guardrail.
- The container needs a definite inline size. `text-fit` never changes intrinsic size, so it does nothing on `fit-content`/`max-content` widths or content-sized flex/grid items.
- Trim the leading above the first and below the last line: see `precise-text-alignment` (via `npx -y modern-web-guidance@latest retrieve "precise-text-alignment"`).
- Keep `line-height` small, `1` or under, otherwise gaps between lines of different font-sizes become unwieldy.
- IMPORTANT: Note that computed `font-size` is unchanged, so `em` spacing does not scale.
- To avoid accidental over-emphasized orphans, apply `text-wrap: balance` or `text-wrap: pretty` if there are free lines.


### Spacing

If all lines are forced, this produces more control over spacing:
- Apply `text-box: trim-both cap alphabetic` to each line block so its box hugs its own glyphs. It trims using the scaled metrics. See `precise-text-alignment` (via `npx -y modern-web-guidance@latest retrieve "precise-text-alignment"`) for more details.
- Space lines using Flexbox or Grid + `gap` on the heading, not `line-height`. Gaps are then uniform instead of growing with each line's font-size.

If some lines are free, do not use `text-box`: it only trims the first and last line, so the outer lines would hug the glyphs while interior gaps keep their leading. Let `line-height` govern all spacing.

## Visual design

- Lockups look best when there is significant variance in font sizes between lines. Avoid creating lockups from text with mostly uniform lines, as it will result in font sizes that are neither the same, nor sufficiently different, violating the design principle of _contrast_. You can ensure this by forcing short lines: wrap the words to emphasize in a block and let the rest wrap, i.e. a mixed lockup. This is especially important when combining with `text-wrap: balance`.
- Prefer combining this with `text-transform: uppercase` when used with Western scripts, as ascenders and descenders tend to create trapped space and/or overlap adjacent lines, which creates a less aesthetically pleasing result.
- When forcing short lines, pick words that would enhance the message if emphasized.
- **Limitation:** Growing text will also increase in visual weight and its strokes will be perceived as stronger. There is currently no way to counterbalance this e.g. by reducing `font-weight` for larger text, since there is no unit to use in a calculation, since the scaling does not affect font-relative units like `em`.

## Fallback strategies

### For `text-box`

Browser support for text-box: Limited availability.
Supported by: Chrome 133 (Feb 2025), Edge 133 (Feb 2025), and Safari 18.2 (Dec 2024).
Unsupported in: Firefox.

`text-box` needs no separate fallback: keep the small `line-height` on fixed lockups too. It is a no-op under `text-box` and keeps gaps tight where it is unsupported, at the cost of gaps that scale with each line's font-size.

### For `text-wrap: balance`

Baseline status for text-wrap: balance: Newly available. It's been Baseline since 2024-05-13.
Supported by: Chrome 114 (May 2023), Edge 114 (Jun 2023), Firefox 121 (Dec 2023), and Safari 17.5 (May 2024).

### For `text-fit`

Browser support for text-fit: Limited availability.
Supported by: Chrome 150 (Jun 2026) and Edge 150 (Jul 2026).
Unsupported in: Firefox and Safari.

Forced lines have a short, faithful fallback: measure each line at its base size and scale it by the ratio to the container, with the same cap.

```css
@supports not (text-fit: grow) {
  .lockup > span {
    /* Shrink-wrap each line so its width is the text width */
    width: fit-content;
    /* --text-fit-scale is measured by the script; the cap mirrors the text-fit percentage */
    font-size: min(var(--text-fit-scale, 1) * 1em, 300%);
  }
}
```

```js
if (!CSS.supports('text-fit', 'grow per-line-all')) {
  const fit = lockup => {
    const lines = [...lockup.querySelectorAll(':scope > span')];
    // Unscale first: on a refit, offsetWidth would otherwise include the previous scale
    for (const line of lines) line.style.removeProperty('--text-fit-scale');
    // MANDATORY: all reads, then all writes. Interleaving them (e.g. reading
    // lockup.clientWidth inside the write loop) forces one reflow per line.
    const scales = lines.map(line => lockup.clientWidth / line.offsetWidth);
    lines.forEach((line, i) => line.style.setProperty('--text-fit-scale', scales[i]));
  };
  // Refit on resize and font load
  for (const lockup of document.querySelectorAll('.lockup')) {
    new ResizeObserver(() => fit(lockup)).observe(lockup);
  }
}
```

Free lines have no faithful fallback (line breaks are unknown until layout): progressive enhancement to a balanced heading with a fluid base size such as `clamp(2rem, 1rem + 5cqi, 5rem)`. In a mixed lockup the script above still fits the forced lines; a wrapping block measures as wide as the container, so it keeps scale 1 and only gets the fluid base size.

If text fitting is critical, consider using a JS library (e.g. `fitty`), conditionally loaded only if `text-fit` is not supported.
