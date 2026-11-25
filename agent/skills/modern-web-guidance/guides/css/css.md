# CSS: Modern Architecture

These guidelines provide a high-density reference for writing maintainable and standard-compliant CSS.

- [1. Foundations](#1-foundations)
- [2. Inheritance and The Cascade](#2-inheritance-and-the-cascade)
- [3. Selectors and scoping](#3-selectors-and-scoping)
  - [Prefer CSS selectors over JS for complex element targeting](#prefer-css-selectors-over-js-for-complex-element-targeting)
  - [Use `:is()` (or `:where()`) instead of CSS rule duplication for fallbacks](#use-is-or-where-instead-of-css-rule-duplication-for-fallbacks)
  - [Avoid overmatching](#avoid-overmatching)
    - [Use `:not()` instead of overrides to exclude irrelevant states/targets](#use-not-instead-of-overrides-to-exclude-irrelevant-statestargets)
    - [Prefer `@scope` over `:not()` for excluding (potentially deeply nested) subtrees](#prefer-scope-over-not-for-excluding-potentially-deeply-nested-subtrees)
    - [Overrides are fine for specialization](#overrides-are-fine-for-specialization)
    - [No global resets](#no-global-resets)
  - [Nesting and scoping](#nesting-and-scoping)
- [4. Interactivity](#4-interactivity)
- [5. Design Tokens and Theming](#5-design-tokens-and-theming)
  - [Theming](#theming)
- [6. Responsive design](#6-responsive-design)
- [7. Typography](#7-typography)
- [8. Visual effects](#8-visual-effects)
- [9. Shapes](#9-shapes)
- [10. Transitions \& animations](#10-transitions--animations)
- [11. Generated content](#11-generated-content)


## 1. Foundations

Be allergic to knowledge duplication. Prefer variables over repetition, but whenever possible, prefer built-in conventions such as:
- `currentColor` instead of defining a variable and setting `color` to it
- The `inherit` keyword instead of defining a variable on the parent and using it on the same property across parent and child.
- `em` units instead of `font-size: var(--size)`
- `cqw`/`cqh` (or their logical versions — `cqi`/`cqb`) units instead of repeating box model values.
- Code duplication is not knowledge duplication. The goal is robustness and maintainability, not saving characters.
- Prefer **logical properties and values** over physical ones (e.g. `margin-inline-start` instead of `margin-left`) so that styles adapt to different writing modes and orientations. Even if the page author does not plan to localize, external translation tools often display translated text in context.
- Do not use logical properties indiscriminately — ask yourself "would I want this to flip in RTL?" — if the answer is no, use the physical property instead.
- Consider different viewing modes (dark mode, high contrast mode), different viewport sizes, and different input modes (touch, keyboard, pointer).

## 2. Inheritance and The Cascade

**Avoid** introducing BEM naming conventions to manage specificity.
Instead, use modern CSS features such as cascade layers and `:where()` to make cascade behavior predictable and follow author intent.

Use cascade layers (`@layer`) to define explicit priority zones (e.g., `reset`, `base`, `theme`, `components`, `utilities`), and declare their order upfront (e.g. `@layer reset, base, theme, components, utilities;`).
Within each layer, use `:where()` to make selectors only compete based on meaningful signals, not incidental filters (`:not()` edge cases, remote ancestors, etc.) or for one-off easily overridable defaults.

Use keywords like `inherit`, `initial`, `unset`, or `revert` instead of explicit values to improve maintainability and better express intent.
Examples:
- When specifying a transition on a child that should match the parent's `transition-*` properties, instead of repeating the transition properties on the child, use `transition: inherit` (reduce duplication, improve maintainability)
- Use `initial` to reset a property to its initial value instead of specifying the value explicitly (clearer expression of intent)

## 3. Selectors and scoping

Modern browser-native selectors reduce the need for preprocessors and complex state-tracking in JS.

### Prefer CSS selectors over JS for complex element targeting

- **DO** use `:has()` to style parents based on child state instead of managing classes in JS (e.g. `label:has(:checked)` instead of a manual `label.has-checked` class) For more information, see the guides at `child-state-based-styling` (via `npx -y modern-web-guidance@latest retrieve "child-state-based-styling"`) and `content-based-styling` (via `npx -y modern-web-guidance@latest retrieve "content-based-styling"`).
- **DO NOT** nest `:has()` or use pseudo-elements inside it (browser API limitation)
- Use `:nth-child(<An+B> of <selector>)` when you need to style every n-th element of a certain type. E.g. `details:nth-child(1 of [open])` will style the first open `<details>` element it finds, whereas `details[open]:first-child` would style only the first child if and only if it was open.

### Use `:is()` (or `:where()`) instead of CSS rule duplication for fallbacks

**DO NOT** duplicate CSS rules to provide fallbacks for pseudo-classes that may not be supported — use `:is()` or `:where()` instead and take advantage of their forgiving parsing rules.

```css
/* BAD: duplicate rules instead of using `:where()` */
[popover]:popover-open {
  /* styles for native popovers */
}
[popover].\:popover-open {
  /* same styles again, for polyfilled popovers */
}

/* GOOD */
[popover]:where(:popover-open, .\:popover-open) {
  /* same styles in one rule */
}
```

Do NOT use this for pseudo-elements, as they are not supported in `:is()` or `:where()`.

### Avoid overmatching

Write selectors in a way that expresses _intent_.

#### Use `:not()` instead of overrides to exclude irrelevant states/targets

When the intent is to exclude certain states or elements that are fundamentally irrelevant, use `:not()`.

For example, to apply bottom borders between list items, don't do this:

```css
.fancy-list li {
  border-bottom: 1px solid silver;
}

.fancy-list li:last-child {
  border-bottom: none;
}
```

This can unintentionally overwrite a desirable `border-bottom` set from another rule.
The actual intent was to only apply the bottom border to the non-last `li`s. The code above is a workaround that poorly expresses this intent. Instead, this expresses intent more clearly:

```css
.fancy-list li:not(:last-child) {
  border-bottom: 1px solid silver;
}
```

Similarly, don't do this:

```css
button:hover {
  background: var(--color-blue);
}

button:disabled {
  background: var(--color-neutral);
}
```

If we reorder the two rules, we will get a hover background on disabled buttons!
Instead, do this:

```css
button:hover:not(:disabled) {
  background: var(--color-blue);
}

button:disabled {
  background: var(--color-neutral);
}
```

This works regardless of reordering, as the first rule does not overmatch.

If you _must_ use an override (e.g. you are using an experimental container query and the `not` case is also the fallback), in some cases you may be able to use the `revert-layer` keyword to remove the value without coupling the override to specific values.
Note that this can only work if the value to fall back to is also layered.

#### Prefer `@scope` over `:not()` for excluding (potentially deeply nested) subtrees

While `:not()` + descendant selectors can exclude subtrees, this works poorly for deeply nested structures.
For example, `.card :not(.content *)` will not work as expected for nested cards.
`@scope` fixes this as it takes hierarchical proximity into account:

```css
@scope (.card) to (.content) {
  /* styles for elements inside .card but not inside .content */
}
```

This will work as expected even for nested cards.

#### Overrides are fine for specialization

This is fine:

```css
button {
  background: var(--color-neutral);
}

button.primary {
  background: var(--color-blue);
}
```

Both rules express legitimate _intent_: buttons are generally neutral, but primary ones are blue.

#### No global resets

**DO NOT** use global resets (styles on `*`) as they cannot be overridden by web components or lower-priority cascade layers (without `!important`). Instead, apply reset styles to specific element types and/or conditions.

### Nesting and scoping

Use native CSS nesting to group related styles to the extent it improves maintainability and readability.

Prefer `@scope` over nesting when proximity should matter more than pure specificity. This is common in selectors that can be nested in any order, but the closest matching one (in element -> ancestor order) should win, e.g. theming classes.

For example this will not work as expected:
```css
.dark .invert { color-scheme: light }
.light .invert { color-scheme: dark }
```

If `.invert` is nested within _both_ `.dark` and `.light`, it will always resolve to dark mode as both rules have the same specificity.
Using `@scope` fixes this:

```css
@scope (.dark) {
  .invert { color-scheme: light }
}

@scope (.light) {
  .invert { color-scheme: dark }
}
```

## 4. Interactivity

See `accessibility` (via `npx -y modern-web-guidance@latest retrieve "accessibility"`) for focus rings, touch targets, and custom gestures.

## 5. Design Tokens and Theming

Use CSS custom properties on `:root` to define core design variables (colors, fonts, sizes, etc) used throughout the design, for visual consistency and to scale UI design across teams.
**DO NOT** specify nontrivial styling values inline. E.g. `background: transparent` or `padding: 0` is ok, but `background: #f06` or `padding: .3em` are not.
One exception is use cases where keeping code small and simple is far more important than long-term maintainability and evolution, such as testcases.

Typically these are organized in tiers, with each tier building upon the previous one. For example:
1. Tier 1: Literal design tokens (e.g. `--color-blue-10`, `--color-gray-90`, `--font-sans-serif`, `--size-xl` etc)
2. Tier 2: Semantic design tokens (e.g. `--color-accent`, `--color-neutral`, `--font-body`, `--font-heading` etc)
3. Tier 3: General UI design tokens (e.g. `--ui-border`, `--surface-bg-subtle` etc)
4. Tier 4: Component-specific design tokens (e.g. `--button-bg-primary-hover`, `--button-border-color-secondary` etc)

The smaller the scope of the use case, the fewer tiers it needs. E.g. a quick demo or toy app are fine with one tier. Do not overengineer.
Check for any existing conventions around naming and levels before inventing your own.

### Theming

- Dark mode: see `dark-mode` (via `npx -y modern-web-guidance@latest retrieve "dark-mode"`) and `component-specific-light-dark-theme` (via `npx -y modern-web-guidance@latest retrieve "component-specific-light-dark-theme"`).
- Forced Colors Mode: see `color` (via `npx -y modern-web-guidance@latest retrieve "color"`).
- Generating tints and shades: see `color` (via `npx -y modern-web-guidance@latest retrieve "color"`).
- Theming browser-generated UI (selection, scrollbars, form controls): see `browser-ui-theming` (via `npx -y modern-web-guidance@latest retrieve "browser-ui-theming"`).

## 6. Responsive design

See `responsive-design` (via `npx -y modern-web-guidance@latest retrieve "responsive-design"`) for components that adapt to the space they are given, layouts that survive mobile browser UI appearing and disappearing, reserving space for media before it loads, and text that scales with the viewport.

## 7. Typography

See `typography` (via `npx -y modern-web-guidance@latest retrieve "typography"`) for guidelines around readability, accessibility, and aesthetics of text on Web UIs.

## 8. Visual effects

See `visual-effects` (via `npx -y modern-web-guidance@latest retrieve "visual-effects"`) for look & feel enhancements such as conveying depth, texture, and elevation, blending layers, aesthetically pleasing gradients, and flexible pattern backgrounds.

## 9. Shapes

- Use `corner-shape: squircle` for more aesthetically pleasing curves as a progressive enhancement over regular rounded corners.
- Use elliptical `border-radius` (e.g., `10px / 20px`) for proportional curves without extra elements.

## 10. Transitions & animations

See `motion` (via `npx -y modern-web-guidance@latest retrieve "motion"`). For rendering performance (`content-visibility`, containment), see `performance` (via `npx -y modern-web-guidance@latest retrieve "performance"`).

## 11. Generated content
See `accessible-generated-content` (via `npx -y modern-web-guidance@latest retrieve "accessible-generated-content"`) for adding decorative or supplementary content with CSS without breaking screen readers or copy-paste.

