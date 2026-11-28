# Pre-rendering custom elements

Pre-rendering means shipping a custom element's markup — including its shadow tree — from the server, so the component is styled and structured *before* any JavaScript runs. The main platform primitive for this is **Declarative Shadow DOM (DSD)**: the parser attaches the shadow root from HTML alone, and the element is later upgraded ("hydrated") by its class if one is registered. Use this pattern for server-side rendering, streaming, and avoiding a flash of unstyled content (FOUC).

## Authoring a declarative shadow root

Nest a `<template>` with the `shadowrootmode` attribute as the first child of the host. The parser attaches its content as a shadow root and removes the template; no script needed.

```html
<my-card>
  <template shadowrootmode="open">
    <style>
      .card { border: 1px solid; border-radius: 8px; padding: 1rem; }
    </style>
    <div class="card">
      <slot name="header"></slot>
      <div class="body"><slot></slot></div>
    </div>
  </template>

  <!-- Light DOM children are projected into the slots above. -->
  <h2 slot="header">Server-rendered title</h2>
  <p>Visible and styled before JS loads.</p>
</my-card>
```

## Hydration timing

When the matching class is registered, the browser upgrades the host. Because the shadow root **already exists**, the constructor must not blindly create a second one:

```javascript
class MyCard extends HTMLElement {
  constructor() {
    super();
    // Reuse the server-rendered shadow root if present; only create one if absent.
    if (!this.shadowRoot) {
      this.attachShadow({ mode: 'open' });
      this.shadowRoot.append(template.content.cloneNode(true));
    }
    // Hydrate in place: attach listeners once against existing markup (not unguarded
    // in connectedCallback, which re-runs if the element moves in the DOM), and do
    // NOT re-render; that would discard the server's DOM and flash.
    this.shadowRoot.getElementById('toggle')
      ?.addEventListener('click', () => this.toggleAttribute('open'));
  }
}
```

Set `shadowrootmode="open"` (not `closed`) for almost all cases, so scripts and tools can reach `this.shadowRoot` to hydrate. To serialize an existing shadow root back to HTML on the server or in tests, use `getHTML({ serializableShadowRoots: true })` and attach the root with `serializable: true`.

## Avoiding FOUC

DSD renders correctly on first paint only if styles ship inside the declarative template. To preserve that:

- Put component CSS **inside** the `<template shadowrootmode>` (a `<style>` tag or a `<link>`), not in a separate script-loaded sheet.
- Pair with `my-card:not(:defined) { … }` only for styles that must wait for JS — typically page-level guard rules like a fade-out on client-rendered instances that miss the SSR pass. These live in the light-DOM (page) stylesheet, since the shadow root doesn't yet exist there and `:host` selectors don't apply from outside. Structural styles inside the DSD template need no such guard.
- Do not re-render the shadow tree on hydration. Treat the server markup as authoritative and attach behavior to it.

## Fallback strategies

Baseline status for Declarative shadow DOM: Widely available. It's been Baseline since 2024-02-20.
Supported by: Chrome 111 (Mar 2023), Edge 111 (Mar 2023), Firefox 123 (Feb 2024), and Safari 16.4 (Mar 2023).

In engines that don't parse `shadowrootmode`, the template is inert and its content is not attached as a shadow root. Detect this (`Object.hasOwn(HTMLTemplateElement.prototype, 'shadowRootMode')`) and, if absent, attach the shadow root imperatively from the same markup during upgrade so the component still renders.
