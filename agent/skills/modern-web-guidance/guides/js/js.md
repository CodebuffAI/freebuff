# JavaScript

Modern JavaScript and Web platform runtimes provide built-in primitives for deep cloning, non-mutating collection transforms, asynchronous coordination, query-string parsing, binary text encoding, and DOM mutation. Replacing legacy userland workarounds (`JSON.parse(JSON.stringify(...))`, `[...arr].sort()`, `.reduce()` bucket accumulators, manual `AbortController` timers, and `innerHTML = ''` clearing loops) eliminates subtle data corruption, prototype pollution, call-stack overflows, and unnecessary parser overhead.

## Table of Contents

- [Use-Case Guide Matrix](#use-case-guide-matrix)

1. [Immutable Data, Deep Cloning, and Grouping](#1-immutable-data-deep-cloning-and-grouping)
   - [Deep Cloning with `structuredClone()`](#deep-cloning-with-structuredclone)
   - [Non-Mutating Array Copies and Reverse Search](#non-mutating-array-copies-and-reverse-search)
   - [Grouping Iterable Collections (`Object.groupBy()` and `Map.groupBy()`)](#grouping-iterable-collections-objectgroupby-and-mapgroupby)
2. [Asynchronous Coordination, Cancellation, and Error Chaining](#2-asynchronous-coordination-cancellation-and-error-chaining)
   - [Externalized Promise Settlement (`Promise.withResolvers()`)](#externalized-promise-settlement-promisewithresolvers)
   - [Declarative Timeout and Composite Cancellation (`AbortSignal.timeout()` and `AbortSignal.any()`)](#declarative-timeout-and-composite-cancellation-abortsignaltimeout-and-abortsignalany)
   - [Chaining Error Causes with Error Cause Options](#chaining-error-causes-with-error-cause-options)
3. [URL Query Manipulation and Binary Text Encoding](#3-url-query-manipulation-and-binary-text-encoding)
   - [Parsing and Constructing Query Strings (`URLSearchParams`)](#parsing-and-constructing-query-strings-urlsearchparams)
   - [Binary UTF-8 Text Decoding and Encoding (`TextDecoder` and `TextEncoder`)](#binary-utf-8-text-decoding-and-encoding-textdecoder-and-textencoder)
4. [DOM Child Replacement and Custom Events](#4-dom-child-replacement-and-custom-events)
   - [Atomic Child Replacement and Clearing (`Element.prototype.replaceChildren()`)](#atomic-child-replacement-and-clearing-elementprototypereplacechildren)
   - [Constructing Standard and Custom Events (`new Event()` and `new CustomEvent()`)](#constructing-standard-and-custom-events-new-event-and-new-customevent)

## Use-Case Guide Matrix

For specialized temporal, scheduling, and security workflows, consult the dedicated guides below:

| Workflow / Domain | Guide |
| :--- | :--- |
| Calculating exact calendar durations (`years`, `months`, `days`) between dates or events | `calculate-event-differentials` (via `npx -y modern-web-guidance@latest retrieve "calculate-event-differentials"`) |
| Representing calendar dates (`PlainDate`), wall-clock times (`PlainTime`), or recurring rules without time-zone shift bugs | `capture-location-agnostic-data` (via `npx -y modern-web-guidance@latest retrieve "capture-location-agnostic-data"`) |
| Converting instants across IANA time zones (`ZonedDateTime`) with DST disambiguation | `coordinate-global-events` (via `npx -y modern-web-guidance@latest retrieve "coordinate-global-events"`) |
| Sorting and comparing nanosecond-precision timestamps (`Temporal.Instant.compare`) | `sort-high-precision-timestamps` (via `npx -y modern-web-guidance@latest retrieve "sort-high-precision-timestamps"`) |
| Projecting dates into non-Gregorian calendar systems (`hebrew`, `islamic-civil`, `japanese`, `chinese`) | `support-global-calendar-systems` (via `npx -y modern-web-guidance@latest retrieve "support-global-calendar-systems"`) |
| Sanitizing untrusted HTML strings before DOM insertion | `sanitize-untrusted-html` (via `npx -y modern-web-guidance@latest retrieve "sanitize-untrusted-html"`) |

---

## 1. Immutable Data, Deep Cloning, and Grouping

### Deep Cloning with `structuredClone()`

Use `structuredClone(value)` to deep-copy nested objects, arrays, and built-in platform types without round-tripping through a JSON string.

#### Guidelines

- **DO** use `structuredClone(value)` instead of `JSON.parse(JSON.stringify(value))` or recursive cloning utilities (`_.cloneDeep`) when copying structured state in memory.
- **DO** rely on `structuredClone()` to preserve cyclic references, shared object references (DAGs), `Date` instances, `RegExp`, `Map`, `Set`, `ArrayBuffer`, `TypedArray`, `DataView`, `BigInt`, `Error` instances, `undefined` property values, `NaN`, `Infinity`, `-0`, and sparse array holes.
- **DO** pass a `{ transfer: [arrayBuffer] }` options object when moving ownership of `ArrayBuffer` or `MessagePort` instances without copying underlying bytes.
- **DO NOT** replace `JSON.parse(JSON.stringify(value))` with `structuredClone(value)` when callers depend on **JSON wire normalization** or transforms:
  - Converting `Date` instances to ISO-8601 strings (`Date.prototype.toJSON()`), or running `JSON.stringify` `replacer` allowlists/redactions or `JSON.parse` `reviver` transforms.
  - Invoking custom `.toJSON()` methods on objects (`structuredClone()` ignores inherited or non-enumerable `.toJSON()` methods and throws `DataCloneError` if an object has own enumerable function properties such as `.toJSON` or imported library singleton/options methods).
  - Stripping keys whose values are `undefined`, Functions, or `Symbol`s, converting `NaN`, `Infinity`, `-Infinity`, and sparse array holes to `null` (and `-0` to `+0`), or intentionally breaking shared DAG references (`a.x !== a.y` so callers can mutate aliased branches independently).
- **DO NOT** pass non-cloneable values to `structuredClone()`. It throws a `DOMException` (`DataCloneError`) on:
  - Functions or imported library singletons/options objects with own enumerable methods (whereas `JSON.stringify` silently omits function properties on objects or turns array elements into `null`).
  - `Symbol` values or `Symbol`-keyed properties (which `JSON.stringify` silently ignores).
  - DOM nodes (`Element`, `Document`, `Node`), live browser/WebIDL objects (`window.location`, `localStorage`, `element.dataset` (`DOMStringMap`), `getComputedStyle(el)` (`CSSStyleDeclaration`), DOM `Event`, `URLSearchParams`, `FormData`, `Headers`—whereas serializable geometry objects like `DOMRect` do clone), `Promise`, `WeakMap`, `WeakSet`, or any `Proxy` instance (both generic `Proxy` wrappers and reactive stores such as Vue `reactive()` or MobX observables).
- **DO NOT** expect `structuredClone()` to preserve custom class prototypes, class methods, non-enumerable properties, property descriptors, or `#private` fields. Like `JSON.parse(JSON.stringify(...))`, `structuredClone()` strips custom prototype chains to `Object.prototype`, drops non-enumerable properties and `#private` fields, and evaluates enumerable getters once into plain data properties.

> [!NOTE]
> `structuredClone` is a host-provided global rather than an intrinsic ECMAScript language global. In isolated Node.js `vm.createContext({})` sandboxes or legacy custom test environments that do not expose host globals on the context object, `structuredClone` may be `undefined` unless explicitly injected into the context.

#### Code Example

```js
const original = {
  id: 'session-42',
  createdAt: new Date('2026-03-15T12:00:00Z'),
  tags: new Set(['admin', 'audit']),
  metrics: new Float64Array([0.98, 0.99]),
  optionalNote: undefined,
};
original.self = original; // Circular reference

const copy = structuredClone(original);

console.assert(copy !== original);
console.assert(copy.createdAt instanceof Date);
console.assert(copy.tags instanceof Set && copy.tags !== original.tags);
console.assert(copy.self === copy);
console.assert('optionalNote' in copy && copy.optionalNote === undefined);
```

---

### Non-Mutating Array Copies and Reverse Search

Use the copying array methods (`.toSorted()`, `.toReversed()`, `.toSpliced()`, `.with()`) and reverse search methods (`.findLast()`, `.findLastIndex()`) to transform or query arrays without mutating the source reference or allocating intermediate shallow clones.

#### Guidelines

- **DO** use `array.toSorted(compareFn)` instead of `[...array].sort(compareFn)`, `array.slice().sort(compareFn)`, or `Array.from(array).sort(compareFn)`.
- **DO** use `array.toReversed()` instead of `[...array].reverse()` or `array.slice().reverse()`.
- **DO** use `array.toSpliced(start, deleteCount, ...items)` for immutable insertions, deletions, and replacements instead of cloning and calling `.splice()`.
- **DO** use `array.with(index, value)` (which supports negative indices) for single-index immutable updates instead of copying and assigning `clone[index] = value`.
- **DO** use `array.findLast(predicate)` and `array.findLastIndex(predicate)` instead of `[...array].reverse().find(predicate)` or reversing indices manually.
- **DO NOT** refactor `arr.slice().reverse().findIndex(fn)` without auditing multi-argument callbacks and `-1` miss math: `findLast()`/`findLastIndex()` pass the **original** forward `index` to `(item, index, arr)` rather than the reversed-copy index, and `arr.length - 1 - (-1) === arr.length` evaluates to an out-of-bounds index on a miss whereas `findLastIndex()` returns `-1`.
- **DO NOT** drop `[...iterable]` / `Array.from()` conversion when the receiver is a `string`, non-Array iterable, or array-like object (`Set`, `Map.keys()`, `Map.values()`, generator, `NodeList`, `HTMLCollection`, or `arguments`). Calling `.toSorted()` or `.toReversed()` directly on a `string`, `Set`, or `NodeList` throws a `TypeError`; convert first and chain the mutating method (`[...set].sort(compareFn)`, `[...nodeList].reverse()`, or `Array.from(str).toReversed().join('')`) rather than allocating redundant copies.
- **DO NOT** replace `[...typedArray].sort()` with `typedArray.toSorted()` unless numeric ordering and a `TypedArray` return type are intended:
  - `Array.prototype.sort()` / `.toSorted()` converts elements to UTF-16 strings by default (`[10, 2].toSorted()` yields `[10, 2]`), whereas `%TypedArray%.prototype.toSorted()` sorts numerically (`new Uint8Array([10, 2]).toSorted()` yields `Uint8Array [2, 10]`) and returns a `TypedArray` instead of a plain `Array`.
  - `%TypedArray%.prototype` does **not** implement `.toSpliced()` (because TypedArrays have fixed byte lengths).
- **DO NOT** use `.toSorted()` or `.toReversed()` when code intentionally relies on sparse array hole preservation (`!(i in arr)`). Copying methods always produce dense arrays where sparse holes become `undefined` elements (`0 in [, 1].toReversed()` is `true`), whereas `Array.prototype.slice()`, `.sort()`, and `.reverse()` preserve empty slots.

#### Code Example

```js
const tasks = [
  { id: 1, priority: 2, status: 'done' },
  { id: 2, priority: 5, status: 'open' },
  { id: 3, priority: 1, status: 'done' },
];

// Immutable sort and single-element update without mutating `tasks`
const byPriority = tasks.toSorted((a, b) => b.priority - a.priority);
const reopened = tasks.with(-1, { ...tasks.at(-1), status: 'open' });

// Reverse search without allocating a reversed copy
const lastCompleted = tasks.findLast((task) => task.status === 'done');
const lastCompletedIndex = tasks.findLastIndex((task) => task.status === 'done');
```

---

### Grouping Iterable Collections (`Object.groupBy()` and `Map.groupBy()`)

Use `Object.groupBy(items, callbackFn)` and `Map.groupBy(items, callbackFn)` to partition any iterable into array buckets in a single step.

#### Guidelines

- **DO** use `Object.groupBy(items, (item, index) => key)` instead of `items.reduce((acc, item) => { (acc[key] ??= []).push(item); return acc; }, {})` when grouping into string or symbol property keys and each bucket holds unmodified original elements (`Object.groupBy()` uses `CreateDataProperty`, so keys like `'constructor'` or `'toString'` never collide with `Object.prototype`).
- **DO** use `Map.groupBy(items, (item, index) => key)` when grouping by object references, class instances, or primitive keys whose non-string types (`number`, `boolean`, `undefined`, `BigInt`) must be preserved without `ToPropertyKey` coercion (`Object.groupBy()` coerces keys with `String(key)`, turning objects into `'[object Object]'`).
- **DO** use `Object.hasOwn(groups, key)` or nullish coalescing (`groups[key] ?? []`) when reading buckets from `Object.groupBy()`.
- **DO NOT** call `Object.prototype` methods (`groups.hasOwnProperty(key)`) or rely on `grouped instanceof Object` on `Object.groupBy()` results: it returns a `null`-prototype object (`Object.getPrototypeOf(grouped) === null`, `grouped instanceof Object === false`), so `groups.hasOwnProperty` is `undefined` and calling it throws a `TypeError`.
- **DO NOT** replace `.reduce()` accumulators that simultaneously transform elements (`acc[key].push(item.id)`), compute scalar aggregations (counts, sums, min/max), or pre-seed empty keys that have zero matching items (`Object.groupBy()` only creates keys that appear at least once in `items`).

#### Code Example

```js
const deliveries = [
  { id: 'd1', region: 'eu-west', weightKg: 4.2 },
  { id: 'd2', region: 'us-east', weightKg: 1.1 },
  { id: 'd3', region: 'eu-west', weightKg: 8.5 },
];

// String-keyed null-prototype dictionary of arrays
const byRegion = Object.groupBy(deliveries, (item) => item.region);
const euShipments = byRegion['eu-west'] ?? [];

// Non-string or object keys preserved in a Map
const heavyKey = { tier: 'heavy' };
const standardKey = { tier: 'standard' };
const byTier = Map.groupBy(deliveries, (item) =>
  item.weightKg >= 5 ? heavyKey : standardKey,
);
```

---

## 2. Asynchronous Coordination, Cancellation, and Error Chaining

### Externalized Promise Settlement (`Promise.withResolvers()`)

Use `Promise.withResolvers()` when a promise's `resolve` and `reject` callbacks must be stored or invoked outside the `new Promise` executor scope (such as in event listeners, worker message handlers, stream queues, or cancellation tokens).

#### Guidelines

- **DO** use `const { promise, resolve, reject } = Promise.withResolvers()` instead of declaring mutable outer variables (`let resolve, reject; const promise = new Promise((res, rej) => { resolve = res; reject = rej; });`), or `Promise.withResolvers.call(SubPromise)` when constructing a `Promise` subclass.
- **DO** keep standard `new Promise((resolve, reject) => { ... })` when the asynchronous operation is self-contained inside the executor callback.
- **DO NOT** move synchronous setup code out of a `new Promise((resolve, reject) => { ... })` executor into `Promise.withResolvers()` without wrapping it in `try / catch` calling `reject(err)`: synchronous throws inside an executor automatically reject the promise, whereas throws after `Promise.withResolvers()` become uncaught synchronous exceptions.

#### Code Example

```js
export function createRequestGate() {
  const { promise, resolve, reject } = Promise.withResolvers();
  return {
    waitUntilReady: () => promise,
    open: (config) => resolve(config),
    abort: (reason) => reject(new Error(`Gate aborted: ${reason}`)),
  };
}
```

---

### Declarative Timeout and Composite Cancellation (`AbortSignal.timeout()` and `AbortSignal.any()`)

Use `AbortSignal.timeout(ms)` for time-bounded asynchronous operations and `AbortSignal.any(signals)` to combine multiple cancellation sources without manual timer bookkeeping.

#### Guidelines

- **DO** pass `{ signal: AbortSignal.timeout(ms) }` directly to `fetch()`, `addEventListener()`, streams, or abortable APIs instead of creating a one-off `AbortController` and `setTimeout(() => controller.abort(), ms)`.
- **DO** combine user-initiated cancellation (`AbortController`) with a deadline using `AbortSignal.any([controller.signal, AbortSignal.timeout(ms)])`. The composite signal aborts as soon as the first input signal aborts and propagates that signal's `reason`.
- **DO** check for both `'TimeoutError'` and `'AbortError'` when inspecting `error.name` in `catch` blocks if distinguishing user cancellation from a deadline matters.
- **DO NOT** assume `AbortSignal.timeout(ms)` aborts with `error.name === 'AbortError'`. Whereas `controller.abort()` without arguments sets `signal.reason` to `DOMException(..., 'AbortError')`, `AbortSignal.timeout(ms)` sets `DOMException(..., 'TimeoutError')` (`error.name === 'TimeoutError'`, `err.code === DOMException.TIMEOUT_ERR` / `23`).
- **DO NOT** pass `0`-arg or negative delays to `AbortSignal.timeout(ms)` (omitting `ms` throws `TypeError`; negative delays throw `RangeError` or `TypeError`), do not expect `AbortSignal.timeout(ms)` to keep a Node.js event loop alive on its own (Node.js uses an unref'd timer), and do not replace manual `AbortController` + `setTimeout` timers that reset on activity (sliding/idle debounce) or require a custom abort reason before expiry.

#### Code Example

```js
export async function fetchJsonWithDeadline(url, userSignal, timeoutMs = 5_000) {
  const signal = userSignal
    ? AbortSignal.any([userSignal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs);

  try {
    const response = await fetch(url, { signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} for ${url}`);
    }
    return await response.json();
  } catch (err) {
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      throw new Error(`Request to ${url} timed out after ${timeoutMs}ms`, { cause: err });
    }
    throw err;
  }
}
```

---

### Chaining Error Causes with Error Cause Options

Attach the original caught error via the `{ cause }` options parameter whenever wrapping and re-throwing an exception across architectural layers.

#### Guidelines

- **DO** pass `{ cause: err }` as the second argument to `new Error(message, { cause: err })` (or built-in subclasses: `TypeError`, `RangeError`, `SyntaxError`, `URIError`, `EvalError`, `AggregateError`); custom `Error` subclasses must accept and forward `(message, options)` to `super(message, options)` to preserve `.cause`.
- **DO** replace string-concatenated re-throws (`new Error('Failed: ' + err.message)`) with `new Error(message, { cause: err })` when concatenation was used solely as a substitute for structured error chaining—and retain interpolated `${err.message}` alongside `{ cause: err }` whenever callers or tests assert on the outer `.message` substring—rather than mutating `wrapper.cause = err` after construction (which sets an enumerable property instead of the non-enumerable spec property).
- **DO NOT** expose raw internal `cause` chains directly to untrusted client responses if the underlying error contains sensitive database queries, file paths, or credentials; log the full `error.cause` chain server-side and sanitize client-facing payloads.

#### Code Example

```js
export class ProfileLoadError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'ProfileLoadError';
  }
}

export async function loadUserProfile(userId, readRecord) {
  try {
    const raw = await readRecord(`users:${userId}`);
    return JSON.parse(raw);
  } catch (err) {
    throw new ProfileLoadError(
      `Failed to load profile for user "${userId}": ${err.message}`,
      { cause: err },
    );
  }
}
```

---

## 3. URL Query Manipulation and Binary Text Encoding

### Parsing and Constructing Query Strings (`URLSearchParams`)

Use `URLSearchParams` (and `new URL(input, base).searchParams`) to parse, inspect, mutate, and serialize query strings instead of manual `.split('&')` / `.split('=')` loops and `decodeURIComponent`.

#### Guidelines

- **DO** use `new URLSearchParams(search)` to read or mutate parameters (`.get(key)`, `.getAll(key)`, `.has(key)`, `.set(key, value)`, `.toString()`) or convert to a plain key-value dictionary with `Object.fromEntries(new URLSearchParams(search))`.
- **DO** use `new URL(fullUrl, baseOrigin).searchParams` when starting from a full URL string (`https://example.com/path?a=1#section`) rather than passing a full URL directly to `new URLSearchParams(fullUrl)` (which only strips a single leading `?` and treats `https://example.com/path?a` as part of the first key name).
- **DO** rely on `URLSearchParams` to preserve `=` characters inside parameter values (such as Base64 padding `?token=aGVsbG8=`, which `.split('=')[1]` truncates) and to avoid `Object.prototype` pollution when building lookup maps.
- **DO** account for the `application/x-www-form-urlencoded` rules enforced by `URLSearchParams`:
  - **Plus (`+`) decoding:** `URLSearchParams` decodes `+` as a space (`' '`), whereas `decodeURIComponent('a+b')` preserves `a+b`. Encode literal `+` values (phone numbers, Base64) as `%2B` at the source when `+` must stay literal.
  - **Valueless flags (`?debug` vs `?debug=`):** Both normalize to `""` (`params.has('debug') === true`, `params.get('debug') === ''`), whereas custom `split('=')` parsers sometimes assign `undefined` or `true`.
  - **Duplicate keys (`?tag=a&tag=b`):** `params.get('tag')` returns the **first** value (`'a'`), `Object.fromEntries(params)` retains the **last** value (`'b'`), and `params.getAll('tag')` returns `['a', 'b']`.
  - **Invalid percent-encoding, bracket keys, and `'??'`:** Non-hex escapes (`%ZZ`) stay literal `'%ZZ'` and invalid UTF-8 byte sequences (`%E0%A4%A`) become `\uFFFD` without throwing (keep `decodeURIComponent` inside `try / catch` when strict malformed-URI rejection is required); bracket keys (`?ids[]=1&user[name]=alice`) remain flat literal keys; and only a single leading `?` is stripped (`new URLSearchParams('??a=1')` keeps `'?a'` as the first key).
- **DO NOT** pass `location.hash` or hash-routing fragments directly to `new URLSearchParams(...)`: `URLSearchParams` does not strip `#`, so `'#tab=2'` parses the key as `'#tab'` (use `slice(1)`), and hash-routing fragments (`'#/route?a=1'`) require extracting the query segment after `?` before parsing (`hash.slice(hash.indexOf('?') + 1)`).
- **DO NOT** use `URLSearchParams` to parse semicolon-delimited strings (such as `document.cookie` or RFC 6265 `Cookie` headers); `URLSearchParams` splits exclusively on `&`.

#### Code Example

```js
// Parsing a query string into a plain object (last value wins on duplicate keys)
const query = '?filter=active&token=eyJhbGciOiJIUzI1NiJ9==&tag=js&tag=web';
const params = new URLSearchParams(query);

const token = params.get('token'); // 'eyJhbGciOiJIUzI1NiJ9==' (preserves trailing '==')
const allTags = params.getAll('tag'); // ['js', 'web']
const lastWinsDict = Object.fromEntries(params); // { filter: 'active', token: '...', tag: 'web' }

// Mutating query parameters on a full URL safely
const endpoint = new URL('https://api.example.com/v1/items?page=1#results');
endpoint.searchParams.set('page', '2');
endpoint.searchParams.append('limit', '50');
```

---

### Binary UTF-8 Text Decoding and Encoding (`TextDecoder` and `TextEncoder`)

Use `TextDecoder` and `TextEncoder` to convert between `Uint8Array` byte buffers and JavaScript strings.

#### Guidelines

- **DO** use `new TextDecoder().decode(bytes)` instead of `decodeURIComponent(escape(binaryString))`, `String.fromCharCode.apply(null, bytes)`, or `String.fromCharCode(...bytes)` when decoding UTF-8 byte buffers into text (`String.fromCharCode` treats bytes as UTF-16 code units—corrupting multi-byte UTF-8 into Latin-1 mojibake and overflowing the call stack at ~65 KB+—while `Uint16Array` elements `> 0xFF` represent 16-bit code units rather than raw UTF-8 bytes).
- **DO** use `new TextEncoder().encode(str)` to encode strings into UTF-8 `Uint8Array` byte arrays instead of manual character-code loops.
- **DO** reuse a single `TextDecoder` instance with `decoder.decode(chunk, { stream: true })` for chunked streams (`ReadableStream`, WebSocket frames, file chunks), followed by a final `decoder.decode()` flush call, so multi-byte code points split across chunk boundaries reassemble cleanly.
- **DO** pass `{ fatal: true }` when invalid UTF-8 sequences must throw `TypeError` instead of `\uFFFD` (note `TypeError` rather than `URIError`, and `decoder.decode(string)` always throws `TypeError`), and pass `{ ignoreBOM: true }` when a leading UTF-8 BOM (`0xEF 0xBB 0xBF`) must not be stripped by default.
- **DO** use `new TextDecoder('latin1')` (or `'iso-8859-1'`) only when a 1-byte-per-character mapping is needed on large buffers without call-stack limits, noting that per WHATWG Encoding both labels map to `windows-1252` (decoding bytes `0x80`–`0x9F` as characters such as `€` (`\u20AC`) rather than `\u0080`–`\u009F`).
- **DO NOT** replace `String.fromCharCode` with `new TextDecoder('utf-8')` when constructing a raw 1-byte-per-code-unit binary string (`0x00`–`0xFF`) for `btoa()` / `atob()`: use `TextEncoder` / `TextDecoder` for UTF-8 text payloads and chunked `String.fromCharCode` (or Node.js `Buffer.from(bytes).toString('base64')`) for raw binary strings passed to `btoa()`, since passing multi-byte UTF-8 `TextDecoder` output to `btoa()` throws `InvalidCharacterError`.

#### Code Example

```js
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

// Encode string to UTF-8 Uint8Array and decode back without stack limits
const bytes = encoder.encode('🚀 Modern Web Platform — 100% UTF-8');
const text = decoder.decode(bytes);

// Streaming decode across arbitrary chunk boundaries
export async function readUtf8Stream(readableStream) {
  const streamDecoder = new TextDecoder();
  let output = '';
  for await (const chunk of readableStream) {
    output += streamDecoder.decode(chunk, { stream: true });
  }
  output += streamDecoder.decode(); // Flush any trailing bytes
  return output;
}
```

---

## 4. DOM Child Replacement and Custom Events

### Atomic Child Replacement and Clearing (`Element.prototype.replaceChildren()`)

Use `element.replaceChildren(...nodesOrStrings)` to clear a container or replace all of its existing children in a single operation.

#### Guidelines

- **DO** call `container.replaceChildren()` with no arguments to remove all `childNodes` instead of `container.innerHTML = ''` (which invokes the HTML parser and fails under Trusted Types) or child-removal loops (forward `for` loops over live `children`/`childNodes` skip every other node, and `replaceChildren()` batches mutations into a single `MutationObserver` `childList` record—emitting `0` records on an already-empty element—and fires Custom Element `disconnectedCallback()` via `[CEReactions]` after all removals complete rather than interleaved per node).
- **DO** call `container.replaceChildren(...nodes)` to atomically clear and insert new `Node` instances or `DocumentFragment`s (`HierarchyRequestError` pre-validation fails atomically before mutating existing children).
- **DO** pass plain strings directly to `container.replaceChildren(text)` when inserting literal text without parsing HTML (note `el.replaceChildren('')` inserts an empty `Text` node with `childNodes.length === 1`, unlike `el.replaceChildren()`).
- **DO** target `templateElement.content.replaceChildren(...)` when clearing or replacing the contents of a `<template>` element (calling `templateElement.replaceChildren()` leaves its inert `content` `DocumentFragment` untouched), and narrow `Node` references to `ParentNode` (`Element`, `Document`, `DocumentFragment`) in TypeScript since leaf `Node`s (`Text`, `Comment`) do not implement `replaceChildren()`.
- **DO NOT** replace `while (el.firstElementChild) el.removeChild(el.firstElementChild)` when inline `Text` or `Comment` nodes must remain intact (`replaceChildren()` removes all `childNodes`), do not replace chained assignments (`a.innerHTML = b.innerHTML = ''`, since `replaceChildren()` returns `undefined`), do not pass raw HTML markup strings (`'<li>Item</li>'`) expecting parsed elements (for untrusted HTML strings, follow `sanitize-untrusted-html` (via `npx -y modern-web-guidance@latest retrieve "sanitize-untrusted-html"`)), do not pass a live `HTMLCollection`/`NodeList` (`source.children`) when `source` must keep copies, and do not replace `element.innerHTML = ''` on `<object>` or `<embed>` plugin containers or test harnesses asserting HTML parser steps.

#### Code Example

```js
export function renderNotificationList(listElement, messages) {
  const items = messages.map((msg) => {
    const li = document.createElement('li');
    li.className = 'notification-item';
    li.textContent = msg;
    return li;
  });

  // Atomically replaces all existing <li> children in a single DOM operation
  listElement.replaceChildren(...items);
}

// Clearing a <template> element's inert DocumentFragment
export function clearTemplate(templateEl) {
  templateEl.content.replaceChildren();
}
```

---

### Constructing Standard and Custom Events (`new Event()` and `new CustomEvent()`)

Use `new Event(type, options)`, `new CustomEvent(type, options)`, and specialized WebIDL event constructors instead of the deprecated `document.createEvent()` and `initEvent()` / `initCustomEvent()` methods.

#### Guidelines

- **DO** use `new Event(type, { bubbles, cancelable, composed })` for standard notifications, `new CustomEvent(type, { detail, bubbles, cancelable, composed })` for structured `event.detail` payloads, and specialized WebIDL constructors (`new MouseEvent()`, `new KeyboardEvent()`, `new UIEvent()`) when replacing `initMouseEvent` / `initKeyboardEvent` / `initUIEvent` (avoiding legacy `initKeyboardEvent` argument quirks and read-only `keyCode === 0` issues).
- **DO** specify `bubbles: true` and `cancelable: true` explicitly whenever an event must bubble up the DOM tree or support `event.preventDefault()` (both default to `false`), and set `composed: true` when crossing a Shadow DOM boundary.
- **DO NOT** use `document.createEvent('Event')`, `document.createEvent('CustomEvent')`, `event.initEvent()`, or `event.initCustomEvent()`, and do not pass non-`EventTarget` values for WebIDL dictionary fields (e.g., `relatedTarget: 0` in `MouseEventInit` throws `TypeError`).

#### Code Example

```js
// Dispatching a bubbling, shadow-piercing custom event with payload data
export function notifyFilterChange(filterPanel) {
  const filterChanged = new CustomEvent('filter-change', {
    detail: { category: 'architecture', minScore: 80 },
    bubbles: true,
    cancelable: true,
    composed: true,
  });

  return filterPanel.dispatchEvent(filterChanged);
}
```
