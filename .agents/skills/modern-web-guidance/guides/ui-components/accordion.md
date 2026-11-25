# Accordion

Build accordions from a set of adjacent `details` elements.

If the accordion is a distinct section of the page, group its items in an element with an accessible name, such as a `section` labeled by the group heading.

```html
<section class="accordion" aria-labelledby="faq-heading">
	<h2 id="faq-heading">Frequently Asked Questions</h2>
	<details>
		<summary>Lorem ipsum dolor sit amet?</summary>
		<!-- answer 1 -->
	</details>
	<details>
		<summary>Consectetur adipiscing elit?</summary>
		<!-- answer 2 -->
	</details>
</section>
```

**Warning:** Do not put headings inside `summary`. JAWS and TalkBack expose `summary` as a button and drop any heading inside it, so their users cannot move between items by heading.
If each item needs its own heading, build a custom accordion instead (see below).

Accessibility notes:
- Do not wrap every small accordion in a landmark or `region`; that adds navigation noise for screen reader users.
- Do not add arrow key navigation, roving `tabindex`, or `Home`/`End` handling.
Accordion contents are often long enough to need scrolling, and arrow keys on a focused trigger are how keyboard users scroll.
- If a heading for the entire accordion is not desirable, use an `aria-label` on the container element to provide an accessible name for the group.

## Exclusive accordions

An exclusive accordion only allows one item to be open at a time.

To make an accordion exclusive, add the same `name` to each `details` element that should be part of the exclusive group.
Ensure that `name` is not used elsewhere on the page unless it is intended to be part of the same exclusive accordion group.

```html
<section class="accordion" aria-labelledby="faq-heading">
	<h2 id="faq-heading">Frequently Asked Questions</h2>
	<details name="faq-question">
		<summary>Lorem ipsum dolor sit amet?</summary>
		<!-- answer 1 -->
	</details>
	<details name="faq-question">
		<summary>Consectetur adipiscing elit?</summary>
		<!-- answer 2 -->
	</details>
</section>
```

Avoid exclusive accordions, as they can produce suboptimal user experience:
- Sometimes users want to reference between the contents of multiple items, which exclusive accordions prevent.
- They also can cause content to shift out of the user’s view which can cause significant problems for those using screen magnifiers.

### Keeping one item always open

To require that one item is always open, stop the open item’s `summary` from closing it and expose it as disabled. Opening another item still closes it through `name`. This compounds the downsides above, since users can never reclaim the space, so only use it when the layout depends on an item being open.

```html
<section class="accordion always-open" aria-labelledby="plans-heading">
	<h2 id="plans-heading">Plans</h2>
	<details name="plan" open>
		<!-- Mirrors the open state; the script keeps it in sync -->
		<summary aria-disabled="true">Basic</summary>
		<!-- Basic plan -->
	</details>
	<details name="plan">
		<summary>Pro</summary>
		<!-- Pro plan -->
	</details>
</section>
```

```javascript
// Enter and Space on a summary also dispatch click, so this covers keyboard too
document.addEventListener("click", event => {
	if (event.target.closest(".accordion.always-open details[open] > summary")) event.preventDefault();
});

// toggle does not bubble, hence capture
document.addEventListener("toggle", event => {
	if (!event.target.matches(".accordion.always-open details")) return;
	event.target.querySelector(":scope > summary").setAttribute("aria-disabled", event.target.open);
}, { capture: true });
```

Keep the disabled `summary` focusable so focus is not lost when the item a user just opened becomes disabled, but exclude it from hover and pointer styles so it does not look clickable:

```css
/* :where() keeps the guard from raising specificity */
summary:where(:not([aria-disabled="true"])) {
	cursor: pointer;

	&:hover {
		background: var(--color-hover);
	}
}
```

## Optional: Expand/Collapse All button

For non-exclusive accordions, a single button that expands or collapses every item can improve user experience.
Give it `aria-expanded` and keep it in sync with the items, so screen readers announce the change (VoiceOver does not reliably announce a label change on its own).
Mark it expanded only once every item is open; in a mixed state it reads "Expand all" and pressing it opens everything.

```html
<section class="accordion" id="support-accordion" aria-labelledby="support">
	<h2 id="support">Support</h2>
	<button type="button" commandfor="support-accordion" command="--toggle-all" aria-expanded="false">
		<span class="expand">Expand all</span>
		<span class="collapse">Collapse all</span>
	</button>
	<!-- Accordion items -->
</section>
```

```css
/* Show the label for the action the button will perform */
[command="--toggle-all"][aria-expanded="true"] .expand,
[command="--toggle-all"][aria-expanded="false"] .collapse {
	display: none;
}
```

