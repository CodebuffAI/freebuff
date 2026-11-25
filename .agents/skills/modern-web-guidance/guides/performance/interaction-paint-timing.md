# Measure interaction and soft-navigation paint timing

Standard paint and responsiveness metrics leave a measurement gap after the initial page load:

- **`LargestContentfulPaint` (`largest-contentful-paint`)** only measures the initial ("hard") document load and stops emitting entries as soon as the user first interacts with the page.
- **`PerformanceEventTiming` and `event` / Interaction to Next Paint (INP)** measures input responsiveness up to the *very next frame* (such as a button active state or loading spinner), but does not track subsequent asynchronous paints—such as new content rendered after a `fetch()` resolves, or a client-side route transition completes.
- Observing route changes in a Single Page App (SPA) can be difficult outside of framework code. Just monitoring URL updates can over report URL changes that are not linked to route changes (for example, anchor link changes, multiple "redirects" for a single route change).

The `InteractionContentfulPaint` (`interaction-contentful-paint`) and `PerformanceSoftNavigation` (`soft-navigation`) performance entry types fill this gap. They propagate interaction causality across asynchronous tasks (`fetch`, `await`, `setTimeout`) to attribute new contentful paints and Single-Page Application (SPA) route transitions directly back to the user interaction that triggered them.

## How to implement

### 1. Observe contentful paints triggered by interactions

Use a `PerformanceObserver` with `type: 'interaction-contentful-paint'` and `buffered: true` to observe progressively larger contentful paints attributable to any user interaction.

Each `InteractionContentfulPaint` entry provides:
- `interactionId`: The unique identifier of the initiating user interaction (matching `PerformanceEventTiming.interactionId` and `PerformanceSoftNavigation.interactionId`).
- `startTime`: The timestamp when the initiating user interaction started, relative to the initial hard navigation time origin.
- `paintTime` and `presentationTime`: When the rendering phase ended and when the painted pixels were drawn on screen.
- `duration`: The elapsed time from interaction start to paint presentation (`presentationTime - startTime`).
- `largestContentfulPaint`: A snapshot `LargestContentfulPaint` object containing details about the largest painted element for that interaction so far (`element`, `size`, `url`, `id`, `renderTime`, `loadTime`).

```javascript
/**
 * Observes contentful paints caused by user interactions and invokes a callback
 * whenever an interaction produces a larger contentful paint.
 *
 * @param {(entry: PerformanceEntry) => void} onInteractionPaint
 */
export function observeInteractionPaints(onInteractionPaint) {
  // Feature-detect support before calling observe() so unsupported browsers
  // do not throw or log console warnings.
  if (
    typeof PerformanceObserver === 'undefined' ||
    !PerformanceObserver.supportedEntryTypes?.includes('interaction-contentful-paint')
  ) {
    return null;
  }

  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      // entry.duration is already calculated as (entry.presentationTime - entry.startTime),
      // giving the total time from the user interaction to this contentful paint.
      onInteractionPaint(entry);
    }
  });

  // MANDATORY: Pass buffered: true to capture interaction paints that occurred
  // before this observer was registered.
  observer.observe({ type: 'interaction-contentful-paint', buffered: true });
  return observer;
}
```

### 2. Measure Largest Contentful Paint (LCP) for SPA soft navigations

A soft navigation is emitted by the browser when a trusted user interaction causes both a visible URL change and a contentful paint. To calculate LCP for each soft navigation:

1. Observe both `'soft-navigation'` and `'interaction-contentful-paint'` entries with `buffered: true`.
2. **MANDATORY:** When a `'soft-navigation'` entry is received, seed its initial LCP candidate by calling `softNavEntry.getLargestInteractionContentfulPaint()`. If the application painted content *before* updating the URL (for example, rendering a view and then calling `history.pushState()`), those early `interaction-contentful-paint` entries were emitted before the `soft-navigation` entry and still carry the *previous* `navigationId`.
3. **MANDATORY:** Correlate subsequent `'interaction-contentful-paint'` entries to the active soft navigation by matching `entry.interactionId === softNavEntry.interactionId`, **DO NOT** match by `entry.navigationId`. Using `interactionId` ensures you include paints that occurred before the URL update and exclude paints from later, unrelated interactions on the new route.

