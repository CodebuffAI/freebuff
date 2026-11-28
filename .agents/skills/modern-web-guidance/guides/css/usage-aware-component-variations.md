# Semantic Component Adaptation

Use style queries (`@container style()`) to trigger contextual variations without hardcoding what produces or reacts to each context. This reduces design system coupling and improves extensibility and component encapsulation.

For example, a `section.featured { --surface: featured }` rule can mark a context, and a landing page might also default to it via `main { --surface: featured }`. Components then opt in to react to `--surface: featured`: a card reveals a promotional badge, a button defaults to its filled variant, and so on.

Style queries let **both sides stay decoupled**: the featured surfaces never name the elements that adapt to them, and the components never inspect what produced the context. Either side can be extended independently — new components, new featured surfaces — without touching the other. Descendant selectors (e.g., `.featured .button`) force the opposite: the selector must encode both sides of the relationship and must change whenever either side does.

## When to use this guide

This guide covers *behavioral* changes: a component deciding **what to render, how to arrange itself, or which variant to present** in response to its context — hiding or showing a badge, switching layout direction, or swapping a button variant.

If instead you need *token-level* changes — density modes, themes, or other higher-order tokens that uniformly shift values like padding and color across many components — see `design-token-reactivity` (via `npx -y modern-web-guidance@latest retrieve "design-token-reactivity"`).

## Choosing the right tool

Reach for a style query when **both sides of a contextual relationship may change independently** — new elements may start producing the context, or new components may start reacting to it. The indirection pays for itself in extensibility and encapsulation, and style queries cross shadow DOM boundaries that descendant selectors cannot. When that flexibility isn't needed, prefer the simpler tool:

- **Descendant selectors** (`.toolbar .button`): a fixed, one-off relationship that isn't reusable or extensible. YAGNI applies — don't add indirection you won't use.
- **Size queries** (`@container (min-width: …)`): layout and density changes driven by available space, not semantic state.
- **Style queries** (`@container style(…)`): semantic state — what a component should render, arrange, or present in a given context.

## Implementation Directives

1. Define a semantic context flag using a CSS custom property on a container.
2. **DO NOT** set `container-type` for style queries; they query inherited custom properties on the nearest ancestor and don't require an explicit containment context.
3. **MANDATORY**: Use `@container style(--property: value)` to apply conditional styles to descendant elements. Style queries cannot match the element the property is set on — only its descendants.
4. **DO** prefer style queries over descendant selectors when the relationship must stay extensible or cross component/shadow DOM boundaries (see *Choosing the right tool* above) — but keep descendant selectors for fixed, one-off relationships where the indirection buys nothing.

## Implementation Example

```css
/* 1. Set the context on a layout container */
.featured {
  --surface: featured; /* Semantic context flag for children */
}

/* 2. Component reacts to inherited flag */
.button {
  /* Default: Outlined informational style */
  background: transparent;
  border: 1px solid currentColor;
}

.badge {
  /* Default: Hidden — only revealed in featured surfaces */
  display: none;
}

@container style(--surface: featured) {
  .button {
    /* Automatic switch to Filled promotional style */
    background: var(--brand-accent);
    color: white;
    border: none;
  }

  .badge {
    /* Reveal decorative elements only in featured context */
    display: block;
  }
}
```

## Fallback Strategies

Baseline status for Container style queries: Newly available. It's been Baseline since 2026-05-19.
Supported by: Chrome 111 (Mar 2023), Edge 111 (Mar 2023), Firefox 151 (May 2026), and Safari 18 (Sep 2024).

Until container style queries are widely available, layer them on as a progressive enhancement: ship a selector-based default that works everywhere, and let the style query override it when supported. Use `:where()` on the context selector so the style query (same specificity, later in source order) wins automatically.

```css
/* Default styles — work everywhere */
.button {
  background: transparent;
  border: 1px solid currentColor;
}

.badge {
  display: none;
}

/* Selector-based contextual styles — broad browser support */
:where(.featured) .button {
  background: var(--brand-accent);
  color: white;
  border: none;
}

:where(.featured) .badge {
  display: block;
}

/* Progressive enhancement: style queries override when supported */
@container style(--surface: featured) {
  .button {
    background: var(--brand-accent);
    color: white;
    border: none;
  }

  .badge {
    display: block;
  }
}
```

The selector fallback ties the contextual styling to a class name, which couples the component to its DOM placement. Once style queries are widely supported, the `:where()` rule can be removed.
