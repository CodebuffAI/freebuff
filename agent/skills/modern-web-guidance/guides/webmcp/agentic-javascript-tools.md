# Agentic JavaScript Tools

The Imperative API uses `document.modelContext.registerTool()` to programmatically define JavaScript tools. This is ideal for Single Page Applications (SPAs) where tools need to be added or removed based on the current route or user state.

WebMCP operates on a producer/consumer architecture:
* **Web pages are tool producers:** You define and register tools using `document.modelContext.registerTool()`. That is all a web page needs to implement. **You do not need to call `getTools()` or `executeTool()` on the page to expose tools to agents.**
* **Browser and extension agents are the primary consumers:** Agents provided by or through the browser — including the browser's built-in agent, browser extensions, DevTools, and system-level assistants — discover and invoke registered tools out-of-band through internal platform mechanisms.
* **In-page agents and test harnesses:** `getTools()` and `executeTool()` exist specifically for in-page JavaScript assistants (e.g. an embedded chat widget or `<iframe>`) and automated test suites that need to discover and invoke tools directly within the page context.

## Registration and Lifecycle

Tools are registered by passing a tool definition object and an optional options object (`ModelContextRegisterToolOptions`), which supports two optional members:
* `signal`: An `AbortSignal` used to unregister the tool when it is no longer needed.
* `exposedTo`: An array of origin strings controlling which documents in the document tree are allowed to discover and execute the tool across frame boundaries.

### Lifecycle Handling with `AbortController`

WebMCP does not provide an `unregisterTool()` method. To unregister a tool, you must pass an `AbortSignal` during registration and abort that signal when the tool is no longer needed.

```javascript
const controller = new AbortController();

await document.modelContext.registerTool({
  name: "get_user_preferences",
  description: "Retrieves the user's saved preferences.",
  inputSchema: { type: "object", properties: {} },
  execute() {
    const prefs = localStorage.getItem("user_prefs");
    return prefs ? JSON.parse(prefs) : { theme: "light" };
  },
  annotations: { readOnlyHint: true }
}, { signal: controller.signal });

// To unregister the tool (e.g., on component unmount):
controller.abort();
```

Aborting the registration signal only unregisters the tool — it does not cancel executions that are already running. Tools that start long-running work must also honor the per-execution signal described below, or unregistering will leave orphaned requests and stale UI updates behind.

### Controlling cross-origin tool exposure with `exposedTo`

By default, a registered tool is private to the registering document and same-origin frames. When your application is embedded in an `<iframe>` (or embeds third-party widgets) and you need ancestor or sibling frames to discover and invoke the tool, specify the allowed origins using `exposedTo`.

```javascript
const controller = new AbortController();

await document.modelContext.registerTool({
  name: "get_cart_items",
  description: "Retrieves items currently in the user's shopping cart.",
  inputSchema: { type: "object", properties: {} },
  async execute(input, { signal }) {
    return await cartService.getItems({ signal });
  },
  annotations: { readOnlyHint: true },
}, {
  signal: controller.signal,
  exposedTo: ["https://checkout.example.com"],
});
```

* **Mutual opt-in handshake**: Cross-origin tool discovery is a two-way opt-in. The tool provider frame authorizes the consumer origin via `exposedTo`, and the consumer frame must explicitly request that provider origin via `getTools({ fromOrigins: [...] })`. Without `fromOrigins`, `getTools()` queries only same-origin documents.
* **Origin matching**: The registering document's own origin always has access. Origins specified in `exposedTo` are granted permission to discover the tool via `document.modelContext.getTools({ fromOrigins: [...] })` and execute it via `document.modelContext.executeTool()`.
* **Security requirement**: Every origin in `exposedTo` MUST be potentially trustworthy (HTTPS or localhost). Passing an invalid or non-secure origin causes `registerTool()` to reject with a `SecurityError`.
* **Scope**: `exposedTo` controls in-page cross-document discovery across frames in the document tree.

## Defining Parameters

Parameters (params) are defined using the `inputSchema` property. This must be a **JSON Schema** object that describes the structured data the tool expects.

```javascript
await document.modelContext.registerTool({
  name: "calculate_area",
  description: "Calculates the area of a rectangle.",
  inputSchema: {
    type: "object",
    properties: {
      width: { type: "number", description: "The width of the rectangle." },
      height: { type: "number", description: "The height of the rectangle." }
    },
    required: ["width", "height"]
  },
  execute(input) {
    // input is { width: 10, height: 20 }
    return input.width * input.height;
  },
  annotations: { readOnlyHint: true }
});
```

## Writing Tool and Parameter Descriptions

