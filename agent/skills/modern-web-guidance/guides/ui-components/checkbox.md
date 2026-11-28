# Styling Checkboxes

Use semantic, accessible HTML with each checkbox associated with its label, either by nesting the `<input>` inside the `<label>` or by matching the label’s `for` attribute to the input’s `id`.

Modern CSS provides two approaches to styling checkboxes: customize the native appearance with `accent-color`, or override the default presentation with `appearance: none` on the `<input type="checkbox">` element.

## Native customization with `accent-color`

For simple, brand-consistent styling that retains native rendering, keyboard behavior, validation, and operating-system focus indicators, use `accent-color`.

```css
.checkbox-native {
  accent-color: #1a73e8;

  /* Sizing is controlled via relative units */
  inline-size: 1.25em;
  aspect-ratio: 1;
  margin: 0;
  cursor: pointer;
}
```

## Fully custom styling with `appearance: none`

Use `appearance: none` when the design requires control over the checkbox’s
shape, size, states, or indicators. This removes the native visual styling while
leaving the `<input>` as the interactive target.

Set explicit relative sizes for `--checkbox-size` and `--checkbox-icon-size` because `appearance: none` removes the browser’s default dimensions. Keep the icon smaller than the checkbox to provide space for its border and visual padding.

```css
/* Reusable SVG assets */
:root {
  --icon-check: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='3.5' stroke-linecap='round' stroke-linejoin='round'><polyline points='20 6 9 17 4 12'></polyline></svg>");
  --icon-dash: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='4.5' stroke-linecap='round' stroke-linejoin='round'><line x1='5' y1='12' x2='19' y2='12'></line></svg>");
}

/* Custom checkbox */
.checkbox-custom {
  --checkbox-size: 1.25em;
  --checkbox-icon-size: 0.7em;

  appearance: none;
  display: inline-grid;
  place-content: center;
  inline-size: var(--checkbox-size);
  aspect-ratio: 1;
  margin: 0;
  border: 2px solid currentColor;
  cursor: pointer;

  &::before {
    content: "";
    inline-size: var(--checkbox-icon-size);
    aspect-ratio: 1;
    background-color: currentColor;
    mask: var(--checkbox-icon) no-repeat center / contain;
    scale: 0;

    @media (prefers-reduced-motion: no-preference) {
      transition: scale 150ms ease;
    }

    @media (forced-colors: active) {
      background-color: CanvasText;
    }
  }

  &:checked {
    --checkbox-icon: var(--icon-check);
  }

  &:indeterminate {
    --checkbox-icon: var(--icon-dash);
  }

  &:is(:checked, :indeterminate)::before {
    scale: 1;
  }

  &:focus-visible {
    outline: 2px solid currentColor;
    outline-offset: 2px;
  }

  &:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }
}
```


## The indeterminate state

The indeterminate state cannot be set via an HTML attribute; set the `indeterminate` DOM property in JavaScript (`checkbox.indeterminate = true`) and ensure the `:indeterminate` pseudo-class is visually distinct from both `:checked` and unchecked states:

* **Native (`accent-color`):** Automatically styled by the browser using the element's `accent-color` (no extra `:indeterminate` CSS rule needed).
* **Custom (`appearance: none`):** Swap `--checkbox-icon` to `var(--icon-dash)` on `.checkbox-custom:indeterminate` as shown above.

```js
const selectAll = document.querySelector("#select-all");
selectAll.indeterminate = true;
```

## Accessibility and interaction

- **DO** use `:focus-visible` rather than `:focus` to style focus indicators on custom checkboxes so a distinct outline appears for keyboard navigation without showing on pointer clicks.
- **DO NOT** use `outline: none` or hide focus indicators on checkboxes.
- **DO** ensure the contrast of focus indicators has a contrast of at least `3:1` with the background color
- **DO** ensure the color for the checked and indeterminate state has a contrast of at least `3:1` with the background color
- **DO** ensure the checkbox or its wrapping `<label>` provides an interactive hit target of at least `44px x 44px` while keeping the visual checkbox box sized in relative units:
  ```css
  label {
    display: inline-flex;
    align-items: center;
    gap: 0.65rem;
    min-block-size: 44px;
    cursor: pointer;
  }
  ```
- **DO** provide a `:disabled` style variant that lowers opacity and sets `cursor: not-allowed` to convey inactive states clearly.

### Issues to be aware of when using accent-color

Browser rendering of `accent-color` varies.
For indicators generally painted over an accent color background, such as checkbox marks and radio-button dots, browsers may apply different treatments:
- **Chromium** and **Firefox** generally select a contrasting indicator color.
- **Safari** may instead preserve a white indicator in light mode or a black indicator in dark mode, while modifying the accent color behind it. This adjustment does not always provide sufficient contrast for every supplied color, so test important combinations in Safari, including both light and dark color schemes. Do not assume that Safari will automatically choose whichever indicator color provides the best contrast.

## Fallback strategies

### Fallbacks & browser support for accent-color

Browser support for accent-color: Limited availability.
Supported by: Chrome 93 (Aug 2021), Edge 93 (Sep 2021), Firefox 92 (Sep 2021), and Safari 26.2 (Dec 2025).

The `accent-color` property is progressive enhancement.
Browsers that do not support this property will ignore it and use their default UI colors.

### CSS Masks

Baseline status for Masks: Widely available. It's been Baseline since 2023-12-07.
Supported by: Chrome 120 (Dec 2023), Edge 120 (Dec 2023), Firefox 53 (Apr 2017), and Safari 15.4 (Mar 2022).
