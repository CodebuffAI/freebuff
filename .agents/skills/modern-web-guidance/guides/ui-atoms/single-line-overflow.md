# Single-line text overflow

Text that has to stay on one line (tab and chip labels, table cells, sidebar items, file names, media titles) is often longer than its space, especially with user content and translations.

Keep the full text in the DOM and only adapt how it renders: the full text is the accessible name, and what find-in-page, copy, and search see.

This guide does not cover use cases where wrapping is an acceptable option.

There are two components to handling single-line text overflow:
1. How to display the truncated text
2. How can users find out what the full text is

## How to display truncated text

Truncation is visual only. Screen readers announce the full text, find-in-page matches it, and copying copies it. This is why the string must never be cut in script.

### 1. Truncate with an ellipsis (at the end or middle)

```css
.label {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
```

- Use `overflow: hidden`, not `clip`. Both render the ellipsis, but only `hidden` makes the element a scroll container, which the fade, the scroll reveal, and the CSS detection of truncation below depend on.
- In flex/grid: Let the containing flex or grid item shrink. Items refuse to shrink below their content by default (`min-inline-size: auto`). When the truncated element is the item itself, `overflow: hidden` already allows it; when it is a descendant (such as a label inside a button), set `min-inline-size: 0` on the item.
- In tables, set `table-layout: fixed` and an inline size on the table. With automatic layout, cells grow to fit their text instead of truncating it.
- An element's own `overflow: hidden` does not clip its own focus outline, so buttons and links can truncate their text directly. Outlines are clipped by an ancestor that clips overflow, such as a scrolling row of items; give those items an inset outline (`outline-offset: -2px`).

#### Keeping the end visible

Wrap the part that may truncate, such as everything before the file extension or the last few characters, and leave the end as plain text after it. The split is in the markup (or done once in script when rendering), never by cutting characters out.

```html
<!-- No whitespace before the extension, or it renders as a space -->
<span class="filename"><span>quarterly-report-final-v2</span>.pdf</span>
```

```css
.filename {
  display: flex;
  white-space: nowrap;
}

/* The trailing text is an anonymous flex item, which never shrinks below its content */
.filename > span {
  overflow: hidden;
  text-overflow: ellipsis;
}
```

### 2. Fade out the end

Use a mask that fades the end of the text. Only fade when the text overflows, or text that fits fades for no reason. An element with `overflow: hidden` is a scroll container, so its scroll timeline is only active when its content overflows. An animation on that timeline applies exactly when the text is truncated:

```css
/* --truncated is the flag the animation sets, registered so it does not inherit into nested elements.
   --fade-size is the configured size, registered so it can transition. */
@property --truncated {
  syntax: "<integer>";
  inherits: false;
  initial-value: 0;
}

@property --fade-size {
  syntax: "<length>";
  inherits: false;
  initial-value: 0px;
}

.label {
  white-space: nowrap;
  overflow: hidden;
  /* Example value: how much of the text fades */
  --fade-size: 2rem;
  /* Gradient directions and positions are physical, so flip them for right-to-left text */
  --fade-dir: right;
  --fade-pos: 100%;
  /* An opaque layer that is not clipped to the box, minus a band at the end.
     Masking only the band keeps everything else visible, including a focus outline outside the box.
     The band is --fade-size while truncated, 0 otherwise. */
  mask:
    linear-gradient(black, black) no-clip subtract,
    linear-gradient(to var(--fade-dir), transparent, black) var(--fade-pos) 0 / calc(var(--truncated) * var(--fade-size)) 100% no-repeat no-clip;
  /* Sets the flag only while the text overflows: with no overflow the timeline is inactive and the animation has no effect */
  animation: truncated linear both;
  animation-timeline: scroll(self inline);

  &:dir(rtl) {
    --fade-dir: left;
    --fade-pos: 0;
  }
}

@keyframes truncated {
  from, to {
    --truncated: 1;
  }
}
```

Keep the keyframes to the flag and derive the band from it. The reveal below transitions `--fade-size`, and a keyframe that set the band or the mask directly would not follow that transition in every browser.

DO NOT use a single gradient as the mask. A mask is clipped to the border box by default, so it also hides the element's focus outline, which is outside the box.

### 3. Replace with a predefined shorter version

Put both versions in the markup and switch them with a container query on the cell or item. The short version is presentational: hide it from assistive technology and from selection, and hide the long version visually rather than with `display: none`, so the full text stays the accessible name and what copy and find-in-page see.

```html
<!-- The wrapper is the container: size containment has no effect on table cells themselves -->
<td><div class="day"><span class="long">Saturday</span><span class="short" aria-hidden="true">Sat</span></div></td>
```

```css
.day {
  container-type: inline-size;
}

.short {
  display: none;
  user-select: none;
}

/* Example threshold: relative units resolve against the container's own font */
@container (inline-size < 6em) {
  /* Visually hidden, but still in the accessibility tree */
  .long {
    position: absolute;
    inline-size: 1px;
    block-size: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }

  .short {
    display: inline;
  }
}
```

