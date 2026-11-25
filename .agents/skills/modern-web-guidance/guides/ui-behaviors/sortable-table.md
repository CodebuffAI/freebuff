# Sortable Table

Use this pattern to let users sort a data table by clicking its column headers. Start from a complete, semantic `<table>` that is readable without JavaScript, then enhance it.

This guide covers the header controls, sort state, sorting logic, and applying the new order to the DOM. For keeping state inside rows while they move, see `move-dom-element-without-losing-state` (via `npx -y modern-web-guidance@latest retrieve "move-dom-element-without-losing-state"`). For other narrow-screen table patterns, see `responsive-table` (via `npx -y modern-web-guidance@latest retrieve "responsive-table"`).

For sorting lists and card grids that are not tables, see `dynamic-sort` (via `npx -y modern-web-guidance@latest retrieve "dynamic-sort"`).

## Header markup

* **MANDATORY:** Put a `<button type="button">` inside each sortable `<th scope="col">`. Do not make the `<th>` itself clickable, and do not use `<a>` or `role="button"`.
* Set `aria-sort="ascending"` or `aria-sort="descending"` on the `<th>` of the currently sorted column only, and remove it from all other headers. Do not set `aria-sort="none"`, and do not put `aria-sort` on the button.
* Leave non-sortable columns as plain `<th>` text with no button. Keep their padding, alignment and font weight matching the sortable headers: drop the cell padding only on `th:has(> button)`, since the button supplies it.
* Keep the table's `<caption>` as its accessible name, and keep data rows in a `<tbody>` so sorting reorders only body rows and never the `<thead>` row.
* Use a decorative icon for the sort direction (`aria-hidden="true"`, `currentColor`, see `icons` (via `npx -y modern-web-guidance@latest retrieve "icons"`)). Drive its appearance from `th[aria-sort]` in CSS, not from extra classes or JavaScript. The icon is visual only and hidden from assistive technology, so always convey the sort state with `aria-sort` on the `<th>`.
* Give the button a minimum 24px target and a `:focus-visible` outline. Make it fill the cell.

## Wire buttons with invoker commands

Use `commandfor` pointing at the table and a custom `--sort` command (custom commands must start with `--`). Handle it with one `command` listener on the table instead of a click listener per button. `event.source` is the button that was activated.

```html
<th scope="col" data-type="number">
  <button type="button" commandfor="planets" command="--sort">
    Moons
  </button>
</th>
```

```javascript
table.addEventListener('command', (event) => {
  if (event.command === '--sort') sortBy(event.source);
});

// `button` is the header button that was activated.
function sortBy(button) {
  const th = button.closest('th');
  const direction = th.getAttribute('aria-sort') === 'ascending' ? 'descending' : 'ascending';

  for (const header of table.tHead.rows[0].cells) header.removeAttribute('aria-sort');
  th.setAttribute('aria-sort', direction);

  const rows = sortRows([...tbody.rows], th.cellIndex, th.dataset.type, direction);
  reorderWithTransition(rows);
  // One message per sort; the status element must already be in the DOM.
  status.textContent = `Sorted by ${button.textContent.trim()}, ${direction}, ${rows.length} rows`;
}
```

* The first activation sorts ascending; each repeat toggles direction. Switching columns starts ascending again.
* Keep focus on the header button that was activated.

## Compare values correctly

* Compare text with `Intl.Collator` (`numeric: true, sensitivity: 'base'`), not `<` or `localeCompare` in a loop.
* Compare numbers, dates and currency as numbers. Read the raw value from a `data-value` attribute (or `<time datetime>`) when the displayed text is formatted, for example `12,104` or `$1.2k`.
* Declare the type per column with `data-type` rather than guessing from content.
* `Array.prototype.sort` is stable, so equal rows keep their previous relative order.

```javascript
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function sortRows(rows, index, type, direction) {
  const factor = direction === 'ascending' ? 1 : -1;
  // Prefer the raw value when the displayed text is formatted.
  // This reads the DOM on every comparison; for large tables, read each row's value once before sorting.
  const value = (row) => row.cells[index].dataset.value ?? row.cells[index].textContent.trim();
  return rows.sort((a, b) =>
    factor * (type === 'number' ? value(a) - value(b) : collator.compare(value(a), value(b)))
  );
}
```

