# Motion

- Use `clip-path` and `mask-image` for custom geometric reveals and smooth fade-outs. Both also clip the element's own focus outline, so when the clipped or masked element is focusable (for example, a scroll container with `tabindex="0"`), draw its focus indicator on a parent element that isn't clipped or masked.
- Use **Scroll-Driven Animations** (`animation-timeline: scroll()`) for non-essential scroll-bound effects instead of JS listeners.
- Use **View Transitions** to animate between complex layout states seamlessly.

## Performance

- Prefer to animate `opacity` and `transform` (including individual transform properties, e.g. `translate` instead of `left/right/top/bottom`) to ensure animations stay on the compositor thread.
- Use `transition-behavior: allow-discrete`, `@starting-style`, and (for top-layer elements like `<dialog>` or `[popover]`) `overlay` to animate discrete entry and exit states natively; see `animate-element-entry-exit` (via `npx -y modern-web-guidance@latest retrieve "animate-element-entry-exit"`) and `animate-to-from-top-layer` (via `npx -y modern-web-guidance@latest retrieve "animate-to-from-top-layer"`).

```css
.popover-reveal {
  /* Transition discrete display and top-layer overlay alongside opacity */
  transition:
    opacity ease-out,
    display,
    overlay;
  transition-duration: 0.2s;
  /* Separate after transition so the shorthand doesn't reset it or fail in older browsers */
  transition-behavior: allow-discrete;
}
```

## Accessibility

- **Provide a pause mechanism**: Allow users to stop auto-running carousels, banners, or other persistent animations. Any moving, blinking, or scrolling content that starts automatically, lasts more than five seconds, and is shown alongside other content needs a visible control to pause, stop, or hide it, such as a `<button>` next to the content that works with the keyboard (WCAG 2.2.2 Pause, Stop, Hide). `prefers-reduced-motion` doesn't replace the control, because users who haven't turned on that setting still need to stop the motion. If the button's label changes between "Pause" and "Play", don't also set `aria-pressed`, or screen readers announce a pressed "Play" button.
- **Default to static views**: Consider defaulting to static states and allowing users to opt in to motion.
- **Don't exceed flash limits (three per second)**: Never include rapid light-to-dark flashing. Such effects can cause seizures. This applies whatever the user's motion preference, so don't put flashing content inside `@media (prefers-reduced-motion: no-preference)` either (WCAG 2.3.1 Three Flashes or Below Threshold: nothing flashes more than three times in any one-second period).
- **Keep the final state**: When you turn off an animation, make sure the element still ends in its final state, so content isn't left hidden (for example, at `opacity: 0`) and focus and selection indicators still appear.

### Respect reduced motion

Always respect reduced motion preferences. Choose between `@media (prefers-reduced-motion: no-preference)` and `@media (prefers-reduced-motion: reduce)` based on whether reduced motion removes the animation entirely or only adjusts its parameters:
- Use `@media (prefers-reduced-motion: no-preference)` when the reduced-motion strategy is to **not have the animation at all** (apply the animation only where needed rather than declaring it broadly and canceling it with `animation: none`).
- Use `@media (prefers-reduced-motion: reduce)` when the reduced-motion strategy is to **change animation parameters** (such as slowing down `animation-duration`).

**DO NOT** globally apply `animation-duration: 0.01ms;` as it can cause certain animations to become _more_ jarring. Instead, handle reduced motion on a case-by-case basis by nesting the `@media` query inside the rule so both versions are kept together. Keep non-motion transitions (such as `color` or `background-color` changes on links and buttons) enabled; only dampen or disable spatial movement, scaling, rotation, or persistent animations.

#### Opt in to motion with `@media (prefers-reduced-motion: no-preference)`

When reduced motion should have no animation at all, default to the static state and enable the animation inside `@media (prefers-reduced-motion: no-preference)` instead of setting `animation` and overriding it with `animation: none`:

```css
/* Good: Default to static state and opt in to full motion */
.spinner {
  @media (prefers-reduced-motion: no-preference) {
    animation: spin 1s linear infinite;
  }
}
```

#### Adjust animation parameters with `@media (prefers-reduced-motion: reduce)`

When the animation should still run under reduced motion with gentler parameters, declare the base animation and override only the changed properties inside `@media (prefers-reduced-motion: reduce)`:

```css
/* Good: Slow down the animation for reduced motion instead of canceling it */
progress:not([value]) {
  animation: slide 1s infinite linear;
  @media (prefers-reduced-motion: reduce) {
    animation-duration: 20s;
  }
}
```

## Working with animation and transition events in JavaScript

On both the `AnimationEvent` (`animationstart`, `animationiteration`, `animationend`, `animationcancel`) and `TransitionEvent` (`transitionrun`, `transitionstart`, `transitionend`, `transitioncancel`) interfaces, `event.target` gives you the originating DOM element. To access the specific `Animation` object (`Animation`, `CSSAnimation`, or `CSSTransition`) that triggered the event, use the readonly `event.animation` property.

When `event.animation` is not available, you can usually find the `Animation` instance by calling `event.target.getAnimations()` and filtering by `event.animationName` (or `event.propertyName` for transitions). However, using `event.animation` directly is preferred, in order to avoid several scenarios where this fallback that filters `event.target.getAnimations()` does not work as expected:

- Web Animations API (`element.animate()`) animations do not have an `animationName`, so they cannot be matched by name when filtering `event.target.getAnimations()`.
- Filtering by `animationName` for `AnimationEvent`s is ambiguous when multiple animations with the same name are attached to the same element.
  - Note that filtering on `transitionProperty` for `TransitionEvent`s works as there is only one event per transition property. 
- `event.target` always points to the originating DOM element, so it does not distinguish between animations running on the element itself versus one of its pseudo-elements — whereas `event.animation.effect.pseudoElement` exposes the target pseudo-element directly.

```js
// Works in most basic CSS animation cases, but fails for WAAPI animations,
// duplicate animation names on the same element, or pseudo-elements.
document.addEventListener('animationstart', (event) => {
  const animation = event.target
    .getAnimations()
    .find((anim) => anim.animationName === event.animationName);
  console.log(animation);
});

// PREFERRED: Directly access the exact Animation object via event.animation
document.addEventListener('animationstart', (event) => {
  const animation = event.animation;
  console.log(animation);
});
```

You can feature-detect support using `'animation' in AnimationEvent.prototype` (or `'animation' in TransitionEvent.prototype`).

When reduced motion means an animation or transition never runs (it's only applied inside `@media (prefers-reduced-motion: no-preference)`, set to `none`, or given a zero duration and no delay), `animationend` and `transitionend` never fire. If your code waits for these events to remove or hide an element, continue immediately when `element.getAnimations()` returns an empty array, or keep a short opacity transition instead of removing it.
