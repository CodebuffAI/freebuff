# Context Menu

A context menu provides quick access to actions related to a specific item or region. In a list of items, they are triggered by a single button. They can also be a secondary interaction, triggered by right-clicking or (in some cases) long-pressing, and allow the primary click or touch action to remain dedicated to tasks like selection, navigation, or drag-and-drop.

- **Right-click + Visible Menu Button (Recommended):** Needed when the menu is the primary way to reach those actions on the current view, and supports touch, keyboard, and discoverability.
- **Visible Menu Button Only:** Use if Right-click behavior is not needed.

A Right-click Only option is only accessible when the item can first be selected, and then the same actions are accessible elsewhere (e.g., in a persistent toolbar).

## Implementation

### 1. Shared foundation

Follow the `menu` (via `npx -y modern-web-guidance@latest retrieve "menu"`) guide to create the content of the context menu in a popover.

A context menu should not be reused across multiple items, and each must have a unique ID.

```html
<!-- The menu container -->
<div popover id="context-menu">
  <div focusgroup="menu nomemory" aria-label="Context Menu">
    <button type="button">Edit</button>
    <button type="button">Share</button>
    <button type="button">Delete</button>
  </div>
</div>
```

Use CSS Anchor Positioning to align the popover to its anchor while also preventing the popover from overflowing.

```css
/* Position the popover relative to its anchor */
[popover] {
  margin: 0;
  inset: auto;
  /* Use position-area to align the menu relative to the anchor */
  position-area: block-end span-inline-end;
  position-try: flip-inline, flip-block, flip-start;
}
```

### 2. Method A: Right-Click Trigger (Cursor-Anchored)

To position the menu exactly at the cursor, use an invisible anchor element placed with JavaScript when the user right-clicks. On some platforms (though notably not iOS Safari) this may also be triggered with a long press, but that is not a universal behavior. Put this element inside the element that triggers the context menu, immediately before the visible button.

```html
<span class="menu-anchor"></span>
```

```css
/* An invisible anchor that follows the cursor */
.menu-anchor {
  position: fixed;
  inline-size: 0;
  block-size: 0;
}
```

Listen for the `contextmenu` event to prevent the browser's default menu, and use `pointerup` to capture the coordinates and open the popover. Move the focus to the first enabled button.

```js
const card = document.querySelector('.card');
const menuAnchor = card.querySelector('.menu-anchor');
const popover = card.querySelector('#context-menu');

function openContextMenu(e) {
  const x = e.clientX;
  const y = e.clientY;

  // Move the anchor element to the cursor position
  // Use physical rather than logical to match clientX/clientY.
  menuAnchor.style.left = `${x}px`;
  menuAnchor.style.top = `${y}px`;

  // Open the popover and associate it with the anchor source.
  // MANDATORY: Use showPopover({source}) to establish the implicit anchor.
  popover.showPopover({ source: menuAnchor });
  // In the popover's `toggle` event, check for popover in `enterOnOpen`, and move focus to the first button.
  enterOnOpen.add(popover);
}

card.addEventListener('contextmenu', (e) => {
  // Prevent the browser's default context menu
  e.preventDefault();
});

card.addEventListener('pointerup', (e) => {
  // button 2 = right mouse click
  if (!(e.button === 2 || e.ctrlKey)) return;
  openContextMenu(e);
});
```

### 3. Method B: Visible Menu Button (Element-Anchored)

For touch users or general discovery, add a visible button that toggles the same popover. Use the `command` and `commandfor` attributes for a declarative approach. Place the popover element immediately after this `<button>`. 

The button must be a minimum size of 24 by 24 CSS pixels if it is positioned directly on top of interactive content. If the button is not positioned on top of interactive content, there must not be any interactive elements within a 12 pixel radius, and this must not intersect the 24 CSS pixel diameter circle of other undersized targets.

For optimal discoverability, especially for people who use voice control software or have cognitive disabilities, keep the button always visible. Avoid patterns like only showing the button on hover or focus.

```html
<button type="button" 
  command="toggle-popover" 
  commandfor="context-menu"
  aria-haspopup="menu" aria-expanded="false"
  aria-label="Actions for item 1">
  <!-- Visual trigger (e.g. three dots icon) -->
</button>
```

The `command` attribute sets the popover's implicit anchor position, in the same way as the source in `showPopover({source})`. It can be used as an anchor without setting an `anchor-name` or `position-anchor`. In a list of items, include the item's name in the button's `aria-label` so each trigger and `aria-labelledby` menu has a distinct accessible name. Keep the value of `aria-expanded` in sync with the popover's state.

### 4. Differentiating between methods

To differentiate between the source, for instance to adjust the positioning, check `event.source` in the popover's `beforetoggle` event, and set an attribute that can be used for styling.

```js
popover.addEventListener('beforetoggle', (event)=>{
  if (event.newState === "open") {
    popover.setAttribute("source", event.source?.tagName ?? "");
  }
});
```

```css
[popover][source="button" i]{
  position-area: block-end span-inline-start;
}
```

## Fallbacks

### Fallbacks & browser support for Popover

Baseline status for Popover: Newly available. It's been Baseline since 2025-01-27.
Supported by: Chrome 116 (Aug 2023), Edge 116 (Aug 2023), Firefox 125 (Apr 2024), Safari 17 (Sep 2023), and Safari iOS 18.3 (Jan 2025).

The Popover API is mostly **progressive enhancement**, but its defining behaviors — top-layer promotion, light-dismiss, and `popovertarget` invocation — have no CSS-only equivalent. Older browsers need a polyfill, or a manual fallback if you would rather not ship one.

