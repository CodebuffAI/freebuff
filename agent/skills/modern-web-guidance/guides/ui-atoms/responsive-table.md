# Responsive tables

Large data tables often become unreadable on small screens as columns overflow or shrink beyond legibility. This guide demonstrates how to use **sticky positioning** to keep headers visible during scrolling and how to transform the table into a mobile-friendly "stacked" layout when space is limited.

## Recommended Approach

The core of a responsive table is maintaining the relationship between data cells and their headers.

1.  **Semantic Foundation**: Use standard `<table>` elements with `<thead>`, `<tbody>`, and `<th>` elements.
2.  **Sticky Context**: Apply `position: sticky` to both column headers and row headers. This ensures that no matter how far a user scrolls in any direction, they never lose the context of what the data represents.
3.  **Adaptive Transformations**: Use `@container` queries instead of `@media` queries. This allows the table to adapt based on its own width (e.g., when placed in a sidebar or a narrow dashboard widget) rather than the entire viewport.
4.  **Label Injection**: In the stacked layout, the `<thead>` is hidden, and accessible headers are injected into each cell using `::before` pseudo-elements and CSS variables.
5.  **Legible Cells**: Keep long cell text on one line instead of letting columns shrink below legibility. See `single-line-overflow` (via `npx -y modern-web-guidance@latest retrieve "single-line-overflow"`) for techniques for truncating it and revealing the full text on demand without UX friction.

## Implementation Steps

### 1. Markup and Layout

Structure your table with standard semantic headers. Use a `.table-wrapper` to handle overflow and provide a container for queries. Add a `tabindex="0"` attribute to the container, to ensure that people using only a keyboard can consistently scroll the table.

Give the wrapper a `role="region"` attribute to communicate its purpose. Provide it with an accessible name using `aria-labelledby` (referencing the `id` attribute of an existing element that captions/names the table) or an `aria-label` attribute.

```html
<div tabindex="0" role="region" aria-labelledby="employee-table-caption" class="table-wrapper">
  <table>
    <caption id="employee-table-caption">Current employee directory</caption>
    <thead>
      <tr>
        <th>Employee</th>
        <th>Role</th>
        <th>Status</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <!-- Row header remains sticky horizontally on desktop, 
             and becomes a sticky card header on mobile -->
        <th>Alex Rivera</th>
        <td>Engineer</td>
        <td>Active</td>
      </tr>
    </tbody>
  </table>
</div>
```

### 2. Configure Sticky Headers
Enable scrolling and make headers sticky. Use logical properties and explicit z-index values to manage the stacking order.

```css
.table-wrapper {
  overflow: auto;
  max-inline-size: 100%;
  max-block-size: min(500px, 80vh);
  container-type: inline-size;
}

table {
  border-collapse: separate;
  border-spacing: 0;
}

/* Sticky column headers (desktop) */
thead {
  position: sticky;
  inset-block-start: 0;
  z-index: 1; /* Above sticky row headers */
}

/* Sticky row headers (desktop) */
tbody th {
  position: sticky;
  inset-inline-start: 0;
  background: white; /* Required to cover background during scroll */
}
```

### 3. Responsive Stacked Layout
When space is limited, hide the original header row and transform the table into cards. Inject labels using pseudo-elements. Only provide alternative text for non-text content, otherwise this may result in both the text content and accessible name being announced by screen readers.

```css
@container (width < 600px) {
  table, thead, tbody, tr, th, td {
    display: block;
  }

  thead {
    /* MANDATORY: Hide column header from layout and screen readers. */
    display: none
  }

  tr {
    margin-block-end: 1.5rem;
    border: 1px solid #ccc;
  }

  /* Sticky row headers at the top of each block/card */
  tbody th {
    position: sticky;
    inset-block-start: 0;
    z-index: 2;
    background: #eee;
  }

  /* Define column labels as CSS variables (often set via JS) */
  table {
    --label-1: "Employee";
    --label-2: "Role";
    --label-3: "Status";
  }

  /* Inject labels */
  td:nth-child(2)::before {
    /* MANDATORY: If using non-text content, provide the accessible name (after the /) which ensures screen readers hear the text alternative. */
    content: var(--label-2) ": ";
  }
  /* MANDATORY: Map the label for each column */
  td:nth-child(3)::before {
    content: var(--label-3) ": ";
  }
}
```
