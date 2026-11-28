# Two-Dimensional Panning

When a user scrolls a two-dimensional scroll container, browsers typically apply a scroll axis-locking heuristic (also known as "railing"). If a gesture begins with significantly more movement along one axis than the perpendicular axis, the browser locks the scroll to that single horizontal or vertical axis and ignores perpendicular deltas—often for the remainder of the gesture.

While axis-locking prevents accidental sideways drift in one-dimensional reading flows, it creates friction on two-dimensional panning surfaces such as interactive maps, zoomed images, infinite canvases, node graphs, and large data grids. Because the lock persists across the gesture, it affects any panning that involves two directions—whether both axes are panned simultaneously (diagonal panning) or one after the other within a single gesture (such as curved, circular, or L-shaped paths). The CSS `scroll-axis-lock` property disables this heuristic directly on a native scroll container, allowing unrestricted two-dimensional panning while preserving compositor-thread scrolling, momentum physics, native scrollbars, and keyboard navigation.

## Implementation

### 1. Disable axis-locking and contain overscroll on the two-dimensional scroll container

Apply `scroll-axis-lock: none` directly to the element that establishes the two-dimensional scroll container (`overflow: auto` or `overflow: scroll`). While a 2D scroll container can already update scroll deltas along both axes under the default `auto` value, `auto` allows the browser's railing heuristic to kick in when a gesture starts predominantly along one axis. Setting `scroll-axis-lock: none` prevents that railing from engaging across touchscreens, trackpads, and mouse wheels.

Pair `scroll-axis-lock: none` with `overscroll-behavior: none` (or `overscroll-behavior: contain`) on the scroll container so that reaching an edge does not chain scrolling to the parent page or trigger accidental browser overscroll navigations (such as horizontal back/forward swipe navigation or pull-to-refresh).

### 2. Preserve keyboard focusability and accessibility

Because a 2D panning surface often lacks focusable child controls (for example, a map or zoomed image), ensure keyboard users can focus the container and pan it with the Arrow keys by adding `tabindex="0"`, an appropriate `role` and accessible label, and a visible `:focus-visible` indicator.

## Example Code

```html
<!-- Make the 2D scroll container keyboard-focusable and labeled so keyboard
     users can focus the viewport and pan in all directions with Arrow keys. -->
<div class="pan-viewport" tabindex="0" role="region" aria-label="Interactive canvas">
  <div class="pan-surface">
    <!-- 2D overflowing content (map tiles, zoomed image, canvas nodes, or grid) -->
  </div>
</div>
```

```css
.pan-viewport {
  /* Example viewport dimensions; adjust to fit your layout. */
  inline-size: 100%;
  block-size: 500px;

  /* MANDATORY: Establish a scroll container that can overflow on both axes. */
  overflow: auto;

  /* MANDATORY: Prevent browser scroll axis-locking ("railing") from kicking in
     so 2D gestures never get locked to a single axis. */
  scroll-axis-lock: none;

  /* Contain scrolling and prevent accidental swipe navigations at edges
     (use `none` or `contain`). */
  overscroll-behavior: none;
}

/* Provide a clear focus indicator when keyboard users focus the viewport. */
.pan-viewport:focus-visible {
  outline: 3px solid #005fcc;
  outline-offset: 2px;
}

.pan-surface {
  /* Example surface dimensions larger than .pan-viewport in both axes. */
  inline-size: 3000px;
  block-size: 3000px;
}
```

## Best Practices & Constraints

- **Apply it to the scroll container itself, not an ancestor wrapper**: `scroll-axis-lock` is not inherited, so setting it on a wrapper has no effect on descendant scroll containers.
- **Contain overscroll and prevent accidental navigations**: Add `overscroll-behavior: none` or `overscroll-behavior: contain` to the 2D scroll container so panning into a boundary does not chain to the parent page or trigger browser back/forward swipe navigation and pull-to-refresh gestures.
- **Nested one-dimensional panels keep railing automatically**: Because `scroll-axis-lock` does not inherit, a sidebar or inspector panel nested inside `.pan-viewport` retains the default `scroll-axis-lock: auto` behavior.
- **Keep `auto` on standard vertical feeds, articles, and one-dimensional lists**: Axis-locking prevents unintentional perpendicular drift in unidirectional content.
- **Do not set `touch-action` unconditionally**: `touch-action` controls whether the browser handles touch gestures at all (and has no effect on trackpad or wheel input), so restricting it disables native compositor touch scrolling. Only apply it inside `@supports not (scroll-axis-lock: none)` when implementing the JavaScript pointer fallback, and use `touch-action: pinch-zoom` rather than `none`, so users can still pinch-zoom (WCAG 1.4.4 Resize Text).
- **Pan with `scrollLeft` / `scrollTop`, never CSS `transform`**: Translating the surface with `transform` stops the element from functioning as a scroll container—breaking native scrollbars, boundary clamping, keyboard Arrow-key scrolling, `scroll` events, `IntersectionObserver`, and scroll-driven animations.

