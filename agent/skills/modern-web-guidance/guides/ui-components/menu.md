# Build a popup menu

This guide covers one popup menu: a list of commands or links that users move through with arrow keys. What opens it does not matter: a button (an "Actions" or overflow button), an item in another menu (a submenu), or no visible trigger at all (a context menu).

Several triggers on one page are independent menus unless you build a bar: each is its own `Tab` stop, and nothing links them. A row of menus that act as one widget (File, Edit, View: one `Tab` stop, `ArrowLeft`/`ArrowRight` between them, hover switching) is an application menu bar. Build each menu as described here, then see `app-menus` (via `npx -y modern-web-guidance@latest retrieve "app-menus"`) for what links them.

## Commands, links, and what makes a menu

Two independent choices. Everything else here applies to both.

* **Element, per item.** A command is a `<button type="button">`; a destination is an `<a href>` that still opens in a new tab, copies as a URL, and works without script. A menu may mix them freely: two links and six commands, or one command and six links, changes nothing below.
* **Interaction model, per menu.** Arrow keys, `Home`/`End`, and `Esc` make it a menu: add the focusgroup, let it infer `menuitem` on every item whether button or link, and make it look like one (a trigger with a dropdown indicator, or a continuous bar for an application menu bar). A short list of links users `Tab` through is navigation: no focusgroup, no `role="menu"`, `role="menuitem"`, or `aria-haspopup="menu"`; keep the popover, `Esc`, and focus restoration. For navigation, see `navbar` (via `npx -y modern-web-guidance@latest retrieve "navbar"`).

Content never decides the roles. A "Products" dropdown of links can be a menu; an "Account" dropdown of commands cannot be navigation.

Use the menu pattern only for a composite widget with one tab stop and arrow-key navigation. Use a `<div focusgroup="menu nomemory">`, not the HTML `<menu>` element. Do not add `role="menu"` or `role="menuitem"` in the shared markup: native focusgroup infers those roles, and explicit roles block that inference. Add them only in the unsupported-browser fallback below. `nomemory` makes reopening start at the first item. Focusgroup moves focus; script handles activation, submenu preview, and focus restoration.

## Open and position the menu

Make each trigger a command invoker with `commandfor` and `command="toggle-popover"`. The browser opens and closes the popover on click, Enter, and Space, and keeps the trigger inside its popover's light-dismiss group, so clicking an open trigger closes it. Do not use `popovertarget` or `popovertargetaction`; this pattern uses `commandfor` instead.

Place each popover immediately after its trigger. Browsers add an implicit `aria-details` relationship only when the popover is not the next sibling, so this placement avoids it without extra attributes.

A menu with no trigger button opens from script with `showPopover({ source })`. `source` sets the implicit anchor, so pass the element the menu belongs to: the right-clicked card, or the focused element when a keyboard shortcut opens it. To open at a point instead (the pointer position, or the caret for an `@`-mention picker), anchor positioning still needs an element, so use a placeholder: an empty, zero-size `position: fixed` element kept directly before the menu, moved to the point with `left` and `top` on each open, and passed as `source`. A zero-size anchor puts the menu's corner at the point, as a native context menu does, and the flip fallbacks below still apply. Name the menu with `aria-label` instead of `aria-labelledby`. Everything else in this guide applies unchanged; where it says "trigger" for positioning, read the placeholder. For opening a menu from a right-click or long-press, see `context-menu` (via `npx -y modern-web-guidance@latest retrieve "context-menu"`).

