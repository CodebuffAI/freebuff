# Build a toolbar

A toolbar groups related controls (formatting, alignment, view options) into one composite widget with a **single tab stop**. Users `Tab` into it once, move between controls with the arrow keys, and `Tab` out. Use it only for controls that act on something else (an editor, preview, canvas). For site navigation, see `navbar` (via `npx -y modern-web-guidance@latest retrieve "navbar"`); for a dropdown or context menu of commands without a persistent row of controls, see `menu` (via `npx -y modern-web-guidance@latest retrieve "menu"`).

## Structure and semantics

MANDATORY: Put `role="toolbar"` and an `aria-label` on the container. Wrap related controls in `role="group"` with their own `aria-label`, and divide groups with `role="separator"` and `aria-orientation="vertical"`. If a wrapped separator would sit alone at a row end, hide it visually with `opacity: 0`, not `display: none` or `visibility: hidden`, which also remove it from the accessibility tree. Optionally add `aria-controls` pointing at the element the toolbar acts on; it is only worth adding when the toolbar controls one specific element.

* Use real `<button type="button">` elements.
* Icon-only buttons need an `aria-label`; tooltips do not replace it. Render decorative icons with `<svg aria-hidden="true">` and `currentColor`, or with a CSS `mask`, `background-color: currentColor`, and `forced-color-adjust: none` so forced-colors mode does not strip the fill. For a reusable CSS icon token system, see `icons` (via `npx -y modern-web-guidance@latest retrieve "icons"`).
* Toggle buttons (bold, italic) use `aria-pressed="true|false"`. Do not change their label when toggled.
* A mutually exclusive set (left/center/right) uses `aria-pressed` on each button, with script keeping exactly one `true`.
* Action buttons (copy, undo, save) run once and have no on/off state, so DO NOT add `aria-pressed` to them. Mark `aria-pressed` only on buttons that stay on or off.
* Disable with `aria-disabled="true"` rather than `disabled` so the control stays focusable and reachable by arrow keys. Ignore clicks while it is set.

```html
<div role="toolbar" focusgroup="toolbar wrap" aria-label="Text formatting" aria-controls="preview">
  <div role="group" aria-label="Style">
    <button type="button" aria-pressed="false" aria-label="Bold" title="Bold"></button>
  </div>
  <span role="separator" aria-orientation="vertical"></span>
  <!-- Overflow trigger: the last item in the toolbar -->
  <button type="button" aria-label="More actions" aria-haspopup="menu" aria-expanded="false"
    popovertarget="more-menu" title="More actions"></button>
</div>
```

## Action buttons and feedback

Toggles show their result through `aria-pressed`. An action has no state to show, so a screen reader user gets no confirmation unless you provide it. When the result is not otherwise visible or announced (copy, save), write a short message to a live region outside the toolbar. If the action changes content that is already announced or focused, skip the message.

```html
<!-- Always present in the DOM so the announcement is reliable; keep it outside the toolbar -->
<p role="status"></p>
```

```js
// Report the outcome, including failure; clipboard access can be denied
try {
  await navigator.clipboard.writeText(text);
  status.textContent = "Text copied";
} catch {
  status.textContent = "Copy failed";
}
```

## Keyboard navigation

MANDATORY: Only one item is in the tab order at a time. Put `focusgroup="toolbar wrap"` on the `role="toolbar"` container: the browser provides the roving tab stop, arrow-key movement across all groups (wrapping at the ends, reversed in RTL), `Home`/`End`, and focus restoration after a click. Do not add a second roving-tabindex system alongside it. Where `focusgroup` is unsupported, install the fallback in "Fallbacks" below.

## Vertical toolbar

Choose a vertical toolbar when controls stack along a side edge (a tool palette or zoom controls beside a canvas); otherwise use a horizontal one. Everything above applies except:

* Set `aria-orientation="vertical"` on the toolbar and use `focusgroup="toolbar wrap block"` so `ArrowDown`/`ArrowUp` move between items.
* Lay items out in a column (`flex-direction: column`, no wrapping).
* A separator between stacked items is horizontal: use `aria-orientation="horizontal"` (the separator default) there, not `vertical`.
* Tooltips open beside the button (`position-area: inline-end`), not below it; see Tooltips below.

## Visible states

* Size each button at least 24×24 CSS px using `min-inline-size`/`min-block-size` (not `inline-size`/`block-size`), so content can grow the target but never shrink it. Enlarge it under `@media (pointer: coarse)`. Values like `2.5rem` and `3rem` are examples.

