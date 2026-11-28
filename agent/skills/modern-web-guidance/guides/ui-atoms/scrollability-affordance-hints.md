# Scrollability Affordance Hints

## Overview

Scrollability hints show users that a region has more content in a given direction, and disappear at that end of the content. There are two kinds:

- **Shadows** are drawn over the edge of the scrollport, as if the content were tucked under it. Show them with scroll-state container queries on pseudo-elements of the scroller.
- **Fades** make the content itself fade out at the edge. Draw them with a mask on the scroller, driven by a scroll-driven animation.

Both need no scroll listeners and no extra elements in the markup.

## Choosing between a shadow and a fade

Use a **fade** when:
- The scroller scrolls horizontally through a row of items (tabs, chips, carousels). Items cut off by a fade read as "more of the same".
- The background is not a solid color (gradients, images, translucent surfaces). A mask makes content transparent instead of painting over it, so it works on any background.
- The scroller has no visible boundary. A fade needs no edge to tuck content under.

Use a **shadow** when:
- The content must stay legible right up to the edge (long text, tables, forms). A fade makes content near the edge hard to read.
- The scroller is bounded by fixed chrome, such as a dialog's header and footer or a table's sticky header. The shadow makes the chrome look raised above the content.

If neither applies, default to a shadow for vertical scrollers and a fade for horizontal ones.

## Shadows

### 1. Make the scroller a scroll-state container

```css
.scroller {
  overflow-y: auto;
  container-type: scroll-state;
}
```

### 2. Draw the shadows with `::before` and `::after`

DO NOT add indicator elements to the markup. The scroller's own `::before` and `::after` are its first and last children, so `position: sticky` keeps them at the edges of the scrollport. Their negative margins cancel out their height, so they take no space.

```css
.scroller::before,
.scroller::after {
  content: "";
  display: block;
  position: sticky;
  /* Example value: how far the shadow reaches into the content */
  block-size: .75rem;
  /* Paint above positioned content */
  z-index: 1;
  /* Let clicks through to the content underneath */
  pointer-events: none;
  opacity: 0;
  transition: opacity .2s;
}

/* Radial, so the shadow curves and tapers off at the sides. Keep it subtle: it should not compete with the content. */
.scroller::before {
  inset-block-start: 0;
  margin-block-end: -.75rem;
  background: radial-gradient(farthest-side at 50% 0, rgb(0 0 0 / .15), transparent);
}

.scroller::after {
  inset-block-end: 0;
  margin-block-start: -.75rem;
  background: radial-gradient(farthest-side at 50% 100%, rgb(0 0 0 / .15), transparent);
}
```

The pseudo-elements take part in the scroller's layout even while hidden. This works best when the scroller uses block layout, or a single-column grid or flex column layout.

### 3. Show each shadow when there is content beyond its edge

Pseudo-elements can query their own originating element, so the scroller's `::before` and `::after` respond to its scroll state.

```css
@container scroll-state(scrollable: block-start) {
  .scroller::before {
    opacity: 1;
  }
}

@container scroll-state(scrollable: block-end) {
  .scroller::after {
    opacity: 1;
  }
}
```

## Fades

Fade the content with a mask on the scroller itself: an opaque layer minus a gradient band at each end. Masking only the bands keeps everything else visible, including a focus outline on the scroller, which a single gradient clipped to the border box would hide. Animate each band's size with a scroll-driven animation on the scroller's own scroll position: each fade grows from 0 as the user scrolls away from that end, and shrinks back to 0 as they reach the other end. When the content fits, the scroll timeline is inactive and there is no fade.

