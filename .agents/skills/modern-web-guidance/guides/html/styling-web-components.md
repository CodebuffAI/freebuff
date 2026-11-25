# Styling Web Components

Shadow DOM is a style boundary: page rules don't reach in and component rules don't leak out, except **inherited** properties (including custom properties). Cross it deliberately through the channels below.

## `:host`, `:host()`, `:host-context()`

```css
/* The component's own host element, styled from inside its shadow tree. */
:host { display: block; }

/* Only when the host matches a selector (e.g. a reflected state attribute). */
:host([disabled]) { opacity: 0.5; pointer-events: none; }

/* Based on an ancestor in the Light DOM; useful for theming. */
:host-context([theme="dark"]) { background: #111; color: #eee; }
```

**Avoid `:host-context()`.** It reaches *outside* the boundary to test ancestors, but Firefox and Safari have declined to ship it and the CSSWG is leaning toward not developing it further — treat it as a Chromium-only dead end, not a forward-looking option. Theme through an inherited CSS custom property instead (below): the consumer sets the property on an ancestor and the component reads it across the boundary, which works everywhere and keeps both sides decoupled.

## Inherited properties and custom properties cross the boundary

Inherited CSS properties (`color`, `font-family`, `line-height`, and CSS custom properties) **do** pass through the shadow boundary. This makes custom properties the primary theming API: expose them with sensible fallbacks.

```css
:host {
  /* Consumers override --card-bg from outside; the fallback keeps it usable. */
  background: var(--card-bg, white);
  color: var(--card-fg, black);
}
```

A custom property *defined* on `:host` can only be overridden by rules targeting the host element specifically. To let it inherit and be overridable from anywhere up the tree, leave the public property unset on `:host` and rely on the fallback in each `var()`; do not seed the public property on `:host`.

To keep the fallback declared once rather than repeated at every `var()`, define a private "shadow" property on `:host` that reads the public one, and reference the private property internally:

```css
:host {
  --_card-bg: var(--card-bg, white);
  --_card-fg: var(--card-fg, black);
}
.card { background: var(--_card-bg); color: var(--_card-fg); }
```

Consumers still override `--card-bg` from outside; the leading underscore signals the alias is internal, and the fallback lives in exactly one place.

## `::slotted()`: styling projected Light DOM

`::slotted(selector)` targets the **top-level** nodes assigned to a slot. It cannot reach their descendants, and it loses to any Light DOM rule (the consumer owns their own content), so use it for light touch-ups, not control. `::slotted(...) !important` can beat consumer rules, but doing so overrides styling the consumer is entitled to own — reserve it for structural fixes, not aesthetic overrides.

```css
/* Matches a slotted <p>, but NOT a <p> nested inside a slotted <div>. */
::slotted(p) { margin: 0; }
```

## `::part()` and `exportparts`: expose internals for theming

Mark an internal element with `part="name"` to let consumers style it with any property, without learning your internal structure.

```html
<!-- inside the shadow template -->
<button part="submit">Submit</button>
```

```css
/* consumer stylesheet */
my-card::part(submit) { background: navy; color: white; }
```

Expose a few **high-level** parts (button, input, label), not every `<div>`; broad part surfaces become a brittle API. To re-expose a nested component's parts upward through your own component, forward them with `exportparts`:

```html
<inner-widget exportparts="submit: card-submit"></inner-widget>
```

Choose between the two channels deliberately: **custom properties** for a constrained, design-system-safe set of values; **parts** for unrestricted styling of a specific element.

## Forwarding styles to a wrapped native element

When a custom element wraps a native control (`<my-button>` around a real `<button>`), three things routinely trip people up:

- **Form controls don't inherit typography.** `color` and custom properties cross the boundary, but `<button>`, `<input>`, and `<select>` take `font` and friends from the UA stylesheet, which does *not* inherit. The wrapped control therefore renders in the platform font, not the page font, until you set `font: inherit` (and usually `color: inherit`) on it inside the shadow tree. This is the single most common miss.
- **`:host` styles don't reach the inner element.** Setting `background`/`border`/`padding` on `:host` styles the host box, not the control inside it. Forward deliberately: expose the control as a `::part` for open-ended styling, or pipe a fixed set of values through custom properties — a `:host` rule does not cascade into the wrapped element.
- **`display: contents` + `all: inherit` is a real tradeoff, not a shortcut.** Collapsing the host with `display: contents` and resetting the inner control with `all: inherit` is currently the only generic way to pass arbitrary styles through to a wrapped native element without consumers learning per-component parts or custom properties — and removing the host's own box is usually *the point* of the pattern (composition compensating for a missing built-in inheritance). Two real caveats: `all: inherit` wipes UA defaults, so scope to specific properties or use `revert` when you want defaults back; and the concrete blocker — `getBoundingClientRect()` and `getClientRects()` return zero for `display: contents` elements, so anchor positioning against the host is broken. Reach for `::part` or custom properties when those tradeoffs don't fit.

## `:state()`: style the component's own states

A custom element can expose internal boolean states through `ElementInternals` via `this.#internals.states.add('busy')` and `.delete('busy')` (see `custom-elements` (via `npx -y modern-web-guidance@latest retrieve "custom-elements"`) for lifecycle usage), and those states become a styling channel across the boundary — like `::part` and custom properties, but for *state* rather than structure or values. Match them inside the shadow tree with `:host(:state(name))`, and from a consumer's stylesheet with `tag-name:state(name)`:

```css
/* Inside the component's shadow tree. */
:host(:state(busy)) button { opacity: 0.6; pointer-events: none; }

/* From the consumer's stylesheet — a read-only public hook. */
favorite-button:state(favorited) { filter: drop-shadow(0 0 4px crimson); }
```

Unlike a reflected attribute, a custom state is **read-only to the outside**: consumers can style it but cannot set or forge it, so the component stays the sole writer. Prefer it over a `data-*` attribute whenever the state is owned by the component and only needs to be styled.

## `@layer` and container queries inside components

- **Cascade layers** (`@layer`) work inside a shadow root and are scoped to it; a layer name in the shadow tree is independent of a same-named layer in the page. Use them to order your own component styles (e.g. `@layer base, theme;`) so consumer overrides via custom properties and `::part` still win predictably.
- **Container queries** are the right tool for responsive components: a component should respond to the space it's given, not the viewport. Declare the host or a wrapper as a container (giving `:host` a layout box such as `display: block`, since custom elements default to `display: inline` and size containment does not apply to `inline` or `contents` elements) and query it, so the same component adapts in a sidebar or a full-width region.

```css
:host {
  display: block; /* Required: size containment does not apply to default display: inline */
  container-type: inline-size;
}

@container (min-width: 30rem) {
  .card { grid-template-columns: 1fr 2fr; }
}
```

## Fallback strategies

Baseline status for Shadow parts: Widely available. It's been Baseline since 2020-07-28.
Supported by: Chrome 73 (Mar 2019), Edge 79 (Jan 2020), Firefox 72 (Jan 2020), Safari 13.1 (Mar 2020), and Safari iOS 13.4 (Mar 2020).

Baseline status for Cascade layers: Widely available. It's been Baseline since 2022-03-14.
Supported by: Chrome 99 (Mar 2022), Edge 99 (Mar 2022), Firefox 97 (Feb 2022), and Safari 15.4 (Mar 2022).

Baseline status for Container queries (size): Widely available. It's been Baseline since 2023-02-14.
Supported by: Chrome 105 (Sep 2022), Edge 105 (Sep 2022), Firefox 110 (Feb 2023), and Safari 16 (Sep 2022).

Browser support for :host-context(): Limited availability.
Supported by: Chrome 54 (Oct 2016) and Edge 79 (Jan 2020).
Unsupported in: Firefox and Safari.

`::part`, cascade layers, and container queries are broadly available; theme primarily through inherited custom properties, which work even where these don't. As noted above, do **not** rely on `:host-context()` — it is effectively Chromium-only and not a forward-looking option.
