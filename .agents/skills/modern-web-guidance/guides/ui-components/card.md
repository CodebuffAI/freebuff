# Build a Card

## Overview

A card groups one related piece of content or one choice. It is a visual pattern, not a fixed semantic or interaction model, so preserve the content's meaning and use the native interaction that matches its purpose.

## Guidelines

Choose semantics for the content and its interaction separately:

- use `<article>` as the card root, whether or not it links to a destination;
- use a native link for navigation. When the whole card is one destination, a single link may wrap the `<article>` only if the card contains no other interactive elements (`a`, `button`, `input`, `select`, `textarea`);
- keep links and buttons for independent actions as separate native controls;
- use a radio button or checkbox with an associated `<label>`, or an `option` in a native `<select>`, when the card is a choice.

Keep media, title, supporting content, and actions in meaningful source order; don't use CSS `order` to contradict it (see `css-layout` (via `npx -y modern-web-guidance@latest retrieve "css-layout"`)).

## Implementation

Keep the markup minimal and let CSS selectors recognize each region, so simple cards stay simple and richer cards stay possible. A card has up to four regions, in this source order, and any of them can be omitted. Regions are direct children of the card, not grouped in wrapper elements such as `.card__body`, which prevents placing and styling regions by selector. A region with a single element is that element itself, not wrapped: a lone paragraph is the `<p>`. Use a wrapper only when a region holds multiple elements.

- **Media**: an `<img>`, `<picture>`, `<video>`, or `<svg>` as the first child. Add a `.media` class only to arbitrary hero content that is not one of those elements, and never wrap a plain `<img>` in a `.media` element.
- **Header**: a heading on its own. Use `<hgroup>` only when the heading has a subtitle or tagline, and `<header>` when the region carries more than a title, such as a byline or badge. When the card has a primary destination, the link goes inside the heading.
- **Content**: a single `<p>`, `<ul>`, or `<dl>` stands on its own. When the content is several elements, such as multiple paragraphs or a paragraph plus a list, group them in one `<div>` so the region is a single grid item.
- **Footer**: a `<footer>` holding independent actions as native links and buttons. A "read more" link may share the heading link's URL, but give it a descriptive accessible name that starts with the visible text, using visually hidden text (for example, `Read more<span> about poached eggs</span>`), because identical "read more" links are ambiguous in a screen reader's link list. Don't add other footer links that repeat the heading's URL.

The simplest card is an `<article>` containing a heading and a paragraph. Choose the link and action pattern that matches the card's behavior; see [Interaction models](#interaction-models).

For card images or video that should fill a fixed-ratio area, set `aspect-ratio` and `object-fit: cover` on the `<img>` or `<video>` itself, so it fills the area without distortion (cropping may occur). Use a `.media` container's `aspect-ratio` only for other hero content. Otherwise, preserve the media's intrinsic ratio. Give informative images an appropriate text alternative; use `alt=""` for decorative images.

### Adapt to available space

Base the layout on the card's available space, not the viewport. To adapt the card's descendants (media, text, actions), make the card the size container (`container-type: inline-size`) and write `@container` rules against its children. Avoid sizing from the grid or list parent: the card's actual width can depend on column count, gaps and so on, making parent-based breakpoints are noisy.

In a narrow container, stack the regions in source order. In a wide container, place the media in a side column beside the other regions, but only for cards that have media: scope those rules with `:has()` on the media child (for example `.card:has(> img)`) so the column definitions and `grid-column` placements never apply to a card without media. A card without media stays single-column at every width, and must not reserve an empty media column.

### Align cards in a grid

When cards in a row should share the heights of their regions, use `subgrid`: make each card span four shared row tracks (media, header, content, footer) and place regions by element selector, treating everything that is not media, a heading, or a `<footer>` as content. A card that omits a region leaves its track empty, so the remaining regions still line up with neighboring cards. Each track holds one grid item, so wrap the content region in a `<div>` only when it has more than one element and cards share tracks. Cards that are not aligned with siblings need neither wrapper nor subgrid.

## Interaction models

### Content cards

Use an `<article>` as the card root. Keep links and buttons as separate native controls.

### Single-destination cards

When the whole card is one destination and has no independent actions, use one native link. The link can wrap the `<article>`. Do not nest other links, buttons, or form controls inside the link, and keep any "read more" text a plain `<p>` or `<span>`. Because the link's accessible name is all of the card's text, keep the content short; if the card has a lot of text or other actions, use the stretched-link pattern below so only the heading is the link:

```html
<a href="/recipes/poached-eggs">
  <article class="card">
    <h3>Poached eggs</h3>
    <p>Two poached eggs served on toasted sourdough.</p>
  </article>
</a>
```

### Clickable cards with independent actions

If clicking the card triggers an action rather than navigating, use a `<button>` instead of a link.

When a content card links to a primary destination, also contains other interactive elements, and needs to be clickable as a whole:
- Use a single opt-in, on the primary link itself: put `.card-link` on exactly one link per card (the heading link). Footer and other links never get it, or each would stretch its own overlay and the last one would capture the whole card.
- Link its title and stretch the pointer hit area across the card with `::after`

```css
.card:has(a.card-link) {
	position: relative;
}

.card a.card-link::after {
	content: "";
	position: absolute;
	inset: 0;
}
```

- Elevate interactive elements with `position: relative; z-index: 1` so they remain operable. Target types of elements (e.g. `a, button`) rather than requiring opt-in via classes. 
- Do NOT apply `z-index` to entire containers as that would make them capture pointer events that don't produce any action.

```css
.card:has(a.card-link) {
	/* Keep other interactive elements above the overlay */
	a:not(.card-link), button, input, x-button {
	    position: relative;
	    z-index: 1;
	}
}
```

- Style the card itself on hover/focus, rather than the stretched link:

```css
.card {
	a.card-link {
		&:focus-visible {
			outline: none; /* Draw it on the card instead */
		}
	}
	
	&:has(a.card-link:focus-visible) {
		/* Focus ring */
	}

	&:has(a.card-link:hover) {
		/* Hover styles */
	}
}

```

### Choice cards

For cards that represent predefined choices, use `<label class="card">` with a checkbox or radio as a direct child.

Style the selected card with `:has(:checked)`. Never change layout-affecting properties such as `border-width`, `padding`, or `font-weight` on selection, because the card and its neighbors jump; draw the emphasis with `outline`, `box-shadow`, or a transparent border that only changes color:

```css
.card {
  border: 2px solid transparent;

  &:has(> :checked) {
    border-color: var(--accent);
  }
}
```

The visible checkbox or radio is itself a non-color indicator of selection, so the color change alone is sufficient. If the control is visually hidden (keep it focusable and in the accessibility tree, never `display: none`), add a non-color indicator that does not affect layout, such as a check icon or a thicker `outline`.

When choices belong in a dropdown picker whose options are laid out as cards, use a native `<select>` with `appearance: base-select` and style `::picker(select)` and `<option>` elements rather than replacing the select with `<div>` cards; see `custom-select-picker-layouts` (via `npx -y modern-web-guidance@latest retrieve "custom-select-picker-layouts"`) for more details and fallbacks.
