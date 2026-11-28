# Brand-Consistent Range Slider

## Use the native range input

Use a labeled `<input type="range">` rather than recreating a slider with `<div>` elements or custom pointer handlers. The native control preserves keyboard and pointer interaction, touch behavior, and accessibility support. Configure `min`, `max`, `step`, and `value` for the use case.

```html
<label for="range-slider">Volume</label>
<input type="range" id="range-slider" value="70"/>
```

If the value requires a formatted label or unit, expose it in ordinary DOM content and update `aria-valuetext` when changed. Do not use `::before` or `::after` on slider pseudo-elements, as generated content on form controls is not interoperable. If a tooltip that follows the thumb is required, anchor it to the thumb with CSS anchor positioning; see `position-aware-tooltips` (via `npx -y modern-web-guidance@latest retrieve "position-aware-tooltips"`) for tooltips that stay correctly oriented when they flip.

## Choose the styling approach

For simple color customization, use `brand-consistent-forms` (via `npx -y modern-web-guidance@latest retrieve "brand-consistent-forms"`) and retain the browser’s native rendering:

```css
input[type="range"] {
  accent-color: var(--brand-color);
}
```

`accent-color` is not a complete slider styling API. Its effect on the thumb, track, and fill is user-agent-dependent. Use the pseudo-elements below when the track, thumb, dimensions, shape, or fill must be controlled.

## Style the track and thumb

Reset default OS styling with `appearance: none`, `margin: 0`, and `border: 0`. To normalize cross-browser rendering, declare WebKit and Firefox pseudo-elements in separate rule blocks, and center the WebKit thumb using `margin-block-start: calc((var(--slider-track-size) - var(--slider-thumb-size)) / 2)` (Firefox centers the thumb automatically). Keep consumer-facing values as custom properties on the input so themes do not target pseudo-elements directly.

```css
input[type="range"] {
  --slider-track-size: 0.5rem;
  --slider-thumb-size: 1.25rem;
  --slider-track-radius: 999px;
  --slider-thumb-radius: 50%;
  --slider-track-color: #d9d9d9;
  --slider-fill-color: #06c;
  --slider-thumb-color: var(--slider-fill-color);
  --slider-direction: to right;

  /* reverse gradient direction for right-to-left layouts */
  &:dir(rtl) {
    --slider-direction: to left;
  }

  /* Read min and max from attributes; --control-value is synced by the script below. */
  --attr-min: attr(min type(<number>), 0);
  --attr-max: attr(max type(<number>), 100);
  --control-value: attr(value type(<number>), 50);
  --slider-progress: calc(
    progress(var(--control-value), var(--attr-min), var(--attr-max)) * 100%
  );

  appearance: none;
  inline-size: 100%;
  block-size: 2.5rem; /* Preserve a generous interaction area. */
  margin: 0;
  padding: 0;
  border: 0;
  border-radius: 0;
  background: transparent;
  cursor: pointer;
}

/* WebKit/Blink. */
input[type="range"]::-webkit-slider-runnable-track {
  block-size: var(--slider-track-size);
  border: 0;
  border-radius: var(--slider-track-radius);
  background: linear-gradient(
    var(--slider-direction),
    var(--slider-fill-color) var(--slider-progress),
    var(--slider-track-color) var(--slider-progress)
  );
}

input[type="range"]::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  inline-size: var(--slider-thumb-size);
  block-size: var(--slider-thumb-size);
  margin-block-start: calc(
    (var(--slider-track-size) - var(--slider-thumb-size)) / 2
  );
  border: 0;
  border-radius: var(--slider-thumb-radius);
  background: var(--slider-thumb-color);
}

/* Firefox. */
input[type="range"]::-moz-range-track {
  block-size: var(--slider-track-size);
  border: 0;
  border-radius: var(--slider-track-radius);
  background: var(--slider-track-color);
}

input[type="range"]::-moz-range-progress {
  block-size: var(--slider-track-size);
  border-radius: var(--slider-track-radius);
  background: var(--slider-fill-color);
}

input[type="range"]::-moz-range-thumb {
  inline-size: var(--slider-thumb-size);
  block-size: var(--slider-thumb-size);
  border: 0;
  border-radius: var(--slider-thumb-radius);
  background: var(--slider-thumb-color);
}
```

Ensure the track color has a contrast of at least `3:1` with the background color.

Always provide a visible keyboard focus indicator after removing the native appearance. Ensure the focus indicator has a contrast of at least `3:1` with the background color or the adjacent track. Do not use color alone:

```css
input[type="range"]:focus-visible {
  outline: 2px solid var(--slider-fill-color);
  outline-offset: 4px;
}
```

## Style the active track

When the filled portion of the track is styled differently from the unfilled track, Firefox exposes it via `::-moz-range-progress`. WebKit/Blink do not provide an equivalent pseudo-element, so sync the live input value to `--control-value` on `input` events:

```js
const slider = document.querySelector('#range-slider');

function syncSliderValue() {
  slider.style.setProperty('--control-value', slider.value);
}

syncSliderValue();
slider.addEventListener('input', syncSliderValue);
```

## Limitations

- Do not combine WebKit and Firefox pseudo-selectors into a single comma-separated list (e.g. `::-webkit-slider-thumb, ::-moz-range-thumb`); browsers drop the entire rule if an unrecognized vendor pseudo-element is encountered.

## Fallbacks

### Fallbacks & browser support for accent-color

Browser support for accent-color: Limited availability.
Supported by: Chrome 93 (Aug 2021), Edge 93 (Sep 2021), Firefox 92 (Sep 2021), and Safari 26.2 (Dec 2025).

The `accent-color` property is progressive enhancement.
Browsers that do not support this property will ignore it and use their default UI colors.

### Fallbacks & browser support for `progress()` and `attr()`

Baseline status for progress(): Newly available. It's been Baseline since 2026-09-01.
Supported by: Chrome 138 (Jun 2025), Edge 138 (Jun 2025), Firefox 155 (Sep 2026), and Safari 26 (Sep 2025).

When `progress()` is unsupported, compute `--slider-progress` with `calc()`:

```css
@supports not (opacity: progress(1, 0, 100)) {
  input[type="range"] {
    --slider-progress: calc(
      (var(--control-value) - var(--attr-min)) /
      (var(--attr-max) - var(--attr-min)) * 100%
    );
  }
}
```

Browser support for attr(): Limited availability.
Supported by: Chrome 133 (Feb 2025), Edge 133 (Feb 2025), and Firefox 155 (Sep 2026).
Unsupported in: Safari.

When typed `attr()` is unsupported, sync `--attr-min` and `--attr-max` from the input's `min` and `max` attributes in JavaScript:

```js
function syncSliderValue() {
  slider.style.setProperty('--attr-min', slider.min || 0);
  slider.style.setProperty('--attr-max', slider.max || 100);
  slider.style.setProperty('--control-value', slider.value);
}
```

