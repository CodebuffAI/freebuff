# Rearrange Items with Drag and Drop

Add reordering to an existing list or row, vertical or horizontal. Reorder the real children in the DOM (not via CSS `order` or `flex-direction: *-reverse`) so visual, keyboard, and reading order stay aligned. For free-form 2D repositioning of a floating element such as a dialog or toolbar, see `drag` (via `npx -y modern-web-guidance@latest retrieve "drag"`). This guide covers one axis at a time; it does not cover reordering a grid or wrapped layout, or moving items between lists.

When items contain interactive controls or selectable text, provide a dedicated drag handle rather than making the entire item draggable. Then set up the pointer drag:

- Start pointer drags only for the primary button, and record the initial pointer offset.
- Apply `cursor: grab`/`grabbing`, `touch-action: none`, and `user-select: none` to the handle so item text remains selectable and page scrolling works outside the handle. Scope `touch-action: none` to the handle only: it disables touch scrolling over the element, which is acceptable on a small dedicated handle (the rest of the item and the page still scroll) but would trap scrolling if applied to the whole item or list.
- Because the pointer leaves the handle as soon as the drag moves, `:active` on the handle isn't enough to keep the grabbing cursor. Toggle a class on the root element for the length of the drag (removed in the drag-end cleanup) and set `cursor: grabbing` on it and its descendants.

## Keep movement active while reordering

Keep the drag active and find the destination reliably:

- **Capture the pointer.** Keep the drag active after the pointer leaves the handle with `handle.setPointerCapture(event.pointerId)` on `pointerdown`, and clean up on `lostpointercapture` unless capture was deliberately re-established after a `before()` move (see the `moveBefore()` section).
- **Follow one pointer.** Remember the `pointerId` that started the drag and ignore `pointerdown`, `pointermove`, `pointerup`, and `pointercancel` from any other pointer, so an accidental second touch (such as the thumb holding a phone) can't start a competing drag or end the active one.
- **Let `Escape` cancel.** On `Escape`, record the item's current rect, clear its drag `translate` without moving it in the DOM, scroll the item's slot back into view if the container scrolled, animate it back from the recorded rect, and announce the cancellation.
- **Find the destination from layout, not `event.target`.** Pointer capture redirects `pointermove` `event.target` to the capturing handle. Clamp the pointer to the container's bounds on the list's axis and compare it with each sibling's layout midpoint. For a vertical list use `offsetTop + offsetHeight / 2`, with `position: relative` on the container and its `clientTop` and `scrollTop` accounted for. The drop spot is before the first sibling whose midpoint is below the pointer, or at the end if none is. For a horizontal row use `offsetLeft + offsetWidth / 2` with `clientLeft` and `scrollLeft`: `offsetLeft` and `scrollLeft` share one coordinate space in both reading directions (`scrollLeft` is negative once a right-to-left row is scrolled), so the same sum works for either. In a right-to-left row the DOM order runs right to left, so insert before the first sibling whose midpoint the pointer is already past, rather than the first one it has not reached.
- **Why layout midpoints.** Layout positions ignore in-flight `translate` animations and padding gaps, so a pointer past either edge reliably resolves to the first or last place. `document.elementFromPoint()` hit-tests painted positions and can miss items while siblings are animating. Use `document.elementFromPoint(event.clientX, event.clientY)` only when the destination is one of several containers (such as board columns).

When an item gets dragged, communicate where it will be dropped. This can be done by reserving space, showing an explicit drop marker, or showing a clone at the target position. When using a drop marker, consider collapsing the source slot so the marker alone signals the destination. Avoid combining a marker with a leftover gap that suggests a second drop target.

Don't reorder while the pointer moves: shifting siblings feel jittery. Keep the source item in its slot and show a drop marker. This is the default for a single-axis list:

- **Render a marker, not a shift.** Set `data-drop` on the list during a drag and draw the marker with its `::before` (ring) and `::after` (line), both `position: fixed; pointer-events: none`. Don't append an element to `<body>`.
- **Place it in the gap.** On every drop-spot update and scroll step, set `--drop-x`, `--drop-y`, `--drop-w` and `--drop-h` from the neighbors' `getBoundingClientRect()`, centering the line in the gap between the previous and next item (on the inline axis, flipped in right-to-left, for rows). Don't use CSS anchor positioning (it drifts while autoscrolling), and keep `transform`, `filter` and `contain` off the list and its ancestors.
- **Skip no-op drops.** Show no marker when the drop spot is the item's own slot. Remove `data-drop` and the custom properties when the drag ends.
- **Make it themeable.** Drive color, line size, ring size, gap, lifted-item opacity and shadow from custom properties (such as `--drop-marker-color`) with defaults that suit the host design system, and use `Highlight` under `forced-colors: active`.
- **Move once on release.** On `pointerup`, if the drop spot differs from the item's current next sibling, move the existing item node atomically with `container.moveBefore(item, referenceNode)` rather than recreating it, so internal state (such as focused controls, input values, scroll position, media, or custom element instances) and active pointer capture are preserved. Keyboard moves use the same call on each step. Then animate the move:

