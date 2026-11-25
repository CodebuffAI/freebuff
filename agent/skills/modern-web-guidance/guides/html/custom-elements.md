# Custom Elements

A custom element is a class registered against a tag name via `customElements.define()`. Registration and basic lifecycle are well understood; the rules below target the parts routinely implemented incorrectly.

A custom element has no role or keyboard behavior of its own. That's fine when its content already carries the meaning, for example a layout wrapper around headings and text. If it needs semantics or keyboard support, build it from native elements such as `<button>` inside its template, or give it a role and ARIA state through `ElementInternals`, and focus handling, as described in `accessible-web-components` (via `npx -y modern-web-guidance@latest retrieve "accessible-web-components"`). If its content is purely decorative, hide it from assistive technologies with `aria-hidden="true"`.

## Lifecycle: the parts that get implemented wrong

The callbacks themselves are well documented; these are the misconceptions that cause bugs:

- **`connectedCallback` can run more than once.** It fires on every insertion, so moving the element re-runs it. Make setup idempotent — don't assume a single first run.
- **`connectedMoveCallback` skips the disconnect/reconnect pair on a move.** When an element is relocated with `Node.moveBefore()`, this callback fires *instead of* `disconnectedCallback` → `connectedCallback`, so state, focus, and iframe/media playback survive the move. Define it when your setup or teardown is expensive or observably re-runs.
- **Tear down in `disconnectedCallback`.** Remove global listeners, timers, and observers or you leak; but the element may be re-inserted, so don't treat teardown as permanent.
- **Call `super()` first in the constructor, and do not depend on the full DOM being present.** Calling `super()` after touching `this` throws a `ReferenceError`. Attributes are usually (but not always) present; long lists of children may not have finished parsing. Use `connectedCallback` for one-shot initialization, `slotchange` to monitor direct children, and `attributeChangedCallback` to monitor attributes. `connectedCallback` may still fire before all children are parsed, so do not ignore subsequent `slotchange` / `attributeChangedCallback` calls.
- **`attributeChangedCallback` fires only for `observedAttributes`,** and should stay cheap for attributes that don't affect output.
- **Lifecycle hooks and `observedAttributes` are snapshotted at registration.** `customElements.define()` reads both once; adding a hook or extending `observedAttributes` on the class *after* the call is silently ignored. In particular, `attributeChangedCallback` never fires unless `observedAttributes` was already present at `define()` time.

## Upgrade timing and `:defined`

An element can exist in the DOM *before* its class is registered (in server-rendered HTML, or when the script loads late). Until defined it is an inert `HTMLElement` with none of your behavior; when `customElements.define()` runs, the browser **upgrades** every matching element already in the document, running its constructor and `connectedCallback` then.

Two consequences models routinely miss:

1. **Attributes and children may already be present** when your constructor/`connectedCallback` runs on upgrade. Read existing attributes in `connectedCallback` to sync initial state, and never assume the element started empty.
2. **Children may still be missing** even in `connectedCallback` — the HTML parser can yield mid-parse of long child lists, so the callback sometimes runs before every child is attached. See the constructor bullet in *Lifecycle* above for the pattern (`slotchange` + `attributeChangedCallback`).

Hide undefined elements to avoid a flash of unstyled content — but **fail open**, so the content stays reachable if the script never loads. Hide them with `visibility: hidden`, which also removes their content from the tab order and the accessibility tree while it can't be seen (`opacity: 0` on its own leaves focusable descendants in the tab order, invisible; WCAG 2.4.7 Focus Visible), and animate `visibility` back with a delay, so the element reveals itself after a timeout even when it is never upgraded. `visibility` switches rather than fades, so if you also want the element to fade in, add `opacity: 0` and animate it alongside `visibility`; the opacity is optional:

```css
my-element:not(:defined) {
  visibility: hidden;
  opacity: 0; /* Optional: fades the element in as it becomes visible. */
  /* Reveal anyway after 2s, so a failed or slow script never hides content for good. */
  animation: defined-fallback 0.2s 2s forwards;
}
@keyframes defined-fallback { to { visibility: visible; opacity: 1; } }
```

Scope these guards to the elements that need them — or to a specific subtree via `:has(:not(:defined))` — rather than the whole `body`. One slow, non-critical widget (a share button, say) should not delay paint for the entire page.

## Attribute ⇄ property reflection

Keep the HTML attribute and the JS property in sync so the element is usable from both markup and script. Attribute values are **always strings**; coerce them.

```javascript
class MyToggle extends HTMLElement {
  static observedAttributes = ['label', 'count', 'disabled'];

  // String attribute reflected via getter/setter.
  get label() { return this.getAttribute('label') ?? ''; }
  set label(v) {
    v ? this.setAttribute('label', v) : this.removeAttribute('label');
  }

  // Numeric attribute: coerce from string on read, serialize on write.
  get count() { return Number(this.getAttribute('count')) || 0; }
  set count(v) { this.setAttribute('count', String(v)); }

  // Boolean attribute: present = true, absent = false. Never set it to "false".
  get disabled() { return this.hasAttribute('disabled'); }
  set disabled(on) { this.toggleAttribute('disabled', !!on); }

  attributeChangedCallback(name, oldVal, newVal) {
    if (oldVal !== newVal) this.render();
  }
}
```

### Where the value lives

The example above keeps the **DOM as the source of truth** — each getter reads `getAttribute`. That's the right default for a handful of simple, string-ish attributes: there is only one place the state can live, so it can't desync.

