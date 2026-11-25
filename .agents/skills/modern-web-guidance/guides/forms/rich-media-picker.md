# Rich Media Picker (Customizable Select)

The native `<select>` element was historically difficult to style and could only contain plain text options. The `appearance: base-select` property offers a declarative, CSS-only way to opt into a customizable state for the `<select>` element. This allows developers to include rich HTML content—such as images, SVGs, and complex layouts—inside `<option>` elements, while retaining native keyboard accessibility and form integration. Use this pattern to replace heavy, custom-built select components with standard, native elements.

## How to Implement

To implement a rich media picker using the Customizable Select API:

1. **Opt-in to base styles**: Apply `appearance: base-select` to both the `<select>` element and its internal picker using the `::picker(select)` pseudo-element. This changes the browser's HTML parser for the contents inside the `<select>`.
2. **Define the Button Content**: Use standard `<button>` and `<selectedcontent>` elements inside the `<select>` to define what is shown when the picker is closed. The `<selectedcontent>` element automatically mirrors the content of the selected option. This is required if you want to display the currently selected rich content in the button.
3. **Use Rich Content inside Options**: You can now place images, SVGs, and other HTML tags inside `<option>` tags. Prior to this API, the browser would strip tags from `<option>` tags and render only plain text.
4. **Style the Popover**: Style the dropped-down options list by targeting the `::picker(select)` pseudo-element. It renders in the top layer, meaning you don't need to fight with `z-index`. Options are positioned using the Anchor Positioning API natively.

## Example Code: Rich Role Picker

```html
<label for="role-picker">Select your role</label>
<select class="custom-select" name="role" id="role-picker">
  <button>
    <selectedcontent></selectedcontent> <!-- Mirrors the selected option's content automatically so you do not need JS to update the button -->
  </button>

  <!-- Define concise aria-label values on options whose mirrored rich content would otherwise read awkwardly as a concatenated string -->
  <option value="frontend">
    <svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor">
      <rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect>
    </svg>
    <div class="option-text">
      <span class="option-title">Frontend Developer</span>
      <span class="option-desc">React, Vue, CSS</span>
    </div>
  </option>

  <option value="backend">
    <svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor">
      <rect x="2" y="12" width="20" height="14" rx="2" ry="2"></rect>
    </svg>
    <div class="option-text">
      <span class="option-title">Backend Developer</span>
      <span class="option-desc">Node.js, Python</span>
    </div>
  </option>
</select>
```

```css
select.custom-select,
select.custom-select::picker(select) {
  appearance: base-select; /* MUST opt-in both the select and its picker to enable the customizable state, otherwise browser standard rendering applies */
}

select.custom-select {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 12px;
  background-color: #1e293b;
  border: 1px solid #334155;
  border-radius: 8px;
  color: #f1f5f9;
  cursor: pointer;
}

select.custom-select::picker(select) {
  background-color: #0f172a;
  border: 1px solid #334155;
  border-radius: 8px;
  padding: 8px;
  box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.5);
  width: anchor-size(width); /* Uses Anchor Positioning API to keep the dropdown precisely aligned to the button trigger width */
}

select.custom-select option {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px;
  border-radius: 4px;
  cursor: pointer;
}

select.custom-select option:hover {
  background-color: #1e293b;
}

/* Remove standard OS checkmark for base-select */
select.custom-select option::checkmark {
  display: none;
}

/* MANDATORY: Provide multiple visual indicators (e.g., prominent background color and bold title font) to communicate the checked state cleanly */
select.custom-select option:checked {
  background-color: #3b82f6;
  color: #ffffff;
}
select.custom-select option:checked .option-title {
  font-weight: 700;
}
```

## Strategic Implementation & Best Practices

- **DO** use `appearance: base-select` when you need complex options layouts (icons, descriptions, images) that was previously only possible with heavy JavaScript UI frameworks.
- **DO NOT** use ad-hoc elements if you notice performance lags; the browser handles native keyboard focus natively.
- **DON'T** use z-index on the picker. The picker renders in the top-layer, meaning it overrides relative `z-index` of page content.
- **DO** hide secondary details (like descriptions) in the button state if they take too much space, by styling `.custom-select selectedcontent .option-desc { display: none; }`.
- Test layout behavior. Setting `appearance: base-select` removes the default browser behavior of sizing the select based on its longest option width. You may need to set a fixed width or use flex/grid constraints to prevent layout shifts.
- Ensure your `<select>` has a `name` attribute and an associated `<label>`. This ensures that even with a custom UI, the component remains accessible to screen readers and works correctly with standard form submissions.
- Use standard `value` attributes on options to ensure form submission works exactly as before.

