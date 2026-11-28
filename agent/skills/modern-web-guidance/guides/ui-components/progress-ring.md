# Progress ring

A progress ring (or circular progress bar) provides visual feedback on the status of a task. Unlike a linear progress bar, its circular shape is ideal for dashboards, card components, or anywhere space is constrained.

This guide implements a progress ring by:

- Using the native `<progress>` element as the semantic foundation to ensure the component is accessible to screen readers and keyboard users out-of-the-box.
- Styling the component with `conic-gradient()` and `mask-image`, allowing for a fully responsive and themeable ring without the complexity of SVG path manipulation.
- Leveraging CSS Custom Properties and `@property` to enable smooth, GPU-accelerated transitions of the progress fill.

This approach is preferred over SVG-only solutions because it uses the semantic `<progress>` element rather than ARIA, and more easily integrates with existing layout, design systems and typography.

See the `spinner` (via `npx -y modern-web-guidance@latest retrieve "spinner"`) for handling indeterminate loading states.

## Implementation

### 1. Markup

Use a wrapper to hold both the visual ring and the optional center content. The `<progress>` element remains the semantic source of truth. Use a utility class to visually hide the native progress bar while keeping it accessible.

```html
<div class="progress-ring-wrapper">
  <progress value="75" max="100" aria-label="Task progress" class="progress-ring"></progress>
  <!-- Optional: Content to display in the center. Hidden from assistive
       technologies because it repeats the value of the <progress> element. -->
  <div class="progress-ring-content" aria-hidden="true">
    75%
  </div>
</div>
```

Hide the center content from assistive technologies with `aria-hidden="true"`. The `<progress>` element already exposes its value, so screen readers would otherwise announce it twice.

If the center content shows the value in another form, such as "3 of 5 files" or a percentage, set the same text in `aria-valuetext` on the `<progress>` element whenever you update it, otherwise screen readers only get the number.

### 2. Styles

#### Hiding Native UI
To style the `<progress>` element as a progress ring, first hide the default browser styling for progress bars.

```css
/* Hide native bars */
progress.progress-ring::-webkit-progress-bar {
  display: none;
  background: none;
}
progress.progress-ring::-webkit-progress-value {
  display: none;
  background: none;
}
progress.progress-ring::-moz-progress-bar {
  display: none;
  background: none;
}
progress.progress-ring::slider-fill {
  display: none;
  background: none;
}
```

#### Container and Ring

The wrapper provides the positioning context. The `<progress>` element handles the visual gradient. Forced colors mode removes background gradients, so in `@media (forced-colors: active)`, opt the ring out with `forced-color-adjust: none` and draw it with system colors, or the ring disappears.

```css
.progress-ring-wrapper {
  position: relative;
  display: grid;
  place-items: center;
}

progress.progress-ring {
  --size: 150px;
  --thickness: 16px;
  --track-color: #f1f5f9;
  --fill-color: #3b82f6;
  --value: attr(value type(<number>));
  width: var(--size);
  height: var(--size);

  transition: --value 0.4s cubic-bezier(0.4, 0, 0.2, 1);
  border-radius: 50%;

  background: conic-gradient(
    var(--fill-color) calc(var(--value) * 1%),
    var(--track-color) 0
  );

  /* MANDATORY: Clip the background to the border-area. */
  background-clip: border-area;
  border: var(--thickness) solid transparent;
  background-origin: border-box;

  @media (forced-colors: active) {
    /* Keeps the gradient, which forced colors mode removes, and draws it in system colors */
    forced-color-adjust: none;
    --fill-color: CanvasText;
    --track-color: Canvas;
  }
}

.progress-ring-content {
  /* Positioned in the center of the wrapper */
  position: absolute;
}
```

You can also use a `radial-gradient` to make rounded end caps.

#### Enable smooth transitions with `@property`

To animate the progress ring smoothly when the value changes, register `--value` as a numeric custom property. 

Users with motion sensitivities may find the transition between values disorienting. Respect the `prefers-reduced-motion` media query by having a 0 second (immediate) duration by default, and setting a longer time for users with no preference.


```css
@property --value {
  syntax: '<number>';
  inherits: true;
  initial-value: 0;
}

progress.progress-ring {
  transition: --value 0s ease-in-out;
  @media (prefers-reduced-motion: no-preference) {
    transition-duration: 0.4s;
  }
}

```

### 3. Progress Updates

Update the `value` attribute on the `<progress>` element and the text content of `.progress-ring-content` (if displaying a percentage) whenever the value changes.

### 4. Optional Success State

You can use the CSS attribute selector to automatically update the ring's appearance (e.g., changing the color to green) when the task reaches completion.

```css
/* Change the fill color to green when the progress reaches 100% */
progress.progress-ring[value="100"] {
  --fill-color: #10b981;
}
```

## Fallback strategies

Do not add a fallback value inside the `<progress>` element. It is not used by assistive technology and ignored by all modern browsers.

#### Animation fallback

Baseline status for Registered custom properties: Newly available. It's been Baseline since 2024-07-09.
Supported by: Chrome 85 (Aug 2020), Edge 85 (Aug 2020), Firefox 128 (Jul 2024), and Safari 16.4 (Mar 2023).

If `@property` is not supported, the ring will jump to the new value instantly instead of transitioning smoothly. In most cases this is fine, and does not break any functionality.

If the transition is absolutely necessary, you can check for `@property` support and use a `requestAnimationFrame()` loop to interpolate `--value` in older browsers.

Browser support for background-clip: border-area: Limited availability.
Supported by: Chrome 150 (Jun 2026), Edge 150 (Jul 2026), and Safari 18.2 (Dec 2024).
Unsupported in: Firefox.

For browsers that don't yet support `background-clip: border-area`, fall back to a `mask-image` to hollow out the center of the `<progress>` element.

```css
/* Declarations inside a top-level @supports need a selector, or the parser drops them. */
@supports not (background-clip: border-area) {
  progress.progress-ring {
    mask-image: radial-gradient(
      transparent calc(50% - var(--thickness)),
      black calc(50% - var(--thickness) + 0.5px)
    );
    border: 0;
  }
}
```

Browser support for attr(): Limited availability.
Supported by: Chrome 133 (Feb 2025), Edge 133 (Feb 2025), and Firefox 155 (Sep 2026).
Unsupported in: Safari.

For browsers that don't support the `attr()` CSS function for any property, use a `MutationObserver` to automatically sync the `value` attribute to the `--value` custom property.

```js
if (!CSS.supports("width: attr(value type(<number>))")) {
  const observer = new MutationObserver(() => {
    progress.style.setProperty("--value", progress.getAttribute("value"));
  });
  observer.observe(progress, {
    attributes: true,
    attributeFilter: ["value"],
  });
}
```