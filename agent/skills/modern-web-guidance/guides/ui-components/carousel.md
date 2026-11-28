# Build a carousel

Build a carousel for a finite set of related items. Use native scrolling and CSS scroll snap as the foundation; add HTML previous/next and marker controls, with a small script for wiring them and for status updates. This keeps content and basic scrolling usable without JavaScript.

## Structure and accessibility

- Use a named `region` with `aria-roledescription="carousel"` when the carousel is a meaningful page section. Give each slide `role="group"`, `aria-roledescription="slide"`, and an `aria-label` that includes its position (for example, `aria-label="2 of 4"`). Write the labels in the markup, localized with the rest of the page; if slides change at runtime, regenerate them from the same localized strings. The position is the slide's place in the original sequence, not its current visual position. Keep slide content available to assistive technology.
- Give every control a clear accessible name: use a native `<button>` with a text or `aria-label` name, not an unlabeled chevron.
- Announce the current slide in a visually hidden polite status region after scrolling settles. Update it whenever the visible slide changes, whether through the buttons, the markers, or direct scrolling, so assistive technology receives feedback.
- Ensure that where possible all interactive elements have a target size of at least 24 by 24 CSS pixels, as these provide a way to quickly navigate to each individual slide. This can be achieved by providing undersized elements with enough spacing so that a 24px circle centered on it does not overlap neighboring targets. To do this, make the target itself a little larger than the visible shape with padding, a pseudo-element, or a thin transparent border (with `background-clip: padding-box` so the fill stays on the visible shape), and leave the rest of the spacing to a gap. Do not rely on wide gaps alone, and do not make the invisible area so large that clicks well away from a control activate it. This adheres to the requirements in WCAG 2.5.8 Target Size.
- Ensure that all controls have sufficient contrast, with non-text elements requiring a contrast ratio of at least 3:1 between the non-text content and adjacent colors, in order to adhere to WCAG 1.4.11 Non-text Contrast.
- Ensure that when a previous/next control becomes disabled, causing focus to be lost, that focus is redirected elsewhere, such as the opposite control (e.g. move focus to "Next" if previous becomes disabled and has focus, or move focus to "Previous" if next becomes disabled and has focus).
- The active slide's control must not communicate that it is active through color alone, in order to adhere to WCAG 1.4.1 Use of Color. There must be another visual affordance, such as an outline, or use of a larger height/width, to convey that the control is active.

## Scrolling and controls

- Make the track natively scrollable and snap slides on its scrolling axis. For horizontal carousels, arrange slides in a row and use the inline axis; for vertical carousels, use a column and the block axis.
- Set `overscroll-behavior` to `contain` on the track's scrolling axis (`overscroll-behavior-x` for horizontal, `overscroll-behavior-y` for vertical). A scroll that reaches an end of the track then stays on the carousel instead of scrolling the page or starting a back or forward swipe, which makes repeated swipes at the ends smoother. Do not use the `overscroll-behavior` shorthand: it also contains the other axis, which can stop the page from scrolling while the pointer is over the carousel.
- Use HTML `<button>` elements for previous/next controls and one marker button per slide for direct navigation, in every browser. Do not use `::scroll-button()` or `::scroll-marker` for now.

- Keep controls visible, operable, and clearly focused with `:focus-visible`. Loop previous/next controls continuously from the last slide to the first and back by default when there are at least three slides (see Looping); disable them at the ends only when finite navigation is requested. Preserve native keyboard behavior; do not intercept keys from links, form fields, or buttons. Add custom key handling only for a defined interaction need, and avoid overriding nested controls.

## Related patterns

- For styling the active slide itself, see `carousel-snap-highlights` (via `npx -y modern-web-guidance@latest retrieve "carousel-snap-highlights"`).
- For a continuous progress indicator instead of discrete markers, see `scroll-progress-indicator` (via `npx -y modern-web-guidance@latest retrieve "scroll-progress-indicator"`).
- For scroll-driven slide effects, see `carousel-slide-effects` (via `npx -y modern-web-guidance@latest retrieve "carousel-slide-effects"`).
- For synchronizing other UI with snap events, see `scroll-snap-state-sync` (via `npx -y modern-web-guidance@latest retrieve "scroll-snap-state-sync"`).

## Example: horizontal carousel

