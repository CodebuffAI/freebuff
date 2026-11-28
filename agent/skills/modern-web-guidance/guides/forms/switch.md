# Build Accessible Switch Controls

Use the HTML `switch` attribute on `<input type="checkbox" switch>` with an associated `<label>` to build a binary on/off toggle that preserves native form submission, keyboard navigation, and screen reader semantics (see `checkbox` (via `npx -y modern-web-guidance@latest retrieve "checkbox"`) and `forms` (via `npx -y modern-web-guidance@latest retrieve "forms"`)).

## Markup

Add the boolean `switch` attribute to a standard checkbox input:

```html
<label>
  Enable notifications
  <input id="notifications" type="checkbox" switch>
</label>
```

- The label can wrap the input or be associated with `for`/`id`. All styling targets the input, so it doesn't depend on the label structure.
- When checked, the input submits its standard checkbox value. In JavaScript, listen for `change` (or `input`) events and read `.checked` rather than `.value`.

## Styling

Customize the control's highlight color using `accent-color` (see `brand-consistent-forms` (via `npx -y modern-web-guidance@latest retrieve "brand-consistent-forms"`)) and ensure visible focus styling with a contrast ratio of at least 3:1 against adjacent colors (WCAG 1.4.11 Non-text Contrast):

```css
input[type="checkbox"][switch] {
  accent-color: var(--accent-color, #1769e0);
  margin: 0;
  cursor: pointer;
}

input[type="checkbox"][switch]:focus-visible {
  outline: 3px solid var(--focus-color, #d35400);
  outline-offset: 4px;
}
```

## Fallback strategies

### Fallbacks & browser support for switch-control

Browser support for <input type="checkbox" switch>: Limited availability.
Supported by: Safari 17.4 (Mar 2024).
Unsupported in: Chrome, Edge, and Firefox.

If your Baseline target does not support `<input type="checkbox" switch>`, load `input-switch-polyfill` only when `'switch' in HTMLInputElement.prototype` is `false`. Do not load the polyfill unconditionally. The polyfill enhances checkboxes with the `switch` attribute by setting `role="switch"`, applying switch styling (`appearance: none`), syncing computed `accent-color`, and providing pointer drag support.

Use the package-loading approach appropriate to your project. The example below assumes your setup can resolve module specifiers:

```javascript
if (!('switch' in HTMLInputElement.prototype)) {
  import('input-switch-polyfill');
}
```

### Fallbacks & browser support for accent-color

Browser support for accent-color: Limited availability.
Supported by: Chrome 93 (Aug 2021), Edge 93 (Sep 2021), Firefox 92 (Sep 2021), and Safari 26.2 (Dec 2025).

The `accent-color` property is progressive enhancement.
Browsers that do not support this property will ignore it and use their default UI colors.