The agent already receives the full `inputSchema`, so the `description` only needs to say what the tool does and when to use it. **DO NOT** repeat parameter names, types, `enum` values, defaults, or limits in it; declare them in the schema (`enum`, `default`, `minimum`/`maximum`) instead. Parameter descriptions follow the same rule: say what the value means, not its type or allowed values.

The browser does not validate arguments against `inputSchema` or apply `default` values, so do both in `execute`.

```javascript
const SORT_ORDERS = ["newest", "price_low_to_high"];

await document.modelContext.registerTool({
  name: "search_products",
  // Don't list the sort orders here, even via SORT_ORDERS: `enum` already does.
  description: "Searches the product catalog by keyword. Use when the user wants to find or compare products.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Words to search for." },
      sort: { type: "string", enum: SORT_ORDERS, default: "newest", description: "Order of the results." },
    },
    required: ["query"],
  },
  async execute({ query, sort = "newest" }, { signal }) {
    if (typeof query !== "string" || !SORT_ORDERS.includes(sort)) {
      return { error: "Pass a search query and a supported sort order.", sortOrders: SORT_ORDERS };
    }
    return await productService.search({ query, sort }, { signal });
  },
  annotations: { readOnlyHint: true },
});
```

## Declaring Return Values with `outputSchema`

Since Chrome 159, a tool definition accepts an optional `outputSchema`: a JSON Schema object describing the value `execute` returns.

* **Separate intent from structure**: Keep `description` focused on what the tool does and when to call it. **DO NOT** list returned property names, types, or chaining IDs in `description`; declare them in `outputSchema` instead.
* **Use `outputSchema` selectively**: Add it to consolidated read or search tools that return multiple fields, to mutating actions that return updated state (e.g. `{ items, subtotal, total }` after a cart update), and to tools that return IDs consumed by other tools. Omit it on narrow reads with obvious outputs (e.g. a single number), actions that return only a status or confirmation, and UI navigation tools, since every schema costs prompt tokens.
* **Keep `execute()` aligned with `outputSchema`**: Return a JSON-serializable value that matches the schema. Agents can validate results against `outputSchema` and send the model a tool error instead of the result when it doesn't match. This includes structured error payloads: if `execute` can return `{ error: "..." }`, allow that shape in `outputSchema` (e.g. with `anyOf`), or the agent may never see your error message.

```javascript
await document.modelContext.registerTool({
  name: "search_flights",
  // Say what the tool does and when to use it; the result shape lives in `outputSchema`.
  description: "Searches available flights between two airports. Use before booking a flight.",
  inputSchema: {
    type: "object",
    properties: {
      from: { type: "string", description: "Departure airport IATA code." },
      to: { type: "string", description: "Arrival airport IATA code." },
    },
    required: ["from", "to"],
  },
  outputSchema: {
    anyOf: [
      {
        type: "object",
        properties: {
          flights: {
            type: "array",
            items: {
              type: "object",
              properties: {
                // Declared here so the agent knows to pass it to `book_flight`.
                flightId: { type: "string", description: "Pass to book_flight." },
                departureTime: { type: "string", format: "date-time" },
                price: { type: "number" },
              },
              required: ["flightId", "departureTime", "price"],
            },
          },
        },
        required: ["flights"],
      },
      // Allow the structured error payload so validation doesn't swallow it.
      {
        type: "object",
        properties: { error: { type: "string" } },
        required: ["error"],
      },
    ],
  },
  async execute({ from, to }, { signal }) {
    if (typeof from !== "string" || typeof to !== "string") {
      return { error: "Pass departure and arrival airport codes." };
    }
    try {
      const flights = await flightService.search({ from, to }, { signal });
      // Return only the declared fields, matching `outputSchema`.
      return {
        flights: flights.map(({ id, departureTime, price }) => ({ flightId: id, departureTime, price })),
      };
    } catch (err) {
      // A cancelled execution is re-thrown, not returned as an error value.
      if (signal.aborted) throw err;
      // Matches the `{ error }` branch of `outputSchema`, so the agent sees the message.
      return { error: err instanceof Error ? err.message : String(err) };
    }
  },
  annotations: { readOnlyHint: true },
});
```

## Execution Patterns

The `execute` callback always receives two arguments: the input object, and an options object carrying an `AbortSignal` — `execute(inputObject, { signal })`.

### When to use `async execute`
Use `async` when the tool involves operations that return a Promise or take time to complete:
- **Network calls**: Fetching data from an API.
- **Asynchronous Storage**: Accessing IndexedDB.
- **External Events**: Waiting for a specific state change or animation to finish.

