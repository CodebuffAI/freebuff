# Build breadcrumbs

Breadcrumbs show where the user is in a site hierarchy and link to each ancestor page.

This is not for switching between views of the same page (tabs) or for site-wide navigation (a navbar).

## 1. Semantics

- Wrap the trail in `<nav aria-label="Breadcrumbs">` containing an ordered list (`<ol>`) of `<li>` items, each holding an `<a>`. Order conveys hierarchy, so use `ol`, not `ul`.
- Give each `<nav>` a unique label if a page has several landmarks (e.g. "Breadcrumbs").
- Mark the current page, the last item, as a link with `aria-current="page"`. Keep it a link (not plain text) so the trail structure stays consistent.
- Dividers are decorative. Do not put them in the markup as text. Generate them in CSS with an empty alt so they stay out of the accessibility tree:

```css
/* The empty alt text after the slash hides the divider from screen readers; li + li skips the first item */
.breadcrumb > ol > li + li::before { content: "/" / ""; }
```

- A styled character (`/`, `›`, `>`) generated as above is the simplest divider. For an icon divider such as a chevron, render it the way the codebase renders icons and keep it decorative; see `icons` (via `npx -y modern-web-guidance@latest retrieve "icons"`).

## 2. Styling

- Lay out with `display: flex; flex-wrap: wrap; align-items: center; gap` on the `<ol>`; reset list styles.
- Whatever the visual style, the trail must read as a path: each step visibly follows the previous one through a separator (slash or chevron) or an arrow or slant shape. Plain links with a separator are the default and the safest choice.
- **DO NOT** drop the separator in chip-like styles. Pills, tags and a segmented bar without one look like tabs or filters (items on the same level), not a hierarchy. Plain text with no divider is also weak, since order is then the only cue; avoid it.
- Choose a visual variant:
  - **Plain (slash or chevron):** use when the trail should stay visually quiet. Underline links at rest, or at least on hover and focus, so they never rely on color alone.
  - **Bar:** one bordered, segmented container with `overflow: clip`; use when segments need large, clear touch targets. Keep a separator in each segment after the first. A bar must not wrap: when its segments no longer fit on one row, stack it in a column in a container query set just above the bar's natural width (measure it and round up, so it stacks only when it would not fit), with compact rows (smaller block padding), separated by a 1px `border-block-start` and the chevron turned to point down and use a fixed `border-radius` for a joined pill, since `999px` becomes an oval once it grows tall. For a joined pill, round the container (`border-radius: 999px`) and separate segments with a 1px `border-inline-start` and no gap. Give the current page's `<li>` the same background as its link, so the chevron outside the link does not sit on the bar's background. Round the container, not the individual links, so the clip handles the end caps, and give the end links the same end radius so an inset focus ring follows the rounded ends instead of being cut off.
  - **Pills / tags:** use rounded or shaped links when the trail is a prominent control, with a separator between them. Show backgrounds only on hover for tags.
- Style the current page distinctly (weight, color) and non-current links with a hover state.
- Custom palettes must meet WCAG AA contrast (4.5:1 for text) for links, hover, and the current page against their actual backgrounds (e.g. dark red on light gray). Keep a non-color cue on the current page, such as font weight.
- Provide a clear `:focus-visible` outline that has a contrast of at least `3:1` with the background color. For shaped or clipped segments use a negative `outline-offset` or a background/color change, since outlines get clipped.
- Lift the focused link above its neighbors (`position: relative; z-index: 1` on `a:focus-visible`). Neighbors that overlap it (shaped segments) are painted later and cover an outside ring.
- In `forced-colors: active`, restore borders and an underline on `[aria-current="page"]` since backgrounds are removed. An icon divider drawn as a masked background also needs `forced-color-adjust: none` and a system color such as `CanvasText`, since forced colors replaces the background.

### Shaped segments

Pick the simplest technique that produces the shape, and use **one** shape per trail. The snippets are alternatives, not meant to be combined.