```html
<!-- Command invoker: the browser toggles the popover on click, Enter, and Space -->
<button id="actions-trigger" class="trigger" type="button" aria-haspopup="menu" aria-expanded="false"
  commandfor="actions-menu" command="toggle-popover">
  Actions
</button>
<!-- Immediately after its trigger, so browsers add no implicit aria-details -->
<div id="actions-menu" popover="auto">
  <!-- Nested, not on the popover: Chromium otherwise drops focusgroup keyboard behavior -->
  <div focusgroup="menu nomemory" aria-labelledby="actions-trigger">
    <button type="button">Duplicate</button>
    <button type="button">Rename</button>
    <button id="export-trigger" type="button" aria-haspopup="menu" aria-expanded="false"
      commandfor="export-menu" command="toggle-popover">
      Export <span aria-hidden="true">›</span>
    </button>
    <!-- Submenu: popover="auto" directly after its trigger, inside the parent focusgroup -->
    <div id="export-menu" popover="auto">
      <div focusgroup="menu nomemory" aria-labelledby="export-trigger">
        <button type="button">PDF</button>
        <button type="button">Plain Text</button>
      </div>
    </div>
  </div>
</div>
```

Name each menu with `aria-labelledby` pointing at its trigger. Keep decorative submenu indicators in CSS, or add `aria-hidden="true"`. Give triggers with `aria-expanded="true"` a visible active style so users can tell which menu is open. Outside a menu bar, style each trigger as a standalone button: it is its own `Tab` stop, and the styling must say so. Anything that links triggers (`role="menubar"`, arrow keys between them, preview on focus) belongs to the application menu bar.

### Position the menu with CSS Anchor Positioning

Use CSS anchor positioning, not JavaScript coordinates. Both `command="toggle-popover"` and `showPopover({ source: trigger })` set an implicit anchor, so do not add per-menu `anchor-name` or `position-anchor` rules. Menu behavior must not depend on anchor positioning.

```css
/* Top-level menus sit below their trigger, flipping when they would overflow. The implicit anchor comes from the invoker or source. */
[popover]:has(> [focusgroup~="menu"]) {
  position-area: block-end span-inline-end;
  position-try-fallbacks: flip-block, flip-inline, flip-block flip-inline;
  inset: auto;
}

/* A popover directly inside a menu is a submenu: beside its parent item, flipping when it would overflow. */
[focusgroup~="menu"] > [popover] {
  position-area: inline-end span-block-end;
  position-try-fallbacks: flip-inline, flip-block, --below;
}

/* Last resort for narrow viewports: directly below the trigger, indented, so the submenu never
   covers its trigger. */
@position-try --below {
  position-area: block-end span-inline-end;
  margin-inline-start: 1rem;
  /* Fit the area: the submenu's minimum width must not stop this fallback from fitting. */
  min-inline-size: 0;
  max-inline-size: calc(100% - 1rem);
}
```

Keep `--below` last so it applies only when neither side fits. It opens directly under the trigger, so on a narrow screen it covers the sibling items beneath the trigger; that is the accepted trade-off for staying next to the trigger. Also let the submenu shrink to the area (`min-inline-size: 0`, `max-inline-size` minus the indent). A fallback that does not fit is skipped, and if none fit the browser keeps the base placement, so a submenu that is a few pixels too wide silently covers its trigger.

For how the flip fallbacks work on a plain popover, see `viewport-aware-dropdowns` (via `npx -y modern-web-guidance@latest retrieve "viewport-aware-dropdowns"`). That guide positions a button group, not a menu; for menus, the submenu placement and `--below` fallback above take precedence.

### Animate open and close

Optional. Under 150 ms, `opacity` and a small `translate` only, same for submenus, inside `@media (prefers-reduced-motion: no-preference)`. Focus moves on `toggle`, so the transition never delays keyboard users.

```css
@media (prefers-reduced-motion: no-preference) {
  /* Closing: this rule is in effect once :popover-open is removed. */
  [popover]:has(> [focusgroup~="menu"]) {
    opacity: 0;
    translate: 0 -.25rem;
    transition: opacity, translate, display, overlay;
    transition-duration: .15s;
    /* Separate after transition so the shorthand doesn't reset it or fail in older browsers */
    transition-behavior: allow-discrete;
  }
  /* Opening: faster. */
  [popover]:has(> [focusgroup~="menu"]):popover-open {
    opacity: 1;
    translate: 0 0;
    transition-duration: .1s;
    @starting-style { opacity: 0; translate: 0 -.25rem; }
  }
}
```