- **Animate every move.** Items should visibly travel instead of jumping, including the move on release and keyboard moves. Record each sibling's `getBoundingClientRect()` before the move, then afterwards animate the `translate` property from the old offset (on both axes, correcting for any scroll that happened) to `0 0` (FLIP).
- **Animate the release.** When the pointer is released, animate the item from its released position to its final rect (FLIP), measured after finishing the item's in-flight animations (`item.getAnimations().forEach((animation) => animation.finish())`) because otherwise the rect includes the animation's offset. Keep it raised until the animation finishes.
- **Respect reduced motion.** Skip the animations under `prefers-reduced-motion: reduce`.
- **Lift the real item; don't clone it.** Keep the dragged item in the DOM and in its layout slot, and follow the pointer with a `translate` (add the list's scroll change since the grab so auto-scroll keeps it under the pointer). Give it `position: relative`, a raised `z-index`, a slight `scale`, a shadow, and `pointer-events: none`. Its empty slot shows where it was picked up from. A clone duplicates IDs, loses state, breaks descendant selectors, framework bindings, and `idref`s, and ends up as invalid markup when appended outside the list. On release, animate the item from its dragged position to its new spot.
- **Handle a quick re-grab.** Don't clear the item's drag state from a finished animation's callback if a new drag of that item has already started.

## Scroll while dragging

If the items live in a scrollable container, scroll it while the pointer is near or beyond its start or end edge on the list's axis (top and bottom, or left and right for a row, using `scrollTop` or `scrollLeft`), so off-screen items stay reachable (especially on small viewports). Run a `requestAnimationFrame` loop for the duration of the drag that scales scroll speed with how far the pointer is into an edge zone (the dragged item's size on the list axis, capped at a third of the container's size so the two zones never overlap), continuing to increase beyond the edge up to a cap, and uses frame time rather than a fixed step. After each scroll change, re-run drop-spot detection with the last pointer position, clamped into the container's bounds, because the pointer hasn't moved. Avoid `scroll-behavior: smooth` on that container. Give it space on every side so focus rings and elevation shadows aren't clipped: the space must cover the focus ring's outline width and offset plus the grabbed item's scale growth (about 1rem for a 3px outline, 2px offset, and `scale(1.02)`), and `overflow-y: auto` also clips on the x axis. Put the end space (bottom, or inline-end for a row) on the last item's margin rather than the container's padding, because some engines omit a grid or flex container's end padding from its scrollable overflow. Cancel the loop when the drag ends.

## Support keyboard reordering

Provide a keyboard-accessible alternative to pointer reordering. Choose an interaction that fits how frequently users reorder items and how easily they need to discover it:

- **Visible movement controls or an actions menu**: Best default for discoverability and screen-reader compatibility, because activating standard buttons works in screen-reader browse modes without intercepting arrow keys. Use an actions menu when persistent inline buttons add too much visual clutter.
- **Direct arrow keys (or modifier + arrow keys, such as `Alt` + arrow keys) on a focusable handle or item**: Suits frequent reordering with minimal UI chrome. Give the handle an accessible name that identifies both the item and the reorder action, and note that screen-reader browse modes may intercept bare arrow keys on a `<button>` handle unless paired with explicit movement controls or modifier keys.
- **Grab–move–drop mode (`Space` or `Enter` to pick up, arrow keys to move along the list's axis, `Space` or `Enter` to drop, `Escape` to cancel)**: Arrow keys do nothing until the item is grabbed, which keeps them from conflicting with screen-reader navigation. Toggle `aria-pressed` on the handle, announce the grabbed state and available keys on pickup, restore the item to its original DOM position on `Escape`, and drop when the handle itself loses focus (not only when focus leaves the whole list, since the next stop is often another control in the same item), ignoring any blur caused by the move itself.

The keys follow the list's axis: `ArrowUp` and `ArrowDown` for a vertical list, `ArrowLeft` and `ArrowRight` for a row. Arrow keys follow the visual direction, so in a right-to-left row `ArrowLeft` moves the item later in the DOM and `ArrowRight` earlier. Ignore the other axis's keys, use matching direction labels and icons on any move buttons, and name the direction in the announcement.

For any approach, announce the item and its new position in a polite live region, resetting its text and delaying the update briefly (see the `moveBefore()` fallback below) so moves that refocus the handle are still announced. Announce only when the position actually changed (not for a click or a drop in place), while still announcing a cancellation. Show focus and the grabbed state on the item being moved, not just the handle:

- **Keep the item in view.** After each keyboard move (including `Escape` restoring the original position) and each pointer drop, call `item.scrollIntoView({ block: 'nearest', inline: 'nearest' })` after the move but before starting the animation, because an in-flight `translate` skews the position it scrolls to. Restore focus afterwards with `focus({ preventScroll: true })` so the browser doesn't scroll again, and give items a `scroll-margin` matching the space around them in the container.
- **Reveal the whole item on keyboard focus.** The browser otherwise scrolls only the focused handle into view and leaves the rest of the item and its focus ring clipped. When keyboard focus enters an item (for example with `Tab`), scroll the item the same way (`block` and `inline` both `'nearest'`) from a `focusin` handler that checks `:focus-visible` and skips items with running animations.
- **Draw the focus ring on the item** with `.item:has(.handle:focus-visible)`. For grab–move–drop handles, show a visible key hint on the focused item (an `aria-hidden="true"` element in the item reading "Space to reorder", switching to "Arrows to move · Space to drop · Esc to cancel" while grabbed—keep instructional text in the DOM rather than CSS `content` so it stays translatable), and fade the handle slightly at rest so reordering reads as available. Also apply the handle's hover style on `:focus-visible` (`.handle:is(:hover, :focus-visible)`) so sighted keyboard users see the handle is activatable; use a fill rather than an outline so it doesn't read as a second focus ring, and give the grabbed (`aria-pressed`) state its own pressed look.
- **Elevate the grabbed item** with full opacity, a slight `scale()`, and `box-shadow`. Avoid rotation, especially when movement is on one axis.
- **Keep the layout shrinkable.** Make each row's flexible column shrinkable (`minmax(0, 1fr)` with form controls at `width: 100%`) so the movement controls stay visible on narrow viewports without horizontal scrolling.

### Align reading order with visual layout

Keep the DOM and keyboard focus order understandable in relation to the visual layout. If reordering is provided through separate controls, ensure the item's context is available before or alongside those controls. If the drag handle is focusable, give it an accessible name that identifies the item and its reordering function. Position controls to suit the layout and writing direction without making the resulting reading or focus order confusing.

For complex layouts where visual and DOM order cannot naturally align, use the **`reading-flow`** CSS property inside grid/flex containers to instruct the browser's tab order to follow visual coordinates rather than DOM source order:
```css
.task {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto; /* minmax(0, ...) lets the middle column shrink at narrow widths */
  reading-flow: grid-rows; /* Follows visual layout and tab order by row */
}
```

### Disable boundaries and safeguard focus
Keep moves within valid destinations. If items can move between containers, make those destinations available to keyboard users too. At the boundary of a container, prevent further movement only when there is no valid destination in that direction.

After moving an item, keep focus on its handle. If the implementation uses separate movement buttons instead, keep focus on the activated button or shift it to the alternative movement control on the same item when the activated control becomes disabled.

## Decide on fallback behavior

When reordering is supplementary, keep the collection readable and usable in its default DOM order without JavaScript. If the order represents user-controlled data or directly affects behavior—for example, task priority, playlist order, or workflow sequence—treat reordering as essential and provide the required pointer and keyboard interactions rather than presenting the static order as equivalent behavior.

## Browser support and fallback strategies

### `moveBefore()`

Browser support for moveBefore(): Limited availability.
Supported by: Chrome 133 (Feb 2025), Edge 133 (Feb 2025), and Firefox 144 (Oct 2025).
Unsupported in: Safari.

If your Baseline target does not support `moveBefore()`, feature-detect with `'moveBefore' in Element.prototype` and fall back to `referenceNode.before(item)` (or `container.append(item)` when there is no reference node) with the existing item node. Because `before()` removes and reinserts the node, it has two side effects to handle:

- **It drops active pointer capture.** Keep the `pointermove`, `pointerup`, and `pointercancel` listeners on `document`, where captured events still bubble. After the move, re-call `handle.setPointerCapture(event.pointerId)` when `hasPointerCapture()` is false, and end the drag on `lostpointercapture` only if capture is not re-established.
- **It blurs focused descendants.** Explicitly call `.focus()` on the active handle or movement button after moving. Also delay the live-region update by about 500 ms (debounced, clearing the previous message first), because the focus re-announcement otherwise swallows the position announcement in screen readers such as VoiceOver in Safari.

### `reading-flow`

Browser support for reading-flow: Limited availability.
Supported by: Chrome 137 (May 2025) and Edge 137 (May 2025).
Unsupported in: Firefox and Safari.

In browsers that do not support `reading-flow`, sequential focus navigation follows DOM source order. Structure each item's DOM order so interactive controls appear in a logical reading and tab sequence without relying on CSS visual reordering.

### `user-select`

Browser support for user-select: Limited availability.
Supported by: Chrome 54 (Oct 2016), Edge 79 (Jan 2020), and Firefox 69 (Sep 2019).
Unsupported in: Safari.

Include `-webkit-user-select: none` before `user-select: none` on the drag handle so text selection stays suppressed during dragging in Safari.
