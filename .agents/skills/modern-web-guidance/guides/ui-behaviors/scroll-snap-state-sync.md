# Scroll Snap State Sync

Synchronizing UI state with a scrollable container's snap position traditionally required complex scroll event listeners, manual calculations of scroll offsets, and intersection observers. The `scrollsnapchange` event provides a native, efficient way to detect when a scroller has settled on a new snap target, making it useful for synchronizing sidebars or highlighting the active section in a table of contents.

## Implementation

### 1. Configure Scroll Snap in CSS
The container must have `scroll-snap-type` defined, and have children with `scroll-snap-align` for the browser to track snap targets. In a long article with a table of contents, you can use this to snap section headers to the top of the viewport.

```css
main {
  /* Enable scroll snapping on the container */
  scroll-snap-type: y proximity;
  overflow-y: auto;
}

h2 {
  /* Define how headers align when snapped */
  scroll-snap-align: start;
}
```

### 2. Listen for Snap Changes
Use the `scrollsnapchange` event on the scroll container to react when the user finishes scrolling and the browser snaps to a new element, such as highlighting the active link in a table of contents.

```html
<!-- MANDATORY: Wrap table of contents links inside a proper navigation landmark -->
<nav aria-label="Table of contents">
  <ul>
    <li><a href="#section-1" aria-current="location">Section 1</a></li>
    <li><a href="#section-2">Section 2</a></li>
  </ul>
</nav>
```

```javascript
const main = document.getElementById('main');
const links = document.querySelectorAll('nav a');

function setActiveLink(id) {
  for (const link of links) {
    if (link.getAttribute('href') === `#${id}`) {
      link.setAttribute('aria-current', 'location');
    } else {
      link.removeAttribute('aria-current');
    }
  }
}

// The event fires when the scroller settles on a new snap target
main.addEventListener('scrollsnapchange', (event) => {
  // Use snapTargetBlock for vertical or snapTargetInline for horizontal
  const snappedHeader = event.snapTargetBlock;

  if (snappedHeader) {
    setActiveLink(snappedHeader.id);
  }
});
```

## Accessibility

> [!CAUTION]
> While Scroll Snap Events make it possible to visually synchronize other content to the state of the scroller, they do not automatically expose that information programmatically. Relationships between elements, active states, and live content must be reflected in the Accessibility Tree.

For a table of contents, ensure the sidebar links use `aria-current="true"` or `aria-current="location"` when they are active.

In addition, be careful when using the `mandatory` value for `scroll-snap-type`, as it can cause content in-between snap-points to become inaccessible when longer than the screen.

To ensure that people can navigate the scrollable region after selecting an anchor element, apply the corresponding element with a `tabindex="-1"` attribute. This will allow the element to receive focus, and allow people using a keyboard to scroll the container, or easily navigate from that content.

```html
<li><a href="#section-2">Section 2</a></li>
…
<!-- Adding a tabindex="-1" attribute to the heading will mean that it can receive focus after being navigated to -->
<h2 id="section-2" tabindex="-1">Section 2</h2>
```

To ensure consistent operability across different browsers and assistive technology combinations, ensure that the scrollable container can receive focus (by applying `tabindex="0"`), and has an accessible name that describes the content, along with an appropriate role (such as `role="region"`), if it does not already have an implicit role (which elements like `<main>` do).

## Fallback strategies

Browser support for Scroll snap events: Limited availability.
Supported by: Chrome 129 (Sep 2024) and Edge 129 (Sep 2024).
Unsupported in: Firefox and Safari.

If `scrollsnapchange` is not supported, use `IntersectionObserver` to detect which element is currently at the top of the scroller. Note this is different behavior than `scrollsnapchange`, as this will trigger while the scroll happens, rather than only when the scroll has settled.

```javascript
// Feature detect support for scroll snap events
if (!('onscrollsnapchange' in HTMLElement.prototype)) {
  const headers = main.querySelectorAll('h2');
  const observer = new IntersectionObserver(
    () => {
      // Account for any top border on the scroll container so scrollportTop
      // matches the IntersectionObserver root's padding-box top.
      const scrollportTop =
        main.getBoundingClientRect().top + main.clientTop;
      const topEntry = [...headers].reduce((currentTop, header) => {
        // Use the bottom to handle scrolling up, when the top is still offscreen
        const { bottom } = header.getBoundingClientRect();
        // Exclude targets whose bottom has scrolled past the 1px top rootMargin
        if (bottom <= scrollportTop + 1) return currentTop;
        if (!currentTop) return header;
        return bottom < currentTop.getBoundingClientRect().bottom
          ? header
          : currentTop;
      }, undefined);
      if (topEntry) setActiveLink(topEntry.id);
    },
    {
      root: main,
      // Inset top by 1px so adjacent sections stop intersecting when snapped to start
      rootMargin: '-1px 0px 0px 0px',
      // Fire both when a target exits/enters (0) and when a heading settles into view (0.9)
      threshold: [0, 0.9],
    },
  );

  // Observe all snap targets (e.g., section headers)
  headers.forEach((header) => observer.observe(header));
}
```