This example uses full-width horizontal slides. Adapt the slide sizing for a peek layout or use the block axis for a vertical carousel. Give each marker a name that identifies its destination. The CSS below is split by concern, and only the parts that are easy to get wrong are shown; everything else is described in prose. Adapt dimensions, spacing, and colors to the design.

```html
<section class="carousel" aria-roledescription="carousel" aria-label="Featured products">
  <div class="carousel-controls">
    <button type="button" data-direction="previous">Previous slide</button>
    <button type="button" data-direction="next">Next slide</button>
  </div>

  <div class="carousel-track" tabindex="0" role="group" aria-label="Slides">
    <div role="group" aria-roledescription="slide" aria-label="1 of 3"
        data-marker-name="Go to slide 1">
      <h3>Product one</h3>
    </div>
    <div role="group" aria-roledescription="slide" aria-label="2 of 3"
        data-marker-name="Go to slide 2">
      <h3>Product two</h3>
    </div>
    <div role="group" aria-roledescription="slide" aria-label="3 of 3"
        data-marker-name="Go to slide 3">
      <h3>Product three</h3>
    </div>
  </div>

  <p class="visually-hidden" role="status" aria-live="polite"></p>

  <nav class="carousel-markers" aria-label="Choose a slide"></nav>
</section>
```

### Track and snapping

The track is a flex row that scrolls on the inline axis and snaps to slides. Each slide fills the track and snaps to center.

```css
.carousel-track {
  display: flex;
  gap: 1rem; /* example value */
  overflow-x: auto;
  /* mandatory so the track always rests on a slide, which the settled-scroll status relies on */
  scroll-snap-type: x mandatory;
  /* keep a scroll that reaches either end on the carousel; only the scrolling axis, so the page still scrolls the other way */
  overscroll-behavior-x: contain;
}

.carousel-track > * {
  flex: 0 0 100%; /* one slide per view; use a smaller basis for a peek layout */
  scroll-snap-align: center;
}
```

### Controls

Position the Previous and Next buttons over the track's start and end edges (a `position: absolute` container with a `z-index` so slides don't cover them, and `pointer-events: none` on the container with `pointer-events: auto` on the buttons so the track stays scrollable between them). Build the marker buttons from the slides' `data-marker-name` values, and style the active one with `[aria-current="true"]`.

```css
.carousel-markers button[aria-current="true"] {
  background: #0a5; /* example color; any clear contrast with the other markers works */
}
```

### Supporting styles

Write these to fit the design:

- Style the markers as dots in a centered flex row with a gap, using the pointer cursor.
- Show a clear `:focus-visible` outline on the control and marker buttons.
- Set `touch-action: manipulation` on the track and the control buttons, so quick taps on them do not trigger double-tap zoom on touch devices.
- Keep the status region visually hidden without removing it from the accessibility tree.
- Enable `scroll-behavior: smooth` on the track only inside `@media (prefers-reduced-motion: no-preference)`.

## Fallback strategies

The controls are plain HTML, so the fallbacks below only cover the platform features that the script and CSS rely on. Scrolling and snap behavior remain native, and small amounts of script add the controls' behavior and status updates.

### Scrolling and completion

Baseline status for scroll-behavior: Widely available. It's been Baseline since 2022-03-14.
Supported by: Chrome 61 (Sep 2017), Edge 79 (Jan 2020), Firefox 36 (Feb 2015), and Safari 15.4 (Mar 2022).

Smooth scrolling is optional. The example enables it only when reduced motion is not requested.

Browser support for overscroll-behavior: Limited availability.
Supported by: Chrome 144 (Jan 2026), Edge 144 (Jan 2026), and Firefox 150 (Apr 2026).
Unsupported in: Safari.

Containing overscroll is a progressive enhancement and needs no fallback. Without support, a scroll that reaches an end of the track can scroll the page or start a swipe navigation, and the carousel still works.

Baseline status for scrollend: Newly available. It's been Baseline since 2025-12-12.
Supported by: Chrome 114 (May 2023), Edge 114 (Jun 2023), Firefox 109 (Jan 2023), and Safari 26.2 (Dec 2025).

If `scrollend` is unavailable, use a debounced `scroll` listener to run the settled-scroll handler. Run the initial marker, button, and parking sync once on load, leaving the polite status region empty until user-initiated scrolling settles so page load is not interrupted.