* Keep a clear `:focus-visible` outline with an offset; never remove it.
* Style toggled state from the ARIA attribute (`[aria-pressed="true"]`), not a separate class, so visual and accessible state cannot diverge.
* Show the toggled state by changing the button background; if the contrast between the button background and the adjacent background color is less than 3:1 in each supported color scheme, provide an additional visual cue such as an outline or inset shadow around the background that meets the 3:1 threshold. For more information, see `color` (via `npx -y modern-web-guidance@latest retrieve "color"`).
* Under `forced-colors: active`, use system colors (`ButtonText`, `Highlight`).
* Draw separators and tooltip boxes with a border (a `transparent` one is fine), not `background` alone, which forced colors replaces with the page color.
* Wrap hover styles in `@media (hover: hover)` and transitions in `@media (prefers-reduced-motion: no-preference)`.

## Tooltips for icon-only buttons

Give each icon-only button a `title` as the baseline tooltip. Only where both interest invokers and anchor positioning are supported, upgrade it to an interest invoker with `popover="hint"`, which shows the tooltip without closing an open menu popover. Elsewhere the native `title` tooltip stays.

MANDATORY: Position the hint on the axis the toolbar does not stack along: `position-area: block-end` (fallback `flip-block`) for a horizontal toolbar, `position-area: inline-end` (fallback `flip-inline`) for a vertical one. A hint placed along the stacking axis covers the next control and swallows its click, because the hint stays open while the pointer is over it.

```html
<button type="button" aria-label="Bold" title="Bold">…</button>
```

```js
// Upgrade title tooltips only when interest invokers and anchor positioning both work
if ("interestForElement" in HTMLButtonElement.prototype && CSS.supports("position-area", "block-end")) {
  document.querySelectorAll('[role="toolbar"] button[title]').forEach((b, i) => {
    const tip = Object.assign(document.createElement("div"), { id: `tip-${i}`, textContent: b.title });
    tip.popover = "hint";
    b.setAttribute("interestfor", tip.id);
    b.removeAttribute("title"); // avoid a second, native tooltip
    document.body.append(tip); // keep open hint nodes out of role="group" / role="toolbar"
  });
}
```

`interestfor` is specified to wire hint popovers (`popover="hint"`) for assistive technology itself, based on what the target contains. A **plain hint** (text and images only) becomes the trigger's accessible description, or its name if it has none. A **rich hint** (headings, links, or other interactive content) gets a minimum role of `tooltip`, the trigger gets `aria-expanded` and an `aria-details` relation while the hint is open, and the open hint comes right after the trigger in the tab order so keyboard users can reach its content.

Browsers and screen readers do not yet expose this consistently, so add explicit ARIA as well:

- **Hint that repeats the trigger's accessible name** (e.g. an icon-only button with `aria-label="Bold"` and a "Bold" tooltip): add nothing. A description identical to the name would be read twice.
- **Hint on a trigger with no visible label of its own** (e.g. an icon-only button without `aria-label`): `aria-labelledby` on the trigger pointing at the hint, so the hint becomes the name.
- **Hint whose trigger also opens it on activation** (a toggletip, or any button whose only job is the hint: give it `popovertarget` with `popovertargetaction="show"`): `role="tooltip"` on the hint and `aria-expanded` on the trigger, kept in sync with the popover's `toggle` event. A description read right after "button" suggests further actions and muddles the role; the expanded state tells the user there is content to reveal and whether it is open, and pressing the button delivers it. Place the hint right after the trigger in the DOM so reading keys reach its content once it is open.
- **Hint whose trigger does something else on activation** (a link, a button with its own action): `role="tooltip"` on the hint and `aria-describedby` on the trigger, never `aria-expanded`. A trigger announced as "collapsed" suggests `Enter` would expand it, but `Enter` navigates or acts. The hint must be something the user can afford to miss: a hovercard previews the destination, a tooltip on an action button describes the action.
- **DO NOT** attach a hint that opens on activation to a control that already uses `aria-expanded` for something else (for example, a menu button). Give that hint its own trigger instead.
- **DO NOT** move focus into the target when interest is shown (no `autofocus`, no `focus()` in an `interest` listener). Interest is triggered by hover or focus alone, so moving focus would fail WCAG 3.2.1 (On Focus).

Not every screen reader reads descriptions when moving through the page (NVDA skips them in browse mode by design), so a hint exposed as a description must only carry content the user can afford to miss. Link previews and tooltips on action controls qualify; anything the user needs belongs in a toggletip or inline.

Wire this with a short script instead of hand-authoring the attributes, so the markup stays declarative and the same rules apply to every hint. The script should:

1. Run in every browser, before loading the `interestfor` polyfill, once the DOM is parsed, and expose a function that can be called again for content inserted later. Scanning upfront is required: a browse-mode screen reader user needs the attributes in place before any interaction, so wiring them lazily on `focus` or `interest` is too late, and so is waiting for the polyfill, which wires its ARIA only on `load` and adds no `role="tooltip"` to plain hints.
2. For every `[interestfor]` trigger whose target has `popover="hint"`, normalize whitespace and compare the hint text with the trigger's accessible name (`aria-labelledby` targets, else `aria-label`, else text content including image `alt`, else `title`). Equal: do nothing. Otherwise set `role="tooltip"` on the hint if it has no role.
3. When the trigger has no name, point `aria-labelledby` at the hint unless it already has one. Otherwise, if the trigger also opens the hint on activation (a `popovertarget` or `commandfor` naming the hint), set `aria-expanded` to the popover's current state (`:popover-open`) unless it already has `aria-expanded`, and remember which triggers the script owns; if not, point `aria-describedby` at the hint unless it already has one.
4. Keep `aria-expanded` in sync from the popover's `toggle` event in every browser with a single capturing listener on `document`, updating every trigger with a matching `interestfor` that the script owns (the `interestfor` polyfill does not sync `aria-expanded` on plain-text hints or when a toggletip is opened via `popovertarget`).

Things that are easy to get wrong:

- `toggle` does not bubble. A bubbling listener on `document` never fires; use the capture phase (or a listener per popover).
- Sync `aria-expanded` from `toggle`, not from `interest`/`loseinterest`. The popover is the source of truth: it can be closed by `Escape`, light dismiss, or another invoker, and several triggers can share one hint.
- A hidden popover is a valid `aria-describedby` or `aria-labelledby` target. Do not force the hint open or duplicate its text to make it "visible".
- Do not add `aria-haspopup` or a live region to any hint.
- Do not override author ARIA: an existing `aria-describedby`, `aria-labelledby`, or `aria-expanded` on the trigger wins.

By default, interest is shown and lost for keyboard and mouse users with a delay of half a second. This prevents the targeted popover from opening while tabbing through a page or moving your mouse around, and from closing while moving your mouse from the trigger to the popover. To adjust the timing, use the `interest-delay` CSS property.

```css
[interestfor]{
  /* Shorthand for interest-delay-start and interest-delay-end */
  interest-delay: 0.2s 0.1s;
}
```

If users are likely to move through multiple triggers in quick succession, set the initial delay to `0s` if an interest-triggered popover is already open. To prevent performance issues with `:has()`, select a nearby container with a small number of child nodes, and target the triggers as directly as possible.

```css
.container:has( > li > a:interest-source) [interestfor] {
  interest-delay-start: 0s;
}
```

```css
[popover="hint"] {
  inset: auto;
  /* Anchor to the invoker; flip to the other side if there is no room */
  position-area: block-end;
  position-try-fallbacks: flip-block;
}
```

## Overflow menu for secondary actions (optional)

Two patterns fit a toolbar into a narrow space: an overflow menu, better on desktop, or a horizontally scrollable toolbar with no scrollbar and scroll hints, better on mobile. For the scrollable pattern use `overflow-x: auto; scrollbar-width: none; scroll-snap-type: x proximity`, and hint at hidden controls with edge fades (`mask-image`) or a partly visible last item. Choose by input type (`@media (pointer: coarse)`) or container width.

Add a trailing "More actions" menu when the toolbar has secondary actions or must fit narrow containers; skip it if every control is common and fits. If items must move into the menu dynamically as space runs out, build that overflow behavior yourself.

* Make the trigger the last toolbar item (`aria-label="More actions"`, `aria-haspopup="menu"`, `aria-expanded="false"`, and `popovertarget` pointing at the menu popover) with the conventional three vertical dots icon (`⋮`). Open it only on activation—never preview on focus when arrowing across the toolbar.
* Anchor the `popover` container to its trigger (`inset: auto; position-area: block-end span-inline-start; position-try-fallbacks: flip-block, flip-inline`) and nest `<div focusgroup="menu nomemory" aria-label="More actions">` inside it, adding `role="menu"`, `role="menuitem"`, `tabindex="-1"`, and `ArrowDown`/`ArrowUp`/`Home`/`End` only when `'focusGroup' in HTMLElement.prototype` is false. Sync `aria-expanded` and focus the first item on `toggle`, close the popover on `Tab` without trapping focus, and let `Space` on `role="menuitemcheckbox"` toggle `aria-checked` without closing. For nested submenus or radio groups, see `menu` (via `npx -y modern-web-guidance@latest retrieve "menu"`).
* Announce the result of every menu activation in the toolbar's live region, such as `"Strikethrough on"` or `"Formatting cleared"`. When closing the menu returns focus to the trigger, delay the live-region write slightly—for example `500ms`—so the focus-change announcement does not preempt it.

## Fallback strategies

### Fallbacks & browser support for `focusgroup`

Browser support for focusgroup: Limited availability.
Supported by: Chrome 150 (Jun 2026) and Edge 150 (Jul 2026).
Unsupported in: Firefox and Safari.

