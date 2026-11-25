# Identify causes of poor INP

Poor responsiveness to interactions leads to a poor impression of a page being slow or even completely broken. Interaction to Next Paint (INP) is a metric based on the Event Timing API. It measures the worst interaction (minus some outliers) as a measure of the page's responsiveness.

Identifying root causes of an unresponsive web page can be tricky especially as it depends on user interactions and environmental conditions such as device capabilities and network conditions. This makes it even more difficult to diagnose compared to a more repeatable and predictable scenario like page load. Lab data only replicates a small subset of real user scenarios so measuring the causes of slow INP in the field is essential.

The Event Timing API allows for splitting the INP duration into three subparts: Input Delay (processing that is already happening when the interaction happens), Processing Duration (delays due as a direct result of the interaction), and Presentation Delay (delays that are due to rendering the next frame after the interaction). This helps identify if the issue is in other code, the interaction JavaScript code, or browser processing rendering updates respectively rather than jumping straight to the interaction code.

It is possible to gather further insights into JavaScript, style recalculation, and layout work delaying an interaction. A full performance trace using the JS Self-Profiling API is a heavyweight solution that is liable to cause performance problems. The Long Animation Frames API is a lightweight API that can be used in the field to identify slow-running JavaScript and distinguish between style recalculation and layout costs during INP interactions:

- **Script-level forced style and layout (`forcedStyleDuration` and `forcedLayoutDuration`):** Reports synchronous style recalculations (such as calling `getComputedStyle()` after DOM mutations) and forced layouts/reflows (such as reading `getBoundingClientRect()` or `offsetWidth` after mutations) inside a running script during **Input Delay** or **Processing Duration**.
- **Frame-level rendering style and layout (`styleDuration` and `layoutDuration`):** Reports time spent recalculating styles versus updating layout during the frame's rendering update, helping explain high **Presentation Delay**.

Distinguishing style recalculation from layout is critical because they have different root causes and fixes: high style duration points to expensive CSS selector matching or broad style invalidation (remediated by simplifying selectors or reducing rule scope), whereas high layout duration points to expensive geometry calculations or synchronous layout thrashing (remediated by batching DOM reads before writes, simplifying DOM structure, or using CSS containment).

## How to implement

Calculating INP from the raw Event Timing API is complicated and has several nuances. You are advised to use a RUM tool or library to gather this data.

`web-vitals` is an open-source library from Google that calculates the Core Web Vitals including INP, and also includes subparts and long animation frame data for the INP interaction.

## Get attributions for INP interactions using web-vitals library

The `web-vitals` library is a tiny library used to measure Core Web Vitals and other performance metrics. The `onINP()` function can be used to identify the slowest interaction and includes information about the INP subparts, scripts that were executed during the interaction, and style and layout durations using the Long Animation Frames API.

