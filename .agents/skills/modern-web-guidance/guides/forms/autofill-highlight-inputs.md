# Customize the styling of autofilled form fields

Use the CSS `:autofill` pseudo-class to replace the browser's default highlight for autofilled `<input>`, `<select>`, and `<textarea>` elements. It matches fields filled by the browser or by the user picking an autofill suggestion, and stops matching once the user edits the field, even if the value is identical.

It never matches checkbox, radio, file, or button inputs, form-associated custom elements, or `contenteditable`: browsers do not autofill those. A native control inside a custom element's shadow DOM matches; style it from inside, or via `::part(name):autofill`.

## How to implement

- Add at least one non-color indicator (e.g. a thicker inset ring). The browser's default highlight is color only.
- Do not remove the focus outline (`outline: none`). If you use `outline` for the autofill styling, give `:autofill:focus-visible` an outline that differs in more than color (e.g. thickness, style, or offset) so focus remains perceivable.
- Do not change layout-affecting properties (`border-width`, `padding`); the state toggles with user activity so that would shift content.

```css
input:autofill {
  /* Non-color indicator without layout shift: a thicker inset ring */
  box-shadow: inset 0 0 0 2px var(--autofill-ring-color);
  border-color: var(--autofill-ring-color);
}
```

### Overriding the background and text color

Prefer to keep the browser's background and text color. Users have learned that the default highlight means "this was autofilled", and replacing it breaks that association.
All browsers also set `background-color`, `background-image`, and `color` on autofilled fields with `!important` in their user agent stylesheets, so overriding them relies on workarounds.

If your design requires it:

```css
input:autofill {
  /* Fill: an inset box-shadow paints over the UA's `!important` background */
  box-shadow:
    inset 0 0 0 2px var(--autofill-ring-color),
    inset 0 0 0 100vmax var(--autofill-background-color);
  /* Text color: -webkit-text-fill-color is not set by the UA */
  -webkit-text-fill-color: var(--autofill-text-color);
  /* The caret still follows the UA's `color`, so set it explicitly */
  caret-color: var(--autofill-text-color);
}
```

Caveats:
- The UA text color is `FieldText`: black in a light color scheme, white in a dark one. Keep the fill legible against it (e.g. via `light-dark()`), so the field stays readable even if the text color override does not apply.
- The fill is painted over the browser's color, not your page background, so use an opaque `--autofill-background-color`.
- The rule replaces any other `box-shadow` on the field (e.g. a focus ring done with `box-shadow`); repeat those shadows in the same declaration.
- `-webkit-text-fill-color` changes painted text only. `color`, and therefore `currentColor`, still resolve to the UA's `FieldText`.

## Fallback strategies

Browser support for :autofill: Limited availability.
Supported by: Chrome 110 (Feb 2023), Edge 110 (Feb 2023), and Safari 15 (Sep 2021).
Unsupported in: Firefox.

Firefox only matches `:autofill` on autofilled username and password fields (bug 1923525). No workaround; other fields keep the default tint.

Chrome before 110 and Safari before 15 only support `:-webkit-autofill`. If they are in your Baseline target, wrap both names in `:is()` so an unrecognized pseudo-class does not invalidate the whole rule:

```css
input:is(:autofill, :-webkit-autofill) {
  /* same declarations as above */
}
```

This is progressive enhancement: unsupported browsers keep their default highlight. Do not add a JavaScript fallback.