## Reorder the existing rows

**MANDATORY:** Move the existing `<tr>` elements within the `<tbody>`. Do not rebuild the table or `<tbody>` with `innerHTML` or a re-render: that discards focus and state inside rows and breaks view transitions, which match old and new elements by identity. Never move the header row.

```javascript
// Moving every row to the end in sorted order is enough; no need to compute minimal moves.
function reorder(container, orderedRows) {
  for (const row of orderedRows) container.moveBefore(row, null);
}
```

**DO NOT** fake the order with CSS `order`; DOM order must match visual order for keyboard and screen reader users.

## Optionally animate the reorder

Animation is an enhancement; the sort works without it. For when to animate, reduced-motion handling and rapid-click behavior, see `dynamic-sort` (via `npx -y modern-web-guidance@latest retrieve "dynamic-sort"`). Skip it for large tables.

```css
tbody tr {
  /* Derives a unique name from each row's identity. */
  view-transition-name: match-element;
}

@media (prefers-reduced-motion: reduce) {
  ::view-transition-group(*),
  ::view-transition-old(*),
  ::view-transition-new(*) {
    animation: none;
  }
}
```

```javascript
// Scoped to the table so the rest of the page stays interactive during the animation.
function reorderWithTransition(rows) {
  table.startViewTransition(() => reorder(tbody, rows));
}
```

* **DO NOT** put `aria-live` on the table: it would announce every moved row. Use the single `role="status"` element instead, hidden visually (not with `display: none`) using `clip-path: inset(50%)` and a 1px size.

## Narrow screens

Wrap the table in a horizontally scrollable container (`overflow-x: auto`) with `role="region"`, an accessible name from the caption via `aria-labelledby`, and `tabindex="0"` so keyboard users can scroll it. Give the table a `min-inline-size` so columns do not collapse.

## Common mistakes

* **DO NOT** re-render the `<tbody>` or `<table>` on sort; it discards focus and state and breaks view transitions.
* **DO NOT** put `aria-live` on the table, or announce each row.
* **DO NOT** leave `aria-sort` on more than one header.
* **DO NOT** change the button's label to describe the action ("Sort ascending"). Keep the column name; `aria-sort` conveys state.
* **DO NOT** sort formatted strings when the underlying values are numbers or dates.

## Fallbacks

Baseline status for Invoker commands: Newly available. It's been Baseline since 2025-12-12.
Supported by: Chrome 135 (Apr 2025), Edge 135 (Apr 2025), Firefox 144 (Oct 2025), and Safari 26.2 (Dec 2025).

If your Baseline target does not support invoker commands, the `command` event never fires and the header buttons do nothing. Feature-detect support and, only when it is missing, add a `click` listener to each header button that runs the same sort function. Mouse, touch and keyboard activation then behave identically, so this fallback is faithful to the use case.

```javascript
// Only without invoker commands: in supporting browsers a click also fires `command`,
// so an unconditional click listener would sort twice and undo the first sort.
if (!('commandForElement' in HTMLButtonElement.prototype)) {
  for (const button of table.tHead.querySelectorAll('button[command="--sort"]')) {
    button.addEventListener('click', () => sortBy(button));
  }
}
```

**DO NOT** fall back to `pointer-events: none` on the buttons: they stay focusable and keyboard-activatable, so keyboard users reach controls that silently do nothing.

The buttons do nothing without JavaScript either way, so add them from script if the table must stay fully readable without it.

Browser support for Element-scoped view transitions: Limited availability.
Supported by: Chrome 147 (Apr 2026) and Edge 147 (Apr 2026).
Unsupported in: Firefox and Safari.

Browser support for moveBefore(): Limited availability.
Supported by: Chrome 133 (Feb 2025), Edge 133 (Feb 2025), and Firefox 144 (Oct 2025).
Unsupported in: Safari.

If your Baseline target does not support `moveBefore()` or element-scoped view transitions, follow the fallbacks in `dynamic-sort` (via `npx -y modern-web-guidance@latest retrieve "dynamic-sort"`); the table still sorts and the announcement is unchanged.