```css
@property --fade-start {
  syntax: "<length>";
  inherits: false;
  initial-value: 0px;
}

@property --fade-end {
  syntax: "<length>";
  inherits: false;
  initial-value: 0px;
}

.scroller {
  overflow-x: auto;
  /* Example value: how far each fade reaches */
  --fade-size: 3rem;
  /* Gradient directions and positions are physical, so flip them for right-to-left content */
  --fade-dir: right;
  --fade-start-pos: 0;
  --fade-end-pos: 100%;
  mask:
    linear-gradient(black, black) no-clip subtract,
    linear-gradient(to var(--fade-dir), black, transparent) var(--fade-start-pos) 0 / var(--fade-start) 100% no-repeat no-clip,
    linear-gradient(to var(--fade-dir), transparent, black) var(--fade-end-pos) 0 / var(--fade-end) 100% no-repeat no-clip;
  animation: reveal-fade-start linear both, hide-fade-end linear both;
  animation-timeline: scroll(self inline);
  /* Each fade animates over the first or last --fade-size of scrolling */
  animation-range: 0 var(--fade-size), calc(100% - var(--fade-size)) 100%;

  &:dir(rtl) {
    --fade-dir: left;
    --fade-start-pos: 100%;
    --fade-end-pos: 0;
  }
}

@keyframes reveal-fade-start {
  to {
    --fade-start: var(--fade-size);
  }
}

@keyframes hide-fade-end {
  from {
    --fade-end: var(--fade-size);
  }
}
```

- MANDATORY: Register `--fade-start` and `--fade-end` with `@property`. Unregistered custom properties do not interpolate, so the fades would jump.
- Set `scroll-padding-inline` (or `scroll-padding-block`) to the fade size if the scroller uses scroll snapping or contains focusable items, so snapped and focused items never stop inside a fade.
- For vertical scrollers, use `to bottom`, put the bands at `0 0` and `0 100%` with sizes `100% var(--fade-start)` and `100% var(--fade-end)`, and use `scroll(self block)` and `overflow-y`.
- For right-to-left content, flip `--fade-dir` and swap the band positions, as in the `:dir(rtl)` rule above. The scroll timeline follows the writing direction, but gradient directions and mask positions are physical.

## Accessibility considerations

Scrollability affordance hints are intended to supplement existing browser behaviour and help people be aware of larger scrollable regions. As a result of these hints being supplemental, and secondary to the primary hint (which would be the default scrollbar, or a sufficiently contrasting custom scrollbar), these scrollability affordance hints do not have to meet a specific contrast threshold. If the author wants to remove the scrollbar (which is not recommended for many usability reasons), then the scrollability affordance hint must have a contrast ratio of 3:1 against any immediately adjacent colours (to meet WCAG success criterion 1.4.11 Non-text Contrast), so that people are able to easily determine that scrolling is possible.

## Fallback strategies

Hints are an enhancement: without them, the scroller still works. If your Baseline target does not support the features below, omitting the hints is acceptable when the scrollbar is visible. If the scrollbar is hidden, the hints are the only cue that the region scrolls, so you MUST use a fallback.

### Fallbacks & browser support for scroll-state container queries

Browser support for Container scroll-state queries: Limited availability.
Supported by: Chrome 144 (Jan 2026) and Edge 144 (Jan 2026).
Unsupported in: Firefox and Safari.

Without scroll-state queries, the shadows stay hidden. Show them with a scroll-driven animation instead, which has broader support. The pseudo-elements are inside the scroller, so `scroll()` uses it as their timeline. Each shadow fades in over the first few pixels of scrolling away from its edge, instead of toggling.

```css
@supports not (container-type: scroll-state) {
  .scroller::before,
  .scroller::after {
    animation: show-shadow linear both;
    animation-timeline: scroll();
  }

  .scroller::before {
    /* Example value: how much scrolling it takes to fully show the shadow */
    animation-range: 0 2rem;
  }

  .scroller::after {
    animation-direction: reverse;
    animation-range: calc(100% - 2rem) 100%;
  }
}

@keyframes show-shadow {
  to {
    opacity: 1;
  }
}
```

When the content fits, the scroll timeline is inactive, so neither shadow shows. If your Baseline target does not support scroll-driven animations either, use one of the last-resort fallbacks below.

