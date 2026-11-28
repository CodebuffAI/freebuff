# Scroll Snap Real-Time Feedback

## Overview
Users expect immediate visual feedback when interacting with UI elements like carousels or galleries. Traditional scroll snap only provides feedback *after* the scroll gesture completes and the element settles. By using Scroll Snap Events, specifically `scrollsnapchanging`, you can provide real-time feedback during the scroll gesture, highlighting the pending snap target before the user releases their touch or mouse.

## Implementation

### 1. Listen for `scrollsnapchanging`
Attach an event listener for `scrollsnapchanging` to the scroll container. This event fires when the browser determines a new snap target is likely to be selected.

```javascript
const container = document.querySelector('#gallery');
const thumbnails = document.querySelectorAll('.thumbnail');
const items = document.querySelectorAll('.gallery-item');

container.addEventListener('scrollsnapchanging', (event) => {
  // Highlight pending snap target during scroll for real-time feedback.
  const pendingTarget = event.snapTargetInline;
  const index = [...items].indexOf(pendingTarget);

  if (index === -1 || !thumbnails[index]) return;

  // Use lightweight class toggle to avoid layout thrashing during rapid events.
  // Note: aria-current is NOT toggled here. It tracks the settled "current"
  // item, which is updated in the scrollsnapchange handler below.
  thumbnails.forEach((thumb) => thumb.classList.remove('pending'));
  thumbnails[index].classList.add('pending');
});
```

This example uses `snapTargetInline` because the gallery scrolls horizontally. If your scroll container scrolls vertically, use `snapTargetBlock` instead.

### 2. Listen for `scrollsnapchange`
To finalize the state when the scroll gesture completes and the element actually snaps, listen for the `scrollsnapchange` event. This is required to establish the final active state.

```javascript
container.addEventListener('scrollsnapchange', (event) => {
  // Promote pending state to active on scroll completion.
  const snappedTarget = event.snapTargetInline;
  const index = [...items].indexOf(snappedTarget);

  if (index === -1 || !thumbnails[index]) return;

  // Establish final active state and clean up pending.
  thumbnails.forEach((thumb) => {
    thumb.classList.remove('pending', 'active');
    thumb.removeAttribute('aria-current');
  });
  thumbnails[index].classList.add('active');
  thumbnails[index].setAttribute('aria-current', 'true');
});
```

### 3. Sync initial state
When the page loads, the scroll position might be restored by the browser (e.g., via history traversal or an anchor link). Neither `scrollsnapchange` nor `scroll` events will fire automatically. Run a one-off geometric check to sync the UI with the initial scroll position.

```javascript
// Note: For item.offsetLeft to be relative to the container, 
// the container MUST be the offsetParent (e.g., `position: relative`).
const findClosestItemIndex = () => {
  // Center-distance assumes scroll-snap-align: center on items.
  // For start-aligned snap, compare scrollLeft to item.offsetLeft directly.
  const containerCenter = container.scrollLeft + container.clientWidth / 2;
  let closestIndex = 0;
  let minDistance = Infinity;

  items.forEach((item, index) => {
    const itemCenter = item.offsetLeft + item.offsetWidth / 2;
    const distance = Math.abs(containerCenter - itemCenter);
    if (distance < minDistance) {
      minDistance = distance;
      closestIndex = index;
    }
  });
  return closestIndex;
};

const initActiveItem = () => {
  const closestIndex = findClosestItemIndex();
  if (!thumbnails[closestIndex]) return;

  thumbnails.forEach((thumb) => {
    thumb.classList.remove('pending', 'active');
    thumb.removeAttribute('aria-current');
  });
  thumbnails[closestIndex].classList.add('active');
  thumbnails[closestIndex].setAttribute('aria-current', 'true');
};

if (document.readyState === 'complete') {
  initActiveItem();
} else {
  window.addEventListener('load', initActiveItem, { once: true });
}
```

## Accessibility considerations

If creating a carousel or gallery pattern, which has associated controls for navigation:

1. Ensure that parity is maintained between the controls that relate to the scroll container, and the content displayed in the scroll container. The correct state of the associated controls must be updated (using `aria-current="true"`) as the scroll container updates, so that people can determine the current content.
2. Wrap the entire component in a `<section>` element, with an accessible name. Give the element a `focusgroup="toolbar wrap"` property, updating the value to match the visual design used. This will manage focus and provide a roving tabindex behaviour for the controls.
3. Ensure that the name for the button matches the text/description in the scroll-container that it controls. This way, people reading through the content can understand the relationship between the control and the content it displays.

> [!NOTE]
> This pattern does not represent a traditional carousel component in which slides typically automatically change, in a way that doesn't allow people to pause or stop the transition, or accurately communicate the visible information to people using screen readers. If the intended use case is a carousel that only presents a single slide at any time and automatically transitions between slides, then do not use this technique, as it lacks the accessibility information required for such a component. Instead, opt for a tab-like implementation, ensuring that the carousel can be operated using a keyboard alone, that the carousel can be paused or stopped, and that the semantic information including the name, role, and state, is accurately conveyed to people using screen readers. Making carousel components accessible to everyone is highly nuanced and context-dependent; be sure to refer to established accessibility standards and perform thorough user testing for production environments.