```javascript
document.addEventListener("command", event => {
	if (event.command !== "--toggle-all") return;
	const expand = event.source.getAttribute("aria-expanded") !== "true";

	// Command events fire on the commandfor target
	for (const details of event.target.querySelectorAll(":scope > details")) {
		details.open = expand;
	}
}, { capture: true }); // Command events do not bubble, hence capture

// Items also open and close individually, so derive the button state from them
document.addEventListener("toggle", event => {
	if (!event.target.matches(".accordion > details")) return;
	const accordion = event.target.parentElement;
	const button = accordion.querySelector(':scope > [command="--toggle-all"]');
	if (!button) return;

	const items = accordion.querySelectorAll(":scope > details");
	button.setAttribute("aria-expanded", Array.prototype.every.call(items, details => details.open));
}, { capture: true }); // toggle does not bubble, hence capture
```

Separate buttons are also possible and improve discoverability, at the cost of _feedback_: there are states where one of the buttons will produce no visible result, and disabling it accessibly introduces challenges and increases complexity.

## Styling

The disclosed content lives in the `::details-content` pseudo-element. While closed it is hidden with `content-visibility: hidden`, not `display: none`, which is what keeps it findable and lets its size animate. Style the item on `details`, the trigger on `summary`, and the content on `details::details-content`.

### Customizing the marker

`summary` renders as a list item, so its disclosure triangle is a `::marker`. Remove it with `list-style: none` and draw your own with `::before`, which unlike `::marker` can be sized, positioned, and animated.
Render the icon as a mask so it follows the text color, and rotate it for the closed state so one icon serves both states and both writing directions.
See `icons` (via `npx -y modern-web-guidance@latest retrieve "icons"`) for more details on including and customizing icons via CSS.

Prefer keeping the marker directly next to the label text, not pushed to the opposite edge of the summary, especially for accordions that can get wide.
A marker far from its label makes it harder for users to associate with the correct label, and falls outside the field of view of users with low vision or screen magnification.
Right before the label text is preferable to right after, as it facilitates vertical scanning.

```css
summary {
	/* Removes the default triangle */
	list-style: none;
	display: flex;
	align-items: center;
	gap: 0.5ch;

	&::before {
		content: "";
		inline-size: 1em;
		block-size: 1em;
		flex-shrink: 0;
		background-color: currentColor;
		/* Example chevron pointing down, the open state; any single-color SVG works */
		mask: url("icons/chevron-down.svg") no-repeat center / contain;
		/* Closed: point toward the inline end */
		rotate: -90deg;
	}

	&:dir(rtl)::before {
		rotate: 90deg;
	}

	/* Rotate rather than swap icons, so the change can animate */
	details[open] > &::before {
		rotate: 0deg;
	}

	@media (prefers-reduced-motion: no-preference) {
		&::before {
			transition: rotate 0.2s;
		}
	}
}
```

### Slide up/down animation

To animate opening and closing, transition `block-size` between `0` and its intrinsic size, and transition `content-visibility` discretely so the content stays rendered until the collapse finishes.

```css
details::details-content {
	/* Lets block-size transition to and from its intrinsic auto size */
	interpolate-size: allow-keywords;
	overflow: clip;
	/* Keeps layout containment constant across states; otherwise content-visibility toggling it
	   makes the transition jitter when the content has outward margins (e.g. a nested p) */
	contain: layout;
}

details:not([open])::details-content {
	block-size: 0;
}

/* Only animate for users who have not asked for reduced motion */
@media (prefers-reduced-motion: no-preference) {
	details::details-content {
		transition: block-size, content-visibility, display;
		/* Example duration; match the surrounding motion design */
		transition-duration: 0.3s;
		transition-timing-function: ease-in-out;
		/* Defers content-visibility: hidden until the collapse ends */
		transition-behavior: allow-discrete;
	}
}
```

See `animate-to-intrinsic-sizes` (via `npx -y modern-web-guidance@latest retrieve "animate-to-intrinsic-sizes"`) for more details.

## Excluding a `details` element’s contents from find-in-page

If it’s undesirable for a `details` element’s contents to be included in what’s matched with the browser’s find-in-page feature, hide the closed contents with `display: none`. To keep the slide animation, set the collapsed size in `@starting-style`. See `animate-element-entry-exit` (via `npx -y modern-web-guidance@latest retrieve "animate-element-entry-exit"`) for more details.

```css
.accordion.unsearchable > details {
	/* Excludes the contents from find-in-page */
	&:not([open])::details-content {
		display: none;
	}

	/* Where the opening transition starts from, since display: none has no size */
	&[open]::details-content {
		@starting-style {
			block-size: 0;
		}
	}
}
```

## Custom accordion