```javascript
/**
 * Tracks FCP and LCP for each client-side soft navigation and reports finalized
 * route metrics when the user navigates to a new route or hides the page.
 *
 * @param {(report: {
 *   url: string,
 *   navigationId: number,
 *   interactionId: number,
 *   fcpDuration: number,
 *   lcpDuration: number | null,
 *   lcpElement: Element | null,
 *   lcpSize: number | null
 * }) => void} onSoftNavReport
 */
export function trackSoftNavigationLCP(onSoftNavReport) {
  const supported =
    typeof PerformanceObserver !== 'undefined' &&
    PerformanceObserver.supportedEntryTypes?.includes('soft-navigation') &&
    PerformanceObserver.supportedEntryTypes?.includes('interaction-contentful-paint');

  if (!supported) {
    return null;
  }

  let activeSoftNav = null;
  let activeLcpEntry = null;

  function finalizeCurrentSoftNav() {
    if (!activeSoftNav) return;

    onSoftNavReport({
      // activeSoftNav.name holds the destination URL of the soft navigation.
      url: activeSoftNav.name,
      navigationId: activeSoftNav.navigationId,
      interactionId: activeSoftNav.interactionId,
      // activeSoftNav.duration is (activeSoftNav.presentationTime - activeSoftNav.startTime),
      // which represents First Contentful Paint (FCP) relative to interaction start.
      fcpDuration: activeSoftNav.duration,
      // activeLcpEntry.duration is (activeLcpEntry.presentationTime - activeSoftNav.startTime),
      // representing the soft navigation's LCP duration relative to interaction start.
      lcpDuration: activeLcpEntry ? activeLcpEntry.duration : null,
      lcpElement: activeLcpEntry?.largestContentfulPaint?.element ?? null,
      lcpSize: activeLcpEntry?.largestContentfulPaint?.size ?? null,
    });

    activeSoftNav = null;
    activeLcpEntry = null;
  }

  const softNavObserver = new PerformanceObserver((list) => {
    for (const softNavEntry of list.getEntries()) {
      // Finalize the previous route's metrics before resetting state for the new route.
      finalizeCurrentSoftNav();

      activeSoftNav = softNavEntry;
      // MANDATORY: Seed the LCP candidate with getLargestInteractionContentfulPaint()
      // to capture any attributed contentful paints that occurred before the URL updated.
      activeLcpEntry = softNavEntry.getLargestInteractionContentfulPaint();
    }
  });

  const icpObserver = new PerformanceObserver((list) => {
    for (const icpEntry of list.getEntries()) {
      // MANDATORY: Match by interactionId (not navigationId) so only paints caused
      // by the soft navigation's initiating interaction update the route's LCP.
      if (activeSoftNav && icpEntry.interactionId === activeSoftNav.interactionId) {
        activeLcpEntry = icpEntry;
      }
    }
  });

  softNavObserver.observe({ type: 'soft-navigation', buffered: true });
  icpObserver.observe({ type: 'interaction-contentful-paint', buffered: true });

  // Finalize the active route's LCP when the page is backgrounded or unloaded.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      finalizeCurrentSoftNav();
    }
  });

  return { softNavObserver, icpObserver, finalizeCurrentSoftNav };
}
```

### 3. Measure Core Web Vitals across soft navigations with `web-vitals`

If your goal is to report standard Core Web Vitals (LCP, CLS, and INP) across both hard and soft navigations to an analytics endpoint, use the `web-vitals` library (v6.0.0+) with `{ reportSoftNavs: true }` rather than manually slicing every metric timeline.

```javascript
import { onLCP, onFCP, onCLS, onINP } from 'web-vitals';

function sendToAnalytics(metric) {
  // Example-only endpoint; replace with your real telemetry URL.
  navigator.sendBeacon(
    '/analytics',
    JSON.stringify({
      name: metric.name,
      value: metric.value,
      navigationType: metric.navigationType,
      navigationURL: metric.navigationURL,
    }),
  );
}

// Pass { reportSoftNavs: true } to report metrics per soft navigation in addition
// to the initial hard navigation.
onLCP(sendToAnalytics, { reportSoftNavs: true });
onFCP(sendToAnalytics, { reportSoftNavs: true });
onCLS(sendToAnalytics, { reportSoftNavs: true });
onINP(sendToAnalytics, { reportSoftNavs: true });
```

## Best practices

- **DO** feature-detect `'interaction-contentful-paint'` and `'soft-navigation'` using `PerformanceObserver.supportedEntryTypes?.includes(...)` before calling `observer.observe()`.
- **DO** pass `{ buffered: true }` when observing `'interaction-contentful-paint'` and `'soft-navigation'` so early entries are not missed if analytics code initializes asynchronously.
- **DO** call `softNavEntry.getLargestInteractionContentfulPaint()` when handling a new `soft-navigation` entry so paints that occurred prior to the URL update are included in LCP.
- **DO** match `interaction-contentful-paint` entries to a soft navigation using `interactionId`, not `navigationId`.
- **DO** use `entry.duration` (or `entry.presentationTime - entry.startTime`) to measure interaction paint latency, rather than reporting `entry.presentationTime` directly. All `PerformanceEntry` timestamps are measured from the initial hard page load time origin, not from the soft navigation start.
- **DO NOT** rely on `performance.getEntriesByType('soft-navigation')` to monitor long-lived single-page applications, as the browser's buffer is limited to the first 50 soft navigation entries.

## Fallback strategies

Browser support for Interaction contentful paint performance entries: Limited availability.
Supported by: Chrome 151 (Jul 2026) and Edge 151 (Jul 2026).
Unsupported in: Firefox and Safari.

Browser support for Soft navigation performance entries: Limited availability.
Supported by: Chrome 151 (Jul 2026) and Edge 151 (Jul 2026).
Unsupported in: Firefox and Safari.

If your Baseline target includes browsers that do not support `InteractionContentfulPaint` or `PerformanceSoftNavigation`, treat these APIs as a progressive enhancement for Real User Monitoring (RUM):

1. **Feature detection and graceful degradation:** Guard observer registration with `PerformanceObserver.supportedEntryTypes?.includes('interaction-contentful-paint')` and `PerformanceObserver.supportedEntryTypes?.includes('soft-navigation')`. In browsers lacking support, skip registering the observers so your application runs without throwing errors.
2. **Keep standard hard-navigation observers active:** Continue observing standard `'largest-contentful-paint'`, `'event'`, and `'layout-shift'` entries across all browsers. Because `LargestContentfulPaint` is finalized on the first user interaction regardless of soft-navigation support, measuring soft navigations in supporting browsers does not alter or break initial hard-load LCP measurements.
