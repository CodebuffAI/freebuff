# Tabbed interfaces

## Basic markup

Instead of manually implementing a roving tabindex or ARIA activedescendant pattern to meet the focus management requirement of the ARIA `tablist` role, we can use `focusgroup` which has a `tablist` behavior and automatically assigns the right roles (`tablist` on the container and `tab` on its focusable children).

```html
<div class="tabs">
  <div focusgroup="tablist" aria-label="Web platform technologies">
      <button type="button" id="html-tab" aria-selected="true" focusgroupstart>HTML</button>
      <button type="button" id="css-tab">CSS</button>
      <button type="button" id="js-tab">JavaScript</button>
  </div>
  <div role="tabpanel" aria-labelledby="html-tab" tabindex="0"><!-- content for HTML tab --></div>
  <div role="tabpanel" aria-labelledby="css-tab" hidden="until-found"><!-- content for CSS tab --></div>
  <div role="tabpanel" aria-labelledby="js-tab" hidden="until-found"><!-- content for JavaScript tab --></div>
</div>
```

DO NOT use this or the WAI-ARIA tabs pattern for page navigation, even if it is intended to be presented as a tabbed interface.

Tablist:
- Prefer `<button>` for the tabs to avoid needing to reimplement button-like behavior. Add `type=button` to avoid unexpected submitter behavior if nested within a form.
- Use `aria-labelledby` or `aria-label` to give the tablist an accessible name.
- Use `aria-selected` to indicate which tab is currently selected.

Tab panels:
- Set `role=tabpanel` on the tab panels and use `aria-labelledby` or `aria-label` to give the panel an accessible name (e.g. `aria-labelledby` can reference the associated tab).
- Do not add `aria-controls` to the tabs: no screen reader uses it.
- Use `hidden="until-found"` to hide tab panels whose tab is not actively selected while still keeping them searchable by the browser’s find-in-page feature. Use `hidden` with no value to remove the content from the browser's search in-page feature as well.
- When using `hidden="until-found"`, use the `beforematch` event to sync the tab & tab panel selection state when find-in-page makes a different tab active.
- Set `tabindex=0` on the visible tab panel if it contains no focusable elements, and remove it from hidden panels.

- MANDATORY: Render the initial state in the HTML: `hidden` on every panel except the selected one, and `aria-selected="true"` on the selected tab. Otherwise every panel shows until script runs, overlapping when they share a grid cell.

## Keyboard interaction

When it comes to how tabs become selected, one can either make _selection follow focus_ or allow the user to move focus between tabs and perform _selection by activation_.

Default to _selection follows focus_.
It saves a keypress per tab, is more discoverable, and matches native radio groups.
Use selection by activation instead when showing a panel has a cost the user should opt into, since arrowing from the first tab to the fifth would pay it for every tab along the way:
- Showing the panel is not instant: content is fetched on demand, or rendering it is noticeably slow.
- Selecting a tab has side effects: it changes the URL or history, sends analytics, starts media, or saves state.
- The panel shifts the layout significantly (e.g. panels of very different heights push the rest of the page around).

With either pattern, focus entering the group must land on the selected item. By default it returns to the last focused item instead, which is wrong once selection can change without focus (find-in-page, script).
Use `nomemory` and move `focusgroupstart` to the selected tab:

```html
<div focusgroup="tablist nomemory" aria-label="Web platform technologies">
```

```js
for (const tab of tabs) {
  tab.ariaSelected = tab === selected;
  tab.toggleAttribute('focusgroupstart', tab === selected);
}
```

## Styling

### Indicating the selected tab

Style the selected tab from `aria-selected`, so the visual state can never disagree with the accessible one.
Do not apply any styling that changes the dimensions of the tab (e.g., `padding`, `border`, `margin`, `font-size`, `font-weight`, etc).

- MANDATORY: Do not indicate the selected tab with color alone (WCAG 1.4.1). Add a shape, such as an underline.
- Draw the underline with a border on a pseudo-element. DO NOT use `box-shadow` or a background: forced colors mode removes both, leaving no indicator.

```css
[role="tab"] {
  position: relative;
}

[aria-selected="true"] {
  color: var(--accent);

  /* Example: a 3px underline that takes no space */
  &::after {
    content: "";
    position: absolute;
    inset: auto 0 0;
    border-block-end: 3px solid var(--accent);
  }
}
```

To animate the underline between tabs, move the pseudo-element to the tablist and tether it to the selected tab with anchor positioning. See `anchor-positioning-tab-underline` (via `npx -y modern-web-guidance@latest retrieve "anchor-positioning-tab-underline"`) for details.


