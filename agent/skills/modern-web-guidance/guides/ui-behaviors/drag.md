# Build a Draggable Element

Add dragging to an existing floating element such as a panel, palette, toolbar, inspector, or dialog. Dragging does not determine how the element is displayed, dismissed, stacked, or focused.

## Use a dedicated handle

Start dragging from a dedicated handle when the element contains selectable text, buttons, inputs, or links. This keeps its normal contents usable. Make the handle focusable for keyboard movement and give it an accessible name that mentions the arrow-key interaction. Ensure the handle exposes a `button` role so that the accessible name is conveyed to screen reader users.

Apply `cursor: grab`/`grabbing`, `touch-action: none`, and both `user-select: none` and `-webkit-user-select: none` to the handle—not the entire draggable element—so text outside it remains selectable and touch gestures retain their usual behavior:

```css
.drag-handle {
  cursor: grab;
  touch-action: none;
  -webkit-user-select: none;
  user-select: none;
}

.drag-handle.dragging {
  cursor: grabbing;
}
```

## Preserve pointer position and reachability

Use a viewport-relative positioning model such as `position: fixed` when clamping movement to the viewport.

- Start a drag only for the primary pointer button (`event.button === 0`).
- Record the pointer offset on `pointerdown` and use it on every move so the element does not jump when grabbed away from its corner.
- Keep the drag active after the pointer leaves the handle. Default to `setPointerCapture()` and clear the dragging state on `lostpointercapture`. If the handle may be removed or re-rendered mid-drag, use document-level `pointermove`, `pointerup`, and `pointercancel` listeners instead, since capture is lost in that case.
- Optionally, wait for roughly 4px of movement before entering the dragging state, so a click on the handle does not trigger drag styling.

With pointer capture, the movement listeners can remain on the handle:

```js
handle.addEventListener('pointerdown', (event) => {
  const control = event.target.closest('button, input, select, textarea, a');
  if (event.button !== 0 || (control && control !== handle)) return;

  const rect = draggable.getBoundingClientRect();
  offsetX = event.clientX - rect.left;
  offsetY = event.clientY - rect.top;
  handle.setPointerCapture(event.pointerId);
});

handle.addEventListener('pointermove', (event) => {
  if (!handle.hasPointerCapture(event.pointerId)) return;
  handle.classList.add('dragging');
  moveTo(event.clientX - offsetX, event.clientY - offsetY);
});

handle.addEventListener('lostpointercapture', () => {
  handle.classList.remove('dragging');
});

function moveTo(left, top) {
  const maxLeft = Math.max(0, window.innerWidth - draggable.offsetWidth);
  const maxTop = Math.max(0, window.innerHeight - draggable.offsetHeight);

  draggable.style.left = `${Math.max(0, Math.min(left, maxLeft))}px`;
  draggable.style.top = `${Math.max(0, Math.min(top, maxTop))}px`;
}
```

Clamp every pointer and keyboard position through the same helper so the element stays reachable. Re-clamp its current position after viewport or element-size changes. For layout-heavy elements, consider translating during the drag to avoid per-frame layout, then commit the final position to `left` and `top` on release.

## Provide keyboard movement

When the handle has focus, move the element with the arrow keys and call `preventDefault()` for those keys. Use the same clamped positioning helper as pointer movement. A 15px increment is a reasonable starting point; adapt it to the component's size and precision needs.

## Dialog-specific note

A `<dialog>` or `[popover]` can use this mechanism with its header in addition to a separate drag handle. Set `margin: 0` before assigning `left` and `top`, because the browser's default margins interfere with manual positioning. For dialog and popover opening, closing, focus, and dismissal behavior, see `declarative-dialog-popover-control` (via `npx -y modern-web-guidance@latest retrieve "declarative-dialog-popover-control"`) and `platform-controls-dismiss-dialog` (via `npx -y modern-web-guidance@latest retrieve "platform-controls-dismiss-dialog"`).

## Accessibility requirements

The drag handle that is exposed to assistive technologies must be a dedicated button, rather than just scripting the header of a dialog to be draggable. This will ensure the button is exposed to screen reader users with an appropriate role and accessible name. For example, using a native button element:

```html
<button type="button" aria-label="Notes panel handle. Use arrow keys to move.">
  <!-- handle icon -->
</button>
```

Ensure the draggable element can also be moved or operated using a single pointer without dragging (for example, clicks or taps). What the UI for this looks like depends on the use case. A few examples:
- Kanban boards: a "move to column" menu or buttons
- Maps: directional pan buttons
- Sliders: clicking on the track, and sometimes adjusting the value via a linked `<input>`
- Floating panels and dialogs: a grid in the background where clicking on a cell in the grid moves the element to the new position or their drag handle may be a menu button, with menu items to reposition the element ("Dock left", "Move left", "Dock top", "Move up", "Dock right", "Move right", "Dock bottom", and "Move down")

Provide feedback for screen reader users when the draggable element is moved. Use a visibly hidden live region, so that any updates to the region are announced to screen reader users. Ensure the region is included on page load, so that it is registered.

```html
<div class="visually-hidden" aria-live="polite"></div>
```

Update the region when the draggable element is moved:

```html
<div class="visually-hidden" aria-live="polite">
  [Name of element] moved [new position]
</div>
```

Do not display raw coordinates for the position, prefer a descriptive name (e.g. "docked left", "moved left", "moved up", and so on) or omit it if there is no meaningful description.
The message can be removed after a second, as it will be announced and no longer relevant.

As the keyboard interaction may not be obvious for some users, provide a help button in the draggable element that reveals the keystrokes to perform the operation.

## Fallback strategies

When dragging only repositions a component, treat it as progressive enhancement: without JavaScript, keep the element, its content, and its controls visible, readable, and functional in a sensible default position. Do not expose a non-functional drag handle: if the handle is a standalone grip control, hide it by default and reveal it when JavaScript initializes; if a header doubles as the handle, attach its drag affordances when JavaScript initializes.

Browser support for user-select: Limited availability.
Supported by: Chrome 54 (Oct 2016), Edge 79 (Jan 2020), and Firefox 69 (Sep 2019).
Unsupported in: Safari.

Include `-webkit-user-select: none` before `user-select: none` so text selection stays suppressed during dragging in Safari.
