# Scoped Component Transitions

Starting a view transition with `document.startViewTransition()` attaches the `::view-transition` overlay to the `:root` element, which blocks pointer events on the rest of the page, prevents concurrent transitions, and obscures `position: fixed` headers or open `[popover]` elements (even when nested view transition groups are used to prevent overflow bleeding).

Calling `element.startViewTransition()` on a component root addresses this by scoping the transition to that DOM subtree: the `::view-transition` pseudo-element tree is injected directly onto the element, preserving external stacking contexts and page interactivity while allowing multiple components to transition concurrently.

## Implementation

### 1. Trigger a Scoped Transition

Call `element.startViewTransition()` on the component's root container element instead of `document.startViewTransition()`. The element you call `startViewTransition()` on becomes the transition's scope (the scope element): only elements within its subtree are captured, only rendering of the scope halts during the update callback, and the resulting `::view-transition` overlay matches the scope element's size, shape, and stacking context.

### 2. Name Participating Elements

Assign a `view-transition-name` to child elements inside the scope that should animate. You can use `view-transition-name: match-element` on dynamic list items to automatically derive each element's transition name from its DOM node identity, or assign explicit names (which only need to be unique within that scope).

Names are isolated within each scope, preventing collisions across components in different parts of the DOM. However, `view-transition-name`s can collide with names in nested scoped view transitions. To prevent this, add `view-transition-scope: all` to the child scope element.

### 3. Self-Participation and Overflow Clipping

The scope element automatically participates in its own view transition because the user-agent stylesheet applies `view-transition-name: root` and `view-transition-group: contain` to it. This way, when the scope’s geometry is affected by the change you make in the DOM, it smoothly animates its own geometry alongside its children, as part of the View Transition.

When the scope clips its overflow (`overflow: hidden`, `scroll`, or `clip`), `::view-transition-group-children(root)` automatically applies `overflow: clip`, preventing transitioning children from bleeding outside the component bounds.

> [!NOTE]
> Automatic overflow clipping only applies to the scope element itself (`root`). If a captured element inside the scope clips its own overflow and contains other nested captured elements (for example, a scrollable or clipped `<ul>` inside a `.card`), use Nested View Transition Groups so those nested elements stay clipped to their outer captured container:
>
> ```css
> .card ul {
>   height: 200px;
>   overflow-y: auto;
>   view-transition-name: match-element;
>   view-transition-group: contain;
>   view-transition-class: list;
> }
>
> ::view-transition-group-children(.list) {
>   overflow: clip;
> }
> ```

### 4. Concurrent and Nested Transitions

Separate component subtrees can run `element.startViewTransition()` concurrently without skipping each other. Active scopes automatically receive `view-transition-scope: all` in the UA stylesheet so internal `view-transition-name` values do not leak into outer transitions. Apply `view-transition-scope: all` in CSS on repeated component containers to prevent outer transitions from capturing internal names even when the component is idle.

If an outer transition needs to move a component while its inner transition is active, assign a `view-transition-name` to an element wrapping the inner scope. The outer transition then captures and animates only the wrapper instead of the inner scope element, allowing the inner transition to run to completion.

## Example

