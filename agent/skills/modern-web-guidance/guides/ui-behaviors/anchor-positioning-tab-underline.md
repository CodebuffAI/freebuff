# Anchor Positioning Tab Underline

In a tab menu, provide a visual indicator showing users which tab is active by underlining the active tab item. With anchor positioning, you can create a smooth animation between the positions of the underline as the active tab changes. This does not work when changing the active tab loads a new web page.

You can also use this effect to add an animated dot to indicate the active tab in a vertical tab bar.

Create the underline using a `::before` pseudo-element on the `<ul>` that contains the `<li>` elements. **Using a pseudo-element is the preferred approach as it keeps the DOM clean and avoids adding extra elements for purely decorative effects.**

```css
ul::before {
  /* Use a pseudo-element on the container to represent the animated indicator */
  content: '';
}
```

Make the active list item an anchor by adding the `anchor-name` property, which has a value that starts with `--`.

```css
li.active {
  /* Make a unique anchor-name for the active element. */
  anchor-name: --active;
}
```

Tether the underline to the active item anchor with a `position-anchor` that matches the `anchor-name` on the anchor, and making it `position: absolute`.

```css
ul::before {
  /* Tether the underline to the active element. */
  position: absolute;
  position-anchor: --active;
}
```

Position the underline with logical insets and `anchor(self-start)` or `anchor(self-end)`. Unlike `start` and `end`, these keywords use the underline's own writing mode rather than its containing block's. This keeps the anchor sides consistent with the logical insets when an RTL tab list is inside an LTR page and no ancestor of the underline establishes a containing block within the RTL section.

```css
ul::before {
  /* DO NOT use position-area, which can not be transitioned. */
  /* Add a small gap between the indicator and the tab's block-end edge. */
  inset-block-start: calc(anchor(self-end) + .1lh);
  inset-inline-start: anchor(self-start);
  inset-inline-end: anchor(self-end);
}
```

Draw the underline with a border. DO NOT use a background or `box-shadow`: forced colors mode removes both, leaving no indicator.

```css
ul::before {
  /* Apply your project's styles for the indicator */
  border-block-end: .25lh solid red;
}
```

Finally, add a transition on the `inset` properties.

```css
ul::before {
  @media (prefers-reduced-motion: no-preference) {
    /* MANDATORY: The transition must be wrapped in a prefers-reduced-motion media query to respect user preferences. */
    transition: inset .2s;
  }
}
```

This is only a visual indicator, and must not be a replacement for setting the appropriate `aria-current="page"` or `aria-selected` aria values.

```html
<!-- MANDATORY: Provide explicit assistive technology state alongside the visual tab underline -->
<nav aria-label="Primary">
  <ul>
    <li class="active">
      <a href="/home" aria-current="page">Home</a>
    </li>
    <li>
      <a href="/about">About</a>
    </li>
  </ul>
</nav>
```

## Fallback strategies

### Anchor positioning

Baseline status for the css.types.anchor capability: Newly available. It's been Baseline since 2026-01-13.
Supported by: Chrome 125 (May 2024), Edge 125 (May 2024), Firefox 147 (Jan 2026), and Safari 26 (Sep 2025).

If the browser lacks the anchor positioning used here, hide the pseudo-element and draw a static `border-block-end` on the active tab. The border follows the tab's writing mode.

```css
@supports not (position-anchor: --active) {
  ul::before {
    content: none;
  }

  ul li.active {
    /* Choose a color appropriate to the app theme. */
    border-block-end: .25lh solid currentColor;
  }
}
```

### Anchor positioning animations

Browser support for Anchor positioning animations and transitions: Limited availability.
Supported by: Chrome 125 (May 2024), Edge 125 (May 2024), and Safari 26 (Sep 2025).
Unsupported in: Firefox.

If the browser can position the underline but cannot transition `anchor()` values, keep the anchored underline. It moves directly to the new active tab when selection changes.
