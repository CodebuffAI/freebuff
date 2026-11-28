# Responsive design

## Overall best practices

- Use `@container` queries to create component-driven responsive layouts that adapt to their parent container's size rather than the viewport. See `size-aware-styling` (via `npx -y modern-web-guidance@latest retrieve "size-aware-styling"`) for more details.
- Use dynamic viewport units (`dvh`, `dvw`) instead of `vh`/`vw` to prevent layout breakage when mobile browser UI elements (like address bars) appear or disappear.
- Use `aspect-ratio` for media elements (like `<img>` and `<video>`) to reserve space during loading and prevent Cumulative Layout Shift (CLS).

For the layout mechanics behind responsive UI (flexbox, grid, container query units, viewport units), see `css-layout` (via `npx -y modern-web-guidance@latest retrieve "css-layout"`).

## Responsive typography

- **DO** combine viewport-relative and font-relative units in `clamp()` for font sizes that scale with the viewport size while ensuring they stay within a desired range. For example, `clamp(2rem, 1rem + 5vw, 4rem)`. Adjust the proportion of viewport-relative and font-relative units to control how quickly the font-size changes. Use font-relative minimum and maximum values, and keep the maximum no more than 2.5 times the minimum. Viewport units don't grow when users zoom, so the text only grows once its minimum overtakes the viewport-based value; with a maximum no more than 2.5 times the minimum, browser zoom, which goes up to 500%, can still resize the text to 200% (WCAG 1.4.4 Resize Text requires text to resize up to 200% without loss of content or functionality).
- **DON'T** use `vw` alone for font-size without `clamp()`, as it can scale text too small or too large on extreme screens.

To scale type and spacing with the container instead of the viewport, see `fluid-scaling` (via `npx -y modern-web-guidance@latest retrieve "fluid-scaling"`).
