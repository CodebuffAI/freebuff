# Conditionally Apply CSS Based on At-Rule Support

Use `@supports at-rule(@<at-rule name>) {…}` to conditionally apply certain CSS rules or declarations only if a certain at-rule is supported by the browser.
This can contain entire rules, or be used in conjunction with CSS nesting to conditionally apply certain declarations.

```css
.foo {
  background: var(--accent-color);

  @supports at-rule(@property) {
    background-image: var(--rainbow-gradient);
    animation: sliding-rainbow 1s linear infinite;
  }
}
```

Do NOT use `@supports at-rule()` to conditionally apply the at-rule being detected and nothing else.

```css
/* BAD: CSS already ignores rules the browser doesn't understand, so this is unnecessary */
@supports at-rule(@starting-style) {
  @starting-style {
    /* ... */
  }
}
```

## Detecting support for at-rules when `@supports at-rule()` isn’t appropriate { #detecting-at-rules-without-supports-at-rule }

When `at-rule()` is not an option, either due to browser support or because deeper detection is needed, you can use the guidance below.

### Try properties, values, or selectors first

`@supports` can already detect properties, values, and selectors (via `@supports selector(...)`).
In many cases, you can use these to detect support for a feature without needing to check for the at-rule itself.

For example, instead of `@supports at-rule(@function)` to detect supports for custom functions, you can use `@supports (color: --foo())`.

In other cases there may be pseudo-classes or pseudo-elements that are only available when a certain at-rule is supported, which can be used to detect support.

### Detecting container query types { #supports-container-types }

`at-rule()` ONLY allows detection of at-rules by **name**.
It does NOT allow detection of other syntax or descriptors.
E.g. this will not work:

```css
@supports at-rule(@container style(--a: 1)) {
  /* ... */
}
```

For many types of container queries, you can use `container-type` with a suitable value.
E.g. `@supports (container-type: scroll-state)` for scroll-state queries, `@supports (container-type: size)` for size queries, or `@supports (container-type: anchored)` for `anchored()` queries.

However, there is no `container-type` for style queries.
IMPORTANT: Do NOT try `@supports (container-type: style)` to detect support for style queries, as this will not work.

Instead, you can try a style query that is always true:

```css
@container style(--a: 1) or (not (style(--a: 1))) {
  /* Rules here will only be applied if style queries are supported */
}
```

This will match in any browser that supports style queries, regardless of what property name or value you use, provided they are the same across both.

### Registered custom properties (`@property`) { #supports-atproperty }

In some cases, if the conditional CSS to apply can be reduced to a single property, you can use a dedicated custom property registered for this purpose:

```css
/* Use a custom property to conditionally include the dash animation */
@property --progress-dash-animation {
  syntax: "*";
  inherits: false;
  initial-value: , progress-dash 3s ease-in-out infinite;
}

.spinner {
  /* The dash animation is only included if @property is supported */
  animation:
    progress-spin var(--_used-spinner-duration) linear infinite
    var(--progress-dash-animation, );
}
```


For a more general-purpose solution, you can register a non-inheriting property and set it to ` ` (a space) on the root element:

```css
@property --supports-atproperty {
	syntax: "*";
	inherits: false;
}

:root {
	--supports-atproperty: ;
}

body {
  /* The background is only applied if @property is supported */
	background: var(--supports-atproperty, green);
}
```

Notes:
- Both of these only work if whitespace is an acceptable alternative. For other cases, you will need to use JS as described below.
- The general-purpose solution depends on non-inheritance, so it will not work for declarations on the root element.

### Using JavaScript as a last resort

For entire at-rules, check for the presence of certain interfaces in JavaScript.
For example, if `globalThis.CSSFunctionRule` is defined, then `@function` is supported.

If you need to test more deeply (e.g. for certain preludes, nested rules, descriptors), you can set up a test and check how it was parsed:

```js
const sheet = new CSSStyleSheet();
sheet.replaceSync(`
  @page {
    @top-left {
      content: "test";
    }
  }
`);
const SUPPORTS_PAGE_MARGINS = Boolean(sheet.cssRules[0]?.cssRules?.[0]);
```

IMPORTANT:
- When using JS to detect support for CSS features, do NOT apply the styles from JS directly. Instead, apply a class to the root element and branch off that in CSS.
- Do note that container queries are parsed even if the prelude is not recognized, and there is no way to detect support for certain types of container queries from the CSSOM structure.
- Do NOT use `CSS.registerProperty` to detect support for `@property` as its support is slightly broader.

## Fallback strategies

Browser support for at-rule(): Limited availability.
Supported by: Chrome 148 (May 2026), Edge 148 (May 2026), and Firefox 157 (Sep 2026).
Unsupported in: Safari.

Unless this is within your support target, **ONLY** use `@supports (at-rule())` to detect at-rules for which support is narrower than the `@supports (at-rule())` feature itself.

To conditionally apply CSS based on support for at-rules that shipped before this feature, use [the guidance in the section above](#detecting-at-rules-without-supports-at-rule).

To detect support for the `@supports at-rule()` feature _itself_, you can use an at-rule that is guaranteed to exist in all browsers that support `@supports at-rule()`, such as `@supports at-rule(@media) { ... }`.