To ensure consistent operability across different browsers and assistive technology combinations, ensure that the scrollable container can receive focus (by applying `tabindex="0"`), and has an accessible name that describes the content, along with an appropriate role (such as `role="region"`).

## Fallback strategies
Browser support for Scroll snap events: Limited availability.
Supported by: Chrome 129 (Sep 2024) and Edge 129 (Sep 2024).
Unsupported in: Firefox and Safari.

Baseline status for Scroll snap: Widely available. It's been Baseline since 2020-01-15.
Supported by: Chrome 69 (Sep 2018), Edge 79 (Jan 2020), Firefox 68 (Jul 2019), and Safari 11 (Sep 2017).

For browsers that do not support `scrollsnapchanging`, the UI will not provide eager feedback during the scroll gesture by default, and the linked UI will desynchronize from the content.

**MANDATORY:** Provide a fallback for browsers without support, or the linked UI will desynchronize from the content.

**DO** simulate the real-time nature of `scrollsnapchanging` with a `scroll` event listener coupled with `requestAnimationFrame` and geometric distance calculations to determine the closest snap target while the user is actively scrolling.

```javascript
if ('onscrollsnapchanging' in HTMLElement.prototype) {
  // Use native scroll snap events
} else {
  // Fallback: use scroll + requestAnimationFrame for eager feedback
  // (assumes the same container, thumbnails, items defined in step 1)
  let scrollTimeout;
  let rafId = null;

  const promotePendingToActive = () => {
    const closestIndex = findClosestItemIndex();
    if (!thumbnails[closestIndex]) return;
    thumbnails.forEach((thumb) => {
      thumb.classList.remove('pending', 'active');
      thumb.removeAttribute('aria-current');
    });
    thumbnails[closestIndex].classList.add('active');
    thumbnails[closestIndex].setAttribute('aria-current', 'true');
  };

  container.addEventListener('scroll', () => {
    if (rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = null;
      const closestIndex = findClosestItemIndex();
      if (!thumbnails[closestIndex]) return;

      // DO NOT forget to clean up stale pending classes
      thumbnails.forEach((thumb) => thumb.classList.remove('pending'));
      thumbnails[closestIndex].classList.add('pending');
    });

    // Debounce fallback for browsers that don't support scrollend
    clearTimeout(scrollTimeout);
    scrollTimeout = setTimeout(promotePendingToActive, 100);
  }, { passive: true });

  // Fallback: use Baseline `scrollend` event to promote pending to active cleanly where supported
  container.addEventListener('scrollend', () => {
    clearTimeout(scrollTimeout);
    promotePendingToActive();
  });
}
```

The geometric `scroll` + `requestAnimationFrame` fallback closely emulates the behavior of native snap prediction, including handling programmatic scrolling correctly. Because functions like `scrollIntoView` naturally fire `scroll` events during their execution, the UI will stay smoothly synchronized throughout the scroll animation without requiring additional custom logic.

### Fallbacks & browser support for focusgroup

Browser support for focusgroup: Limited availability.
Supported by: Chrome 150 (Jun 2026) and Edge 150 (Jul 2026).
Unsupported in: Firefox and Safari.

Keep `focusgroup="toolbar wrap"` in the markup. If `'focusGroup' in HTMLElement.prototype` is false, implement a roving tabindex pattern on the gallery controls, and manually apply a `role="toolbar"` to the container. Never install it when native focusgroup is present.

```js
if (!('focusGroup' in HTMLElement.prototype)) {
  document.querySelectorAll('[focusgroup~="toolbar"]').forEach(group => {
    group.setAttribute('role', 'toolbar');

    const items = () => [...group.querySelectorAll('button')]
      .filter(item => item.closest('[focusgroup]') === group)
      .filter(item => !item.disabled && item.getAttribute('aria-disabled') !== 'true');

    const syncTabIndex = () => {
      const list = items();
      let current = list.indexOf(document.activeElement);

      if (current < 0) {
        current = list.indexOf(list.find(item => item.getAttribute('aria-current') === 'true'));
      }

      list.forEach((item, index) => {
        item.tabIndex = current === index ? 0 : -1;
      });
    };

    group.addEventListener('focusin', syncTabIndex);
    group.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      const list = items();
      const current = list.indexOf(document.activeElement);
      if (current < 0) return;
      const next = (current + (event.key === 'ArrowLeft' ? -1 : 1) + list.length) % list.length;
      event.preventDefault();
      event.stopImmediatePropagation();
      list.forEach((item, index) => {
        item.tabIndex = index === next ? 0 : -1;
      });
      list[next].focus({ preventScroll: true });
    }, true);

    syncTabIndex();
  });
}
```