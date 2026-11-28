# Triggering Effects After Programmatic Scrolling Completes

When programmatically scrolling to a section or element (especially with `behavior: 'smooth'`), triggering a follow-up action immediately—such as flashing a highlight state, starting an entry animation, or moving focus—causes the effect to run while the target is still off-screen or mid-scroll.

Previously, developers had to guess the scroll duration with `setTimeout()` (which fires too early on long scrolls and too late on short ones) or manually wrap a `scrollend` event listener in a `Promise` with a fallback timer (because `scrollend` does not fire when the target is already in view and no scrolling occurs).

The programmatic scroll methods on `Element` (`scrollIntoView()`, `scroll()`, `scrollTo()`, `scrollBy()`) and `Window` (`scroll()`, `scrollTo()`, `scrollBy()`) return a `Promise` that resolves when the scroll operation completes. If the target is already at the requested scroll position and no scrolling is needed, the returned `Promise` resolves immediately without hanging.

## Implementation

1. **Mark the handler as `async`**: Use an `async` function for the event listener or navigation handler that triggers the scroll.
2. **Await the scroll method directly**: Call `await element.scrollIntoView({ behavior: 'smooth', ... })` (or `await element.scrollTo(...)`, `await window.scrollTo(...)`, etc.). Execution pauses until the browser finishes the scroll animation and the scroll position settles.
3. **Apply the post-scroll effect**: Toggle the highlight class, start the animation, or move focus after the `await` expression completes.

## Interrupted Scrolls & Focus Management

- **Handling rapid / interrupted scrolls**: If a new scroll starts on the same scroll container before an ongoing smooth scroll finishes, the browser aborts the ongoing smooth scroll and **resolves** (does not reject) all pending scroll promises on that container. If you need to suppress the post-scroll effect for superseded scrolls when a user clicks rapidly, track an incrementing operation ID and return early after `await` if a newer scroll was started:

```javascript
let currentScrollId = 0;
const sections = document.querySelectorAll('section');

async function scrollToAndHighlight(targetElement) {
  const scrollId = ++currentScrollId;
  sections.forEach((sec) => sec.classList.remove('highlight'));

  await targetElement.scrollIntoView({ behavior: 'smooth', block: 'center' });

  // Abort follow-up effect if another scroll was triggered while awaiting
  if (scrollId !== currentScrollId) return;

  targetElement.classList.add('highlight');
}
```

- **Focusing the target after scrolling**: When moving keyboard focus to the target element (or a heading inside it with `tabindex="-1"`) after `await targetElement.scrollIntoView(...)`, pass `{ preventScroll: true }` to `focus()` so the focus call does not initiate a second, competing scroll:

```javascript
await targetElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
targetHeading.focus({ preventScroll: true });
```

## Constraints & Best Practices

- **MANDATORY**: Await the `Promise` returned directly by `scrollIntoView()`, `scroll()`, `scrollTo()`, or `scrollBy()` rather than guessing scroll durations with `setTimeout()`.
- **DO NOT** wrap `scrollend` in a manual `new Promise()` as your primary implementation—`scrollend` does not fire when the target is already in view and no scroll distance is traveled, whereas scroll method promises resolve automatically in that case.
- **DO**: Pass `{ preventScroll: true }` when calling `.focus()` after awaiting a scroll method so the browser does not jump or scroll a second time.
- **DO**: Guard post-scroll effects with a request token if rapid user interactions can trigger overlapping smooth scrolls on the same container, since interrupting a smooth scroll resolves (rather than rejects) the previous promise.
- **Known Chrome bug with the root scroller**: Chrome has a bug where the `Promise` returned by `scrollIntoView()` resolves too early when it is the document's root scroller that is scrolling. Awaiting a `scrollIntoView()` on a nested scroll container works as expected. Do not wrap your content in a scroll container, such as `div` with `overflow-y: auto`, as a workaround for this bug.

## Accessibility considerations

Ensure that the control used to trigger scrolling has an appropriate role. If the scrolling is intended to redirect the user elsewhere in the current context, then use a `<a>` element with a `href` attribute, so that it receives an implicit `link` role, along with the expected keyboard interactions. Redirect focus to this location scrolled to, so that people can continue navigating from the location that they are redirected to.

**DON'T** provide important information solely through visual design updates upon completion of programmatic scrolling. If there is important information that needs to be conveyed as a result of this interaction, ensure that this is available in sufficiently contrasting text, and that this is conveyed to people using screen readers through use of an ARIA live region.

## Fallback strategies

Browser support for Scroll method promises: Limited availability.
Supported by: Chrome 150 (Jun 2026) and Edge 150 (Jul 2026).
Unsupported in: Firefox and Safari.

In browsers that do not support scroll method promises, `scrollIntoView()`, `scroll()`, `scrollTo()`, and `scrollBy()` return `undefined` instead of a `Promise`.

- **Progressive enhancement (default `await` behavior)**: Because `await undefined` is valid JavaScript that resolves immediately on the next microtask, writing `await element.scrollIntoView({ behavior: 'smooth' })` will not throw an error in unsupported browsers. Instead, it degrades gracefully by running the post-scroll code as soon as the scroll begins. For non-critical visual flourishes like a temporary highlight, this is often sufficient.
- **Faithful fallback (`scrollend` + timeout)**: If your Baseline target does not support `scroll-promises` and the post-scroll action must wait until scrolling finishes in older browsers, check whether the return value is a `Promise` (`result instanceof Promise`). When it is `undefined`, wait for the `scrollend` event on the scroll container with a short fallback timeout in case the element is already in view and no scrolling occurs:

```javascript
function scrollIntoViewAsync(element, options, scroller = window) {
  const result = element.scrollIntoView(options);

  // Feature detect: in supporting browsers, scrollIntoView() returns a Promise
  if (result instanceof Promise) {
    return result;
  }

  // Fallback for browsers where scrollIntoView() returns undefined
  return new Promise((resolve) => {
    let timeoutId;

    const finish = () => {
      clearTimeout(timeoutId);
      scroller.removeEventListener('scrollend', finish);
      scroller.removeEventListener('scroll', onScroll);
      resolve();
    };

    const onScroll = () => {
      // Restart the idle timer on every scroll event. If scrollend never fires
      // (browsers without scrollend support), this resolves once scrolling goes idle.
      clearTimeout(timeoutId);
      timeoutId = setTimeout(finish, 100);
    };

    scroller.addEventListener('scrollend', finish, { once: true });
    scroller.addEventListener('scroll', onScroll, { passive: true });

    // If no scroll event fires within the idle window (e.g., already in view), resolve.
    // 100ms is an example value; it only needs to exceed the gap between scroll events.
    timeoutId = setTimeout(finish, 100);
  });
}
```
