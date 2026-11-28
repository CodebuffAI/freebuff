# Adapt scrollbar to high-contrast preferences

Users who enable high-contrast modes in their operating system or browser expect UI elements (like scrollbars) to be extremely legible, often relying on stark foreground-background separation rather than subtle grays or theme colors.

This guide provides instructions on how to use the `@media (prefers-contrast: more)` CSS media feature to enforce high-contrast scrollbar styling.

## Enhance Legibility

When customizing scrollbars with `scrollbar-color` or custom variables, you can provide an explicit override for high-contrast modes. This is especially helpful if your primary application theme uses lower-contrast scrollbars for aesthetic reasons, although the default thumb still needs at least 3:1 contrast against the track (WCAG 1.4.11 Non-text Contrast).

Use an `@media (prefers-contrast: more)` block to define dark, distinct colors for the thumb and track.

```css
/* Define default standard colors as variables */
.scroller {
  --scrollbar-thumb: #707070;
  --scrollbar-track: #f1f1f1;

  scrollbar-color: var(--scrollbar-thumb) var(--scrollbar-track);
}

/* Provide clear, high-contrast overrides */
@media (prefers-contrast: more) {
  .scroller {
    /* Use extremely distinct colors like solid black against white */
    --scrollbar-thumb: #000000;
    --scrollbar-track: #ffffff;
  }
}
```

### Issues to be aware of when using scrollbar-color

- Do NOT animate or transition `scrollbar-color`. A [WebKit bug](https://bugs.webkit.org/show_bug.cgi?id=311752) causes the scrollbar to flicker every time `scrollbar-color` changes.
- Any computed `scrollbar-width` other than `auto` (`thin` or `none`) or computed `scrollbar-color` other than `auto` (including an inherited `scrollbar-color`) disables legacy `::-webkit-scrollbar` pseudo-elements on that element.
- With overlay scrollbars (such as the macOS default), `scrollbar-color` styles the thumb while scrolling, whereas the track may remain transparent. Ensure the thumb color has sufficient contrast against both the track color and the scrollable container's background rather than relying on the track to frame the thumb.

## Fallbacks & Browser Support

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