## Accessibility considerations

MANDATORY: When the select is expanded and the list of options are visible, there must be a way to visibly identify which option is selected. Examples of how this could be achieved include: using a custom icon, adding a sufficiently contrasting outline (that clearly differs from focus/hover indication), or using a sufficiently contrasting background color.

Ensure that the rich media picker always has an associated visible label that conveys the context of the information required. This will allow people to independently select the option that they need. This ensures adherence to WCAG 3.3.2 Labels or Instructions, which requires that labels or instructions are provided when content requires user input. Similarly, ensure that all of the options include visible text, and do not rely solely on an image or colour, so that people can easily select the option that they need.

Ensure that options have enough context to be understood in isolation, particularly given that browsers that don't yet support this feature will default to displaying all of the text in a single option. For example, the following rich option, would be rendered as "Frontend Developer React, Vue, CSS", in a browser that doesn't support customizable selects. Without the visual design, this can affect the meaning of the options.

```html
<!-- Rich options -->
<option value="frontend">
  <svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
    stroke-linecap="round" stroke-linejoin="round">
    <rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect>
    <line x1="8" y1="21" x2="16" y2="21"></line>
    <line x1="12" y1="17" x2="12" y2="21"></line>
  </svg>
  <div class="option-text">
    <span class="option-title">Frontend Developer</span>
    <span class="option-desc">React, Vue, CSS</span>
  </div>
</option>
```

To address this issue, ensure that the content makes sense, regardless of visual styling, and where necessary use inclusively hidden text to ensure that content makes sense. In the previous example, we could add: `<span class="visually-hidden">Responsibilities include:</span>`, as well as a full stop, so that browsers that don't support customizable selects would provide the option text as: "Frontend Developer. Responsibilities include: React, Vue, CSS", which makes more sense. The use of a full stop can help indicate when screen readers should pause when announcing the content, helping people to better understand the structure of the option text. The updated HTML for the option would be:

```html
<!-- Rich options -->
<option value="frontend">
  <svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
    stroke-linecap="round" stroke-linejoin="round">
    <rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect>
    <line x1="8" y1="21" x2="16" y2="21"></line>
    <line x1="12" y1="17" x2="12" y2="21"></line>
  </svg>
  <div class="option-text">
    <span class="option-title">
      Frontend Developer<span class="visually-hidden">.</span>
      <span class="visually-hidden">Responsibilities include:</span>
    </span>
    <span class="option-desc">React, Vue, CSS</span>
  </div>
</option>
```

This approach helps ensure equity in the information provided across browsers, regardless of whether the feature is supported or not.

**DON'T** override the option's text, by applying an `aria-label` on it. This will result in people missing visible text that hasn't been included in the `aria-label`. It also risks the issue arising when the option text is updated in the future. Instead, ensure that the entire option text makes sense in isolation.

**DON'T** add interactive elements or semantics inside the `<option>` element. People using screen readers will not hear the announcements, and as a result, won't be able to determine that further information is present.

## Fallback Strategies

### Fallbacks & browser support for Customizable `<select>`

Browser support for Customizable <select>: Limited availability.
Supported by: Chrome 135 (Apr 2025), Edge 135 (Apr 2025), and Safari 27 (Sep 2026).
Unsupported in: Firefox.

For browsers that do not yet support `appearance: base-select`, the `<select>` element degrades gracefully to a standard operating system dropdown.

- **Non-Text Content Ignored**: Older browsers strip HTML tags (like `<svg>` or `<div>`) inside `<option>` tags and render only the text nodes. Ensure the text content of the `<option>` is readable and meaningful on its own.
- **HTML Structure Handling**: Standard parsers may ignore the `<button>` and `<selectedcontent>` tags inside `<select>` or treat them as invalid. No heavy JavaScript polyfills are strictly required for progressive enhancement if you view standard text as a readable fallback.


```javascript
document.addEventListener("DOMContentLoaded", () => {
  // Check if browser supports base-select value
  if (!CSS.supports("appearance", "base-select")) {
    // Custom select overrides are not supported natively.
  }
});
```