For richer components, keep the **source of truth in a JS field** and reflect *outward* to an attribute only when something else must see it — CSS targeting, or a consumer reading it. Reading a field is far cheaper than parsing and coercing an attribute on every access, and non-string values never round-trip through serialization. This is why libraries like Lit hold state in JS and reflect selectively rather than treating attributes as storage: reflect only what the outside world must observe, not every property.

Pitfalls:

- **`observedAttributes` discipline**: list only attributes whose change must re-render or trigger a side effect. Observing everything adds a callback to every mutation for no benefit.
- **Reflection loops**: a setter that writes an attribute will re-enter `attributeChangedCallback`. Guard with an `oldVal !== newVal` check, as above.
- **Accessible state**: derive the state you expose to assistive technologies (ARIA state through `ElementInternals`, or attributes on the native control inside) from the same source of truth as the visible state, and update it on every path that changes it: attributes read on upgrade, `attributeChangedCallback`, property setters, and user interaction. Otherwise a state set from markup or by a consumer's script changes what's shown but not what's announced (WCAG 4.1.2 Name, Role, Value).
- **Re-rendering**: update only the nodes that change rather than rebuilding the shadow tree with `innerHTML`. Replacing an element that has focus moves focus to `<body>`, and keyboard and screen reader users lose their place (WCAG 2.4.3 Focus Order).
- **Style-only state**: for internal state that exists only to drive styling (loading, active, expanded), prefer **custom states** over reflecting a synthetic attribute — see [Custom states](#custom-states) below. Reflect to an attribute only when consumers must be able to set the state from markup.

## Custom states

Custom states are boolean flags an element exposes *about itself* for CSS to target, set through `ElementInternals` and matched with the `:state()` pseudo-class. Use them for internal, runtime UI state — `busy`, `expanded`, `invalid` — instead of reflecting a synthetic attribute: they can't collide with a consumer's attributes, never appear in the DOM, and are read-only from outside (a consumer can *style* `:state()` but can't forge it).

```javascript
class AsyncButton extends HTMLElement {
  #internals;
  #action = async () => {};

  constructor() {
    super();
    this.#internals = this.attachInternals();
  }

  set action(fn) { this.#action = fn; } // host supplies the work to run

  async run() {
    if (this.#internals.states.has('busy')) return; // guard re-entry
    this.#internals.states.add('busy');
    this.#internals.ariaBusy = 'true'; // assistive technologies don't see custom states
    this.#internals.states.delete('success');
    this.#internals.states.delete('error');
    try {
      await this.#action();
      this.#internals.states.add('success');
    } catch {
      this.#internals.states.add('error');
    } finally {
      this.#internals.states.delete('busy');
      this.#internals.ariaBusy = 'false';
    }
  }
}
```

`CustomStateSet` is a set, so independent states compose (`busy` plus `error`) without inventing a combined `data-status` enum.

Custom states only reach CSS: assistive technologies don't see them. When a state tells the user something (busy, success, error, invalid, expanded), also expose it to assistive technologies, as ARIA state through `ElementInternals` (as with `ariaBusy` above) or on the native control inside the component, show it in text rather than color alone, and announce the outcome of an action, such as a save succeeding or failing, as a status message (WCAG 4.1.2 Name, Role, Value; 1.4.1 Use of Color; 4.1.3 Status Messages).

**Custom state is runtime-only.** It is not serialized to the DOM, so it does not survive a reload, the element being re-created, or server rendering. If the state must be set declaratively in markup or persist across loads, that is a job for an **attribute** (see [Where the value lives](#where-the-value-lives)) — restore it in `connectedCallback` from your source of truth. Rule of thumb: custom state for what the component derives and owns at runtime and only needs to *style*; an attribute for what must be set from markup or serialized.

For styling these states — both inside the component and from a consumer's stylesheet — see `styling-web-components` (via `npx -y modern-web-guidance@latest retrieve "styling-web-components"`).

## Naming conventions

- True-private state: native `#` fields (`#count`) for hard encapsulation; a `_` prefix only when subclasses must still reach it. Note `#` fields are not inherited — a subclass cannot see a base class's private fields.
- Symbol-keyed properties are a middle ground: hidden from ordinary enumeration, but reachable by any code holding the symbol (export it, or expose it as a `static` field on the class). Because each symbol is unique, two symbols sharing a description never collide — handy when a subclass or sibling needs controlled access that `#` fields can't provide.
- Do **not** shadow global attributes (such as `style`, `class`, `id`, `slot`, `part`, `title`, `lang`, `dir`) with your own properties, for example a `role` or `ariaLabel` class field; doing so breaks their built-in behavior, and a consumer setting the property no longer changes the attribute or what assistive technologies receive. Note `disabled` is only global on form controls; on other elements you must implement its effect yourself, including ignoring activation and exposing the state to assistive technologies (for example `this.#internals.ariaDisabled = 'true'`). If the component's styles set `display` on `:host`, also add `:host([hidden]) { display: none; }`, or the `hidden` attribute stops hiding the element and its content stays visible, focusable and in the accessibility tree.

When naming a new API surface, follow the platform's own conventions: use lowercase kebab-case with at least one hyphen for custom element tag names (for example `my-toggle`), `lowerCamelCase` for properties and methods, and lowercase attribute names synchronized with their corresponding properties.
