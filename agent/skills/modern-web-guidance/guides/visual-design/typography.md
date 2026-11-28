# Typography

## Overall best practices

- Use unitless numbers for `line-height` (e.g., `1.5`) to ensure relative scaling during font-size inheritance.
- Use `overflow-wrap: break-word` (or `anywhere`) to contain long URLs.
- **DON'T** use `px` for font-size. Prefer `rem` to honor the user's browser font-size preferences (root font size), or `em`/percentages for contextual sizing.
- **DON'T** set a fixed `height` or `block-size` on elements that contain text, such as buttons, badges, tabs and cards. Let the content set the height, with `min-block-size` if a minimum is needed, so text doesn't overflow or get clipped when users increase text spacing to a line height of 1.5, spacing after paragraphs of 2em, letter spacing of 0.12em and word spacing of 0.16em (WCAG 1.4.12 Text Spacing requires no loss of content or functionality at these values).

## Readability

- **Avoid long lines of text**: Cap paragraph blocks to a maximum of 80 characters width.
- **Avoid rivers of whitespace**: Avoid `text-align: justify` as it can make text harder to read. If you must use it, combine it with `hyphens: auto` to avoid excessive whitespace between words. `hyphens: auto` only hyphenates text whose language is declared with the `lang` attribute, such as `<html lang="en">`.
- **Don't use Ornate fonts**: Omit cursive typefaces for main reading content.
- **Don't rely on all-caps for emphasis**: Prefer bolding for visual emphasis, and use `<em>`/`<strong>` when the emphasis is semantic.
- **Limit emphasis overall**: Emphasis loses meaning when it's everywhere — apply it only where it changes how the content should be read.
- **Support user zoom preferences**: Allow users to resize text up to 200% without loss of content or functionality, and let text reflow at a 320 CSS px viewport width without horizontal scrolling (WCAG 1.4.10 Reflow); avoid `white-space: nowrap` and fixed widths on running text.

```css
body {
  line-height: 1.5;
  text-align: start; /* Supports LTR and RTL */
}
article {
  max-width: 60ch; /* Caps line length to ~80 characters for readability (1ch is the width of "0", which is wider than most characters) */
}
```

## Text wrapping

- Use `text-wrap: balance` for balanced headlines and headline-like content (e.g. `<th>`)
- Use `text-wrap: pretty` for long-form body text (paragraphs, blockquotes, etc.)
- Use `text-wrap: balance` or `text-wrap: pretty` deliberately, **DO NOT** apply it on `*` as it does have a performance cost.
- Avoid `text-wrap: balance` on elements with a visible box (backgrounds, borders, shadows, etc) as it does not change the container's width, it only affects how text wraps *within* that width. This can leave empty space at the end of the container, which is usually undesirable.

## Responsive Typography

- **DO** combine viewport-relative and font-relative units in `clamp()` for font sizes that scale with the viewport size while ensuring they stay within a desired range. For example, `clamp(2rem, 1rem + 5vw, 4rem)`. Adjust the proportion of viewport-relative and font-relative units to control how quickly the font-size changes. Use font-relative minimum and maximum values, and keep the maximum no more than 2.5 times the minimum. Viewport units don't grow when users zoom, so the text only grows once its minimum overtakes the viewport-based value; with a maximum no more than 2.5 times the minimum, browser zoom, which goes up to 500%, can still resize the text to 200% (WCAG 1.4.4 Resize Text requires text to resize up to 200% without loss of content or functionality).
- **DON'T** use `vw` alone for font-size without `clamp()`, as it can scale text too small or too large on extreme screens.
