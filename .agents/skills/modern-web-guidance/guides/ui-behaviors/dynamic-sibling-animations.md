# Creating a stagger animation

Stagger animations provide an interesting effect where multiple ordered elements animate sequentially with a slight delay between each, rather than all animating at once. This technique is often used in lists, galleries, or navigation menus to guide the user's eye and add a polished, rhythmic feel to interactions.

## Stagger animations with `sibling-index()`

Use the `sibling-index()` function on the `animation-delay` property so that the animation on each element is offset by a number proportionate to its position in its parent. The `sibling-index()` function returns a 1-based integer, so multiply it by a time value to produce a delay.

```css
#stagger-list > .item {
  --stagger-time: 0.1s; /* Example step delay */
  /* Hold initial keyframe during each sibling's stagger delay */
  animation: fade-in 0.4s both;
  /* Offset each sibling's delay by its 1-based index */
  animation-delay: calc(sibling-index() * var(--stagger-time));
}
```

**MANDATORY:** Respect user preferences by disabling the animation for users who prefer reduced motion.

```css
@media (prefers-reduced-motion: reduce) {
  /* Disable animation for users who prefer reduced motion. */
  #stagger-list > .item {
    animation: none;
  }
}
```

## Fallback strategies

Baseline status for sibling-count() and sibling-index(): Newly available. It's been Baseline since 2026-08-18.
Supported by: Chrome 138 (Jun 2025), Edge 138 (Jun 2025), Firefox 154 (Aug 2026), and Safari 26.2 (Dec 2025).

If your Baseline target does not support `sibling-index()`, feature-detect support so older browsers still receive staggered animations. Test support with a literal time value—`@supports (animation-delay: calc(sibling-index() * 0.1s))` in CSS and `!CSS.supports('animation-delay: calc(sibling-index() * 0.1s)')` in JavaScript. **DO NOT** reference `var()` inside `@supports` or `CSS.supports()`, because custom property references parse as valid in all browsers and make the check always return `true`.

For dynamic lists (or new implementations), use JavaScript to set a 1-based `--sibling-index` custom property on each child element. **MANDATORY:** Wrap this in a `!CSS.supports('animation-delay: calc(sibling-index() * 0.1s)')` check to avoid running unnecessary JavaScript in supporting browsers.

```js
if (!CSS.supports('animation-delay: calc(sibling-index() * 0.1s)')) {
  const staggerList = document.getElementById('stagger-list');
  [...staggerList.children].forEach((el, index) => {
    el.style.setProperty('--sibling-index', index + 1);
  });
}
```

Set the base `animation-delay` using `var(--sibling-index)`, and **MANDATORY:** wrap the `sibling-index()` override in `@supports (animation-delay: calc(sibling-index() * 0.1s))`. Because `calc(sibling-index() * var(--stagger-time))` contains `var(--stagger-time)`, CSS defers syntax validation until computed-value time—without `@supports`, browsers lacking `sibling-index()` accept the second declaration at parse time, discard the fallback, and reset `animation-delay` to `0s` as Invalid at Computed-Value Time.

```css
#stagger-list > .item {
  --stagger-time: 0.1s; /* Example step delay */
  animation: fade-in 0.4s both;
  animation-delay: calc(var(--sibling-index) * var(--stagger-time));
}

/* MANDATORY: Gate sibling-index() in @supports using a literal time unit */
@supports (animation-delay: calc(sibling-index() * 0.1s)) {
  #stagger-list > .item {
    animation-delay: calc(sibling-index() * var(--stagger-time));
  }
}
```

When refactoring an existing `:nth-child()` stagger stylesheet in an environment where adding client-side JavaScript is undesirable (such as static or server-rendered CSS with a small, fixed item count), keep the `:nth-child()` delay rules inside `@supports not (animation-delay: calc(sibling-index() * 0.1s))` instead of injecting `--sibling-index` via JavaScript. Wrapping `:nth-child()` in `@supports not (...)` prevents the higher-specificity `:nth-child()` selectors from overriding `sibling-index()` in supporting browsers:

```css
#stagger-list > .item {
  --stagger-time: 0.1s; /* Example step delay */
  animation: fade-in 0.4s both;
}

/* Literal time in @supports avoids var() always-true parsing */
@supports (animation-delay: calc(sibling-index() * 0.1s)) {
  #stagger-list > .item {
    animation-delay: calc(sibling-index() * var(--stagger-time));
  }
}

/* Gate :nth-child() so its higher specificity doesn't override sibling-index() */
@supports not (animation-delay: calc(sibling-index() * 0.1s)) {
  #stagger-list > .item:nth-child(1) { animation-delay: 0.1s; }
  #stagger-list > .item:nth-child(2) { animation-delay: 0.2s; }
  #stagger-list > .item:nth-child(3) { animation-delay: 0.3s; }
}
```