```javascript
async execute(input, { signal }) {
  const response = await fetch(`/api/data/${input.id}`, { signal });
  return await response.json();
}
```

### When to use `execute` (Synchronous)
Use a standard synchronous function for immediate operations. A synchronous tool runs to completion before cancellation can be observed, so it can ignore the signal:
- **Pure logic**: Math, filtering, or sorting data already in memory.
- **Synchronous state**: Reading from `localStorage` or a synchronous state manager.

```javascript
execute(input) {
  return input.items.filter(item => item.active);
}
```

### Handling errors in `execute`

When `execute` throws (or returns a rejected promise), the agent receives only a generic execution failure. The error message is not forwarded to the agent. If your tool encounters an actionable or recoverable error (such as invalid input, missing items, or a failed HTTP status), **DO NOT** `throw new Error(...)`. Instead, return a structured error payload via the tool's normal return value so the AI agent receives the diagnostic details and can self-correct or retry:

```javascript
execute({ itemName }) {
  const item = menuItems.find((entry) => entry.name.toLowerCase() === itemName.toLowerCase());
  if (!item) {
    // Return the error as a value instead of throwing, so the agent receives the message:
    return {
      error: `Menu item "${itemName}" not found.`,
      availableItems: menuItems.map((entry) => entry.name),
    };
  }
  return item;
}
```

Only re-throw when the execution was cancelled (`signal.aborted` is `true`).

### Cancelling in-flight executions

Cancellation is initiated by the user or the agent. **MANDATORY:** Any tool that performs network requests or other long-running async work MUST honor `signal`, otherwise cancelled executions keep consuming resources and can write stale data into the UI after the agent has moved on.

* **APIs that accept a signal** (`fetch()`, `addEventListener()`, `ReadableStream` readers): pass `signal` straight through.
* **APIs that do not** (`setTimeout`, `setInterval`, polling loops, `await`-heavy pipelines): call `signal.throwIfAborted()` between steps, and/or reject on `signal.addEventListener('abort', ...)`. Timers accept no signal, so you must clear them yourself in the abort listener.

```javascript
await document.modelContext.registerTool({
  name: "fetch_tool",
  description: "Fetch the text content of a URL and show it on the page.",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "The URL to fetch" },
      priority: {
        type: "string",
        enum: ["high", "low", "auto"],
        description: "Relative network priority for the request",
      },
    },
    required: ["url"],
  },
  execute: async ({ url, priority }, { signal }) => {
    const output = document.querySelector("pre");
    output.textContent = "Loading…";
    try {
      // Passing `signal` aborts the network request the moment execution is cancelled.
      const response = await fetch(url, { priority, signal });
      if (!response.ok) {
        output.textContent = "";
        return { error: `Request failed with status ${response.status}` };
      }
      const text = await response.text();
      output.textContent = text;
      return text;
    } catch (err) {
      // Roll back the UI state this execution set, so a cancelled run leaves no trace.
      output.textContent = "";
      if (signal.aborted) {
        // The execution was cancelled: re-throw instead of returning an error value.
        throw err;
      }
      // Return other errors as a value instead of throwing, so the agent receives the message.
      return { error: err instanceof Error ? err.message : String(err) };
    }
  },
  annotations: { readOnlyHint: true }
});
```

## Flagging Consequential Tools

Since Chrome 154, `annotations` supports `consequentialHint`. Set it to `true` for tools that take high-stakes, irreversible, or real-world actions — booking travel, moving money, sending messages, or deleting data. It signals agents to request explicit user confirmation before execution.

```javascript
await document.modelContext.registerTool({
  name: 'book_flight',
  description: 'Book a flight for the user with confirmed flight details.',
  inputSchema: {
    type: 'object',
    properties: {
      flightId: { type: 'string', description: 'ID of the flight to book' },
      passengers: { type: 'number', description: 'Number of tickets to purchase' },
    },
    required: ['flightId', 'passengers'],
  },
  execute: async ({ flightId, passengers }, { signal }) => {
    // Forward `signal` to the transaction API to honor cancellation:
    return await bookFlightReservation({ flightId, passengers }, { signal });
  },
  annotations: {
    readOnlyHint: false,      // This tool mutates state (it makes a booking).
    consequentialHint: true,  // Spends money and is not trivially reversible.
    untrustedContentHint: false, // Output is first-party data, not third-party content.
  }
});
```

**MANDATORY:** Treat `consequentialHint` as a hint, not an enforcement mechanism. It does not block execution on its own, and browsers that predate the hint will not prompt at all. Keep whatever in-app confirmation the action already warrants.

## Flagging Debugging Tools

