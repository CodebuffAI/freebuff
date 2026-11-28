# Conditional Async Dependencies

Top-level `await` allows modules to act as asynchronous functions, meaning they can pause module execution to await promises. This is extremely useful for conditionally loading async dependencies—like polyfills or heavy secondary libraries—only when required by the browser. 

By utilizing top-level await, you can encapsulate the conditional loading logic inside a single module, effectively preventing downstream consumer modules from executing until the dependency is fully loaded and ready.

### Conditional polyfill pattern

While top-level `await` can be used to conditionally load any async dependency that's a module, a good use of the conditional dependency loading pattern is to conditionally load polyfills for browsers that don't support a specific feature. This approach encapsulates feature detection and the dynamic import inside a single dependency module.

In the following case, the `popover` attribute polyfill is conditionally loaded if it isn't present on `HTMLElement.prototype`:

```javascript
// conditionally-load-polyfill.js

// Check if the feature is missing before doing work.
// MANDATORY: Prefer checking HTMLElement.prototype over window or document
// when checking for a global DOM attribute or property like popover.
if (!('popover' in HTMLElement.prototype)) {
  // Use top-level await to pause the execution of any module that imports this file 
  // until the polyfill finishes downloading and executing.
  await import('/path/to/popover-polyfill.js');
}

// Export a marker if needed by your application
export const polyfillLoaded = true;
```

```javascript
// main.js

// MANDATORY: Because conditionally-load-polyfill.js uses top-level await, 
// this import will block execution of main.js until the polyfill is ready.
import './conditionally-load-polyfill.js';

// Now it is safe to use the feature (e.g., showing a popover)
const myPopover = document.getElementById('my-popover');
if (myPopover) {
  myPopover.showPopover();
}
```

### Sequencing module imports and avoiding the pre-Safari 27 bug

**MANDATORY:** You must structure your module graph so the top-level `await` module is imported from a single entry point and completes before downstream modules evaluate:

* **DO NOT place sibling static imports in an entry file** (for example, `import './conditionally-load-polyfill.js'; import './app.js';`). Per the ECMAScript module evaluation specification, top-level `await` only suspends the parent module that imports it—not sibling static imports—so `./app.js` will evaluate concurrently in all browsers before the polyfill finishes loading.
* **DO NOT import the top-level `await` module from multiple sibling modules simultaneously** (for example, having both `a.js` and `b.js` statically import `./conditionally-load-polyfill.js`). While [Safari 27 fixed WebKit's module loader](https://webkit.org/blog/18227/fixing-top-level-await-in-safari/) to support concurrent imports of top-level `await` modules per spec, Safari 15–26.6 fails when multiple modules simultaneously import a module containing a top-level `await` (see [MDN browser compatibility](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Operators/await#browser_compatibility)).

Instead, choose one of two patterns depending on your module structure:

1. **Single entry module (shown in `main.js` above):** If your entry module runs the dependent initialization logic directly, statically import `./conditionally-load-polyfill.js` at the top of that module and run your code in its body.
2. **Bootstrapping separate application modules:** If your entry module delegates to downstream application modules (such as `./app.js`), chain dynamic `import()` calls with top-level `await` so `./app.js` is only fetched and evaluated after the polyfill module resolves:

```javascript
// main.js

// MANDATORY: Chain dynamic imports with top-level await when bootstrapping separate
// application modules so './app.js' waits for the polyfill to finish loading.
// DO NOT use sibling static imports (`import './conditionally-load-polyfill.js'; import './app.js';`),
// which evaluate concurrently and execute './app.js' before the polyfill is ready.
await import('./conditionally-load-polyfill.js');
await import('./app.js');
```

### Fallback strategies

Baseline status for Top-level await: Newly available. It's been Baseline since 2026-09-14.
Supported by: Chrome 89 (Mar 2021), Edge 89 (Mar 2021), Firefox 89 (Jun 2021), and Safari 27 (Sep 2026).

While basic top-level `await` has been supported across major browsers since 2021 (Chrome 89, Edge 89, Firefox 89, and Safari 15), it only reached full spec compliance in [Safari 27](https://webkit.org/blog/18227/fixing-top-level-await-in-safari/) (see [MDN browser compatibility](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Operators/await#browser_compatibility)).

* **Safari 15–26.6:** As long as you follow the single-entry-point pattern in the previous section so multiple sibling modules do not concurrently import the top-level `await` module, you can safely rely on top-level `await` without an additional fallback.
* **Legacy browsers (pre-2021):** If your application must support browsers without any top-level `await` support, avoid top-level `await` and wrap your conditional `import()` orchestration in a standard `async` function or `.then()` promise chain.