**Polyfill:** To support the `popover` attribute in older browsers, conditionally load [`@oddbird/popover-polyfill`](https://github.com/oddbird/popover-polyfill). **MANDATORY:** Feature detect by checking for the `popover` property on `HTMLElement.prototype`, and load the polyfill **only** when native support is missing — do NOT load it unconditionally.

With a bundler or import map:

```js
// MANDATORY: Feature detect 'popover' on HTMLElement.prototype.
if (!Object.hasOwn(HTMLElement.prototype, "popover")) {
  import("@oddbird/popover-polyfill");
}
```

If not using a package manager, import from a CDN, e.g. `"https://unpkg.com/@oddbird/popover-polyfill@latest/dist/popover.min.js"`.

Caveats when using the polyfill:
- Do NOT use the `popover` IDL attribute for any code that may run before the polyfill is fully loaded. It will not be mirrored as an attribute, the popover will not be picked up by the polyfill, and the property will be shadowing the accessor the polyfill adds forever. Use `setAttribute()`/`removeAttribute()` instead.
- **Styling caveat:** The polyfill cannot define the real `:popover-open` pseudo-class, so it applies a `.\:popover-open` class instead. **MANDATORY:** Combine the two with `:is()` or `:where()`, otherwise browsers that lack `:popover-open` discard the entire rule:

```css
[popover]:is(:popover-open, .\:popover-open) {
  display: block;
}
```

To prevent popovers from showing before the polyfill loads, hide them with CSS:

```css
@supports not selector(:popover-open) {
  [popover]:not(.\:popover-open) {
    display: none;
  }
}
```

### Fallback for Invoker Commands

Baseline status for Invoker commands: Newly available. It's been Baseline since 2025-12-12.
Supported by: Chrome 135 (Apr 2025), Edge 135 (Apr 2025), Firefox 144 (Oct 2025), and Safari 26.2 (Dec 2025).

If your Baseline target does not support Invoker Commands, use `popovertarget`.

```html
<button type="button" 
  popovertarget="context-menu"
  aria-haspopup="menu" aria-expanded="false"
  aria-label="Actions for item">
  <!-- Visual trigger (e.g. three dots icon) -->
</button>
```

### Fallback for Anchor Positioning and ToggleEvent source

Browser support for Anchor positioning: Limited availability.
Supported by: Chrome 157 (Nov 2026), Edge 157 (Nov 2026), and Safari 27 (Sep 2026).
Unsupported in: Firefox.

If your Baseline target does not support CSS Anchor Positioning, you must manually calculate the `inset` coordinates of the popover in JavaScript. When triggered with a right click, set the insets in `openContextMenu` to the click position. When triggered by a button click, set the insets to the bottom edge of the button. This allows you to differentiate placement based on the trigger, but note that this does not handle overflow. 

```js
const openContextMenu = (event) => {
  const x = event.clientX;
  const y = event.clientY;
  if(CSS.supports("anchor-name: --a") ){
    anchor.style.left = `${x}px`;
    anchor.style.top = `${y}px`;
  } else {
    popover.style.removeProperty('right');
    popover.style.left = `${x}px`;
    popover.style.top = `${y}px`;
  }

  enterOnOpen.add(popover);
  popover.showPopover({ source: anchor });
};

buttonTrigger.addEventListener("click", (event) => {
  const menu = menuFor(buttonTrigger);
  if (!menu) return;
  // Position the dropdown when anchor positioning is not supported.
  if(!CSS.supports("anchor-name: --a")){
    const {right, width, bottom: y} = event.target.getBoundingClientRect();
    const x = document.body.clientWidth - right;
    menu.style.removeProperty('left');
    menu.style.right = `${x}px`;
    menu.style.top = `${y}px`;
  }
});
```

Baseline status for ToggleEvent source: Newly available. It's been Baseline since 2026-05-11.
Supported by: Chrome 140 (Sep 2025), Edge 140 (Sep 2025), Firefox 145 (Nov 2025), and Safari 26.5 (May 2026).

To differentiate the position based on trigger when `ToggleEvent` source is not available, but anchor positioning is, set the `position-area` in each of the triggers.

```js
const openContextMenu = (event) => {
  const x = event.clientX;
  const y = event.clientY;
  if(CSS.supports("anchor-name: --a") ){
    anchor.style.left = `${x}px`;
    anchor.style.top = `${y}px`;
    if(!'source' in ToggleEvent.prototype){
      popover.style.setAttribute('position-area', 'block-end span-inline-end')
    }
  } 
  // ...
};

buttonTrigger.addEventListener("click", (event) => {
  const menu = menuFor(buttonTrigger);
  if (!menu) return;
  if(!'source' in ToggleEvent.prototype){
    menu.style.setAttribute('position-area', 'block-end span-inline-start')
  }
  // ...
});
```

### Fallbacks & browser support for focusgroup

Browser support for focusgroup: Limited availability.
Supported by: Chrome 150 (Jun 2026) and Edge 150 (Jul 2026).
Unsupported in: Firefox and Safari.

Load `@microsoft/focusgroup-polyfill` only when native support is missing:

```js
if (!(Object.hasOwn(HTMLElement.prototype, 'focusGroup'))) {
  const { polyfill } = await import('@microsoft/focusgroup-polyfill');
  polyfill();
}
```

- Use the `focusgroup` and `focusgroupstart` attributes, not the `focusGroup` property, which the polyfill does not add.
- The polyfill does not notice items hidden or shown later: add `focusgroup="none"` to an item while it is hidden.