## Fallback strategies

Browser support for scroll-axis-lock: Limited availability.
Supported by: Chrome 153 (Sep 2026).
Unsupported in: Edge, Firefox, and Safari.

Choose between **progressive enhancement** and a **JavaScript fallback** based on your application's requirements:

### Option 1: Progressive Enhancement (No JavaScript)

Use progressive enhancement when preserving native compositor-thread touch scrolling and inertial fling momentum is more important than eliminating axis-locking in unsupported browsers:

- **Supporting browsers**: The browser prevents its axis-locking ("railing") heuristic from kicking in on the 2D scroll container during scroll gestures.
- **Unsupported browsers**: Browsers that do not recognize `scroll-axis-lock: none` safely ignore the declaration and keep their default `auto` 2D scrolling behavior—scrolling across both axes natively, while still railing gestures that begin predominantly along a single axis.

### Option 2: JavaScript Fallback (`wheel` + `pointermove` with `scrollLeft`/`scrollTop`)

If unrestricted two-dimensional panning across all browsers is required, use `@supports not (scroll-axis-lock: none)` and `CSS.supports('scroll-axis-lock', 'none')` to conditionally intercept `wheel` and pointer drag gestures.

Because `wheel` (`e.deltaX`, `e.deltaY`) and `pointermove` (`e.clientX`, `e.clientY`) expose raw, unlocked 2D deltas before the browser's scrolling engine applies axis-locking, you can apply those deltas directly to `scrollLeft` and `scrollTop`:

- **Why `scrollLeft`/`scrollTop` instead of CSS `transform`**: Updating `scrollLeft` and `scrollTop` keeps the element as a true scroll container. The browser automatically clamps scroll positions to `[0, scrollWidth - clientWidth]` and `[0, scrollHeight - clientHeight]`, native scrollbars stay synchronized, keyboard Arrow-key scrolling continues to work, and `scroll` events and `IntersectionObserver` fire normally.
- **Trade-offs**: Intercepting `wheel` with `{ passive: false }` moves scrolling onto the main thread, and setting `touch-action: pinch-zoom` on touchscreens hands panning to the script, which loses native inertial fling momentum after `pointerup`. `pinch-zoom` keeps pinch-to-zoom working, which `touch-action: none` would also disable.

```css
/* Only disable native touch panning when scroll-axis-lock is unsupported
   and the JavaScript pointer fallback below is active. pinch-zoom keeps
   pinch-to-zoom working. */
@supports not (scroll-axis-lock: none) {
  .pan-viewport {
    touch-action: pinch-zoom;
  }
}
```

```javascript
// Only attach the main-thread gesture fallback when native support is missing
if (!CSS.supports('scroll-axis-lock', 'none')) {
  const viewport = document.querySelector('.pan-viewport');
  let lastPointer = null;

  // 1. Trackpad and mouse wheel fallback
  viewport.addEventListener(
    'wheel',
    (e) => {
      if (e.ctrlKey) return; // Ctrl+wheel and trackpad pinch zoom the page
      e.preventDefault();
      viewport.scrollLeft += e.deltaX;
      viewport.scrollTop += e.deltaY;
    },
    { passive: false },
  );

  // 2. Touch and pointer drag fallback
  viewport.addEventListener('pointerdown', (e) => {
    // Ignore non-primary buttons and clicks on native scrollbars
    const rect = viewport.getBoundingClientRect();
    if (
      !e.isPrimary ||
      e.button !== 0 ||
      e.clientX - rect.left - viewport.clientLeft >= viewport.clientWidth ||
      e.clientY - rect.top - viewport.clientTop >= viewport.clientHeight
    ) {
      return;
    }
    lastPointer = { x: e.clientX, y: e.clientY };
    viewport.setPointerCapture(e.pointerId);
  });

  viewport.addEventListener('pointermove', (e) => {
    if (!lastPointer) return;
    viewport.scrollLeft -= e.clientX - lastPointer.x;
    viewport.scrollTop -= e.clientY - lastPointer.y;
    lastPointer = { x: e.clientX, y: e.clientY };
  });

  const endPointerPan = () => {
    lastPointer = null;
  };
  viewport.addEventListener('pointerup', endPointerPan);
  viewport.addEventListener('pointercancel', endPointerPan);
}
```
