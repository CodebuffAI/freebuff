# Handling dynamic user-triggered changes to sort order

Use this pattern when a user action reorders a list, card grid or table, with no item mid-interaction. It covers only applying the new order to the DOM (moving nodes, animating, announcing, performance), not how the order is computed or what triggers it.

## Reorder the existing nodes

**MANDATORY:** Reorder the existing DOM nodes into the new order. Do not recreate them. Recreating nodes with `innerHTML` or a re-render that replaces them discards focus, scroll position inside items, and image state, and it breaks view transitions, which match old and new elements by identity.

Use `moveBefore()` rather than `append()` so moved items keep state such as `<iframe>` content, playing animations, and focus inside them.

```javascript
// `orderedNodes` is the container's existing child elements in their new order.
function reorder(container, orderedNodes) {
  // Moving each node to the end in order is enough; no need to compute minimal moves.
  for (const node of orderedNodes) container.moveBefore(node, null);
}
```

**DO NOT** fake a new order with CSS `order` or `flex-direction: row-reverse`. Visual order and DOM order must match so keyboard and screen reader order follows what the user sees.

### Reordering table rows

For a `<table>`, move the `<tr>` elements within their `<tbody>` using the same function: `reorder(tbody, orderedRows)`. Never reorder header rows in `<thead>` or recreate the `<tbody>`.

## Optionally animate the reorder with view transitions

Animation is an enhancement; the reorder works without it. To animate, wrap the DOM reorder in a view transition and give every item a unique `view-transition-name` so each one animates from its old position to its new one. Without it the list snaps.

Use `view-transition-name: match-element` so you do not need to generate a name per item.

MANDATORY: Always respect user preferences for reduced motion using the `prefers-reduced-motion` media query.

Baseline status for View transitions: Newly available. It's been Baseline since 2025-10-14.
Supported by: Chrome 111 (Mar 2023), Edge 111 (Mar 2023), Firefox 144 (Oct 2025), and Safari 18 (Sep 2024).

```css
.item {
  /* Derives a unique name from each element's identity. */
  view-transition-name: match-element;
}

@media (prefers-reduced-motion: reduce) {
  ::view-transition-group(*),
  ::view-transition-old(*),
  ::view-transition-new(*) {
    animation: none;
  }
}
```

```javascript
function reorderWithTransition(list, orderedNodes) {
  const update = () => reorder(list, orderedNodes);

  // Prefer a transition scoped to the list: the rest of the page stays interactive.
  // Fall back to a document-level transition, then to a plain update.
  if (list.startViewTransition) {
    list.startViewTransition(update);
  } else if (document.startViewTransition) {
    document.startViewTransition(update);
  } else {
    update();
  }
}
```

* **Rapid changes:** starting a new view transition skips the one in flight, which is the desired behavior when the user flips through options quickly. Always apply the final state in the update callback so the DOM ends in the correct order even if the animation is skipped.
* **Large lists:** every named element is captured as an image, so naming hundreds of items is expensive. `match-element` names every matching element too, so it is no cheaper than explicit names. Skip the transition when the list is larger than a few hundred items.
* **Interactivity:** a document-level view transition blocks pointer events on the whole page while it runs, whereas `list.startViewTransition()` only affects the list's subtree. Prefer the scoped form, and keep the animation brief either way. Names only need to be unique within the scope. For table rows, scope the `<table>` (or a wrapper around it). See `scoped-component-transitions` (via `npx -y modern-web-guidance@latest retrieve "scoped-component-transitions"`) for scoped transition details.

## Announce the change once

Reordering moves many nodes, but the user performed one action. **DO NOT** put `aria-live` on the list, which would announce every moved item. Instead:

* Add one visually hidden `role="status"` element and set its text once per reorder, after starting the update. It must already be in the DOM before its text changes.
* Name the result, not the mechanism: "Sorted by price, low to high, 24 items".
* Keep focus on the control that triggered the change. Do not move focus into the list.
* Make the current order readable from the control itself, so a screen reader user who lands on it hears what is selected without searching the page. Native controls (`<select>`, radios) do this already; for toggle buttons use `aria-pressed` and label the current state, not the action.

```html
<p id="reorder-status" role="status" class="visually-hidden"></p>
```

```css
/* Hides the status text visually but keeps it available to screen readers. Do not use display: none. */
.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
```

```javascript
reorderWithTransition(list, orderedNodes);
// Set the message once, not once per item.
status.textContent = `Sorted by price, low to high, ${orderedNodes.length} items`;
```

## Performance on large lists

* Layout and rendering are the cost, not computing the order. Reorder nodes in a single pass with no layout reads (`offsetTop`, `getBoundingClientRect()`) in the loop.
* Add `content-visibility: auto` with `contain-intrinsic-size` to items in long lists so off-screen items skip rendering work.
* Above roughly a thousand items, virtualize the list instead of keeping every node in the DOM. Skip the view transition when virtualizing.
* For expensive reorders (very large lists, or an order set through several inputs), apply the new order only when the user confirms it, for example with an Apply button, instead of on every input change.

## Fallbacks

Browser support for Element-scoped view transitions: Limited availability.
Supported by: Chrome 147 (Apr 2026) and Edge 147 (Apr 2026).
Unsupported in: Firefox and Safari.

If your Baseline target does not support `element.startViewTransition()`, use `document.startViewTransition()`. If it does not support that either, reorder without animation. The list still sorts correctly and the announcement is unchanged, so this is graceful degradation: the animation enhances the use case but is not core to it.

Browser support for moveBefore(): Limited availability.
Supported by: Chrome 133 (Feb 2025), Edge 133 (Feb 2025), and Firefox 144 (Oct 2025).
Unsupported in: Safari.

If your Baseline target does not support `moveBefore()`, use `append()`. DOM order is identical; items may lose focus, iframe, or animation state inside them, which only matters when items contain such state.

```javascript
function reorder(container, orderedNodes) {
  const move = Object.hasOwn(Element.prototype, 'moveBefore')
    ? (node) => container.moveBefore(node, null)
    : (node) => container.append(node);

  for (const node of orderedNodes) move(node);
}
```
