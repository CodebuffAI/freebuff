# Custom text decorations

Use the native `text-decoration` properties to style underlines, overlines, and strikethroughs, instead of faking them with borders, background gradients, or pseudo-elements. A native decoration follows the text across wrapped lines, tracks the font's metrics, skips glyph descenders, and inherits through nested elements, so none of that needs to be reimplemented. Reach for the box-based techniques at the end of this guide only when the decoration must outline or wrap the text rather than run along it.

Text decorations apply to any text, not only links. Where underlined text is not a link, make sure it cannot be mistaken for one. When decorating a link, use a real `<a href>` pointing at the destination (add `target="_blank" rel="noopener"` to open a new tab), not `href="javascript:void(0)"` with a script handler. A real link keeps middle-click, copy-link, and screen reader behavior.

## Style the line

Set line, style, color, and thickness with the `text-decoration` shorthand, and the gap from the text with `text-underline-offset`. Wrap the selector in `:where()` so the defaults have zero specificity and any later override wins, without needing custom properties.

```css
:where(.decorated) {
  /* Thickness is relative to the font size (0.08em is an example value), so the line is not too heavy
     on small text or too light on large text, and max() keeps it at least 1px so it never disappears. */
  text-decoration: underline solid currentColor max(1px, 0.08em);
  /* Use em so the gap scales with the font size. 0.2em clears most descenders; example value. */
  text-underline-offset: 0.2em;
}

/* Example hover state: a softer line that firms up on hover and focus. The 50% mix and
   0.12em thickness are example values. */
:where(.decorated) {
  text-decoration-color: color-mix(in srgb, currentColor, transparent);
}

:where(.decorated:is(:hover, :focus-visible)) {
  text-decoration-color: currentColor;
  text-decoration-thickness: max(1px, 0.12em);
}

/* Other lines are a different text-decoration-line on the same properties */
.decorated-over    { text-decoration-line: overline; }
.decorated-through { text-decoration-line: line-through; }
```

`text-decoration-style` accepts `solid`, `double`, `dotted`, `dashed`, and `wavy`. `text-underline-offset` applies to underlines only.

Starting points for the design:

* **Thickness:** about `0.06em` to `0.1em` for body text. Go thicker (`0.1em` to `0.15em`) for headings and emphasized states.
* **Offset:** about `0.15em` to `0.25em`. Dotted and wavy lines need a little more room than solid ones, so raise the offset for them.
* **Color:** `currentColor` keeps the line matched to the text. A softer mix of the text color that firms up on hover keeps long runs of links calm.
* **Style:** `solid` for links, `dotted` for terms and abbreviations, and `wavy` for annotations such as errors.

## Control where the line is skipped

### Ink skipping

By default, underlines and overlines break around glyph parts that cross them, such as descenders. Set `text-decoration-skip-ink` to choose the behavior:

```css
.decorated {
  /* auto: skip ink for most scripts (default). none: draw straight through.
     all: also skip ink in scripts where auto does not, such as Japanese or Chinese. */
  text-decoration-skip-ink: all;
}
```

* Keep `auto` for Latin text, and do not declare it: it is the default.
* Use `all` when the underline sits close enough to the baseline to cross ideographic glyphs, or when mixed-script text must look consistent.
* Use `none` for a very thick line, or a deliberately decorative one, where gaps would look like breaks.


#### Skip spaces

`text-decoration-skip-spaces` decides whether the line is drawn under spaces. The default, `start end`, leaves leading and trailing spaces undecorated.

```css
.decorated {
  /* Spaces collapse by default, so there is nothing to skip. Preserve them when the
     leading or trailing spaces are meaningful, such as padded input values. */
  white-space: pre;
  /* none: decorate every space. all: skip every space, so each word is underlined separately.
     start | end | start end: skip only leading, trailing, or both. */
  text-decoration-skip-spaces: all;
}
```

