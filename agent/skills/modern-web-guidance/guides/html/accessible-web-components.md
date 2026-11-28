# Accessible Web Components

A shadow boundary changes how semantics and ARIA work. Two failures dominate: missing semantics inside the shadow tree, and ARIA references that silently break because they cannot cross shadow roots.

Start from semantic markup: use real `<button>`, `<nav>`, `<ul>` inside the template so most semantics come for free, and reserve `ElementInternals`/ARIA for the gaps.

## Default semantics via the ElementInternals ARIA mixin

Set a custom element's role and ARIA state in JS through `ElementInternals`, rather than writing ARIA attributes onto the host. This keeps the semantics as defaults the component owns, while still letting a consumer override them with attributes in the Light DOM.

```javascript
class ToggleSwitch extends HTMLElement {
  #internals;
  constructor() {
    super();
    this.#internals = this.attachInternals();
    this.#internals.role = 'switch';          // default role, no host attribute needed
    this.#internals.ariaChecked = 'false';    // exposed to the accessibility tree
    this.addEventListener('click', () => this.toggle());
    this.addEventListener('keydown', (e) => {
      if (e.key === ' ') { e.preventDefault(); this.toggle(); }
    });
  }
  connectedCallback() {
    // Put the host in the tab order on connect (setting tabIndex in the constructor throws on createElement).
    if (!this.hasAttribute('tabindex')) this.tabIndex = 0;
  }
  toggle() {
    const on = this.#internals.ariaChecked !== 'true';
    this.#internals.ariaChecked = String(on);
  }
}
customElements.define('toggle-switch', ToggleSwitch);
```

This avoids polluting the DOM with ARIA attributes and prevents consumers from accidentally clobbering them, while the accessibility tree still sees the correct role and state.

## Focus management and `delegatesFocus`

- When the **host element itself is the interactive control** and carries the role and state via `ElementInternals` (like `ToggleSwitch` above), put the host in the tab order inside `connectedCallback` (`if (!this.hasAttribute('tabindex')) this.tabIndex = 0` — never in the constructor, which throws on `document.createElement`) so focus lands on the host and assistive technology announces its role and state. Do not set `tabindex` on the host for static, non-interactive components (such as a callout or card).
- Attach the shadow root with `delegatesFocus: true` when the component **wraps an internal focusable control** that owns the semantics (or on a form-associated custom element with `static formAssociated = true`). Focusing the host (and clicking an associated `<label>` for form-associated elements) then forwards focus to the first focusable child, and `:focus` matches the host. Do not combine `delegatesFocus: true` with a role/state on the host, or focus will land on the inner element and skip the host's state.
- For roving focus or moving focus into a newly revealed region, give the target `tabindex="-1"` and call `.focus()`; make programmatically-focusable targets explicit rather than relying on tab order.

## ARIA relationships across shadow roots

- **MANDATORY**: an `id` referenced by `aria-labelledby`, `aria-describedby`, `aria-controls`, etc. resolves only within the referencing element's **own** tree. An `id`-based attribute in the Light DOM cannot point at an `id` inside a shadow tree, and vice versa; the reference is silently ignored.
- To cross the boundary, use the reflected ARIA *element* properties (e.g. `ariaLabelledByElements`, `ariaDescribedByElements`, etc), which take direct JS element references instead of ids. They resolve **outward**: an element inside a shadow tree can point at a target in the Light DOM or any ancestor tree (including slotted content), so you can label a shadow-internal control from Light DOM content — something `id` references can't express.
- They do **not** resolve **inward**: an element can't reference *into* a descendant shadow tree (e.g. a host can't be labeled by its own shadow content). For that direction the emerging **Reference Target** mechanism is the standards direction, but it is not yet broadly available.
- When a relationship can't be expressed either way, keep it within one tree (render the label in the same tree) or use `aria-label` text instead of an `id` reference.

## Fallback strategies

Baseline status for ARIA attribute reflection: Widely available. It's been Baseline since 2023-10-24.
Supported by: Chrome 103 (Jun 2022), Edge 103 (Jun 2022), Firefox 119 (Oct 2023), and Safari 16.4 (Mar 2023).

Where the `ElementInternals` ARIA mixin is unavailable, set the role and ARIA state as attributes on the host instead (`this.setAttribute('role', 'switch')`). It works everywhere, at the cost of putting attributes in the DOM that a consumer could override.

Baseline status for the api.Element.ariaLabelledByElements capability: Newly available. It's been Baseline since 2025-04-04.
Supported by: Chrome 135 (Apr 2025), Edge 135 (Apr 2025), Firefox 136 (Mar 2025), and Safari 16.4 (Mar 2023).

Where the reflected ARIA *element* properties are unavailable, use an `id`-based `aria-*` attribute for same-tree relationships; a cross-boundary label has no `id`-based equivalent, so fall back to `aria-label` text.