Browser support for Scroll snap events: Limited availability.
Supported by: Chrome 129 (Sep 2024) and Edge 129 (Sep 2024).
Unsupported in: Firefox and Safari.

The carousel does not depend on snap events. If they are unavailable, use settled-scroll tracking for status; use `scrollsnapchange` only when other UI must follow the browser-selected snap target.

### Scroll snap

Baseline status for Scroll snap: Widely available. It's been Baseline since 2020-01-15.
Supported by: Chrome 69 (Sep 2018), Edge 79 (Jan 2020), Firefox 68 (Jul 2019), and Safari 11 (Sep 2017).

The track remains natively scrollable with touch, pointer, and keyboard input. JavaScript adds the controls' behavior and announcements without replacing basic scrolling. Place the script in a `<script type="module">` element so it runs after the document has been parsed.

### Looping

Baseline status for sibling-count() and sibling-index(): Newly available. It's been Baseline since 2026-08-18.
Supported by: Chrome 138 (Jun 2025), Edge 138 (Jun 2025), Firefox 154 (Aug 2026), and Safari 26.2 (Dec 2025).

If `sibling-count()` is unsupported, the script supplies the number of slides instead, so the carousel still loops. Set a `--children-count` custom property on the track only when `CSS.supports("order: sibling-count()")` is false, and read the count in CSS as `var(--children-count, sibling-count())` instead of `sibling-count()`.
Browsers with support never get the property, so they keep counting natively.
Do not wrap the parking rules in `@supports`.

```css
.carousel-track > :first-child {
  /* --children-count is only set where sibling-count() is unsupported */
  order: clamp(0, var(--current) - (var(--children-count, sibling-count()) - 3), 1);
}
```

```js
if (!CSS.supports("order: sibling-count()")) {
  track.style.setProperty("--children-count", track.children.length);
}
```

If content is not static, update the property when slides are added or removed (e.g. via a `MutationObserver`).

### Scroll-driven effects

Baseline status for Scroll-driven animations: Newly available. It's been Baseline since 2026-10-27.
Supported by: Chrome 115 (Jul 2023), Edge 115 (Jul 2023), Firefox 159 (Oct 2026), and Safari 26 (Sep 2025).

Treat slide effects as optional enhancements and keep them inside `@media (prefers-reduced-motion: no-preference)`. The carousel's navigation and current-slide feedback must not depend on them.

## Controls and status updates

Update the active marker as the track scrolls (throttled to one update per animation frame) so the dots keep pace with the visible slide, and run announcements and button state after scrolling settles. Measure only the carousel's scrolling axis.

Write a small script that adapts to your markup and covers these requirements:

- **Wire the HTML controls.** On a Previous or Next click, find the current slide from the track's scroll position along its scrolling axis, then scroll the track to the adjacent slide's snap position in visual order (which differs from DOM order when looping), for example with `track.scrollBy()` using that slide's offset from the track's center. Do not scroll by a fixed viewport width, keep a separate index that can drift from the real scroll position, or use `scrollIntoView()` without limiting it to the track, which can scroll the page. Create one named marker button per slide that scrolls the track to that slide. Keep the Previous and Next buttons before the track in DOM order.
- **Track the current slide** along the carousel's scrolling axis, for horizontal or vertical layouts.
- **Update the active marker live.** From a `scroll` listener throttled with `requestAnimationFrame`, compute the nearest slide and set the active marker's `aria-current="true"` immediately, and also set it from the pending target the moment a marker or Previous/Next button is clicked, so the dots change when the user decides instead of after the slide moves. Skip the write when the current slide is unchanged, and skip the listener entirely while a click or key press has a pending target, because recomputing every frame during a scripted smooth scroll makes Safari stutter.
- **Update the rest after scrolling settles**, from a single handler driven by the settled scroll position: update the buttons' disabled state (and slide parking when looping), and announce "Slide N of M" in the status region only when the settled slide changes from the previously settled slide (keeping initial load and compensating park scrolls silent). Controls only initiate scrolling; they never update state directly.
- **Settle on `scrollend`**, with a debounced `scroll` listener only where `scrollend` is unsupported. Do not run two settle handlers, and do not reorder or re-scroll the track (such as when parking a slide) while a scroll is still in flight, because that cancels it. The one exception is a marker click when looping, whose own scroll replaces the one in flight (see Looping).
- **Resolve clicks from a pending target.** Make rapid previous/next clicks build on the slide already being scrolled to, not on the nearest slide, and clear the target when scrolling settles. Ignore a `scrollend` that arrives after the next scroll has started, because acting on it (such as parking) cancels that scroll. Also ignore a settle at the exact scroll position where a scroll to another slide was just requested: it belongs to an earlier scroll (such as a compensating one), and the requested scroll has yet to move.
- **Respect reduced motion** for any smooth scrolling.

