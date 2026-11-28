# Build a Styled Progress Bar

The `<progress>` element is the semantic way to represent the completion progress of a task, like downloading or uploading information or completing part of a multi-step process. Using the native element helps with accessibility, as screen readers have an implicit `role="progressbar"` and can announce values.

This guide implements a fully styled horizontal progress bar with style customizations.

## Progress bar or progress ring?

- If space is constrained or a square aspect ratio is preferable, consider using a circular progress bar (progress ring): `progress-ring` (via `npx -y modern-web-guidance@latest retrieve "progress-ring"`)
- Prefer spinners for most indeterminate progress scenarios (`spinner` (via `npx -y modern-web-guidance@latest retrieve "spinner"`)). Use indeterminate progress bars when the indeterminate state is temporary and will soon be replaced by a determinate progress bar (e.g. waiting for metadata around an upload before a progress % can be shown)

## Markup

1.  **Use a native `<progress>` element**: It provides built-in accessibility and platform-consistent behavior.
2. Use `max` if a scale different from the default 0-1 scale is needed.
3. For a specific progress value, set a `value` attribute. Omit `value` for an indeterminate state (e.g. before more concrete feedback starts).
4. Use `<label for="...">`, `aria-labelledby`, or `aria-label` to associate the progress element with a label.

## What type of customization is needed?

For limited styling, these properties are sufficient:
- `accent-color` to change the color of the progress bar
- `width` / `inline-size` to change the width of the progress bar
- `height`/`block-size` applies inconsistently — test first
- `writing-mode: vertical-lr` for vertical bars.
- Effects that apply after painting: `opacity`, `filter`, `clip-path`, masks, transforms, `box-shadow`, etc.

If limited styling suffices, skip the next section.

WARNING: Certain properties (e.g. `border-radius`, `background`, `border`) will silently disable the default progress bar styling. If you need styling beyond the properties above, you must implement fully custom styling as described in the next section. Do NOT apply more extensive styling "just in case it works".

## Fully custom styling

### 1. Basic setup

- MANDATORY: Use `appearance: none` to enable custom styling.
- Reset UA borders with `border: 0 solid`
- To clip the active bar to the element’s border-radius, use `overflow: clip` OR apply the same `border-radius` to the bar. Do NOT use `border-radius: inherit` on the bar, which depends on the specific structure of elements in the shadow DOM.

```css
progress {
  /* Reset default browser styles */
  appearance: none;
  border: 0 solid;
  /* Clip bar to element’s border-radius  */
  overflow: clip;
}
```

### 2. Styling

- Style the track on the `progress` element itself.
- Use the appropriate browser-targeted pseudo-element to target the progress bar itself: `::-webkit-progress-value` for WebKit/Blink and `::-moz-progress-bar` for Firefox.
- MANDATORY: Do NOT group `-webkit-` and `-moz-` pseudo-elements in the same rule. The rule will be deemed invalid and will be ignored. `:is()` and `:where()` do not help here, as they don't support pseudo-elements.
- Each browser-targeted pseudo-element should appear exactly once. State-specific customizations (such as the indeterminate segment size and animation) should be routed through custom properties set on the `progress` element itself.
- Optional: Transition `inline-size` on the fill so determinate value changes animate instead of jumping. Firefox sizes the fill in layout and ignores it, which is harmless.

```css
progress {
  --progress-bar-radius: 1e5px;
  border-radius: var(--progress-bar-radius);
  /* Apply color for custom progress track (background) */
  background: var(--progress-bar-track, var(--color-neutral-90));
  /* Subtle depth on the empty part of the track */
  box-shadow: inset 0 1px 2px rgb(0 0 0 / 0.1);
}

/* Let <progress> styling show through */
progress::-webkit-progress-bar {
  background: transparent;
}

/* Webkit, Chrome */
progress::-webkit-progress-value {
  background: var(--progress-bar-fill, var(--accent-color));
  border-radius: var(--progress-bar-radius);
  transition: inline-size 0.3s;
}

/* Firefox */
progress::-moz-progress-bar {
  background: var(--progress-bar-fill, var(--accent-color));
  border-radius: var(--progress-bar-radius);
  transition: inline-size 0.3s;
}
```

### 3. Indeterminate state styling