Since Chrome 156, `annotations` supports `debugging`. Set `annotations.debugging` to `true` for tools built for debugging and developer tooling rather than end-user tasks. Examples: dumping internal app state, toggling feature flags, or seeding test data. This lets agents tell developer-only tools apart from tools meant to act for the user. It defaults to `false`. In-page agents and test harnesses can read it from `RegisteredTool.annotations.debugging` via `getTools()`.

```javascript
await document.modelContext.registerTool({
  name: "dump_app_state",
  description: "Returns a snapshot of the internal application store for debugging.",
  execute() {
    return appStore.getState();
  },
  annotations: {
    readOnlyHint: true, // Only reads state.
    debugging: true,    // Developer tooling, not an end-user action.
  }
});
```

## In-Page Agents and Testing (`getTools` and `executeTool`)

**Web pages do not need `getTools()` or `executeTool()` to expose tools to AI agents.** Simply calling `document.modelContext.registerTool()` is all that is required for browser agents, browser extensions, DevTools, and system-level assistants to discover and execute your tools out-of-band.

The `getTools()` and `executeTool()` methods exist specifically for consumers running inside the JavaScript environment:
1. **In-page JavaScript agents:** An AI assistant, copilot widget, or chat interface embedded directly in the page (or running inside an `<iframe>`) that needs to discover what tools the surrounding page or accessible frames in the document tree offer, and invoke them on behalf of the user.
2. **Automated testing and debugging:** Test suites (such as Playwright, Vitest, or in-browser unit tests) that inspect registered tool metadata and simulate agent tool invocations without requiring a live external LLM harness.

### Discovering available tools with `getTools()`

In-page agents call `document.modelContext.getTools()` to retrieve an array of `RegisteredTool` objects from the current document and any accessible frames in the document tree.

Since Chrome 155, `RegisteredTool.inputSchema` is returned directly as a JavaScript object (a deep copy of the schema supplied at registration). Mutating this object does not alter the registered tool's actual schema.

```javascript
// Example: An in-page AI assistant discovering tools available on the page:
const tools = await document.modelContext.getTools();

// In-page agents can listen for tools being registered or unregistered dynamically:
document.modelContext.addEventListener("toolchange", async () => {
  const updatedTools = await document.modelContext.getTools();
  console.log(`Active tools updated: ${updatedTools.map((t) => t.name).join(", ")}`);
});
```

To discover tools registered inside cross-origin descendant iframes (which must explicitly grant access via `exposedTo` during registration), pass `fromOrigins` in the options dictionary:

```javascript
// Query tools registered in the embedded cart frame that exposed them to this checkout origin:
const cartTools = await document.modelContext.getTools({
  fromOrigins: ["https://cart.example.com"],
});
```

### Invoking tools with `executeTool()`

In-page agents and test scripts call `document.modelContext.executeTool(tool, inputObject, options)` to execute a registered tool. The tool runs on the document where it was registered, and the promise resolves to the stringified result returned by the tool's `execute` callback.

Since Chrome 155, `executeTool()` accepts a plain JavaScript object directly for `inputObject`, matching the input format your tool's `execute` callback receives.

```javascript
// 1. Discover the tool (typically done during agent initialization or test setup):
const tools = await document.modelContext.getTools();
const areaTool = tools.find((t) => t.name === "calculate_area");

if (areaTool) {
  const controller = new AbortController();
  // Example input payload matching the tool's inputSchema:
  const inputObject = { width: 10, height: 20 };
  const options = { signal: controller.signal };

  // 2. Pass input arguments as a JavaScript object, with a JSON string fallback for Chrome <155:
  let resultString;
  try {
    resultString = await document.modelContext.executeTool(areaTool, inputObject, options);
  } catch (err) {
    if (err?.message?.startsWith("Failed to parse input")) {
      resultString = await document.modelContext.executeTool(
        areaTool,
        JSON.stringify(inputObject),
        options
      );
    } else {
      // Re-throw real tool execution or cancellation errors:
      throw err;
    }
  }

  console.log("Execution output string:", resultString);
}
```

The returned promise rejects if:
* `inputObject` is not an object or cannot be serialized to a JSON string (e.g. circular references or `BigInt` values). Note that values omitted by JSON serialization (such as functions and `undefined`) will be omitted from the object received by the tool rather than causing a rejection.
* The execution is aborted via `options.signal`.
* The tool was unregistered prior to execution or encounters an unhandled runtime error.

## Tool Factory Pattern

To pass context (like stores or application instances) to your tools, use factory functions.

```javascript
export function createInventoryTool(inventoryManager) {
  return {
    name: "get_inventory",
    description: "Lists items in the inventory.",
    inputSchema: { type: "object", properties: {} },
    execute() {
      return inventoryManager.getItems();
    },
    annotations: { readOnlyHint: true }
  };
}
```