## Looping (continuous navigation)

Loop previous and next navigation from the last slide to the first and back by keeping the track endless instead of disabling controls at the ends (unless the carousel has fewer than three slides or finite navigation is requested). Do not clone slides or move them in the DOM, which conflicts with frameworks and duplicates content for assistive technology. Instead, park an end slide beside the current one with CSS `order`, and only when the carousel is at or one step from that end. Parking one step early puts the neighbor in place before scrolling reaches an end, so the previous and next buttons never disable mid-scroll. The track then always has a neighbor on both sides, and keyboard scrolling, touch, and snapping all keep working. Only the first and last slides ever get `order`. Because parking starts one step before an end, a short carousel can have an end slide parked at every position (with 4 slides, always; with 3, both ends at the middle slide). DOM order applies unchanged only at positions that are more than one step from both ends, which needs 5 or more slides.

- Keep a `--current` custom property on the track: the zero-based index of the current slide. Do not give it a default in CSS: while it is undefined, `order` falls back to 0, so no slide is parked and the carousel starts on the first slide without JavaScript. The script sets it on load. Park the last slide before the first (`order: -1`) when `--current` is `0` or `1`, and park the first slide after the last (`order: 1`) when `--current` is the last or second-to-last index. Set `order` only on the first and last slides (`:first-child` and `:last-child`), not on every slide. `sibling-count()` is needed to find the last indexes. The formulas below are the part that is easy to get wrong.
- When scrolling settles, update `--current` from the scroll position. If the parking changes, measure the current slide's offset along the scrolling axis before and after, then instantly scroll by the difference in the same task so the change is invisible. Turn scroll snapping off (`scroll-snap-type: none`) around the reorder and the compensating scroll and restore it afterward, because some browsers otherwise re-snap to another slide and keep scrolling. Also lock overflow on the scrolling axis (`overflow-x: hidden`, or `overflow-y: hidden` for vertical) for the same step and restore it two animation frames later: Safari on iOS otherwise paints the reordered layout for a frame before the compensating scroll lands, which flickers. Restoring it immediately breaks looping, so keep the delay. This also applies when a parked slide is released after the user leaves an end slide.
- Markers must scroll in sequence order. A parked end slide sits on the opposite side of the track from its place in the sequence, so a direct scroll to it goes the short way round (from the first slide, the last slide's marker would scroll backward one step). On a marker click for any slide other than the current one, set `--current` to `initial` on the track before scrolling, so every slide is back in DOM order for the trip. Do it in the same measured, compensated step as parking, but without the overflow lock: Safari does not start the scroll that follows on a locked track. The settle handler then sets `--current` again, which re-parks. Do not do this for previous/next navigation, which must reach the parked slide to wrap. While the slides are in DOM order, an end slide has no neighbor to wrap to, so a Previous or Next click made during the trip cannot be followed yet. Hold it and replay it when scrolling settles and the slides are parked again, and skip the overflow lock for that parking step too, for the same reason.
- Looping needs at least three slides. Because the compensation is measured, slides may differ in size.
- The previous/next controls and the status calculation must work from visual order, not DOM sibling order. Per-slide labels ("2 of 4") and the status region use each slide's original index, which does not change when slides are parked. Do not renumber slides when `--current` changes.
- Keep `scroll-behavior: smooth` inside `prefers-reduced-motion: no-preference` for user navigation; only the compensating scroll is instant.

```css
/* The first slide parks after the last while --current is the last or second-to-last index. */
.carousel-track > :first-child {
  order: clamp(0, var(--current) - (sibling-count() - 3), 1);
}

/* The last slide parks before the first while --current is 0 or 1. */
.carousel-track > :last-child {
  order: calc(-1 * clamp(0, 2 - var(--current), 1));
}
```

Parking only changes visual order, so the DOM order stays as the reading and focus order, and no slide is inert or aria-hidden.