- Selectors are illustrative; use your own hook (`.breadcrumb` here). Scope to `> ol > li > a`.
- Make the slant or point size responsive with `clamp()` and container units (`cqi`).
- Pair state colors with the shape: hover and current-page styles must use background or text color, not border color. Keep the focus style visually distinct from hover.
- Use a negative `outline-offset` for focus, since outside outlines are covered by neighbors.

#### Overlapping segments

Overlapping segments communicate hierarchy even without a separator. Pull each segment under the previous one with a negative inline margin, and stack them in reverse source order so each earlier segment sits above the next. `sibling-index()` and `sibling-count()` make this possible without per-item rules:

```css
.breadcrumb > ol > li { position: relative; z-index: calc(sibling-count() - sibling-index()); }
/* The focused segment sits above every other segment (the li is the stacking context, so lift it, not the link) */
.breadcrumb > ol > li:has(> a:focus-visible) { z-index: calc(sibling-count() + 1); }
```

#### Simple irregular shapes (`corner-shape`)

Prefer `corner-shape: bevel` with an irregular `border-radius` for parallelograms and arrows. It has better browser support than `border-shape` and keeps normal border flexibility (per-side widths, colors and styles), whereas `border-shape` needs explicit inner and outer shapes or is limited to a uniform stroke. Use logical corner properties so RTL mirrors automatically; no `:dir(rtl)` rule is needed.

Slant (`/`): bevel the start-start and end-end corners with a horizontal radius of the slant and a vertical radius of 100%.

Arrow (`>`): bevel both end corners with a horizontal radius of the point and a vertical radius of 50%. Overlap the next segment so the tip of each segment covers the flat start edge of the next.

```css
.breadcrumb { --slant: clamp(.4rem, 2cqi, .75rem); }
.breadcrumb > ol, .breadcrumb > ol > li { gap: 0; }
.breadcrumb > ol > li > a {
  display: block;
  corner-shape: bevel;
  /* Extra inline padding equal to the slant keeps text out of the angled corners */
  padding: .55rem calc(var(--slant) + .8rem);
}
/* The shape shows direction, so drop the separator */
.breadcrumb > ol > li + li::before { content: none; }

/* SLANT ONLY: leans like "/" in LTR and "\" in RTL */
.breadcrumb > ol > li > a {
  border-start-start-radius: var(--slant) 100%;
  border-end-end-radius: var(--slant) 100%;
}
/* Overlap by the slant, minus a small visible gap (example .25rem), so the angled edges run parallel */
.breadcrumb > ol > li + li { margin-inline-start: calc(.25rem - var(--slant)); }

/* ARROW ONLY: tip on the end side; a contrasting segment border separates the overlapped edges */
.breadcrumb > ol > li > a {
  border-start-end-radius: var(--slant) 50%;
  border-end-end-radius: var(--slant) 50%;
}
.breadcrumb > ol > li + li { margin-inline-start: calc(var(--slant) * -1); }
```

#### Fully irregular shapes (`border-shape`)

Use `border-shape` only for shapes `corner-shape` cannot make, such as a notched arrow with a concave leading edge. Define the polygon in a custom property (`--shape`) and apply it with `border-shape` so borders and focus outlines follow the shape. Polygons are physically directional and logical properties don't flip `polygon()` coordinates, so each shape needs an explicit `:dir(rtl)` mirror.

```css
/* The first item drops the inner notch vertex so its leading edge stays flat */
.breadcrumb > ol > li > a {
  --shape: polygon(0 0, calc(100% - var(--point)) 0, 100% 50%, calc(100% - var(--point)) 100%, 0 100%, var(--point) 50%);
  padding: .55rem calc(var(--point) + .8rem);
  border-shape: var(--shape);
}
.breadcrumb > ol > li:first-child > a {
  --shape: polygon(0 0, calc(100% - var(--point)) 0, 100% 50%, calc(100% - var(--point)) 100%, 0 100%);
}
/* Overlap by slightly less than --point so the notch and tip interlock */
.breadcrumb > ol > li + li { margin-inline-start: calc(.25rem - var(--point)); }
/* RTL mirror: swap 0 with 100% and calc(100% - var(--point)) with var(--point) in each x coordinate */
.breadcrumb:dir(rtl) > ol > li > a {
  --shape: polygon(100% 0, var(--point) 0, 0 50%, var(--point) 100%, 100% 100%, calc(100% - var(--point)) 50%);
}
.breadcrumb:dir(rtl) > ol > li:first-child > a {
  --shape: polygon(100% 0, var(--point) 0, 0 50%, var(--point) 100%, 100% 100%);
}
```