`@starting-style` is not a repeat of `[popover]`: a closed popover is `display: none`, and transitions do not run from an unrendered state, so it supplies the before-values for the open. Without it the open snaps and only the close animates. `display` and `overlay` with `transition-behavior: allow-discrete` (set as a separate declaration after `transition` so older browsers do not ignore the entire `transition` declaration) keep the popover rendered and in the top layer until the close transition ends.

## Keyboard and focus

Do not add a second roving-tabindex system inside a focusgroup. Script covers only what the invokers and focusgroup do not:

* **The trigger is an ordinary button.** `Tab` reaches it like any other button, and focusing it does not open the menu. `Enter`, `Space`, and click toggle the menu natively, so the script must not intercept these keys.
* **Keyboard open enters the menu.** Opening with `Enter` or `Space` focuses the first enabled item. `ArrowDown` on a trigger opens its menu if it is closed and focuses the first item either way, so arrow keys also work after a pointer open.
* **Pointer click on a closed trigger.** Opens it natively. Focus stays on the trigger; no item is focused. Only keyboard opens enter the menu.
* **Pointer click on an open trigger.** Closes it natively; it does not enter the menu.
  * **Known difference on submenu triggers.** A pointer click on a submenu trigger also toggles natively, so it can close a submenu that hover already previewed, or open one that has not appeared yet. Native menus only open it and never close it. This is harmless, so the guide accepts it.
* **Pointer over an item.** Focuses it without a ring, so hover and focus are one item.
* **Within a menu.** `ArrowUp` and `ArrowDown` move between enabled items. `Home` and `End` move to the first and last enabled item, which the script handles.
* **Submenu preview.** Focusing a submenu trigger, by arrow key or by pointer (which focuses it after a short delay), shows its submenu and sets `aria-expanded="true"`. Focus stays on the trigger, and no submenu item is focused. Moving to a sibling item closes the preview.
* **Enter or Space on a previewed submenu trigger.** They close the preview and keep focus on the trigger. The native `toggle-popover` action handles this.
* **ArrowRight on a submenu trigger.** Opens the submenu if needed and focuses its first item.
* **ArrowLeft or Escape in a submenu.** Closes only that submenu and restores focus to its trigger. The parent menu stays open.
* **Escape in a top-level menu.** Closes it and restores focus to its trigger.
* **Enter or Space on a command.** Activates it and closes all open menus.
* **Tab.** Leaves the menu system. Do not trap focus or step through every command. Closing must not leave focus inside hidden content.
* **No trigger button.** A menu opened from script focuses its first item when it was opened from the keyboard, and on close restores focus to the element that had it before the menu opened.

The `command` event fires before `toggle-popover` opens the menu, so focus cannot move into the menu there. Move focus in the `toggle` event instead. HTML restores focus only for the first `popover="auto"` in a stack, so nested levels must restore focus to their trigger explicitly.

## Implementing the interaction

Implement the behaviors above for your own markup. Arrow, `Home`/`End`, wrap-around and `Tab`-to-exit handling is ordinary `keydown` code. A few parts are easy to get wrong, grouped below by input type.

### Keyboard and focus handling

1. **One open path.** Opening by keyboard calls `trigger.click()`, so the invoker's `toggle-popover` is the only way a menu opens. Mark the menu so the `toggle` handler enters it, keyboard opens only. On a pointer open, `toggle` focuses the trigger without a ring instead, because `pointerdown` prevented focus and arrow keys must still work.
2. **Submenu preview on focus.** Focusing a submenu trigger calls `showPopover({ source: trigger })` so the submenu anchors to it. Ignore focus returning from inside the trigger's own submenu (after `Escape`), or from another window (flag on window `blur`, cleared a tick after window `focus`). Hide a previewed submenu on `blur` unless focus moved into it. Top-level triggers get no preview: focusing them does nothing.
3. **Move focus in `toggle`, not `command`.** `command` fires before the menu opens.
4. **Restore focus to submenus trigger yourself.** HTML returns focus to the trigger when closing the root menu, but not to submenus. Focus the trigger before `hidePopover()`.
5. **Don't override `focusVisible`.** The UA determines whether focus should be visible based on the user's input- do not duplicate or override the expected behavior.
6. **Close one level at a time.** Call `stopPropagation()` on `Escape` and `ArrowLeft` in a submenu, or the parent's listener closes it too.

