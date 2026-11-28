# Accessible generated content

- **DON'T** use `content` to convey meaningful text (labels, state, instructions) — keep that in the DOM (WCAG F87). The alt text argument is harm reduction for cases where decoration accidentally carries meaning, not a license.
- Use the alternative text argument of `content` to provide alt text for screen readers. E.g. `content: url(cloud.svg) / "Save";`
- Use `content: "text" / "";` to prevent purely decorative text from being announced to screen readers.
- **DON'T** use an empty alt text argument for images — they're already presentational by default. E.g. this is wrong: `content: url(cloud.svg) / "";`.
- **DON'T** use the alt text argument to describe emojis unless the description differs from the official emoji name. E.g. don't do `content: "🎉" / "celebration";`, but `content: "🎉" / "Yay!";` is fine.

**ONLY** use the alt text argument when the text is different than the primary value and is not already present in the DOM. I.e. this is wrong:

HTML:
```html
<button class="save">Save</button>
```

CSS:
```css
button.save::before {
  content: url(cloud.svg) / "Save";
}
```

A screen reader would read it out as "Save save".

## Fallback strategies

Baseline status for Alt text for generated content: Newly available. It's been Baseline since 2024-07-09.
Supported by: Chrome 77 (Sep 2019), Edge 79 (Jan 2020), Firefox 128 (Jul 2024), and Safari 17.4 (Mar 2024).

If your Baseline target includes browsers that do not support the `/` alternative text syntax, precede the declaration with a single-value `content` fallback so unsupported browsers do not drop the entire declaration as invalid CSS:

```css
.more-link::after {
  /* Fallback: render the glyph in browsers without `/` support
     (screen readers there will still announce it) */
  content: " →";
  content: " →" / "";
}
```

For non-empty alternative text (`content: url(...) / "..."`), a single-value `content: url(...)` fallback keeps the image visible in older browsers but drops its alt text. If that label is required in older browsers, put it in the DOM instead (e.g., via a visually hidden `<span>` or `aria-label`) and use a plain `content: url(...)` declaration without `/`.