No CSS is needed on the scope element itself (`.card` or `.card ul`) to establish the scope—the scope is determined by calling `startViewTransition()` on the element instead of `document` (if the component will be nested inside an outer view transition, see [Running an outer transition](#running-an-outer-transition) for `view-transition-scope: all`).

```css
/* 1. Name participating child items */
.card ul li {
  view-transition-name: match-element;
}

/* 2. OPTIONAL: Customize transition timing (300ms is an example duration) */
::view-transition-group(*) {
  animation-duration: 300ms;
  animation-timing-function: ease-in-out;
}

/* 3. MANDATORY: Respect user preference for reduced motion */
@media (prefers-reduced-motion: reduce) {
  ::view-transition-group(*),
  ::view-transition-old(*),
  ::view-transition-new(*) {
    animation: none !important;
  }
}
```

```javascript
// 1. Trigger a transition scoped to a single component subtree
function runScopedTransition(scopeEl, updateDOM) {
  // MANDATORY: Call startViewTransition on the component element, not document
  const transition = scopeEl.startViewTransition(() => {
    updateDOM();
  });

  // Re-triggering startViewTransition() on the same element skips the active transition
  // and rejects `ready`. Catch the rejection to avoid unhandled promise rejection errors.
  transition.ready.catch(() => {});
}

// 2. Reorder items by moving existing DOM nodes (required for `match-element`)
// Scope to `listEl` since only the list order changes, keeping controls outside `listEl` interactive
function reorderItems(listEl, orderedIds) {
  const existing = new Map(
    Array.from(listEl.children, (li) => [li.dataset.id, li]),
  );

  runScopedTransition(listEl, () => {
    for (const id of orderedIds) {
      const li = existing.get(id);
      if (li) listEl.appendChild(li);
    }
  });
}

// 3. Remove an item while preserving exit animation and keyboard focus
// Scope to the outer `cardEl` so the card itself also transitions its height change
function removeItem(cardEl, itemEl) {
  const hadFocus = itemEl.contains(document.activeElement);
  const nextFocusTarget =
    itemEl.nextElementSibling?.querySelector('button') ??
    itemEl.previousElementSibling?.querySelector('button') ??
    cardEl.querySelector('button');

  runScopedTransition(cardEl, () => {
    itemEl.remove();
    if (hadFocus) {
      nextFocusTarget?.focus();
    }
  });
}
```

## Running an outer transition

When starting a view transition outside of the intended scope (e.g. from a parent component, or from the document for a page-level transition), the outer transition will capture and animate the scope element and everything inside it.

To prevent this from happening, wrap the scope element in a separate wrapper element with its own `view-transition-name`, and apply `view-transition-scope: all` to the inner scope element. This allows the wrapper itself to be captured and animated by the outer transition while preventing the inner scope's contents from being captured.

```html
<div class="page" id="page">
  <div class="card-wrapper">
    <section class="card" id="left">
      <h2>Card A</h2>
      <ul id="left-list">
        <li>…</li>
      </ul>
    </section>
  </div>
  <div class="card-wrapper">
    <section class="card" id="right">
      <h2>Card B</h2>
      <ul id="right-list">
        <li>…</li>
      </ul>
    </section>
  </div>
</div>
```

```javascript
document.querySelector('#page').startViewTransition(() => {
  // do your DOM updates here...
});
```

```css
/* Apply a view-transition-name on the wrapper */
.card-wrapper {
  view-transition-name: match-element;
}

/* Prevent the contents of the card being captured by an outer transition */
.card {
  view-transition-scope: all;
}

.card ul li {
  view-transition-name: match-element;
}
```

Alternatively, you can allow the outer transition to capture the children. In order to retain clipping effects, resort to using Nested View Transition Groups to clip the captured children at the boundaries of their wrapper. In that case, though, you need to manually apply the `clip` onto the resulting `::view-transition-group-children()` pseudo.

```css
.card-wrapper {
  overflow: clip;
  view-transition-name: match-element; /* Capture me as part of the outer VT */
  view-transition-group: contain; /* Nest children that also have a view-transition-name */
  view-transition-class: card; /* For targeting purposes */
}

/* Manually copy back the clip onto the ::view-transition-group-children pseudo */
::view-transition-group-children(.card) {
  overflow: clip;
}

.card ul li {
  view-transition-name: match-element;
}
```

## Constraints & Accessibility

- **MANDATORY**: Call `startViewTransition()` on the component root element rather than `document` so external `position: fixed` elements and `[popover]` overlays remain layered on top and the rest of the page stays interactive.
- **MANDATORY**: Preserve and move existing DOM nodes (rather than recreating them with `innerHTML`) when using `view-transition-name: match-element`, as `match-element` tracks DOM node identity.
- **MANDATORY**: Respect user preferences for reduced motion using `@media (prefers-reduced-motion: reduce)` by setting `animation: none !important` on `::view-transition-group(*)`, `::view-transition-old(*)`, and `::view-transition-new(*)`.
- **MANDATORY**: Preserve keyboard focus when removing a focused element during a transition by shifting focus to an adjacent item or control inside the update callback.
- **DO**: Use Nested View Transition Groups (`view-transition-group: contain` and `overflow: clip` on `::view-transition-group-children()`) when a captured element inside the scope clips its own overflow and contains nested captured elements.
- **DO**: Attach `transition.ready.catch(() => {})` when rapid interactions can re-trigger `element.startViewTransition()` on the same scope element.
- **DO**: Wrap an inner scope element in a separate named wrapper element if an outer transition needs to animate the component's position while an inner transition is running.
- **DO NOT**: Set `view-transition-name: none` on a scope element that clips its overflow (`overflow: hidden`, `scroll`, or `clip`) or changes its own geometry, as opting out of self-participation disables automatic overflow clipping.

## Fallback strategies

Browser support for Element-scoped view transitions: Limited availability.
Supported by: Chrome 147 (Apr 2026) and Edge 147 (Apr 2026).
Unsupported in: Firefox and Safari.

Baseline status for View transitions: Newly available. It's been Baseline since 2025-10-14.
Supported by: Chrome 111 (Mar 2023), Edge 111 (Mar 2023), Firefox 144 (Oct 2025), and Safari 18 (Sep 2024).

If your Baseline target does not support element-scoped view transitions, degrade gracefully by running the DOM update callback immediately without animation. While you could fall back to `document.startViewTransition()` this is not recommended for isolated component updates, as a document-scoped transition blocks concurrent component transitions and obscures `position: fixed` and `[popover]` elements in the top layer.

```javascript
// Feature detect specifically on Element.prototype (not document.startViewTransition)
const supportsScopedTransition = 'startViewTransition' in Element.prototype;

function runWithTransition(scopeEl, updateDOM) {
  if (!supportsScopedTransition) {
    // Fallback: apply the DOM update immediately without animation
    updateDOM();
    return;
  }

  const transition = scopeEl.startViewTransition(() => {
    updateDOM();
  });

  transition.ready.catch(() => {});
}
```

If you really need to have a fallback using `document.startViewTransition()`, you’ll need to make sure that clipping effects of containers are preserved, as detailed in the [Running an outer transition](#running-an-outer-transition) section. Note that this fallback approach breaks the ability to run multiple view transitions concurrently and will obscure `position: fixed` and `[popover]` elements in the top layer.