# Selector & @-rule Combinations

## The problem

We often need to combine filtering criteria of different types, e.g. selectors + media queries, media queries + container queries, and so on.

For example, combining `(prefers-color-scheme: dark)` with a selector that targets color scheme overrides (e.g. `:root:has(> head > meta[name="color-scheme"][content="dark"])` or `:root.dark`) to apply certain styles in light/dark mode regardless of how the color scheme was set.

The naive approach leads to duplicated code:

```css
/* Light mode styles */
.card.featured {
  font-weight: 400;
}

#logo-dark {
  display: none;
}

@media (prefers-color-scheme: dark) {
  /* Dark mode styles */
  :root:not(.light) {
    .card.featured {
      font-weight: 300;
    }

    #logo-dark {
      display: inline;
    }

    #logo {
      display: none;
    }
  }
}

/* Dark mode styles, again */
:root.dark {
  .card.featured {
    font-weight: 300;
  }

  #logo-dark {
    display: inline;
  }

  #logo {
    display: none;
  }
}
```

## What to do instead

Store the result of the combined filter on a custom property, then use container style queries to set rules based on that property.

IMPORTANT: Due to how container queries work, this technique only works if we can set the custom property on an ancestor of any rules that must be matched.

### 1. Decouple selection logic from applied rules

```css
:root {
  --color-scheme: light;

  @media (prefers-color-scheme: dark) {
    --color-scheme: dark;
  }

  &:has(> head > meta[name="color-scheme"][content="dark"]) {
    --color-scheme: dark;
  }

  &:has(> head > meta[name="color-scheme"][content="light"]) {
    --color-scheme: light;
  }
}
```

### 2. Key on the custom property for applied rules

```css
@container not style(--color-scheme: dark) {
  .card.featured {
    font-weight: 400;
  }

  #logo-dark {
    display: none;
  }
}

@container style(--color-scheme: dark) {
  .card.featured {
    font-weight: 300;
  }

  #logo {
    display: none;
  }
}
```

### 3. OPTIONAL: Utility classes for toggling visibility

A very common case is toggling visibility based on whether the criteria match.
Utility classes must win over arbitrary component styles (hence `!important`) and their shown `display` is unknown, so they can't use overrides — gate them with `not style(...)`:

```css
@container not style(--color-scheme: dark) {
  .if-dark {
    display: none !important;
  }
}

@container not style(--color-scheme: light) {
  .if-light {
    display: none !important;
  }
}
```

## Fallbacks

Baseline status for Container style queries: Newly available. It's been Baseline since 2026-05-19.
Supported by: Chrome 111 (Mar 2023), Edge 111 (Mar 2023), Firefox 151 (May 2026), and Safari 18 (Sep 2024).

There are two types of fallbacks, depending on how critical the branching is and what constitutes an acceptable fallback.

1. For critical branching, where all states must work correctly even if style queries are not supported, you simply cannot use style queries.
Instead, use the naive approach above, duplicating rules for each state.
Utility classes can still be used, as long as they are also defined that way.
2. For non-critical branching, where a default state is acceptable, you can define the base styles outside of any `@container` rule, and only use style queries as overrides.
This preserves most of the spirit of this approach, its main downside being the coupling of values that overrides introduce.

```css
#logo-dark {
  display: none;
}

@container style(--color-scheme: dark) {
  #logo-dark {
    display: inline; /* override */
  }

  #logo {
    display: none;
  }
}
```
