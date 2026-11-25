# Loading spinner

A loading spinner (or activity indicator) informs users that a process is underway when the exact duration is unknown. Unlike a progress ring, a spinner is "indeterminate" and typically uses animation to signal activity.

This guide implements a spinner by:

- Using the native `<progress>` element as the semantic foundation. By omitting the `value` attribute, the browser treats it as an indeterminate progress bar, ensuring correct announcement by assistive technologies.
- Styling the component with `conic-gradient()` to create a visual "trail" and `background-clip: border-area` to hollow out the center into a ring.
- Animating the spinner efficiently using CSS transforms and respecting `prefers-reduced-motion` to ensure a comfortable experience for all users.

See `progress-ring` (via `npx -y modern-web-guidance@latest retrieve "progress-ring"`) for handling determinate tasks with a known duration.


## Implementation

### 1. Markup

Use the native `<progress>` element as both the semantic source of truth and the visual component. Without a `value` attribute, it is implicitly indeterminate.

```html
<progress aria-label="Loading" class="loading-spinner"></progress>
```

### 2. Styles

#### Hiding Native UI
To style the `<progress>` element as a spinner, first hide the default browser styling for indeterminate progress bars.

```css
/* Hide native bars */
progress.loading-spinner:indeterminate::-webkit-progress-bar {
  display: none;
  background: none;
}
progress.loading-spinner:indeterminate::-webkit-progress-value {
  display: none;
  background: none;
}
progress.loading-spinner:indeterminate::-moz-progress-bar {
  display: none;
  background: none;
}
progress.loading-spinner:indeterminate::slider-fill {
  display: none;
  background: none;
}
```

#### Spinner Ring and Trail
The spinner uses a `conic-gradient` to create a visual trail. Forced colors mode removes background gradients, so in `@media (forced-colors: active)`, opt the spinner out with `forced-color-adjust: none` and draw it with system colors, or the spinner disappears.

```css
@property --arc-start {
  syntax: "<angle>";
  inherits: false;
  initial-value: 0deg;
}
@property --arc-end {
  syntax: "<angle>";
  inherits: false;
  initial-value: 0deg;
}
/* Use a custom property to conditionally include the dash animation */
@property --progress-dash-animation {
  syntax: "*";
  inherits: false;
  initial-value: , progress-dash 3s ease-in-out infinite;
}

progress.loading-spinner:indeterminate {
  --_from: calc(90deg + var(--arc-start, 0deg));
  --_to: calc(90deg + var(--arc-end, 158deg));
  --size: 40px;
  --thickness: 2px;
  --spinner-color: #2563eb;
  --track-color: #e2e5e7;
  --spinner-duration: 1.5s;
  --_used-spinner-duration: var(--spinner-duration);
  --spinner-timing: linear;

  position: relative;
  width: var(--size);
  height: var(--size);
  border-radius: 50%;
  appearance: none;

  /* Create the fading trail with dynamic angles */
  background: conic-gradient(
      from var(--_from),
      var(--spinner-color) calc(var(--_to) - var(--_from)),
      transparent 0
    )
    var(--track-color);

  @supports (background-clip: border-area) {
    background-clip: border-area;
    border: var(--thickness) solid transparent;
    background-origin: border-box;
  }

  /* ... fallback for background-clip: border-area ... */

  @media (forced-colors: active) {
    /* Keeps the gradient, which forced colors mode removes, and draws it in system colors */
    forced-color-adjust: none;
    --spinner-color: CanvasText;
    --track-color: Canvas;
  }

  /* The dash animation is only included if @property is supported */
  animation:
    progress-spin var(--_used-spinner-duration) linear infinite
    var(--progress-dash-animation, );
}

@keyframes progress-spin {
  to {
    rotate: 1turn;
  }
}

@keyframes progress-dash {
  from {
    --arc-start: 0deg;
    --arc-end: 3deg;
  }
  50% {
    --arc-start: 100deg;
    --arc-end: 358deg;
  }
  to {
    --arc-start: 360deg;
    --arc-end: 363deg;
  }
}
```

#### Respecting Motion Preferences

Users with motion sensitivities may find fast-spinning elements disorienting. Always respect the `prefers-reduced-motion` media query. Set the internal `--_used-spinner-duration` property to override the user's `--spinner-duration` value, using the same selector as the spinner rule so that the override applies, and drop the dash animation so that only a slow rotation remains.

```css
@media (prefers-reduced-motion: reduce) {
  progress.loading-spinner:indeterminate {
    /* Slow down the animation significantly rather than stopping it entirely,
       so the user still knows that the process is active. */
    --_used-spinner-duration: 6s;
    /* Drops the dash animation, so the arc keeps a fixed length */
    --progress-dash-animation: ;
    --arc-end: 158deg;
  }
}
```

## Fallback strategies

Baseline status for Registered custom properties: Newly available. It's been Baseline since 2024-07-09.
Supported by: Chrome 85 (Aug 2020), Edge 85 (Aug 2020), Firefox 128 (Jul 2024), and Safari 16.4 (Mar 2023).

If `@property` is supported, the dash animation is automatically included via the `--progress-dash-animation` property's `initial-value`. In browsers without `@property` support, the property registration is ignored, and the animation falls back to a simple rotation. No JavaScript is required for this fallback.

Browser support for background-clip: border-area: Limited availability.
Supported by: Chrome 150 (Jun 2026), Edge 150 (Jul 2026), and Safari 18.2 (Dec 2024).
Unsupported in: Firefox.

For browsers that don't yet support `background-clip: border-area`, fall back to a `mask-image` to hollow out the center.

```css
/* Fallback: use mask-image to create the ring */
@supports not (background-clip: border-area) {
  --clip-boundary: calc(100% - var(--thickness));
  mask-image: radial-gradient(
    farthest-side,
    transparent var(--clip-boundary),
    black var(--clip-boundary)
  );
  border: 0;
}
```