# Show a tooltip when hovering

Users expect to see additional related information without completely changing their context. Showing a tooltip when a user is interested in more information can be useful to provide definitions for a term, clarifying the action an icon-only button will take, or provide additional form field guidance.

## Should you use a tooltip?

A toggletip is a small button, usually an "i" or "?" icon, placed next to a control or a piece of content, whose only job is to reveal more information. The choice between tooltip, toggletip, and inline content is about how important and how long the information is:

- **Tooltip** (on the control itself): a short clarification of what the control does. Missing it costs the user little.
- **Toggletip** (an "i" or "?" next to the control or content): information users may well want but most don't need every time, such as why a field is required, how a total was computed, or what a policy means, or anything longer than a phrase. Showing it inline would add clutter, but it deserves an explicit, visible affordance so every user can find it deliberately rather than by happening to hover, including on touch and with a screen reader. See below for guidance on creating toggletips.
- **Inline content**: information most users need in order to act, or need while they act (password rules while typing, a value they copy). A popover closes as soon as they click or focus elsewhere.

## Creating the tooltip

You can create a popover with the required behavior by adding the `popover="hint"` attribute to a `<div>` or other semantically appropriate element. When the user opens the tooltip, this hides other `popover="hint"` tooltips, but doesn't hide `auto` or `manual` tooltips. It also handles dismissing nested tooltips.

It also provides light dismiss behavior, so when a user clicks or otherwise focuses outside of the popover, the popover is dismissed.

The tooltip element must have an `id` attribute with a unique value:

```html
<!-- MANDATORY: The tooltip element must have popover="hint" so it light-dismisses
     without closing unrelated auto or manual popovers. -->
<div popover="hint" id="tooltip">Tooltip content</div>
```

A user expresses interest in the additional information by hovering or focusing on an `<a>` or `<button>` element. The element must have an `interestfor` attribute that matches the `id` attribute of the tooltip.

```html
<!-- The `interestfor` attribute can be applied to a `<button>` element: -->
<button interestfor="tooltip">Tooltip trigger</button>

<!-- The `interestfor` attribute can also be applied to an `<a>` element (href is an example): -->
<a interestfor="tooltip" href="/docs/dom">Tooltip trigger</a>
```

The trigger must have a visual indicator to indicate that there is additional information available by interacting with the trigger.

### Accessibility

`interestfor` is specified to wire hint popovers (`popover="hint"`) for assistive technology itself, based on what the target contains. A **plain hint** (text and images only) becomes the trigger's accessible description, or its name if it has none. A **rich hint** (headings, links, or other interactive content) gets a minimum role of `tooltip`, the trigger gets `aria-expanded` and an `aria-details` relation while the hint is open, and the open hint comes right after the trigger in the tab order so keyboard users can reach its content.

Browsers and screen readers do not yet expose this consistently, so add explicit ARIA as well:

- **Hint that repeats the trigger's accessible name** (e.g. an icon-only button with `aria-label="Bold"` and a "Bold" tooltip): add nothing. A description identical to the name would be read twice.
- **Hint on a trigger with no visible label of its own** (e.g. an icon-only button without `aria-label`): `aria-labelledby` on the trigger pointing at the hint, so the hint becomes the name.
- **Hint whose trigger also opens it on activation** (a toggletip, or any button whose only job is the hint: give it `popovertarget` with `popovertargetaction="show"`): `role="tooltip"` on the hint and `aria-expanded` on the trigger, kept in sync with the popover's `toggle` event. A description read right after "button" suggests further actions and muddles the role; the expanded state tells the user there is content to reveal and whether it is open, and pressing the button delivers it. Place the hint right after the trigger in the DOM so reading keys reach its content once it is open.
- **Hint whose trigger does something else on activation** (a link, a button with its own action): `role="tooltip"` on the hint and `aria-describedby` on the trigger, never `aria-expanded`. A trigger announced as "collapsed" suggests `Enter` would expand it, but `Enter` navigates or acts. The hint must be something the user can afford to miss: a hovercard previews the destination, a tooltip on an action button describes the action.
- **DO NOT** attach a hint that opens on activation to a control that already uses `aria-expanded` for something else (for example, a menu button). Give that hint its own trigger instead.
- **DO NOT** move focus into the target when interest is shown (no `autofocus`, no `focus()` in an `interest` listener). Interest is triggered by hover or focus alone, so moving focus would fail WCAG 3.2.1 (On Focus).

Not every screen reader reads descriptions when moving through the page (NVDA skips them in browse mode by design), so a hint exposed as a description must only carry content the user can afford to miss. Link previews and tooltips on action controls qualify; anything the user needs belongs in a toggletip or inline.

Wire this with a short script instead of hand-authoring the attributes, so the markup stays declarative and the same rules apply to every hint. The script should:

1. Run in every browser, before loading the `interestfor` polyfill, once the DOM is parsed, and expose a function that can be called again for content inserted later. Scanning upfront is required: a browse-mode screen reader user needs the attributes in place before any interaction, so wiring them lazily on `focus` or `interest` is too late, and so is waiting for the polyfill, which wires its ARIA only on `load` and adds no `role="tooltip"` to plain hints.
2. For every `[interestfor]` trigger whose target has `popover="hint"`, normalize whitespace and compare the hint text with the trigger's accessible name (`aria-labelledby` targets, else `aria-label`, else text content including image `alt`, else `title`). Equal: do nothing. Otherwise set `role="tooltip"` on the hint if it has no role.
3. When the trigger has no name, point `aria-labelledby` at the hint unless it already has one. Otherwise, if the trigger also opens the hint on activation (a `popovertarget` or `commandfor` naming the hint), set `aria-expanded` to the popover's current state (`:popover-open`) unless it already has `aria-expanded`, and remember which triggers the script owns; if not, point `aria-describedby` at the hint unless it already has one.
4. Keep `aria-expanded` in sync from the popover's `toggle` event in every browser with a single capturing listener on `document`, updating every trigger with a matching `interestfor` that the script owns (the `interestfor` polyfill does not sync `aria-expanded` on plain-text hints or when a toggletip is opened via `popovertarget`).

Things that are easy to get wrong:

- `toggle` does not bubble. A bubbling listener on `document` never fires; use the capture phase (or a listener per popover).
- Sync `aria-expanded` from `toggle`, not from `interest`/`loseinterest`. The popover is the source of truth: it can be closed by `Escape`, light dismiss, or another invoker, and several triggers can share one hint.
- A hidden popover is a valid `aria-describedby` or `aria-labelledby` target. Do not force the hint open or duplicate its text to make it "visible".
- Do not add `aria-haspopup` or a live region to any hint.
- Do not override author ARIA: an existing `aria-describedby`, `aria-labelledby`, or `aria-expanded` on the trigger wins.

### Accessibility Constraints (WCAG 1.4.13)

Even with `interestfor` handling the semantics above, your implementation MUST still satisfy WCAG 1.4.13 (Content on Hover or Focus):
- **Dismissible:** Users must be able to dismiss the tooltip without moving pointer hover or keyboard focus (e.g., by pressing the `Escape` key). The native `popover` attribute manages this binding automatically.
- **Hoverable:** The pointer must be able to move over the tooltip content itself without the tooltip disappearing. This allows users with magnification tools to read the tooltip text safely.
- **Persistent:** The tooltip must remain visible until the hover or focus trigger is removed, the user explicitly dismisses it, or its content is no longer valid.

### Positioning the tooltip

The tooltip is positioned using **CSS Anchor Positioning**. When the tooltip is opened using `interestfor`, the trigger element automatically becomes an **implicit anchor** for the popover.

In modern browsers supporting native anchor positioning, you do **not** need to define an `anchor-name` on the trigger or a `position-anchor` on the tooltip. You can position the tooltip directly relative to its implicit anchor using `position-area` and handle collision flipping with `position-try-fallbacks`:

```css
[popover] {
  /* Implicit anchor from interestfor: no anchor-name or position-anchor needed */
  position-area: block-start;
  position-try-fallbacks: flip-block;
  /* Override UA popover centering (`inset: 0; margin: auto`) so the tooltip sits adjacent to its anchor */
  inset: auto;
  margin: 0;
}
```

## Toggletips: an "i" or "?" button

Give a toggletip both triggers: `interestfor` opens it on hover, focus, and long-press; `popovertarget` opens it on click, tap, and `Enter`.

```html
<label>Shipping <input name="shipping"></label>
<!-- The name says what the button reveals; the "?" alone is not a name. -->
<button type="button" interestfor="shipping-help" popovertarget="shipping-help" popovertargetaction="show" aria-label="More about shipping">?</button>
<!-- Right after the trigger, so it reads in sequence. -->
<div id="shipping-help" popover="hint">Free shipping applies to orders over $50. Orders placed before 2pm ship the same day.</div>
```

- Use `popovertargetaction="show"`, not the default `toggle`: hover has usually opened the popover already, and a toggle would close it on the click that follows. `Escape`, light dismiss, and losing interest close it.
- Keep `popover="hint"`: hovering across a toggletip must not close an open menu, which an `auto` popover would.
- Position it like any tooltip. The button is the popover's implicit anchor through either attribute.

## Fallback strategies

### Fallbacks & browser support for Interest invokers

Browser support for Interest invokers: Limited availability.
Supported by: Chrome 149 (Jun 2026) and Edge 149 (Jun 2026).
Unsupported in: Firefox and Safari.