### Pointer handling

1. **Pointer click toggles.** Clicking a closed trigger opens it natively and never enters the menu; only keyboard opens enter it. Do not intercept the click.
2. **Hover follows focus.** Style `:hover` and `:focus-visible` separately. On `pointermove` over an item, call `focus()`; browsers will not match `:focus-visible` on focus changes coming from a mouse, but will match on keyboard-initiated focus changes. Pointer focus on a submenu trigger runs the same submenu preview as keyboard focus, after a short delay so a pointer crossing the item does not flash its submenu.
3. **Safe triangle.** A static CSS bridge is too narrow: it only works when the pointer starts near the parent's edge. Let CSS draw a triangle from where the pointer left the trigger, and use script only to place it:
   * Run this only when `matchMedia('(hover: hover)').matches`; it is irrelevant to touch and keyboard.
   * Start on `pointerleave` of a submenu trigger whose submenu is open, at the event's position. Skip a `--below` submenu, which has no side edge.
   * Set `--pointer-x` and `--pointer-y` (the pointer, in px relative to the submenu's box) on the submenu, and `data-bridge` to switch the bridge on. CSS derives the rest: which side the pointer is on from the sign of `--pointer-x`, and the submenu's near-edge corners from percentages of the pseudo-element's own box.
   * Pointer moves over the bridge target the submenu, so listen there: keep the bridge while the pointer moves toward the submenu, and remove the attribute about 300 ms after it rests, when it moves away from the submenu horizontally, when it reaches an item in the submenu, or when the submenu closes. A fixed 300 ms from the leave is too short for an unhurried diagonal; a bridge that ignores a reversal makes a change of mind wait.
   * CSS gives the submenu a `::before` clipped to a triangle from that point to the near-edge corners, with a few px of slack around the point (`--bridge-slack` below) so the pointer's own position is inside the shape rather than on its edge. The apex does not follow the pointer: an apex at the pointer turns every move into a direction test, and the first step off a straight line closes the submenu. It sits over the sibling items on the pointer's path, so they never receive the hover that would close the submenu. `clip-path` also limits hit testing, so the rest of the parent menu stays interactive.
   * The submenu needs `overflow: visible` (a popover clips by default). The pseudo-element extends `100vw`/`100vh` past it on every side, so the shape's points are offset by that, and `100%` of its box is the submenu plus twice that.
   * Follow-up: a curved path (`shape()` curve commands) follows real pointer arcs better than a straight triangle.

```css
[focusgroup~="menu"] > [popover] {
  overflow: visible;

  &[data-bridge]::before {
    content: "";
    position: absolute;
    inset: -100vh -100vw; /* Room for the triangle. In this box the submenu runs from 100vw/100vh to 100% - 100vw/100vh. */
    --bridge-slack: 5px; /* The apex moves away from the submenu by this much and is twice this tall. */
    --bridge-side: sign(var(--pointer-x)); /* -1: pointer left of the submenu, 1: right. */
    --bridge-edge: calc(50% + var(--bridge-side) * (50% - 100vw)); /* The submenu's near edge. */
    --bridge-apex: calc(100vw + var(--pointer-x) + var(--bridge-side) * var(--bridge-slack));
    clip-path: polygon(
      var(--bridge-apex) calc(100vh + var(--pointer-y) - var(--bridge-slack)),
      var(--bridge-edge) 100vh,
      var(--bridge-edge) calc(100% - 100vh),
      var(--bridge-apex) calc(100vh + var(--pointer-y) + var(--bridge-slack))
    );
  }
}
```

```js
const canHover = matchMedia('(hover: hover)');

// Call on pointerleave of a submenu trigger, with its submenu.
function startBridge(submenu, event) {
  if (!canHover.matches || !submenu.matches(':popover-open')) return;
  const rect = submenu.getBoundingClientRect();
  const left = event.clientX < rect.left;
  if (!left && event.clientX <= rect.right) return; // --below: no side edge.
  submenu.style.setProperty('--pointer-x', `${event.clientX - rect.left}px`);
  submenu.style.setProperty('--pointer-y', `${event.clientY - rect.top}px`);
  submenu.dataset.bridge = '';
  let timer;
  let lastX = event.clientX;
  const stop = () => {
    clearTimeout(timer);
    submenu.removeEventListener('pointermove', extend);
    submenu.removeAttribute('data-bridge');
  };
  const extend = ({ target, clientX }) => {
    // Reached an item, or turned away from the submenu.
    if (target !== submenu || (left ? clientX < lastX : clientX > lastX)) return stop();
    lastX = clientX;
    clearTimeout(timer);
    timer = setTimeout(stop, 300);
  };
  timer = setTimeout(stop, 300);
  submenu.addEventListener('pointermove', extend);
  submenu.addEventListener('toggle', stop, { once: true });
}
```

Hover follows focus (item 2) needs one guard. The move that leaves the trigger was hit-tested before the bridge existed, so its target is the sibling under the pointer. Skip the focus when `document.elementFromPoint(event.clientX, event.clientY)` is not inside the item; later moves on the path hit the bridge, whose target is the submenu, not an item.

Also:

* **Outside focus.** Close every open menu when focus lands outside the menu system (a `document` `focusin` listener).
* **Command activation.** Announce it, then hide the root menu and restore focus to its trigger, without a ring if the activation came from a pointer. For checkable items (`menuitemcheckbox`, `menuitemradio`), wait about 300 ms before closing so the changed check mark is visible. Style a closed trigger as active only on `:focus-visible`; otherwise the restored (ringless) focus leaves it highlighted after a pointer selection.
* **`aria-expanded`.** Set it only in the `toggle` listener. It covers preview and open states, and a trigger's `aria-expanded` stays `"true"` while its menu is previewed or open.
* **Helpers.** The fallbacks below assume helpers you define for your markup: `triggers` (all `[commandfor]` buttons), `menuFor(trigger)`, `isOpen(menu)`, `enterOnOpen` (a `WeakSet` of menus to enter once open) and `pointerTrigger` (the trigger last pressed by a pointer).

### Submenus

* Use `popover="auto"` for submenus, placed after the submenu trigger inside the parent's `focusgroup`. Never `popover="manual"`.
* Nesting lets the browser keep the parent open, close sibling submenus, close child submenus when the root menu closes, and handle outside-click light dismiss.
* The submenu trigger keeps `aria-haspopup="menu"` and `aria-expanded`; the `toggle` listener keeps `aria-expanded` in sync.
* The keyboard script handles nested `Escape` and `ArrowLeft` as described above.
* A submenu trigger never also runs a command: one control cannot both activate and open, and `Enter` cannot mean both. Put the default action as the first submenu item, or add a separate command item beside the trigger. If a combined control is forced, document it as an accessibility tradeoff.

### Separators and checkable items

* Separate item groups with `<hr>` inside the focusgroup: a native `separator`, not focusable, skipped by focusgroup and the fallback. Never a styled `<div>`.
* A boolean option is a `<button type="button">` with `aria-checked` and an explicit `role="menuitemcheckbox"`. Focusgroup does not infer these roles, so this is the one place shared markup sets an item role.
* One of a set is a `<button type="button">` with `role="menuitemradio"` and `aria-checked`, inside a `role="group"` with an `aria-label`, in the same focusgroup.
* Script toggles `aria-checked`.
* `Enter` on a checkbox toggles and closes the menu; `Space` toggles and stays open (APG). Radios close on either key.
* Render the check mark from `[aria-checked="true"]::before`, not a separate icon element (see the CSS below).

### Not covered here

* **Activation feedback.** Native menus flash the chosen item before closing. If wanted, show a ~100 ms visual confirm before `hidePopover()`; do not delay focus restoration or the announcement.
* **Typeahead.** Focusgroup has none. If needed, on printable `keydown` match the current level's enabled item labels and focus the next match after the current item, wrapping. Do not intercept `Space`.

## Verify before finishing

An instruction cannot guarantee behavior, so test the result. Open the page and check each of these with the real keyboard and mouse; fix and re-test any that fail:

* **Keyboard.** `Tab` lands on a trigger without opening its menu; `ArrowDown` opens and enters; `Escape` closes one level and returns focus to its trigger; `Tab` closes every menu.
* **Pointer open.** Clicking a trigger opens its menu with focus on the trigger and no ring; `ArrowDown` then enters; clicking again closes it.
* **Pointer command.** Clicking a command closes every menu and shows no focus ring on the trigger.
* **Submenu.** Moving diagonally from the middle of a submenu trigger to a submenu item keeps it open; moving to an unrelated sibling closes it.
* **Narrow screen.** At 375 px no submenu covers its own trigger.
* **Check marks.** Checked items show a check mark.
* **No leftovers.** No console errors, and no `popovertarget`, `popovertargetaction` or `aria-details` on triggers.

## Align menu item content

When a row has an icon, label, and shortcut or submenu indicator, reserve a fixed-size leading slot for the icon or check mark and push the trailing content to the inline end. Icons are a known size, so a fixed slot keeps labels aligned whether or not an item has an icon. Do not use `subgrid` for rows: any extra inline child (a badge, for example) becomes its own grid item and breaks the layout. Hide shortcut text from assistive technology when it only repeats a key that already operates the item.

```css
[focusgroup~="menu"] {
  --menu-icon-size: 1.25rem;
}

/* Target items only. A closed submenu popover inside the focusgroup must keep display: none. */
[focusgroup~="menu"] > button,
[focusgroup~="menu"] > [role="group"] > button {
  display: flex;
  align-items: center;
  gap: .5rem;
}

/* The leading slot holds the icon or check mark. */
[focusgroup~="menu"] button::before {
  content: "";
  flex: none;
  inline-size: var(--menu-icon-size);
}

/* Check mark for checked items. This selector must be at least as specific as the base
   ::before rule above, or the empty content wins and the check mark never shows. */
[focusgroup~="menu"] button[aria-checked="true"]::before {
  content: "✓";
}

/* Shortcut or submenu indicator at the inline end. */
[focusgroup~="menu"] .hint {
  margin-inline-start: auto;
}
```

Put a trailing indicator or shortcut in a `<span class="hint" aria-hidden="true">` inside the button; the submenu trigger already announces its popup.

## Fallback strategies

### Fallbacks & browser support for focusgroup

Browser support for focusgroup: Limited availability.
Supported by: Chrome 150 (Jun 2026) and Edge 150 (Jul 2026).
Unsupported in: Firefox and Safari.

Keep `focusgroup="menu nomemory"` in the markup. If `'focusGroup' in HTMLElement.prototype` is false, install Up, Down, Home, and End, set `role="menu"` on each menu container, and `role="menuitem"` on buttons with no role; leave checkable items, `<hr>`, and `role="group"` alone. Never install it when native focusgroup is present. Submenu preview, open, and close are author script either way.

```js
if (!('focusGroup' in HTMLElement.prototype)) {
  document.querySelectorAll('[focusgroup~="menu"]').forEach(group => {
    group.setAttribute('role', 'menu');
    group.querySelectorAll('button:not([role])').forEach(item => {
      item.setAttribute('role', 'menuitem');
    });
    group.addEventListener('keydown', event => {
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      // Own items only: a nested submenu has its own focusgroup, a role="group" wrapper does not.
      const items = [...group.querySelectorAll('button')]
        .filter(item => item.closest('[focusgroup]') === group)
        .filter(item => !item.disabled && item.getAttribute('aria-disabled') !== 'true');
      const current = items.indexOf(document.activeElement);
      if (current < 0) return;
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 :
        (current + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length;
      event.preventDefault();
      event.stopImmediatePropagation();
      items[next].focus({ preventScroll: true });
    }, true);
  });
}
```

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

The Popover polyfill can not fully emulate the top layer behavior. Avoid making the menus a containing block for any submenus, which can happen when adding a `translate` opening transition. Wrap any properties that create a containing block (`filter`, `translate`, `scale`, `transform`, etc.) in an `@supports selector(:popover-open)` query.

```css
[popover]:has(> [focusgroup~="menu"]){
  @supports selector(:popover-open){
    translate: 0 -.25rem;
  }
}
```

### Fallbacks & browser support for Anchor positioning

Baseline status for the css.properties.position-area capability: Newly available. It's been Baseline since 2026-01-13.
Supported by: Chrome 129 (Sep 2024), Edge 129 (Sep 2024), Firefox 147 (Jan 2026), and Safari 26 (Sep 2025).

Without CSS Anchor Positioning, a popover falls back to the UA's centered viewport placement. Never ship that for a menu: it detaches the menu from its trigger, and a centered submenu covers its parent. Gate the anchored rules behind `@supports (position-area: block-end)` and position the menu from script when it fails:

* Place the menu below its trigger (top level) or beside it (submenu), flipping to the other side and clamping to the viewport when it would overflow.
* Run it in the `toggle` handler when the menu opens, and apply the result as `left` and `top` on the menu. Use `position: fixed` with `inset: auto` and `margin: 0` so the coordinates are viewport-relative.
* Keep these overrides inside `@supports not (position-area: block-end)`, so browsers with anchor positioning are unaffected.

Baseline status for ToggleEvent source: Newly available. It's been Baseline since 2026-05-11.
Supported by: Chrome 140 (Sep 2025), Edge 140 (Sep 2025), Firefox 145 (Nov 2025), and Safari 26.5 (May 2026).

If targeting earlier implementations where `showPopover({ source })` does not establish an implicit anchor (no `source` on `ToggleEvent.prototype`), give each trigger a unique `anchor-name` and each menu a matching `position-anchor` from script, instead of writing per-menu CSS rules.

### Fallbacks & browser support for Invoker commands

Baseline status for Invoker commands: Newly available. It's been Baseline since 2025-12-12.
Supported by: Chrome 135 (Apr 2025), Edge 135 (Apr 2025), Firefox 144 (Oct 2025), and Safari 26.2 (Dec 2025).

Without invokers, `command="toggle-popover"` does nothing. Use `popovertarget` instead, which has longer support and is supported by the popover polyfill.

* Mark the menu in `enterOnOpen` unless the click came from the pressed trigger (`pointerTrigger`), so only keyboard opens enter the menu.
* `Enter` and `Space` still work because they generate a click on buttons.

### Fallbacks & browser support for `:has()`

Baseline status for :has(): Widely available. It's been Baseline since 2023-12-19.
Supported by: Chrome 105 (Sep 2022), Edge 105 (Sep 2022), Firefox 121 (Dec 2023), and Safari 15.4 (Mar 2022).

If targeting browsers without `:has()`, add a class to each menu popover instead of selecting `[popover]:has(> [focusgroup~="menu"])`.

### Fallbacks & browser support for `sign()`

Baseline status for abs() and sign(): Newly available. It's been Baseline since 2025-06-26.
Supported by: Chrome 138 (Jun 2025), Edge 138 (Jun 2025), Firefox 118 (Sep 2023), and Safari 15.4 (Mar 2022).

If your Baseline target lacks `sign()`, skip `--bridge-side` and pick the edge and the apex nudge with `clamp()`: a large multiplier pushes `--pointer-x` past either bound, so the result is one end or the other.

```css
@supports not (width: calc(sign(1px) * 1px)) {
  [data-bridge]::before {
    --bridge-edge: clamp(100vw, 50% + var(--pointer-x) * 1e6, 100% - 100vw);
    --bridge-apex: calc(100vw + var(--pointer-x) + clamp(-1 * var(--bridge-slack), var(--pointer-x) * 1e6, var(--bridge-slack)));
  }
}
```