## Reveal full text on demand

Reveal on `:hover` and `:focus-visible` of the interactive element, never on hover alone. Move the text only when `prefers-reduced-motion` is `no-preference`; otherwise leave the ellipsis.

Hover and focus reveal nothing on touch. Give the full text another route: the selected item shows it untruncated (a selected tab is never shrunk), a row opens a detail view, or the text is also shown in full elsewhere.

Choose by whether the element may grow:

1. **Scroll the text inside its box** when nothing else may move: grids, tables, tab strips, dense lists. The element keeps its size.
2. **Expand the element** when it may grow to its text, such as a chip or a tag with a `min-inline-size` and `max-inline-size`. Siblings shift to make room, so do not use it in grids or tables, where it breaks alignment.
3. **Use a tooltip** when it would add information beyond the label, or when the full text can be exceedingly long (methods 1 and 2 are less tolerant of extreme variance)

### 1. Scroll the text inside its box

Move the text by the difference between the element's width and its own: a percentage margin resolves against the element, a percentage translate against the text itself. The element's own scroll timeline flags truncation in a custom property, and a style query on it limits the motion to truncated text, so text that fits stays put. The inner `span` is the only extra markup: it becomes the box that moves. The same class works on non-interactive elements such as list items, where hover still reveals.

```html
<a class="label" href="…"><span>Meeting notes from Tuesday afternoon</span></a>
```

```css
.label {
  display: block;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  /* Active only while the text overflows */
  animation: truncated linear both;
  animation-timeline: scroll(self inline);
}

/* The same flag as the fade, registered there so it does not inherit */
@keyframes truncated {
  from, to {
    --truncated: 1;
  }
}

@media (prefers-reduced-motion: no-preference) {
  /* Outside the query: a container cannot query itself */
  .label:is(:hover, :focus-visible) {
    text-overflow: clip;
  }

  @container style(--truncated: 1) {
    .label:is(:hover, :focus-visible) > span {
      /* Needs its own box to be moved. It stays inline otherwise, so the ellipsis renders. */
      display: inline-block;
      /* Forward by the element's width, then back by the text's own width */
      margin-inline-start: 100%;
      /* 1px short, so the text still overflows and the timeline stays active */
      translate: calc(1px - 100%);
      /* Example values. Set only here: when the pointer leaves, the text snaps back behind the ellipsis */
      transition: margin-inline-start 2s ease-in, translate 2s ease-in;
    }

    /* The overflow is on the left, so the text moves right */
    .label:is(:hover, :focus-visible):dir(rtl) > span {
      translate: calc(100% - 1px);
    }
  }
}
```

The duration is fixed, so longer text scrolls faster. CSS cannot measure the text, so if a constant speed matters, set a `--scroll-width` custom property from script to the hidden width (`scrollWidth - clientWidth`, as a number) in the `ResizeObserver` from the detection section below, and derive the duration from it, for both the scroll and the fade:

```css
/* Example speed: 10ms per hidden pixel. Without script, assumes 200px. */
transition-duration: calc(var(--scroll-width, 200) * 10ms);
```

Use a timing function that starts slowly and accelerates, such as `ease-in`: a pointer that only passes over barely moves the text, and the end, which is what the user is waiting for, arrives quickly.

With a fade instead of an ellipsis, the text would scroll under the fade and its end would stay unreadable. Shrink the fade in step with the scroll, so it is gone when the end arrives:

```css
@media (prefers-reduced-motion: no-preference) {
  .label:is(:hover, :focus-visible) {
    --fade-size: 0px;
    /* Same duration and easing as the scroll. Set only here, so the fade is back as soon as the text snaps back. */
    transition: --fade-size 2s ease-in;
  }
}
```

### 2. Expand the element

Let the element grow to its text, and transition the growth. Set `interpolate-size: allow-keywords` so the transition can interpolate to `max-content`.

```css
.chip {
  /* Example values */
  min-inline-size: 6rem;
  max-inline-size: 12rem;
  interpolate-size: allow-keywords;

  & > span {
    display: block;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  &:is(:hover, :focus-visible) {
    max-inline-size: var(--expanded-max-inline-size, max-content);
  }

  @media (prefers-reduced-motion: no-preference) {
    transition: max-inline-size .3s;
  }
}
```

### 3. Use a tooltip

A tooltip is exposed as the element's description, while the label stays its name.
If the tooltip only repeats the label, hide it from assistive technology (`aria-hidden="true"`), or screen readers announce the text twice.
If it adds information, leave it exposed: name and description are announced as different things. If it also repeats the label, hide that part of the tooltip (`aria-hidden="true"` on it), so the description holds only the addition.
DO NOT rely on `title` alone: it is unreachable from the keyboard and on touch.
See `interest-triggered-tooltips` (via `npx -y modern-web-guidance@latest retrieve "interest-triggered-tooltips"`) for tooltips.

## Detecting whether the text is truncated