Keep `focusgroup` in the markup. Only if `'focusGroup' in HTMLElement.prototype` is false, load a roving-tabindex fallback; never install it when native focusgroup is present. The fallback implements what focusgroup does natively:

* The active item has `tabindex="0"`; all others have `tabindex="-1"`. Initially the first item is active.
* On `focusin`, move `tabindex="0"` to the focused item so returning to the toolbar (including after a click) restores position.
* In a horizontal toolbar, `ArrowRight`/`ArrowLeft` move to the next/previous item across all groups and wrap at the ends. In RTL, reverse the directions. Do not wire `ArrowUp`/`ArrowDown`.
* In a vertical toolbar, `ArrowDown`/`ArrowUp` move to the next/previous item instead, and `ArrowLeft`/`ArrowRight` do nothing.
* `Home`/`End` move to the first/last item.
* Call `preventDefault()` only for keys the toolbar handles so `Tab` keeps working.

```js
if (!('focusGroup' in HTMLElement.prototype)) {
  // items = every toolbar control across all groups, in DOM order
  items.forEach((b, i) => (b.tabIndex = i ? -1 : 0));
  bar.addEventListener("focusin", ({ target }) => {
    if (items.includes(target)) items.forEach((b) => (b.tabIndex = b === target ? 0 : -1));
  });
  // Read direction and orientation at event time so runtime changes are honored
  const vertical = bar.getAttribute("aria-orientation") === "vertical";
  // Only horizontal toolbars flip with direction: RTL does not flip Up/Down
  const rtl = getComputedStyle(bar).direction === "rtl";
  const steps = vertical
    ? { ArrowDown: 1, ArrowUp: -1 }
    : { ArrowRight: rtl ? -1 : 1, ArrowLeft: rtl ? 1 : -1 };
  // keydown: look up steps[key] (or Home/End), move focus, preventDefault only for handled keys
}
```

### Fallbacks & browser support for Interest invokers

Browser support for Interest invokers: Limited availability.
Supported by: Chrome 149 (Jun 2026) and Edge 149 (Jun 2026).
Unsupported in: Firefox and Safari.

Do not load an `interestfor` polyfill here: when native interest invokers or anchor positioning are missing, the upgrade script is skipped and buttons keep their baseline `title` tooltip.

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

### Fallbacks & browser support for `popover="hint"`

Browser support for popover="hint": Limited availability.
Supported by: Chrome 151 (Jul 2026), Edge 151 (Jul 2026), and Firefox 153 (Jul 2026).
Unsupported in: Safari.

The popover polyfill does not add `popover="hint"`. Where `popover` exists without `hint`, two tooltips can stay open at once (for example one opened by focus and one by hover). Treat this as graceful degradation: the upgrade only runs where interest invokers are supported, and other browsers keep the native `title` tooltip.

### Fallbacks & browser support for Clipboard API

Baseline status for the api.Clipboard.writeText capability: Widely available. It's been Baseline since 2020-03-24.
Supported by: Chrome 66 (Apr 2018), Edge 79 (Jan 2020), Firefox 63 (Oct 2018), Safari 13.1 (Mar 2020), and Safari iOS 13.4 (Mar 2020).

Where the Clipboard API is unavailable, `navigator.clipboard` is undefined and the call throws, so the `catch` branch in the feedback snippet reports the failure.

### Fallbacks & browser support for Anchor positioning

Baseline status for the css.properties.position-area capability: Newly available. It's been Baseline since 2026-01-13.
Supported by: Chrome 129 (Sep 2024), Edge 129 (Sep 2024), Firefox 147 (Jan 2026), and Safari 26 (Sep 2025).

Without anchor positioning, a popover is placed by the UA at the center of the viewport. Tooltips need no fallback: the `title` upgrade above is skipped without anchor positioning. For the overflow menu, position it from script so it stays attached to its trigger. Keep the CSS inside `@supports not (position-area: block-end)` so supporting browsers are unaffected.

```css
@supports not (position-area: block-end) {
  #more-menu {
    /* Viewport coordinates are set from script when the menu opens */
    position: fixed;
    inset: auto;
    margin: 0;
  }
}
```

```js
// Only needed without anchor positioning; place the menu below its trigger
// and flip above it when it would overflow the viewport.
menu.addEventListener("toggle", ({ newState }) => {
  if (newState !== "open" || CSS.supports("position-area", "block-end")) return;
  const t = more.getBoundingClientRect();
  const m = menu.getBoundingClientRect();
  const below = t.bottom + m.height <= innerHeight;
  menu.style.top = `${below ? t.bottom : t.top - m.height}px`;
  // Right-align with the trigger, clamped to the viewport
  menu.style.left = `${Math.max(0, Math.min(t.right - m.width, innerWidth - m.width))}px`;
});
```