## 3. Optional UX enhancements

These are optional. Implement them only when the trail needs them, and choose the implementation yourself.

- **Sibling menus:** when ancestors have meaningful siblings (e.g. docs sections), let an ancestor expose its siblings in a menu. Keep the ancestor link navigating and put the toggle in a separate button, never inside the `<a>`. For menu mechanics, see `menu` (via `npx -y modern-web-guidance@latest retrieve "menu"`).
- **Long trails:** collapse the middle of a trail with more than 3 items on narrow containers instead of letting it wrap, keeping the first item and the last two. Put the hidden links in a popup opened from a "…" button, and keep the full trail when script is unavailable.
- **Long labels:** keep every item on one line and never truncate the current page. See `single-line-overflow` (via `npx -y modern-web-guidance@latest retrieve "single-line-overflow"`) for techniques for truncating ancestor labels and revealing the full label on demand without UX friction.

## Fallback strategy

### `corner-shape`

Browser support for corner-shape: Limited availability.
Supported by: Chrome 139 (Aug 2025) and Edge 139 (Aug 2025).
Unsupported in: Firefox and Safari.

- Rounded corners are not an acceptable fallback for slants and arrows. Keep plain bordered rectangular segments with a separator (`li + li::before`) as the base style, and put everything from the shape snippets that makes the shape (`corner-shape`, the radii, the padding, the overlap margins and `content: none` on the separator) inside `@supports (corner-shape: bevel)`, so unshaped segments neither overlap nor lose their separator.

### `sibling-index()` and `sibling-count()`

Baseline status for sibling-count() and sibling-index(): Newly available. It's been Baseline since 2026-08-18.
Supported by: Chrome 138 (Jun 2025), Edge 138 (Jun 2025), Firefox 154 (Aug 2026), and Safari 26.2 (Dec 2025).

- Without support, later segments paint on top: slants are unaffected, but arrow tips are hidden. Put the stacking rules in `@supports (z-index: sibling-index())`, and gate the arrow shape on both `corner-shape` and `sibling-index()` so it stays plain with a separator otherwise:

```css
@supports (corner-shape: bevel) and (z-index: sibling-index()) {
  /* Arrow-only shape, overlap and stacking rules from above */
}
```

### `border-shape`

Browser support for border-shape: Limited availability.
Supported by: Chrome 147 (Apr 2026) and Edge 147 (Apr 2026).
Unsupported in: Firefox and Safari.

- Use `clip-path: var(--shape)` with the same polygon as the base style, and enhance inside `@supports (border-shape: polygon(0 0, 100% 0, 100% 100%))` by setting `clip-path: none` and applying `border-shape`.
- `clip-path` clips borders and outlines, so under the fallback use a color/background change plus negative `outline-offset` for focus instead of an outside outline.
- `clip-path` also cuts the slanted sides off a border, and `forced-colors: active` removes the background that draws the shape, so a clipped segment loses its outline. Under forced colors, drop the clip and use plain bordered segments with a text separator so the trail still reads as a path:

```css
@media (forced-colors: active) {
  /* Only without border-shape: with it, the border follows the shape and needs no change */
  @supports not (border-shape: polygon(0 0, 100% 0, 100% 100%)) {
    .breadcrumb > ol > li > a { clip-path: none; border: 2px solid LinkText; }
    .breadcrumb > ol > li + li { margin-inline-start: 0; } /* undo the shape overlap */
    .breadcrumb > ol > li + li::before { content: "›" / ""; } /* the shape no longer shows direction */
  }
}
```

- The trail remains fully functional; only borders and outlines differ.