- DO NOT put padding, borders, margins, or backgrounds on the panel element itself. `hidden=until-found` does not use `display: none`: it only hides the panel's contents, so a hidden panel still renders its padding, border, margin, and background as an empty strip. Put these styles on a child wrapper inside the panel instead.
- `hidden=until-found` panels still participate in grid and flex layout, so `gap` adds space for every hidden panel. Place all panels in the same grid cell, or avoid `gap` between panels.

See `search-hidden-content` (via `npx -y modern-web-guidance@latest retrieve "search-hidden-content"`) for more details.

## Handling tabs that don’t fit

Keep tabs on a single row. DO NOT wrap them onto multiple rows: wrapped rows make the tab order and the selected tab hard to follow.
When the tabs are wider than the available space, either scroll the tablist or move the tabs that don’t fit into a popup menu.
Optionally, also shrink the inactive tabs, so more tabs fit before either kicks in.

1. **Scrolling** keeps every tab in the tablist and in the keyboard order, and works with touch swiping. It needs no script beyond selection. Use it by default, and always on touch-first interfaces.
2. **An overflow menu** shows the names of all hidden tabs at once, in a list, without scrolling. Use it when there are a few primary tabs and a tail of less used ones, and users mostly use a pointer. It needs script to detect overflow.
3. **Shrinking inactive tabs** truncates their labels, so it suits tabs the user creates (e.g. open documents in an editor) better than a fixed set of tabs with short labels. Combine it with scrolling or an overflow menu.

### Strategy 1: scrolling

1. Make the tablist a horizontal scroll container: `display: flex`, `overflow-x: auto`, and `flex: none` on the tabs so they never shrink (unless combined with strategy 3).
2. Optional: snap to tab edges with `scroll-snap-type: inline proximity` on the tablist and `scroll-snap-align: start` on the tabs. Use `proximity`, not `mandatory`, so the user can still stop between tabs.
3. Hide the scrollbar and fade out each edge of the tablist that has more tabs beyond it, as described below. A fade suits a row of tabs better than a shadow, and works on any background. See `scrollability-affordance-hints` (via `npx -y modern-web-guidance@latest retrieve "scrollability-affordance-hints"`) for more details on scrollability hints.
4. On every selection change, scroll the selected tab into view with `scrollIntoView({ block: 'nearest', inline: 'nearest', container: 'nearest' })`. `container: 'nearest'` scrolls only the tablist, not the page. Clicking a partially visible tab then reveals it along with part of the next one, so mouse users without a horizontal scroll wheel can still reach every tab. It also covers selection without focus, such as find-in-page.

#### Fading the edges

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

### Strategy 2: overflow menu

Hide the tabs that don’t fit and list them in a menu opened by a “More” button after the tablist.
Build the button and its menu as a menu button; see `menu` (via `npx -y modern-web-guidance@latest retrieve "menu"`) for structure, positioning, and keyboard behavior.
The rest of this section covers only what is specific to tabs.

- **Place the “More” button outside the tablist.** A tablist may only contain tabs. This makes it a separate `Tab` stop that arrow keys do not reach. If arrow-key access matters more, move focus from the last visible tab to the “More” button on `ArrowRight`/`End`, and back on `ArrowLeft`. The tablist itself does nothing at its last tab, so this does not conflict with it, but it is custom key handling that users of the tab pattern may not expect.
- **Make the “More” button look different from a tab.** Use an icon (such as a horizontal ellipsis) with an accessible name, not a text label: a text label looks like one more tab.
- **Detect overflow with `IntersectionObserver`**, rooted at the tablist with `threshold: 1`, so partially visible tabs count as overflowed. It reports each tab as it starts or stops fitting, with no layout math.
- **Hide overflowed tabs with `visibility: hidden`**, not `display: none` or `hidden`. They keep their layout box, so the observer still reports when they fit again, and they leave the focus order and the accessibility tree. Set `overflow: clip` on the tablist so they don’t overflow the page.
- **Mirror each tab as a `menuitem`**. Show only the items whose tab is hidden. Activating an item selects its tab and focuses it. Focus the tab before hiding the popover: otherwise the popover returns focus to the previously focused tab, which selects it again.
- **Hide the “More” button when no tab overflows.** This cannot loop: showing the button only narrows the tablist, so at least one tab still overflows.
- **Keep the selected tab in the tablist.** DO NOT leave it in the menu or mark the “More” button as selected: it is a button, not a tab. When the selected tab overflows (selected from the menu, by find-in-page, or after a resize), set `display: none` on the tabs before it, closest first, until it fits. The observer then reports them as overflowed, so they appear in the menu. DO NOT reorder tabs (in the DOM or with CSS `order`): the removed tabs are gone from both the visual and the focus order, so the two still match. Keep overflowed tabs visible while they are selected or focused: a selected tab can then be focused before the observer catches up, and a focused tab keeps focus when a resize overflows it.

