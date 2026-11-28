# Spatial Navigation (Directional Keypad Focus)

Directional focus navigation (using arrow keys or D-Pads) enables keyboard-only and alternative-input users to navigate interactive items based on their visual 2D layout. It is highly beneficial for spatial user interfaces (such as media rails, dashboard panels, or nested catalogs), but it must be implemented carefully to avoid breaking native browser behaviors like viewport scrolling.

This guide covers building performant, accessible 2D directional navigation inside composite widgets.

---

### Core Architectural Principles

When implementing custom arrow-key spatial focus, adhere to these foundational rules:

1. **Limit to composite widgets**: Do not override arrow keys on normal document text flow or simple vertical list layouts where default sequential Tab navigation is expected. It must only be used if there is an appropriate composite role that matches the interaction. See `accessibility` (via `npx -y modern-web-guidance@latest retrieve "accessibility"`) for general document flow guidance.
2. **Preserve native boundary scrolling**: If there is no focusable element in the pressed direction, **do not prevent default browser behavior**. Let the event bubble so the browser can scroll the viewport natively. Overriding arrow keys unconditionally breaks accessibility (WCAG 1.4.10).
3. **Ensure focus visibility and alignment**: When focus changes, ensure the newly focused element is scrolled into view (e.g., using `scrollIntoView({ block: 'nearest', inline: 'nearest' })`) so that it remains fully visible.
4. **Coordinate with the layout system**: Determine focus candidate positions from live bounding geometries (`getBoundingClientRect()`) while handling each keypress. Avoid assuming that DOM order or a fixed grid structure represents the visual layout. See `css-layout` (via `npx -y modern-web-guidance@latest retrieve "css-layout"`) for modern layout recommendations.

---

### Accessible Focus Management

The spatial container must expose a single tab stop to sequential Page Tab navigation. Inside the widget, manage keyboard focus using the **Roving Tabindex Pattern**:
* The active item has `tabindex="0"`.
* All inactive items have `tabindex="-1"`.
* When navigating, programmatically move focus by shifting the `tabindex="0"` attribute and calling `focus()`.

Roving tabindex only works with screen readers when the container and items have appropriate composite-widget roles and states (e.g. grid/gridcell, listbox/option); tabindex alone isn't enough.

- If the spatial navigation is used to navigate through rows of interactive elements, then use `grid` semantics
- If the spatial navigation is used to navigate through multiple interactive elements, which when selected, update the content related to the selected control, then use `tablist` semantics
- If the spatial navigation is a list of suggested items, which upon selected, populate a related input field, then use `combobox` semantics
- If the spatial navigation is used to navigate a list, for which one or more option is selectable, then use `listbox` semantics
- If the spatial navigation is used to navigate a collection of interactive items with a clear hierarchy, then use `tree` semantics
- If the spatial navigation is used to navigate a grid-like pattern, with expandable items, and a clear hierarchy, then use `treegrid` semantics

---

### Visual Candidate Selection

In asymmetrical, wrapped, or grid layouts, index-based mapping fails. Instead, derive candidates from the live visual geometry for the current keypress:

* **Candidates**: Use the focusable descendants of the widget container that pass `checkVisibility()`. Hidden elements can have a zero-sized rect at `(0, 0)` and must not become accidental `up` or `left` targets.
* **Geometry**: Read `getBoundingClientRect()` for the focused element and every candidate while handling the keypress. Do not cache these rects globally: layout can change for many reasons, and a small number of geometry reads is cheap when handling a user-paced key event.
* **Direction filter**: A candidate is in the pressed direction only when its near edge is at or beyond the current element’s far edge on that axis, allowing a small tolerance for sub-pixel rounding. For example, a candidate for `right` must have `candidate.left >= current.right - tolerance`. Do not compare centres to determine whether a candidate is in the direction.
* **Aligned candidates first**: Among candidates that pass the direction filter, prefer candidates whose extent on the perpendicular axis overlaps the current element’s extent. Choose the smallest gap on the navigation axis, breaking ties with the smallest perpendicular centre offset. This keeps navigation in the adjacent visual row or column even when an item is unusually wide.
* **Fallback scoring**: If no candidate overlaps on the perpendicular axis, score the remaining candidates as `gap + w * perpendicularCentreOffset` and choose the minimum. Use a weight `w >= 2` as a starting point, then tune it for the layout; a larger weight favours candidates that are more closely aligned.
* **No candidate**: Return nothing. The event handler must not call `preventDefault()`, allowing the browser to scroll natively.

The exact implementation can vary, but keep the direction test edge-based and apply the overlap preference before the weighted fallback. This is the crux of the algorithm; avoid presenting a cache or a fixed weight as universally correct.

---

### Keypress Integration & Scroll Cooperation

Your event router must prevent standard viewport scrolling **only** when a valid spatial focus transition occurs:

* Do not intercept the event when a modifier key is held, when `e.defaultPrevented` is already true, or when the innermost event target consumes arrow keys itself. Use `e.composedPath()[0]` rather than only `e.target`, because `e.target` can be retargeted to a shadow host. A practical editable/control check is `target.matches(':read-write, select, input[type="range"], [role="slider"]')`; closed shadow roots cannot be inspected.
* Scope the listener to the widget container, so multiple spatial widgets can coexist on a page.
* Act only when the focused element is itself a candidate. If items contain their own focusable controls, either make those controls candidates too or leave them alone; do not resolve a parent with `closest()`.
* When a candidate is found, call `preventDefault()`, update the roving `tabindex`, call `focus()`, and use `scrollIntoView({ block: 'nearest', inline: 'nearest' })`.
* When no candidate is found, return without calling `preventDefault()` so native scrolling continues.

---

Avoid adding single-character shortcuts such as `h`/`j`/`k`/`l` or `W`/`A`/`S`/`D` for spatial navigation. Arrow keys are not character keys, and preserving native scrolling when no candidate exists avoids unnecessarily blocking viewport movement.