Do not declare `text-decoration-skip-spaces` unless the decoration should visibly cover padding (`none`) or break between every word (`all`). Ordinary inline text, such as the text of a link, has no leading or trailing spaces, so the declaration does nothing.

## Trim or extend the line with an inset

`text-decoration-inset` moves the start and end of the line. A positive value pulls an end inward, a negative value pushes it outward. One value moves both ends; two values set start and end separately. Percentages refer to the inline size of the decorated box.

```css
/* Small insets soften the ends of the line; larger ones read as a deliberately short line.
   Both values are examples. */
.trimmed  { text-decoration-inset: var(--deco-inset, 0.1em); }
.extended { text-decoration-inset: calc(var(--deco-inset, 0.1em) * -1); }
```

To reveal an underline on hover without a border or background gradient, trim the end by 100% and transition it back to 0:

```css
.reveal {
  text-decoration: underline; /* Always visible, including for reduced motion */
}

/* Only hide and animate the line when the user has not asked for reduced motion. */
@media (prefers-reduced-motion: no-preference) {
  .reveal {
    /* Trim the end by the full inline size so the line starts with zero length. */
    text-decoration-inset: 0 100%;
    /* 150ms to 300ms feels responsive without lagging; ease-out starts quickly. Example values. */
    transition: text-decoration-inset var(--reveal-duration, 0.25s) ease-out;
  }

  /* Include :focus-visible so keyboard users get the same reveal as pointer users. */
  .reveal:is(:hover, :focus-visible) {
    text-decoration-inset: 0 0;
  }
}
```

## Draw a custom line with a pseudo-element

Use a pseudo-element when the line must be a shape `text-decoration` cannot draw, such as a squiggle, and reveal it by clipping. No extra markup is needed, so the link stays a plain `<a>`.

```html
<a class="draw" href="#">Hover to draw underline</a>
```

```css
.draw {
  position: relative;
  display: inline-block;
  color: inherit;
  text-decoration: none;
  padding-block-end: 0.4em; /* Space for the line below the text; example value */
}

.draw::after {
  content: "";
  position: absolute;
  inset: auto 0 0 0;
  block-size: 0.4em; /* Height of the squiggle; example value */
  pointer-events: none;
  border: var(--deco-thickness, max(1px, 0.08em)) solid var(--deco-color, currentColor);
  /* A single shape strokes along its path, using the border width as the stroke. Example squiggle. */
  border-shape: shape(from 0% 50%,
    curve to 20% 50% with 5% 0% / 15% 100%,
    smooth to 40% 50% with 35% 100%,
    smooth to 60% 50% with 55% 100%,
    smooth to 80% 50% with 75% 100%,
    smooth to 100% 50% with 95% 100%);
}

/* Only hide and animate the line when the user has not asked for reduced motion;
   otherwise it stays fully drawn. */
@media (prefers-reduced-motion: no-preference) {
  .draw::after {
    /* Clip the line away from the right edge. The negative block insets keep the stroke
       from being cut off vertically. */
    clip-path: inset(-1em 100% -1em 0);
    /* A slightly slower draw than a hover reveal reads as drawing; example duration. */
    transition: clip-path var(--draw-duration, 0.6s) ease-out;
  }

  .draw:is(:hover, :focus-visible)::after {
    clip-path: inset(-1em 0 -1em 0); /* Fully drawn */
  }
}
```

## Outline text with a box instead

Two box properties decorate text by outlining it rather than running a line along it. Give the text padding so the outline does not touch it.