Use a custom accordion only when each item is a section of the page that needs its own heading, such as a FAQ or a long reference page where screen reader users move between items by heading.
It costs JavaScript for every behavior, including exclusivity, so prefer `details` everywhere else.

Place the `button` inside the heading so the heading keeps its semantics, and put the content element immediately after the heading.
Hide the content with `hidden="until-found"` so it stays findable, or with plain `hidden` to exclude it from find-in-page.
`aria-controls` on the trigger is optional; screen readers gain nothing from it.

```html
<section class="accordion" aria-labelledby="faq-heading">
	<h2 id="faq-heading">Frequently Asked Questions</h2>
	<h3>
		<button type="button" commandfor="answer-1" command="--toggle" aria-expanded="false">How do I reset my password?</button>
	</h3>
	<div id="answer-1" hidden="until-found"><!-- Answer --></div>
</section>
```

```javascript
document.addEventListener("command", event => {
	if (event.command !== "--toggle") return;
	const content = event.target;

	content.hidden = content.hidden ? false : "until-found";
	event.source.setAttribute("aria-expanded", !content.hidden);
}, { capture: true }); // Command events do not bubble, hence capture

// Find-in-page reveals the content directly, so mirror that into the trigger
document.addEventListener("beforematch", event => {
	document.querySelector(`[commandfor="${CSS.escape(event.target.id)}"]`)?.setAttribute("aria-expanded", "true");
});
```

To make it exclusive, hide the other items' content and reset their triggers in both handlers, since find-in-page can also open an item.
See `custom-button-actions` (via `npx -y modern-web-guidance@latest retrieve "custom-button-actions"`) for more details on custom commands and `search-hidden-content` (via `npx -y modern-web-guidance@latest retrieve "search-hidden-content"`) for `hidden="until-found"`.

## Fallback strategies

### Mutually exclusive `details`

Baseline status for Mutually exclusive <details> elements: Newly available. It's been Baseline since 2024-09-03.
Supported by: Chrome 120 (Dec 2023), Edge 120 (Dec 2023), Firefox 130 (Sep 2024), and Safari 17.2 (Dec 2023).

In browsers that don't support `name` on `details`, several items stay open, which is still a working (non-exclusive) accordion.
If the exclusivity is crucial to the user experience, you can implement a fallback. It also keeps always-open accordions working, since the open item still closes when another opens:

```javascript
// Only needed where the name attribute is unsupported
if (!Object.hasOwn(HTMLDetailsElement.prototype, "name")) {
	document.addEventListener("toggle", event => {
		const details = event.target;
		if (!(details instanceof HTMLDetailsElement) || !details.open || !details.hasAttribute("name")) return;

		const name = CSS.escape(details.getAttribute("name"));
		for (const other of document.querySelectorAll(`details[name="${name}"]`)) {
			if (other !== details) other.open = false;
		}
	}, { capture: true }); // toggle does not bubble, hence capture
}
```

### Expand all and Collapse all

Baseline status for Invoker commands: Newly available. It's been Baseline since 2025-12-12.
Supported by: Chrome 135 (Apr 2025), Edge 135 (Apr 2025), Firefox 144 (Oct 2025), and Safari 26.2 (Dec 2025).

If your Baseline target does not support invoker commands, the button does nothing. Feature-detect with `Object.hasOwn(HTMLButtonElement.prototype, "commandForElement")` and fall back to a `click` listener that runs the same loop. See `custom-button-actions` (via `npx -y modern-web-guidance@latest retrieve "custom-button-actions"`) for more details.

### Open and close animation

Baseline status for ::details-content: Newly available. It's been Baseline since 2025-09-16.
Supported by: Chrome 131 (Nov 2024), Edge 131 (Nov 2024), Firefox 143 (Sep 2025), and Safari 18.4 (Mar 2025).

Browser support for interpolate-size: Limited availability.
Supported by: Chrome 129 (Sep 2024) and Edge 129 (Sep 2024).
Unsupported in: Firefox and Safari.

Baseline status for transition-behavior: Newly available. It's been Baseline since 2024-08-06.
Supported by: Chrome 117 (Sep 2023), Edge 117 (Sep 2023), Firefox 129 (Aug 2024), and Safari 17.4 (Mar 2024).

The animation is a progressive enhancement and needs no fallback. Without `interpolate-size`, items open and close instantly. Without `transition-behavior`, the content hides at the start of the collapse and the height animates empty, while opening still animates.

### Custom accordion

Browser support for hidden="until-found": Limited availability.
Supported by: Chrome 102 (May 2022), Edge 102 (May 2022), and Firefox 148 (Feb 2026).
Unsupported in: Safari.

Where `until-found` is unsupported, the attribute behaves as plain `hidden`: the content is hidden but not findable, and the accordion still works.