## TypeScript Types

In TypeScript projects, **DO NOT** hand-write declarations for `document.modelContext`. Install the official `webmcp-types` package (`npm install --save-dev webmcp-types`) and add it to `tsconfig.json`, since it is not picked up automatically:

```jsonc
{
  "compilerOptions": {
    "types": ["webmcp-types"]
  }
}
```

* `document.modelContext` is typed as optional, so guard it with `if (document.modelContext)` before use.
* With an inline `inputSchema`, the `execute` input type is inferred from the schema.
* Named types such as `WebMCP.ModelContextTool` are global (no import needed), useful for typing tool factories.

## Framework support

**MANDATORY:** If the app uses React, Angular, or Vue, register tools through that framework's official WebMCP integration, listed below. **DO NOT** call `document.modelContext.registerTool()` from components or write your own lifecycle wrapper. Each integration already handles feature detection, `AbortSignal` cleanup, and scoping tools to the component or injector lifecycle. These APIs are experimental, so before writing code, look up the current signature in the package's types or docs.

| Framework | Package | API | Docs |
|---|---|---|---|
| React 18+ | `use-webmcp-tool` | `useWebMCP(options)`: one call per tool | npmjs.com/package/use-webmcp-tool |
| Angular | `@angular/core`, `@angular/forms/signals` | `provideExperimentalWebMcpTools([...])` (app or route providers), `declareExperimentalWebMcpTool(...)` (inside services), `provideExperimentalWebMcpForms()` + the `experimentalWebMcpTool` option on Signal Forms | angular.dev/ai/webmcp |
| Vue | `@vueuse/core` | `useWebMCP(options)` composable | vueuse.org/core/usewebmcp |

All the rules in this guide still apply when you use these integrations:
* Keep the tool definition shape the same: `name`, `description`, `inputSchema`, `execute(input, { signal })`, and `annotations`.
* Follow the rules for descriptions and annotations.
* Validate input and apply defaults inside `execute`.
* Pass `signal` to long-running work.
* To offer a tool only some of the time, pass `enabled` (React, Vue). **DO NOT** wrap the hook or composable call in a condition.
* Integrations may wrap results and errors (for example as `{ content, isError }`). Check the integration's docs before relying on how errors reach the agent.

## API Notes

*   **annotations**: (Optional) A dictionary for tool metadata.
    *   **readOnlyHint**: (Optional) Set to `true` if the tool does not modify any state and only reads data. This helps agents decide when it is safe to call the tool.
    *   **consequentialHint**: (Optional, Chrome 154+) Set to `true` for high-stakes, irreversible, or real-world actions so agents request user confirmation first.
    *   **untrustedContentHint**: (Optional) Set to `true` when the tool returns content your site does not control, such as user-generated text or third-party API responses.
    *   **debugging**: (Optional, Chrome 156+) Set to `true` when the tool is meant for debugging and developer tooling, not end-user tasks. Defaults to `false`.
*   **Registration Options**:
    *   **signal**: (Optional) An `AbortSignal` used to unregister the tool when it is no longer needed.
    *   **exposedTo**: (Optional) An array of secure origin strings controlling which documents in the document tree are allowed to discover and execute the tool across frame boundaries.
*   **Tool Discovery Options (`ModelContextGetToolOptions`)**:
    *   **fromOrigins**: (Optional) An array of secure origin strings to query in accessible frames. Calling `getTools()` without `fromOrigins` queries only same-origin documents.
*   **outputSchema**: (Optional, Chrome 159+) A JSON Schema object describing the value `execute` returns. Add it selectively to multi-field read/search tools, mutating actions that return updated state, and tools returning IDs for chaining.
*   **Return Format**: The `execute` function can return any JSON-serializable value (object, array, string, number, boolean). The message of an exception thrown from `execute` is not forwarded to the agent, so return actionable errors as structured error payloads (e.g. `{ error: "..." }`) via the tool's return value so the agent can read and act on them.
*   **Secure Context**: WebMCP requires HTTPS. All origins in `exposedTo` and `fromOrigins` must also be potentially trustworthy.
*   **Deprecated/Removed**: `navigator.modelContext` (deprecated in Chromium 150), `unregisterTool()`, `provideContext()`, and `clearContext()` are no longer supported.

## Fallback strategies

document.modelContext is not natively supported by any major browser yet.

The WebMCP Imperative API should be used with feature detection to ensure compatibility with browsers that do not yet support WebMCP.

```javascript
if ('modelContext' in document) {
  // Register tools
}
```
