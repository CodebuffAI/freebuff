# Build Carousel Slide Effects

Carousel slide effects are a great way to add visual interest to a carousel. As the user scrolls through the slides, each slide can animate as it enters, centers, and exits the scrollport. For example, the slides can fade in and out, rotate, or scale in size. This creates a dynamic and engaging user experience. Unlike simple entry/exit animations, this effect uses a single, continuous animation to control the slide's appearance across the entire scrollport.

## How to implement

Here’s how to create carousel slide effects:

1.  **Create a scroller:** This element will act as the container for your carousel slides. In this example it uses `overflow-x: scroll` to allow horizontal scrolling. When the slides contain no focusable elements, give the scroller `tabindex="0"` and an accessible name, because not every browser makes a scroll container keyboard-focusable. The name needs a role that supports one: a `<ul>` already has the `list` role, but a `<div>` needs one, for example `role="region"`.

    ```html
    <!-- The slides contain no focusable elements, so the scroller takes focus itself. The label is an example. -->
    <ul class="scroller" tabindex="0" aria-label="Slides">
      <li class="entry">1</li>
      <li class="entry">2</li>
      <li class="entry">3</li>
      …
    </ul>
    ```

    ```css
    .scroller {
      overflow-x: scroll;
    }
    ```

    Optionally, add `scroll-snap-type: x mandatory` on the scroller and `scroll-snap-align: center` on the slides if you want items to snap cleanly to the center state when scrolling stops.

2.  **Define the animation:** Create a CSS animation that defines the different states of your slides as they traverse the scrollport. You can define keyframes for any part of the animation. For example, you can define a state for when the slides are in the center of the scrollport by including a `50%` keyframe. In this example, the `scale` property makes the slides grow as they approach the center and shrink as they move away.

    ```css
    @keyframes animate {
      0% {
        scale: 0.5;
      }
      50% {
        scale: 1;
      }
      100% {
        scale: 0.5;
      }
    }
    ```

3.  **Apply the animation and `view-timeline`:** Attach the animation to the carousel slides and link it to a `view-timeline` that tracks the element as it scrolls through the container.

    ```css
    .scroller > * {
      animation: animate auto linear both;
      animation-timeline: view(inline);
    }
    ```

    By default, `view()` tracks the element on the `block` axis. If you need to track it on the `inline` axis, you can use `view(inline)`.

## Example code

This code animates the carousel items of a horizontal scroller on scroll using an **anonymous view-timeline**:

```css
/* Scale values are examples; customize with performant properties such as transform, scale, or opacity */
@keyframes animate {
  0% {
    scale: 0.5;
  }

  50% {
    scale: 1;
  }

  100% {
    scale: 0.5;
  }
}

/* Only runs the effect when the user has no reduced-motion preference */
@media (prefers-reduced-motion: no-preference) {
  /* Include (animation-range: entry) to exclude browsers with partial scroll-driven animation support */
  @supports ((animation-timeline: view()) and (animation-range: entry)) {
    .scroller > * {
      /* Applies the animation using an `auto` duration */
      animation: animate auto linear both;
      /* Sets the animation timeline to use an anonymous view progress timeline, tracking the element's progress through the scroller on the inline axis */
      animation-timeline: view(inline);
    }
  }
}
```

This code animates the carousel items of a horizontal scroller on scroll using a **named view-timeline**:

```css
/* Scale values are examples; customize with performant properties such as transform, scale, or opacity */
@keyframes animate {
  0% {
    scale: 0.5;
  }

  50% {
    scale: 1;
  }

  100% {
    scale: 0.5;
  }
}

/* Only runs the effect when the user has no reduced-motion preference */
@media (prefers-reduced-motion: no-preference) {
  /* Include (animation-range: entry) to exclude browsers with partial scroll-driven animation support */
  @supports ((animation-timeline: view()) and (animation-range: entry)) {
    /* This creates a named view-timeline on each carousel item. The timeline is used to drive the animation that is applied on the same element. */
    .scroller > * {
      /* Applies the animation using an `auto` duration */
      animation: animate auto linear both;
      /* Defines a named view progress timeline, tracking the element's progress through the scroller on the inline axis */
      view-timeline: --item inline;
      /* Sets the animation timeline to use the named view progress timeline defined above */
      animation-timeline: --item;
    }
  }
}
```

## Best Practices

When using scroll-driven animations, it's important to follow a few best practices to ensure a smooth and accessible experience:

- **DO** include feature detection: Not all browsers support scroll-driven animations. Use `@supports ((animation-timeline: view()) and (animation-range: entry))` to check for support and provide a fallback for browsers that don't support it.
  - The `(animation-range: entry)` check **MUST** be included here, to filter out browsers with only partial support.
  - **DO NOT** use the `scroll-timeline-polyfill` package for the fallback strategy as it is not feature complete and has a lot of known issues.
  - If the animation is only considered to be decorative, opt for Progressive Enhancement and **DO NOT** provide a fallback.
- **DO** respect user preferences: Some users prefer to have less motion on the web. Use the `prefers-reduced-motion` media query to disable or reduce your animations for these users.
- **DO** try to animate only performant CSS properties: For the smoothest animations, stick to animating properties that can be handled by the browser's compositor thread, such as `transform` and `opacity`. Animating other properties like `width` or `height` can lead to performance issues.
- **DO** use the correct declaration order: When using the `animation` shorthand property, declare `animation-timeline` and `animation-range` *after* it to prevent the shorthand from resetting the timeline.

Use an anonymous `view()` timeline by default when the animated element is the same element being tracked, so you do not have to name every individual timeline. Use a named `view-timeline` instead when multiple elements reuse a single timeline (avoiding duplicate timelines) or when reaching across the DOM (such as animating descendants or non-ancestors via `timeline-scope` when `view()` or `scroll(nearest)` does not suffice).

When using the `view()` function to create a scroll-driven animation:

- **OPTIONAL** be explicit about the axis to track: When not targeting the default `block` axis (such as in a horizontal scroller), be explicit about which axis to track with `view(block)` or `view(inline)`.

When using the `view-timeline` property to create a scroll-driven animation:

- **DO** use a CSS `<dashed-ident>` for the name (e.g. `view-timeline: --my-custom-name`)
- **OPTIONAL** be explicit about the axis to track: When not targeting the default `block` axis (such as in a horizontal scroller), be explicit about which axis to track with `view-timeline-axis`.
- **DO** make sure the scope of the lookup works: When the element that is declaring the `view-timeline` is not a flat tree ancestor of the animated element, hoist up the visibility of the `view-timeline`’s name by using `timeline-scope` on a shared ancestor.

## Browser support and fallback strategies

Baseline status for Scroll-driven animations: Newly available. It's been Baseline since 2026-10-27.
Supported by: Chrome 115 (Jul 2023), Edge 115 (Jul 2023), Firefox 159 (Oct 2026), and Safari 26 (Sep 2025).

Therefore, a fallback strategy is typically required.

For browsers that do not support scroll-driven animations, you can use a fallback to recreate the visual effects. The fallbacks are typically built with either a scroll listener (for ScrollTimeline effects) or the IntersectionObserver API (for ViewTimeline effects).

In browsers with built-in support for scroll-driven animations, ALWAYS use the native CSS implementation as those are more performant.

Note that not every effect can be recreated using the fallbacks approach.

For this use-case specifically, the following script applies the fallback for browsers that do not support scroll-driven animations. It uses the Web Animations API (`Element.animate()`) to create a paused animation for each item in the carousel. It then listens to the `scroll` event on the scroller and updates the `currentTime` of each animation based on the item's scroll progress within the scroller. The `prefers-reduced-motion` media query in the CSS doesn't affect the animations the script creates, so the script checks the preference with `matchMedia()` and only runs when the user has no reduced-motion preference.

```js
// Fallback for browsers that don't support scroll-driven animations
// Like the CSS, it only runs when the user has no reduced-motion preference.
if (!CSS.supports('(animation-timeline: view()) and (animation-range: entry)') &&
    matchMedia('(prefers-reduced-motion: no-preference)').matches) {
  const scroller = document.querySelector('.scroller');
  const entries = document.querySelectorAll('.entry');

  // Create a map to store animations
  const animations = new Map();

  entries.forEach(entry => {
    const animation = entry.animate(
      {
        scale: ['0.5', '1', '0.5']
      },
      {
        duration: 1, // We'll control the time ourselves
        fill: 'both'
      }
    );
    animation.pause();
    animations.set(entry, animation);
  });

  // Update animations on scroll
  const tick = () => {
    const scrollerRect = scroller.getBoundingClientRect();

    entries.forEach(entry => {
      const animation = animations.get(entry);
      if (!animation) return;

      const entryRect = entry.getBoundingClientRect();
      const progress = (entryRect.left + entryRect.width / 2 - scrollerRect.left) / scrollerRect.width;

      animation.currentTime = progress;
    });
  };
    
  scroller.addEventListener('scroll', tick);
  tick();
}
```