**Add a custom animation for the indeterminate state:** Turn the fill pseudo-element into a short segment and slide it along the track.
- Style the fill itself; do NOT recreate it as a background on `progress`.
- The indeterminate fill exists only through its animation: the keyframes set its length with a real `inline-size` (this beats Chromium's UA inline `inline-size`) and moves it with `translate`. Do NOT use `scale` for the length; it distorts any pattern painted on the fill.
- `translate` percentages resolve against the fill's own width, so express positions in track units instead: make `progress` an inline-size container and use `cqi` in the keyframes. Include `margin-right: auto` in `from, to` so Chromium lays the fill out at the physical left in RTL too.
- Use transforms, not margins, to move the fill.
  - Transforms keep the animation in the compositor (unless `inline-size` is also being animated)
  - Margins break in RTL, for two separate reasons:
    - Firefox positions the indeterminate fill using only its physical left margin, so `margin-inline-start` has no effect in RTL and the fill never moves.
    - In Chromium and WebKit, which lay the fill out as a normal block, once a margin pushes the fill past the end of the track the margins add up to more than the track. Standard CSS resolves that by ignoring `margin-left` in RTL, so the segment jumps to the edge instead of sliding off it.
  - `translate` is applied after layout, so neither problem applies.
- To mirror the motion in RTL (as Chrome's native bar does), reverse the animation under `:dir(rtl)`:

```css
progress:dir(rtl) {
  --progress-bar-indeterminate-animation: progress-bar-indeterminate var(--progress-bar-indeterminate-animation-duration) infinite linear reverse;
}
```

- Define the public `--progress-bar-indeterminate-*` properties on `progress` (their name already scopes them to the state) so consumers can override them without knowing about `:indeterminate`.
- To vary the segment length (e.g. the leading edge races ahead and the trailing edge catches up), set `--progress-bar-indeterminate-animation` to two concurrent animations: one whose keyframes animate `translate` in `cqi` (position) and one whose keyframes animate `inline-size` (length), so each gets its own keyframes and easing. Do NOT try to shape both edges in a single keyframe list; per-keyframe `animation-timing-function` applies to every property in that keyframe.
- `--progress-bar-animation` applies in both states and can be used for effects such as a determinate shimmer. `revert-rule` is used to only override when it is set, to maximize composability.
- Never disable the indeterminate animation (`animation: none` leaves a zero-width fill in Chromium). For reduced motion, slow it down instead.

```css
progress {
  /* Lets the fill position itself in track units (cqi) */
  container-type: inline-size;
  /* Segment length relative to the track */
  --progress-bar-indeterminate-size: 30%;
  --progress-bar-indeterminate-animation-duration: 1.5s;

  /* Respect prefers-reduced-motion */
  @media (prefers-reduced-motion: reduce) {
    --progress-bar-indeterminate-animation-duration: 10s;
  }
}

progress:indeterminate {
  --progress-bar-animation: var(
      --progress-bar-indeterminate-animation,
      progress-bar-indeterminate var(--progress-bar-indeterminate-animation-duration) infinite linear
    );
}

/* Add to the existing pseudo-element rules */
progress::-webkit-progress-value {
  animation: var(--progress-bar-animation, revert-rule);
}

progress::-moz-progress-bar {
  animation: var(--progress-bar-animation, revert-rule);
}

/* Physical: left to right regardless of direction (reverse under :dir(rtl) to mirror). */
@keyframes progress-bar-indeterminate {
  from, to {
    inline-size: var(--progress-bar-indeterminate-size);
    /* Pin to the physical left; Chromium would otherwise lay the fill out at the inline start */
    margin-right: auto;
  }
  from { translate: -100%; } /* Own width: fully outside the left edge */
  to { translate: 100cqi; }  /* Track width: fully outside the right edge */
}
```

### Additional Accessibility Considerations

In addition to the guidelines mentioned above:
* **Announce completion without stealing focus**: Do not set `tabindex` or call `.focus()` on `<progress>`, as it is non-interactive and moving focus to it disrupts keyboard users. To announce when a background task finishes, update a polite status element (`role="status"` or `aria-live="polite"`).
* **Do not add fallback text inside `<progress>`**: Text inside `<progress>` is ignored by modern browsers and is not used by assistive technologies.
* Avoid `aria-busy` + `aria-describedby` on an unlabeled generic `<div>`. `aria-busy` has inconsistent screen reader support, and `aria-describedby` on an unnamed `<div>` without a role is ignored by assistive technologies. If a region's content is not ready while loading, hide it with `hidden` or `aria-hidden="true"`.
* **DO** ensure proper contrast between the progress bar and track when adding custom styles.
* **Consider alternatives to represent indeterminate state**: Indeterminate progress bar animations displayed in parallel to other content can be considered distracting for some users.

## Fallback strategies

### Fallbacks & browser support for accent-color

Browser support for accent-color: Limited availability.
Supported by: Chrome 93 (Aug 2021), Edge 93 (Sep 2021), Firefox 92 (Sep 2021), and Safari 26.2 (Dec 2025).

The `accent-color` property is progressive enhancement.
Browsers that do not support this property will ignore it and use their default UI colors.

If `accent-color` is not supported and styling the progress bar is required, use the customized styling method to apply preferred styling to the progress bar.

### Fallbacks & browser support for `revert-rule`

Baseline status for revert-rule: Newly available. It's been Baseline since 2026-09-14.
Supported by: Chrome 148 (May 2026), Edge 148 (May 2026), Firefox 150 (Apr 2026), and Safari 27 (Sep 2026).

If `revert-rule` is not supported, `animation: var(--progress-bar-animation, revert-rule)` falls back to `animation-name: revert-rule` with a `0s` duration when `--progress-bar-animation` is unset, which is a harmless no-op when no `@keyframes revert-rule` exists.