No property reports truncation. Derive it from overflow: the element is truncated when it can scroll toward its inline end. `text-overflow` only changes painting, so this holds with an ellipsis too.

- **In CSS**, use a scroll-driven animation on the element's own inline scroll timeline, as in the fade above: it is active only while the text overflows. Declarations in the keyframes apply to the element itself. For descendants and pseudo-elements, set a custom property in the keyframes and read it with a style query. For example, to hint that hovering reveals more:

  ```css
  /* Registered so the flag does not inherit into nested truncated elements */
  @property --truncated {
    syntax: "<integer>";
    inherits: false;
    initial-value: 0;
  }

  .label {
    animation: truncated linear both;
    animation-timeline: scroll(self inline);
  }

  @keyframes truncated {
    from, to {
      --truncated: 1;
    }
  }

  @container style(--truncated: 1) {
    .label > span {
      text-decoration: underline dotted;
    }
  }
  ```

  The element's `animation` carries the detection: add any other animation to that list, since declaring `animation` again replaces it.
  DO NOT use a scroll-state query (`scrollable`) for this: the spec excludes `overflow: hidden` containers, so a browser that matches today may stop.

- **In script**, when the result drives something CSS cannot (adding a tooltip, setting an attribute), compare `scrollWidth` to `clientWidth` in a `ResizeObserver`. Run the check again when the text changes: `ResizeObserver` reacts only to size changes.

  ```js
  const observer = new ResizeObserver(entries => {
    for (const { target } of entries) {
      target.classList.toggle('truncated', target.scrollWidth > target.clientWidth);
    }
  });
  observer.observe(label);
  ```

## Fallback strategies

### Fallbacks & browser support for scroll-driven animations

Baseline status for Scroll-driven animations: Newly available. It's been Baseline since 2026-10-27.
Supported by: Chrome 115 (Jul 2023), Edge 115 (Jul 2023), Firefox 159 (Oct 2026), and Safari 26 (Sep 2025).

Without scroll-driven animations the fade never shows, the hint never shows, and the scroll reveal never starts: the text is clipped with no indication. If your Baseline target does not support them, toggle a class from script: a `ResizeObserver` compares `scrollWidth` to `clientWidth`, and the class sets the same flag as the keyframes. Run the check again when the text changes: `ResizeObserver` reacts only to size changes.

```js
if (!CSS.supports('animation-timeline', 'scroll()')) {
  const observer = new ResizeObserver(entries => {
    for (const { target } of entries) {
      target.classList.toggle('truncated', target.scrollWidth > target.clientWidth);
    }
  });

  for (const label of document.querySelectorAll('.label')) {
    observer.observe(label);
  }
}
```

```css
/* Same as the keyframes */
.label.truncated {
  --truncated: 1;
}
```

### Fallbacks & browser support for style queries

Baseline status for Container style queries: Newly available. It's been Baseline since 2026-05-19.
Supported by: Chrome 111 (Mar 2023), Edge 111 (Mar 2023), Firefox 151 (May 2026), and Safari 18 (Sep 2024).

Without style queries the fade still works, since it is on the element itself, but the hint and the scroll reveal never apply. Gate them on the class from the scroll-driven animations fallback above instead, and set that class without the `CSS.supports` guard: at-rules cannot be feature-detected.

```css
/* Same as the style queries */
.label.truncated > span {
  text-decoration: underline dotted;
}

@media (prefers-reduced-motion: no-preference) {
  .label.truncated:is(:hover, :focus-visible) > span {
    display: inline-block;
    margin-inline-start: 100%;
    translate: calc(1px - 100%);
    transition: margin-inline-start 2s ease-in, translate 2s ease-in;
  }
}
```

### Fallbacks & browser support for `interpolate-size`

Browser support for interpolate-size: Limited availability.
Supported by: Chrome 129 (Sep 2024) and Edge 129 (Sep 2024).
Unsupported in: Firefox and Safari.

Without it, `max-content` cannot be interpolated and the element expands instantly. Transition to a length instead: one a little wider than the longest text. The growth stops as soon as the text fits, so a value far above it cuts the visible transition short.

```css
.chip {
  @supports not (interpolate-size: allow-keywords) {
    --expanded-max-inline-size: 20rem;
  }
}
```

### Fallbacks & browser support for container queries

Baseline status for Container queries (size): Widely available. It's been Baseline since 2023-02-14.
Supported by: Chrome 105 (Sep 2022), Edge 105 (Sep 2022), Firefox 110 (Feb 2023), and Safari 16 (Sep 2022).

Container queries and their units are widely available. No fallback is needed.

### Fallbacks & browser support for masks

Baseline status for Masks: Widely available. It's been Baseline since 2023-12-07.
Supported by: Chrome 120 (Dec 2023), Edge 120 (Dec 2023), Firefox 53 (Apr 2017), and Safari 15.4 (Mar 2022).

Masks, including `mask-composite` and `mask-clip: no-clip`, are widely available. No fallback is needed.