Interest invokers must be conditionally polyfilled using the `interestfor` polyfill package from NPM. Prefer bundling the polyfill over using the CDN.

**MANDATORY:** Feature detect by checking for the `interestForElement` property on `HTMLButtonElement.prototype`, and load the polyfill **only** when native support is missing.

```html
<script type="module">
  if (!("interestForElement" in HTMLButtonElement.prototype)) {
    // CDN link only used for example, prefer bundling.
    await import("https://unpkg.com/interestfor@latest");
  }
</script>
```

### CSS Polyfill Caveats

When using the polyfill, the CSS API changes slightly to account for the lack of native pseudo-class and property support:

- **Pseudo-classes:** The polyfill cannot define real `:interest-source` and `:interest-target` pseudo-classes, so it applies `.interest-source` and `.interest-target` classes instead. **MANDATORY:** Combine them with `:is()` to support both native and polyfilled states.

```css
/* Styles to apply when the effect is being previewed */
:is(:interest-source, .interest-source) { /* ... */ }
:is(:interest-target, .interest-target) { /* ... */ }
```

- **CSS Properties:** For `interest-delay`, `interest-delay-start`, and `interest-delay-end`, the polyfill requires using CSS variables as it cannot read the custom properties directly in all browsers.

```css
/* Adjust the start and end delay for interest invokers */
[interestfor] {
  --interest-delay-start: 0.2s;
  interest-delay-start: var(--interest-delay-start);
  --interest-delay-end: 0.1s;
  interest-delay-end: var(--interest-delay-end);
}
```

Set the initial delay to `0s` if an interest-triggered popover is already open and users are likely to move through multiple triggers in quick succession.

```css
.container:has([interestfor]:is(:interest-source, .interest-source)) [interestfor] {
  --interest-delay-start: 0s;
}
```

### Fallbacks & browser support for Popover

Baseline status for Popover: Newly available. It's been Baseline since 2025-01-27.
Supported by: Chrome 116 (Aug 2023), Edge 116 (Aug 2023), Firefox 125 (Apr 2024), Safari 17 (Sep 2023), and Safari iOS 18.3 (Jan 2025).

The Popover API is mostly **progressive enhancement**, but its defining behaviors — top-layer promotion, light-dismiss, and `popovertarget` invocation — have no CSS-only equivalent. Older browsers need a polyfill, or a manual fallback if you would rather not ship one.

