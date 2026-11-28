# Form-Associated Custom Elements

Do not fall back to a hidden `<input>` to surface a custom control's value to a form. Use **Form-Associated Custom Elements** (FACE): with `formAssociated` and `ElementInternals`, the element submits its own value, participates in validation, and reflects form state natively.

```javascript
class RatingInput extends HTMLElement {
  // MANDATORY: opt in. Without this, attachInternals() form APIs are unavailable.
  static formAssociated = true;

  #internals;
  #value = '';

  constructor() {
    super();
    this.#internals = this.attachInternals();
    this.attachShadow({ mode: 'open', delegatesFocus: true });
  }

  connectedCallback() {
    // Validate initial state once attributes (such as `required`) are present.
    this.#validate();
  }

  get value() { return this.#value; }
  set value(v) {
    this.#value = v;
    // Push the value into the owning <form> for submission.
    this.#internals.setFormValue(v);
    this.#validate();
  }

  #validate() {
    if (this.hasAttribute('required') && !this.#value) {
      // Mark invalid and supply the native validation message + anchor.
      this.#internals.setValidity(
        { valueMissing: true },
        'Please choose a rating.',
        this.shadowRoot.querySelector('[tabindex]'),
      );
    } else {
      this.#internals.setValidity({}); // clear
    }
  }

  // Optional FACE lifecycle hooks:
  formResetCallback() { this.value = ''; }
  formDisabledCallback(disabled) {
    // Disable internal controls so they leave the tab order and ignore clicks.
    // Do NOT toggle `disabled` on `this`, or a `<fieldset disabled>` toggle will
    // leave the host permanently stuck with its own `disabled` attribute.
    for (const el of this.shadowRoot.querySelectorAll('button')) {
      el.disabled = disabled;
    }
  }
  formStateRestoreCallback(state) { this.value = state; }
}
customElements.define('rating-input', RatingInput);
```

Key points:

- `static formAssociated = true` is **MANDATORY**; it unlocks the form-related `ElementInternals` methods and the `formXxxCallback` lifecycle.
- `setFormValue(value)` is what submits, with no hidden input required. Pass a `FormData` for multi-value controls.
- `setValidity(flags, message, anchor)` integrates with native constraint validation: the form won't submit while invalid, `:invalid`/`:valid` apply, and the anchor element receives focus on report. Call `setValidity({})` to clear. The interaction-aware `:user-valid`/`:user-invalid` pseudo-classes are *not* consistently wired up for form-associated elements across browsers — verify support before relying on them rather than assuming they track user interaction the way they do for native controls.
- Implement `formResetCallback`, `formDisabledCallback`, and `formStateRestoreCallback` so the element behaves like a native control on reset, `fieldset[disabled]`, and back/forward autofill restore. In `formDisabledCallback(disabled)`, disable internal controls (or remove them from the tab order and ignore input) rather than setting `disabled` on the host — setting the host attribute inside the callback prevents re-enabling when an ancestor `<fieldset>` is re-enabled, and the host already matches `:disabled` automatically.
- Follow platform conventions for dispatched events and prefer the built-in `input` and `change` events over custom ones. `input` fires when the value changes as a direct result of user action (typing, dragging a slider); `change` fires once per stream of changes, when the user commits (releasing the slider, blurring the field). Construct them with `InputEvent` and `Event` respectively.

## Accessibility considerations

When creating custom elements, if the custom element directly handles interaction, or acts as a group for individual controls, ensure that the custom element has a role, and conveys state information (in the case of handling interaction directly). This can be done by using the appropriate properties of ElementInternals.

```js
this.#internals.role = 'group';
```

Unless the custom element contains its own visible label (which may be applicable for single checkbox-like custom elements), then don't apply an accessible name directly using the ElementInternals. This is because this would likely override any accessible name set when using the custom element, such as by labelling the element using a HTML label's `for` attribute.

## Fallback strategies

Baseline status for Form-associated custom elements: Widely available. It's been Baseline since 2023-03-27.
Supported by: Chrome 77 (Sep 2019), Edge 79 (Jan 2020), Firefox 98 (Mar 2022), and Safari 16.4 (Mar 2023).

Feature-detect with `static formAssociated` support before relying on it: `'attachInternals' in HTMLElement.prototype && 'setFormValue' in ElementInternals.prototype`. Where it is unavailable, fall back to a visually-hidden native `<input>` synced to the control's value so the form still submits — the one case where the hidden-input pattern is justified.
