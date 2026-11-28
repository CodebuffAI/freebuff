# Customize the color or thickness of a scrollbar

You can customize the appearance of scrollbars using the standard CSS properties `scrollbar-color` and `scrollbar-width`.

*   **`scrollbar-color`**: Accepts two `<color>` values. The first applies to the thumb (the moving part), and the second to the track (the fixed background).
*   **`scrollbar-width`**: Accepts `auto` (default), `thin` (a thinner variant), or `none` (hides the scrollbar completely while maintaining scrollability).

## Apply `scrollbar-color` and `scrollbar-width`

MANDATORY: Use `scrollbar-color` and `scrollbar-width` on the scrollable container.

Choose a thumb color with a contrast ratio of at least 3:1 against the track color, and against the container's background where the track may be transparent, such as with macOS overlay scrollbars, so users can see the thumb and how far they've scrolled (WCAG 1.4.11 Non-text Contrast).

When using `scrollbar-color`, use CSS variables to keep thumb and track colors separate, for readability and maintainability (especially when using fallbacks).

```css
.scroller {
  --scrollbar-thumb: var(--color-neutral-70);
  --scrollbar-track: var(--color-neutral-90);

  scrollbar-color: var(--scrollbar-thumb) var(--scrollbar-track);
}
```

## Fallback strategies

Baseline status for scrollbar-width: Newly available. It's been Baseline since 2024-12-11.
Supported by: Chrome 121 (Jan 2024), Edge 121 (Jan 2024), Firefox 64 (Dec 2018), and Safari 18.2 (Dec 2024).

### Fallbacks & browser support for scrollbar-color

Baseline status for scrollbar-color: Newly available. It's been Baseline since 2025-12-12.
Supported by: Chrome 121 (Jan 2024), Edge 121 (Jan 2024), Firefox 64 (Dec 2018), and Safari 26.2 (Dec 2025).

This feature is progressive enhancement and does not always require fallbacks.

If the styling is important and the user's Baseline target is "Baseline Widely Available" or earlier, you SHOULD include the non-standard `::-webkit-scrollbar` pseudo-elements as fallbacks.

Place legacy fallbacks after the base rule inside an `@supports not (scrollbar-color: auto)` block to prevent conflicts between standard properties and legacy WebKit selectors in browsers that support both natively. If you also set `scrollbar-width: thin` on the scrollable container, reset `scrollbar-width: auto` on the same selector inside `@supports not (scrollbar-color: auto)` so browsers that support `scrollbar-width` without `scrollbar-color` do not suppress `::-webkit-scrollbar` styling.

If you are using custom properties to define colors, these will cascade to the legacy WebKit selectors automatically. You do NOT need to duplicate them.

```css
/* Legacy fallback for WebKit/Blink browsers */
@supports not (scrollbar-color: auto) {
  .scroller {
    /* Reset scrollbar-width: thin (if set) so it does not disable
       ::-webkit-scrollbar in browsers without scrollbar-color */
    scrollbar-width: auto;
  }

  .scroller::-webkit-scrollbar {
    /* Must define a base size (e.g., 8px for thin or 12px for default) for custom colors to render in WebKit */
    width: 12px;
    height: 12px;
  }

  .scroller::-webkit-scrollbar-thumb {
    background: var(--scrollbar-thumb);
  }

  .scroller::-webkit-scrollbar-track {
    background: var(--scrollbar-track);
  }
}
```