**Polyfill:** To support the `popover` attribute in older browsers, conditionally load [`@oddbird/popover-polyfill`](https://github.com/oddbird/popover-polyfill). **MANDATORY:** Feature detect by checking for the `popover` property on `HTMLElement.prototype`, and load the polyfill **only** when native support is missing — do NOT load it unconditionally.

With a bundler or import map:

```js
// MANDATORY: Feature detect 'popover' on HTMLElement.prototype.
if (!Object.hasOwn(HTMLElement.prototype, "popover")) {
  import("@oddbird/popover-polyfill");
}
```

If not using a package manager, import from a CDN, e.g. `"https://unpkg.com/@oddbird/popover-polyfill@latest/dist/popover.min.js"`.

Caveats when using the polyfill:
- Do NOT use the `popover` IDL attribute for any code that may run before the polyfill is fully loaded. It will not be mirrored as an attribute, the popover will not be picked up by the polyfill, and the property will be shadowing the accessor the polyfill adds forever. Use `setAttribute()`/`removeAttribute()` instead.
- **Styling caveat:** The polyfill cannot define the real `:popover-open` pseudo-class, so it applies a `.\:popover-open` class instead. **MANDATORY:** Combine the two with `:is()` or `:where()`, otherwise browsers that lack `:popover-open` discard the entire rule:

```css
[popover]:is(:popover-open, .\:popover-open) {
  display: block;
}
```

To prevent popovers from showing before the polyfill loads, hide them with CSS:

```css
@supports not selector(:popover-open) {
  [popover]:not(.\:popover-open) {
    display: none;
  }
}
```

### Fallbacks & browser support for `popover="hint"`

Browser support for popover="hint": Limited availability.
Supported by: Chrome 151 (Jul 2026), Edge 151 (Jul 2026), and Firefox 153 (Jul 2026).
Unsupported in: Safari.

The `@oddbird/popover-polyfill` package does not polyfill `popover="hint"` in browsers that already support native `popover` (`auto` and `manual`). In those browsers, the unrecognized `"hint"` value defaults to `popover="manual"` (the HTML invalid value default), so a tooltip opened via keyboard focus may remain open if a second tooltip is opened via pointer hover unless explicitly dismissed on loss of interest by the invoker.

A toggletip can also be opened by click, with no interest to lose, so a `manual` fallback would never close. Where `hint` is unsupported, switch toggletips to `popover="auto"` as they open. This MUST happen in `beforetoggle`: the browser reads the popover type after that event, whereas changing the type of an already open popover closes it. `beforetoggle` does not bubble, so delegate with a capturing listener:

```js
// The `popover` property reports the state the browser actually uses: "manual" when `hint` is unsupported.
const probe = document.createElement("div");
probe.popover = "hint";
if (probe.popover !== "hint") {
  document.addEventListener("beforetoggle", ({ target, newState }) => {
    const toggletip = target.getAttribute("popover") === "hint"
      && document.querySelector(`[popovertarget="${CSS.escape(target.id)}"]`);
    if (newState === "open" && toggletip) {
      target.popover = "auto";
    }
  }, true);
}
```

### Fallbacks & browser support for Anchor positioning

Browser support for Anchor positioning: Limited availability.
Supported by: Chrome 157 (Nov 2026), Edge 157 (Nov 2026), and Safari 27 (Sep 2026).
Unsupported in: Firefox.

Without CSS Anchor Positioning, tethered elements such as `[popover]` overlays fall back to their default user-agent placement (centered in the viewport for popovers). Depending on whether spatial tethering is required for your use case, either conditionally load the polyfill or gate your positioning rules with `@supports`.

#### Option 1: Polyfill (`@oddbird/css-anchor-positioning`)

When the positioned element must stay spatially tethered to its trigger in unsupported browsers, conditionally load the `@oddbird/css-anchor-positioning` package.

**MANDATORY:** Feature-detect support via `CSS.supports("anchor-name: --a")` (or `"anchorName" in CSSStyleDeclaration.prototype`), and load the polyfill **only** when native support is missing — do NOT load it unconditionally.

With a bundler or import map:

```js
// MANDATORY: Feature-detect anchor positioning support before loading the polyfill.
if (!CSS.supports("anchor-name: --a")) {
  import("@oddbird/css-anchor-positioning");
}
```

Without a bundler, import from a CDN inside a `<script type="module">`:

```html
<!-- MANDATORY: Conditionally install the anchor positioning polyfill -->
<script type="module">
  if (!CSS.supports("anchor-name: --a")) {
    import("https://unpkg.com/@oddbird/css-anchor-positioning");
  }
</script>
```

**Polyfill caveats:**
- **No implicit anchors:** The polyfill does not support implicit anchor associations (such as those created by `popovertarget`, `commandfor`, `interestfor`, or `showPopover({ source })`). You **MUST** set a unique explicit `anchor-name` on each trigger and a matching `position-anchor` on the positioned element.
- **No `position-area` with `position-try-fallbacks`:** `position-area` with `position-try-fallbacks` is not supported by the polyfill. When using the polyfill on elements needing fallbacks, position elements using `anchor()` functions on inset properties (`top`, `left`, `right`, `bottom`) with `inset: auto` instead of `position-area`.
- **Do not wrap polyfilled rules in `@supports`:** Browsers without native anchor positioning evaluate `@supports (position-area: ...)` and `@supports (anchor-name: --a)` to `false` and discard the block before the polyfill can process it.

```css
.trigger {
  /* MANDATORY: Each trigger and positioned element pair must share a unique anchor name. */
  anchor-name: --my-trigger;
}

[popover].anchored-overlay {
  position-anchor: --my-trigger;
  /* MANDATORY: Use anchor() on inset properties rather than position-area when using the polyfill on elements needing position-try-fallbacks. */
  inset: auto;
  top: anchor(bottom);
  left: anchor(left);
  margin: 0;
}
```

#### Option 2: Progressive enhancement with `@supports` (no polyfill)

If you do not ship the polyfill, **DO NOT** set `inset: auto` or `margin: 0` unconditionally on a `[popover]` element that relies on `position-area` or `anchor()`. In browsers without anchor positioning, `inset: auto` overrides the user-agent centering (`inset: 0; margin: auto`) while `position-area` is ignored, leaving the popover stranded at `(0, 0)` or overlapping its trigger.

Instead, gate `inset: auto` and `margin: 0` inside `@supports` for the specific positioning feature used (for example, `@supports (position-area: block-end)` or `@supports (top: anchor(bottom))`) so unsupported browsers retain the default centered popover placement, or provide a matching `@supports not (...)` fallback layout (such as a fixed bottom sheet):

```css
@supports (position-area: block-end) {
  [popover].anchored-overlay {
    inset: auto;
    margin: 0;
    position-area: block-end span-inline-end;
    position-try-fallbacks: flip-block, flip-inline, flip-block flip-inline;
  }
}

@supports not (position-area: block-end) {
  /* Optional: override default popover centering with a fixed bottom bar */
  [popover].anchored-overlay {
    position: fixed;
    inset: auto 0 0 0;
    width: auto;
    margin: 0;
  }
}
```