```css
/* Gradient outline with a see-through middle */
.ring {
  padding: 0.2em 0.75em; /* Example values: enough room that the outline does not touch the text */
  /* The border width is the visible outline thickness. Relative to the font size, with a 2px
     minimum so it stays visible on small text; example value. */
  border: var(--ring-width, max(2px, 0.12em)) solid transparent;
  background: linear-gradient(135deg, var(--ring-start, #2563eb), var(--ring-end, #db2777)) border-box;
  /* Paint the background only under the border, so the inside stays transparent. */
  background-clip: border-area;
}

/* Border that follows a shape that border-radius cannot draw, such as a tag with a pointed end */
.tag {
  padding: 0.2em 1.5em 0.2em 0.9em; /* Example values: extra room at the point so the text is not clipped */
  border: var(--shape-stroke, max(2px, 0.08em)) solid var(--shape-color, currentColor); /* Example stroke width */
  /* A single shape strokes along its path. Two shapes fill the area between them.
     This polygon is an example; use shape() for curves. */
  border-shape: polygon(0 0, 85% 0, 100% 50%, 85% 100%, 0 100%);
}
```

`border-shape` replaces only the border. The background is still the rectangular box, so do not rely on it to fill a shape.

When only the corners need a different shape, such as a beveled, scooped, or notched label, use `corner-shape` with `border-radius` instead. It keeps the background and border following the corners, and unsupported browsers fall back to ordinary rounded corners.

```css
.label {
  padding: 0.2em 0.9em; /* Example values */
  border: var(--shape-stroke, max(2px, 0.08em)) solid var(--shape-color, currentColor);
  border-radius: 0.6em; /* Corner size; example value */
  corner-shape: bevel; /* round (default) | scoop | bevel | notch | square | squircle */
}
```

## Choose a technique

* **`text-decoration`** (line, ink skipping, spaces, inset): the line should run along the text, wrap with it, and follow its font metrics. This is the default choice.
* **Pseudo-element with `border-shape` and `clip-path`**: the line is a custom shape or needs a draw-on animation. Choose it only when `text-decoration-style` cannot produce the look, because it needs extra positioning.
* **`background-clip: border-area`**: the text needs a gradient outline. Use plain `border-color` when a solid outline is enough.
* **`corner-shape`**: only the corners need a different shape, such as beveled, scooped, or notched. Pair it with `border-radius`, which sets the corner size.
* **`border-shape`**: the outline needs a shape `border-radius` cannot draw, such as a tag or arrow. Use `border-radius` when rounded corners are enough.
* **Inset hover reveal**: worth adding when a link needs a hover affordance beyond a color change. Skip it for text that is not interactive.

## Fallback Strategies

Each fallback keeps the text readable and keeps the core decoration. Frame the need in terms of your Baseline target: if it includes browsers without a property, apply the matching fallback.

### Ink skipping `all`

Baseline status for text-decoration-skip-ink: all: Newly available. It's been Baseline since 2026-05-07.
Supported by: Chrome 148 (May 2026), Edge 148 (May 2026), Firefox 75 (Apr 2020), and Safari 15.4 (Mar 2022).

If your Baseline target does not support `text-decoration-skip-ink: all`, the declaration is ignored and the browser keeps `auto`. Latin descenders are still skipped; only scripts that `auto` does not cover, such as Japanese, lose ink skipping. This is graceful degradation, so no extra code is needed.

### Skip spaces

If your Baseline target does not support `text-decoration-skip-spaces`, the browser uses its own default handling of spaces. This is graceful degradation: the line is drawn under spaces the browser does not skip.

### Inset

If your Baseline target does not support `text-decoration-inset`, the
declaration is ignored, so the link keeps its normal, fully visible underline
and the transition has nothing to animate. This is graceful degradation: the
hover reveal is lost and the link stays underlined, so no `@supports` check is
needed.

### Border area

Browser support for background-clip: border-area: Limited availability.
Supported by: Chrome 150 (Jun 2026), Edge 150 (Jul 2026), and Safari 18.2 (Dec 2024).
Unsupported in: Firefox.

If your Baseline target does not support `background-clip: border-area`, the declaration is ignored and the background paints under the whole border box, filling the text instead of only its outline. Do NOT settle for a plain solid border when the gradient is part of the design. Reproduce the gradient instead, and apply `background-clip: border-area` only inside `@supports`.

Use an opaque layer when the element's background is a known flat color. Paint the surface color over the padding box and the gradient under the border box, so the gradient shows only through the transparent border:

```css
.ring {
  border: var(--ring-width, max(2px, 0.12em)) solid transparent; /* Example width */
  /* Fallback: an opaque surface layer hides the gradient inside the border. */
  background:
    linear-gradient(var(--surface, canvas) 0 100%) padding-box,
    linear-gradient(135deg, var(--ring-start, #2563eb), var(--ring-end, #db2777)) border-box;
}

@supports (background-clip: border-area) {
  .ring {
    background: linear-gradient(135deg, var(--ring-start, #2563eb), var(--ring-end, #db2777)) border-box;
    background-clip: border-area; /* The inside stays transparent */
  }
}
```

Use a masked pseudo-element when the inside must stay transparent. The pseudo-element carries the gradient, and a mask cuts out everything but its padding ring:

```css
@supports not (background-clip: border-area) {
  .ring {
    position: relative;
    border-color: transparent;
  }

  .ring::before {
    content: "";
    position: absolute;
    inset: calc(var(--ring-width, max(2px, 0.12em)) * -1); /* Cover the border box */
    padding: var(--ring-width, max(2px, 0.12em)); /* Ring thickness */
    border-radius: inherit;
    background: linear-gradient(135deg, var(--ring-start, #2563eb), var(--ring-end, #db2777));
    /* Keep only the area between the content box and the border box. */
    mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
    mask-composite: exclude;
    pointer-events: none;
  }
}
```

### Border shape

Browser support for border-shape: Limited availability.
Supported by: Chrome 147 (Apr 2026) and Edge 147 (Apr 2026).
Unsupported in: Firefox and Safari.

If your Baseline target does not support `border-shape`, the declaration is ignored and the element keeps its rectangular border. A rounded rectangle is only an acceptable fallback when the shape is purely decorative. When the shape carries meaning, such as a tag, arrow, or callout, reproduce it as closely as possible, and apply `border-shape` only inside `@supports`.

Draw the outline with a clipped pseudo-element. Keep a transparent border so the box is the same size as in the supported case, fill the pseudo-element with the outline color, and cut it into a ring with an `evenodd` `clip-path`: the outer shape, then the same shape inset by the stroke width.

```css
.tag {
  --stroke: max(2px, 0.08em); /* Example stroke width */
  position: relative;
  padding: 0.2em 1.5em 0.2em 0.9em; /* Example values */
  border: var(--stroke) solid transparent;
}

@supports not (border-shape: circle(50%)) {
  .tag::before {
    content: "";
    position: absolute;
    inset: calc(var(--stroke) * -1); /* Cover the border box */
    background: var(--shape-color, currentColor);
    pointer-events: none;
    /* Outer shape, then the inner shape inset by the stroke. The inner points are approximate on
       diagonal edges, so the stroke looks slightly thinner there. */
    clip-path: polygon(evenodd,
      0 0, 85% 0, 100% 50%, 85% 100%, 0 100%,
      var(--stroke) var(--stroke),
      calc(85% - var(--stroke)) var(--stroke),
      calc(100% - var(--stroke) * 2) 50%,
      calc(85% - var(--stroke)) calc(100% - var(--stroke)),
      var(--stroke) calc(100% - var(--stroke)));
  }
}

@supports (border-shape: circle(50%)) {
  .tag {
    border-color: var(--shape-color, currentColor);
    border-shape: polygon(0 0, 85% 0, 100% 50%, 85% 100%, 0 100%);
  }
}
```

For a filled shape rather than an outline, put `clip-path: polygon(...)` with the same points directly on the element.

For the pseudo-element underline, draw a straight line with `border-block-end` on `.draw::after`, and apply the `block-size`, `border`, and `border-shape` squiggle only inside `@supports (border-shape: circle(50%))`. The line is straight but still draws on, because the `clip-path` animation does not depend on the shape.

`clip-path` also clips focus rings and `box-shadow`. Do not rely on an outline on the clipped element to show focus; style `:focus-visible` with a color or background change instead.
