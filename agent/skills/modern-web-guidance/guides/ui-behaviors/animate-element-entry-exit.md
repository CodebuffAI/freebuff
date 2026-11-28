# Animate Element Entry and Exit

In the past, CSS transitions could not animate elements when they were first added to the DOM or when their `display` property changed from `none`. The `@starting-style` at-rule and `transition-behavior: allow-discrete` provide a declarative way to create smooth entry and exit animations.

## Implementation

### 1. Animating `display: none` Toggles

To animate an element when toggling its visibility via an attribute (e.g., `hidden` with `display: none`):

1. **Define the visible state**: Set the final property values (e.g., `opacity: 1`) on the base class.
2. **Define the entry starting state**: Use `@starting-style` to specify the values to transition *from* when the element becomes visible.
3. **Enable discrete transitions**: Include `display` in the `transition` property and use `transition-behavior: allow-discrete`.
4. **Define the exit state**: Set the target values in the `hidden` attribute.

```css
.card {
  display: block;
  opacity: 1;
  translate: 0;
  transition:
    display,
    opacity ease-out,
    translate ease-out;
  transition-duration: 0.4s;
  /* Separate after transition so the shorthand doesn't reset it or fail in older browsers */
  transition-behavior: allow-discrete;
}

/* Entry animation: transition FROM these values when first rendered */
@starting-style {
  .card {
    opacity: 0;
    translate: 0 -20px;
  }
}

/* Exit animation: transition TO these values when hidden */
.card[hidden] {
  display: none;
  opacity: 0;
  translate: 0 -20px;
}

/* Respect user preference for reduced motion */
@media (prefers-reduced-motion: reduce) {
  .card {
    /* Disable movement and shorten duration for a simple fade */
    translate: none;
    transition-duration: 0.1s;
  }

  @starting-style {
    .card {
      translate: none;
    }
  }

  .card[hidden] {
    translate: none;
  }
}
```

### 2. Animating DOM Insertion and Removal

For elements added via `appendChild()` or removed via `remove()`:

- **Entry**: Use `@starting-style` as shown above. The browser will automatically detect the style change from "nothing" to the element's initial styles and trigger the transition from the `@starting-style` values.
- **Removal**: Since `element.remove()` is instantaneous and doesn't trigger a CSS transition on its own, you must trigger the exit transition first and wait for it to finish before removing the node from the DOM.

```javascript
// 1. Trigger exit transition
element.hidden = true;

// 2. Wait for all active transitions/animations to finish,
//    with a failsafe timeout in case an animation never ends (e.g. for looping animations)
const animations = element.getAnimations();
if (animations.length > 0) {
  await Promise.race([
    // Promise.allSettled ensures we wait even if some animations fail
    Promise.allSettled(animations.map(a => a.finished)),
    new Promise(r => setTimeout(r, 2000))
  ]);
}

// 3. Finally remove the node from the DOM
element.remove();
```

## Constraints & Accessibility

- **MANDATORY**: Use `transition-behavior: allow-discrete` when transitioning `display`. Without it, the element will instantly disappear during exit.
- **DO NOT** use `allow-discrete` in the `transition` shorthand — it will make older browsers ignore the entire `transition` declaration. Except in use cases where that is desirable, use a separate `transition-behavior: allow-discrete` declaration.
- **MANDATORY**: Use `@starting-style` for entry animations. Browsers skip transitions on an element's first style update (initial render or `display: none` change) unless this is provided.
- **DO**: Include `overlay` in the `transition` list if animating top-layer elements like `<dialog>` or `popover` to ensure they stay in the top layer during the exit animation.
- **DO**: Respect user preferences for reduced motion using the `prefers-reduced-motion` media query.
- **DO NOT**: Rely on `@starting-style` for exit animations; it only defines the *starting* point for an entry transition. Exit animations are defined by the transition to the hidden state.

## Fallback strategies

Baseline status for @starting-style: Newly available. It's been Baseline since 2024-08-06.
Supported by: Chrome 117 (Sep 2023), Edge 117 (Sep 2023), Firefox 129 (Aug 2024), and Safari 17.5 (May 2024).

### Fallbacks & browser support for transition-behavior

Baseline status for transition-behavior: Newly available. It's been Baseline since 2024-08-06.
Supported by: Chrome 117 (Sep 2023), Edge 117 (Sep 2023), Firefox 129 (Aug 2024), and Safari 17.4 (Mar 2024).

Browser support for the css.properties.transition-behavior.transitionable_display capability: Limited availability.
Supported by: Chrome 117 (Sep 2023), Edge 117 (Sep 2023), and Safari 18 (Sep 2024).
Unsupported in: Firefox.

Firefox 129+ parses `transition-behavior: allow-discrete` (`CSS.supports('transition-behavior', 'allow-discrete')` returns `true`) without actually transitioning the `display` property (Firefox bug 1882408), causing elements to disappear immediately on exit.

To reliably detect discrete `display` transition support, probe whether a temporary element's computed `display` remains visible when transitioned to `none` rather than relying solely on `CSS.supports('transition-behavior', 'allow-discrete')`:

```javascript
let supportsDisplayTransition;
function canTransitionDisplay() {
  if (supportsDisplayTransition !== undefined) return supportsDisplayTransition;
  if (!window.CSS?.supports?.('transition-behavior', 'allow-discrete') || !document.body) {
    return false;
  }
  const probe = document.createElement('div');
  // The shorthand is intentional here: browsers that don't parse allow-discrete
  // drop the whole declaration, so display: none applies instantly and the probe
  // correctly returns false. !important guards against global reduced-motion
  // resets like `* { transition: none !important }`.
  probe.style.cssText = 'transition: display 1s allow-discrete !important; display: block;';
  document.body.appendChild(probe);
  getComputedStyle(probe).display;
  probe.style.display = 'none';
  supportsDisplayTransition = getComputedStyle(probe).display === 'block';
  probe.remove();
  return supportsDisplayTransition;
}
```

### Exit fallback when discrete `display` transitions are unsupported

Entry animations using `@starting-style` work across all modern browsers without JavaScript. When discrete `display` transitions are unsupported (`!canTransitionDisplay()`), setting `hidden` applies `display: none` immediately and skips the exit animation (both when hiding and before `element.remove()`). Separate the visual exit state (`[data-closing]`) from `display: none` (`[hidden]`) so `opacity` and `translate` finish animating before hiding or removing the element. Replace the `.card[hidden]` rules from step 1 (including the `prefers-reduced-motion` override) with:

```css
.card:where([hidden], [data-closing]) {
  opacity: 0;
  translate: 0 -20px;
}

.card[hidden] {
  display: none;
}

@media (prefers-reduced-motion: reduce) {
  .card:where([hidden], [data-closing]) {
    translate: none;
  }
}
```

```javascript
async function hideElement(el) {
  if (canTransitionDisplay()) {
    el.hidden = true;
  } else {
    el.setAttribute('data-closing', '');
  }

  const animations = el.getAnimations();
  if (animations.length > 0) {
    await Promise.race([
      Promise.allSettled(animations.map((a) => a.finished)),
      new Promise((r) => setTimeout(r, 2000)),
    ]);
  }

  // Skipped if showElement() cancelled the close mid-animation.
  if (el.hasAttribute('data-closing')) {
    el.removeAttribute('data-closing');
    el.hidden = true;
  }
}

function showElement(el) {
  el.removeAttribute('data-closing');
  el.hidden = false;
}

async function removeElement(el) {
  await hideElement(el);
  el.remove();
}
```