### Fallbacks & browser support for scroll-driven animations

Baseline status for Scroll-driven animations: Newly available. It's been Baseline since 2026-10-27.
Supported by: Chrome 115 (Jul 2023), Edge 115 (Jul 2023), Firefox 159 (Oct 2026), and Safari 26 (Sep 2025).

Without scroll-driven animations, the fades are never shown, and neither are the shadows if scroll-state queries are also unsupported. Use one of these last-resort fallbacks.

#### Shadows on a solid background: background attachment

If the scroller has a solid background color, draw the shadows with backgrounds instead. This works in every browser and needs no JavaScript.
Each shadow is a `scroll` background, which stays at the edge of the scrollport.
Each shadow has a cover: a `local` background in the scroller's own color, which scrolls with the content.
At either end of the content its cover sits on top of its shadow and hides it; once the user scrolls away from that end, the cover moves away and the shadow shows.

```css
@supports not ((container-type: scroll-state) or (animation-timeline: scroll())) {
  .scroller {
    background:
      /* Covers: scroll with the content. Must use the scroller's own background color. */
      linear-gradient(var(--surface) 30%, transparent) top / 100% 2.5rem no-repeat local,
      linear-gradient(transparent, var(--surface) 70%) bottom / 100% 2.5rem no-repeat local,
      /* Shadows: stay at the edges of the scrollport */
      radial-gradient(farthest-side at 50% 0, rgb(0 0 0 / .15), transparent) top / 100% .75rem no-repeat,
      radial-gradient(farthest-side at 50% 100%, rgb(0 0 0 / .15), transparent) bottom / 100% .75rem no-repeat,
      var(--surface);
  }
}
```

The shadows paint behind the content, so content with its own opaque background hides them. In that case, use the `IntersectionObserver` fallback below.

#### Fades, or shadows on any background: `IntersectionObserver`

Use an `IntersectionObserver` to mark which edges have more content, and show the hints from those attributes. Observe the scroller's first and last children, with the scroller as the root and `threshold: 1`: a child that is not fully visible means there is more content beyond it.

```js
if (!CSS.supports('animation-timeline', 'scroll()')) {
  for (const scroller of document.querySelectorAll('.scroller')) {
    const [first, last] = [scroller.firstElementChild, scroller.lastElementChild];
    // rootMargin: without it, sub-pixel widths can leave an edge child a fraction of a pixel short of fully visible
    const observer = new IntersectionObserver(entries => {
      for (const { target, intersectionRatio } of entries) {
        scroller.classList.toggle(target === first ? 'more-start' : 'more-end', intersectionRatio < 1);
      }
    }, { root: scroller, threshold: 1, rootMargin: '1px' });

    observer.observe(first);
    observer.observe(last);
  }
}
```

```css
/* Shadows */
.scroller.more-start::before,
.scroller.more-end::after {
  opacity: 1;
}

/* Fades */
.scroller {
  transition: --fade-start .2s, --fade-end .2s;

  &.more-start {
    --fade-start: var(--fade-size);
  }

  &.more-end {
    --fade-end: var(--fade-size);
  }
}
```

If a single child can be larger than the scroller (e.g. one long article), it is never fully visible, so this would always show both hints. Observe sentinels instead: empty elements that the script adds at each end of the scroller. A sentinel that is out of view means there is more content beyond it.

```js
// Must be valid children of the scroller (e.g. <li aria-hidden="true"> in a list)
const [start, end] = [document.createElement('div'), document.createElement('div')];
for (const sentinel of [start, end]) {
  // A zero-size sentinel at the very edge never counts as intersecting
  sentinel.style.cssText = 'min-inline-size: 1px; min-block-size: 1px';
}
scroller.prepend(start);
scroller.append(end);
// Observe them as above, with the default threshold, using !isIntersecting instead of intersectionRatio < 1
```
