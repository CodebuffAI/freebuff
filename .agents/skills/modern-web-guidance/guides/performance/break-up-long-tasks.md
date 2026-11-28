# Break Up Long Tasks

Heavy computations or long loops can block the main thread, delaying event handlers and causing poor Interaction to Next Paint (INP) responsiveness. To prevent this, yield control back to the browser periodically with `scheduler.yield()`, which pauses an already-running task so the browser can handle pending user input and rendering before continuing.

`scheduler.yield()` only splits a single running task—it does not order separate work streams (`'user-blocking'`, `'user-visible'`, `'background'`), defer non-urgent background work before it starts, or abort and reprioritize queued tasks via `TaskController`. **DO NOT** replace `scheduler.postTask()` or `TaskController` with `scheduler.yield()` alone when scheduling work at different priorities; see `schedule-tasks-by-priority` (via `npx -y modern-web-guidance@latest retrieve "schedule-tasks-by-priority"`). When a background task scheduled with `scheduler.postTask()` itself exceeds 50ms, combine both APIs by calling `await scheduler.yield()` inside the `postTask()` callback—continuations automatically inherit the enclosing task's priority and `TaskSignal`.

### Breaking up long tasks

Use `scheduler.yield()` inside async functions to break up work.

```javascript
async function processLargeArray(items) {
  // DO: Set a time-based deadline 50 milliseconds into the future. 50
  // milliseconds is the boundary for when a task becomes a long task.
  let deadline = performance.now() + 50; // 50ms budget

  for (const item of items) {
    // Process the item
    processItem(item);
    
    // MANDATORY: Yield to the main thread periodically to keep the UI
    // responsive. This can be done by checking if the deadline set earlier
    // has been exceeded. When it has been, yield, then reset the deadline
    // another 50 milliseconds into the future.
    if (performance.now() >= deadline) {
      await scheduler.yield();
      deadline = performance.now() + 50;
    }
  }
}
```

### Fallback strategies

Browser support for Scheduler API: Limited availability.
Supported by: Chrome 129 (Sep 2024), Edge 129 (Sep 2024), and Firefox 142 (Aug 2025).
Unsupported in: Safari.

If your Baseline target does not support the Scheduler API, implement a fallback using `setTimeout` so long loops still yield to the main thread without throwing. (If combining `scheduler.yield()` with `scheduler.postTask()`, feature-detect `postTask` separately as well.)

#### Fallback for `scheduler.yield()`

```javascript
async function processLargeArrayWithFallback(items) {
  // DO: Set a time-based deadline 50 milliseconds into the future.
  let deadline = performance.now() + 50;

  for (const item of items) {
    processItem(item);
    
    // MANDATORY: Yield to the main thread periodically to keep the UI responsive.
    if (performance.now() >= deadline) {
      // DO: Feature detect scheduler.yield
      if ('scheduler' in window && 'yield' in window.scheduler) {
        await scheduler.yield();
      } else {
        // DO: Fallback to setTimeout for older browsers
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      deadline = performance.now() + 50;
    }
  }
}
```