```html
<div class="tabs">
  <div class="tablist" focusgroup="tablist nomemory" aria-label="Product details">
    <button type="button">Overview</button>
    <button type="button">Specifications</button>
    <!-- … -->
  </div>
  <!-- Outside the tablist: a tablist may only contain tabs.
       Icon, not text, so it does not read as another tab. -->
  <button type="button" class="more" hidden aria-label="More tabs" aria-haspopup="menu" aria-expanded="false">⋯</button>
  <!-- Menu: see the menu guide. One menuitem per tab. -->
  <!-- Tab panels -->
</div>
```

```js
const observer = new IntersectionObserver(entries => {
  for (const { target: tab, intersectionRatio } of entries) {
    const overflowed = intersectionRatio < 1;
    // CSS: .clipped:not([aria-selected="true"], :focus) { visibility: hidden; }
    tab.classList.toggle('clipped', overflowed);
    menuItemFor(tab).hidden = !overflowed;
  }
  more.hidden = !tabs.some(tab => tab.classList.contains('clipped'));
  reveal();
}, { root: tablist, threshold: 1 });

tabs.forEach(tab => observer.observe(tab));

// Also call after every selection change.
// CSS: .displaced { display: none; }
function reveal() {
  const tab = tabs.find(tab => tab.ariaSelected === 'true');
  const before = tabs.slice(0, tabs.indexOf(tab));
  tabs.forEach(tab => tab.classList.remove('displaced'));
  while (before.length && !fits(tab)) {
    before.pop().classList.add('displaced');
  }
}

// Checks both edges, so it works in either writing direction
function fits(tab) {
  const list = tablist.getBoundingClientRect();
  const { left, right } = tab.getBoundingClientRect();
  return left >= list.left && right <= list.right;
}
```

### Strategy 3: Making inactive tabs smaller

This may be combined with the overflow handling strategies described above to allow more tabs to fit before scrolling or showing a menu.
It is more well suited to user-driven tablists (e.g. a document editor) rather than hardcoded UI tablists.

- Let inactive tabs shrink and keep the selected tab at its full width: `flex: 0 1 auto` on the tabs, and `min-inline-size: max-content` on the selected tab, which also overrides any `max-inline-size`, so its label is never truncated. DO NOT use `flex-shrink: 0` for this: it cannot transition smoothly (see below).
- Set a `min-inline-size` on the tabs. Once every inactive tab is at its minimum, the remaining overflow is handled by scrolling or the overflow menu.
- Truncate shrunk labels with `text-overflow: ellipsis`. Put the label in its own element, so `overflow: hidden` applies to the text only and an icon beside it is never clipped.
- Keep the full label in the DOM, so the accessible name and find-in-page are unaffected. Reveal it by scrolling the label inside the tab on hover, and on focus when activation is manual (with automatic activation the focused tab is selected, so it is already full width). See `single-line-overflow` (via `npx -y modern-web-guidance@latest retrieve "single-line-overflow"`) for more details.
- If tabs have icons, keep the icon visible and truncate only the label, so a minimum-width tab is still recognizable.
- Transition `min-inline-size` so tabs resize smoothly when the selection changes, instead of jumping. Set `interpolate-size: allow-keywords` on the tablist so it interpolates to and from `max-content`; no view transition is needed. Only transition it when `prefers-reduced-motion` is `no-preference`. Transitioning `flex-shrink` does not work: any value above 0 shrinks a tab all the way to its minimum when the tabs overflow.



## Fallback strategies

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

### Fallbacks & browser support for `hidden=until-found`

Browser support for hidden="until-found": Limited availability.
Supported by: Chrome 102 (May 2022), Edge 102 (May 2022), and Firefox 148 (Feb 2026).
Unsupported in: Safari.

Treat `hidden=until-found` as an enhancement. Do not polyfill it: find-in-page cannot be reproduced across browsers.
No feature detection is needed when setting it from script: in browsers without support, `panel.hidden = 'until-found'` sets the boolean `hidden`, so the panel is simply hidden and not searchable.

### Fallbacks & browser support for `interpolate-size`

Browser support for interpolate-size: Limited availability.
Supported by: Chrome 129 (Sep 2024) and Edge 129 (Sep 2024).
Unsupported in: Firefox and Safari.

No fallback is needed: without `interpolate-size`, tabs resize instantly instead of transitioning.

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