```javascript
// Use the attribution build to get Long Animation Frame data
// alongside the INP metric value.
import { onINP } from 'web-vitals/attribution';

onINP((metric) => {
  const { attribution } = metric;
  const longestScript = attribution.longestScript;

  // Sum rendering-phase style and layout durations across all LoAF entries
  // intersecting the INP interaction (primarily explains presentationDelay).
  let renderStyleDuration = 0;
  let renderLayoutDuration = 0;
  for (const entry of attribution.longAnimationFrameEntries) {
    renderStyleDuration += entry.styleDuration ?? 0;
    renderLayoutDuration += entry.layoutDuration ?? 0;
  }

  // Beacon script, style, and layout attribution for the INP interaction,
  // so you can identify the root cause in production.
  navigator.sendBeacon(
    '/analytics',
    JSON.stringify({
      name: 'INP',
      value: metric.value,
      // These fields give the INP subparts:
      inputDelay: attribution.inputDelay,
      presentationDelay: attribution.presentationDelay,
      processingDuration: attribution.processingDuration,
      interactionTarget: attribution.interactionTarget,
      // These fields identify which script function was responsible
      // for the longest processing during the INP interaction.
      invokerType: longestScript?.entry?.invokerType,
      sourceURL: longestScript?.entry?.sourceURL,
      sourceFunctionName: longestScript?.entry?.sourceFunctionName,
      sourceCharPosition: longestScript?.entry?.sourceCharPosition,
      // subpart indicates which phase (input delay, processing, or
      // presentation delay) the longest script overlapped with most.
      subpart: longestScript?.subpart,
      intersectingDuration: longestScript?.intersectingDuration,
      // Synchronous style and layout work forced inside the longest script
      // (with forcedStyleAndLayoutDuration as a combined fallback):
      forcedStyleDuration: longestScript?.entry?.forcedStyleDuration,
      forcedLayoutDuration: longestScript?.entry?.forcedLayoutDuration,
      forcedStyleAndLayoutDuration: longestScript?.entry?.forcedStyleAndLayoutDuration,
      // Rendering-phase style and layout work across the interaction's frames
      // (with totalStyleAndLayoutDuration as a combined fallback):
      renderStyleDuration,
      renderLayoutDuration,
      totalStyleAndLayoutDuration: attribution.totalStyleAndLayoutDuration
    })
  );
});
```

## Best Practices

- **DO** use INP subparts initially to identify whether the delay is already running JavaScript (input delay), the event handlers JavaScript for the interaction (processing duration), or the subsequent rendering (presentation delay).
- **DO** attempt to identify the biggest blocking JavaScript as additional detail, particularly for input delay, and processing duration.
- **DO** distinguish between style recalculation (`styleDuration`, `forcedStyleDuration`) and layout (`layoutDuration`, `forcedLayoutDuration`) when diagnosing high processing duration or presentation delay: high style times indicate expensive CSS selectors or broad invalidations, while high layout times indicate DOM geometry bottlenecks or synchronous layout thrashing.
- **DO** prefer the Long Animation Frames API for providing this further detail over alternatives like the JS Self-Profiling API, which carries higher runtime overhead.
- **DO** use the `web-vitals` library if no other RUM solution is in place. It can identify the INP interaction and includes information about the subparts and the scripts that were executed during the interaction (using the Long Animation Frames API).
- **DO** beacon back the required information to an analytics service rather than just log it locally.

## Browser support and fallback strategies

Baseline status for Event timing performance entries: Newly available. It's been Baseline since 2025-12-12.
Supported by: Chrome 76 (Jul 2019), Edge 79 (Jan 2020), Firefox 89 (Jun 2021), and Safari 26.2 (Dec 2025).

The Event Timing API is available in most modern browsers and is necessary to calculate INP and the INP subparts. For browsers that do not support this API INP cannot be measured.

Browser support for Long animation frames performance entries: Limited availability.
Supported by: Chrome 123 (Mar 2024) and Edge 123 (Mar 2024).
Unsupported in: Firefox and Safari.

The Long Animation Frames API provides optional, additional details. It can be safely used without fallbacks. In most cases the performance opportunities it identifies will apply to other browsers as well.

If your Baseline target supports the Long Animation Frames API (`long-animation-frames`) but does not support separate style and layout duration properties (`styleDuration` and `layoutDuration` on `PerformanceLongAnimationFrameTiming`, or `forcedStyleDuration` and `forcedLayoutDuration` on `PerformanceScriptTiming`), fall back to the combined style-and-layout timings:
- Use `script.forcedStyleAndLayoutDuration` on `PerformanceScriptTiming` for synchronous forced style and layout work inside scripts.
- Use `metric.attribution.totalStyleAndLayoutDuration` in `web-vitals/attribution` (or compute `(entry.paintTime || entry.startTime + entry.duration) - entry.styleAndLayoutStart` on each `PerformanceLongAnimationFrameTiming` entry) for combined style and layout work.
