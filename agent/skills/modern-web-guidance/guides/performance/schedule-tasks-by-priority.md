# Schedule Tasks By Priority

When building complex web applications, tasks have different levels of urgency. Completing tasks for the current view is more important than sending analytics or prefetching assets. The Prioritized Task Scheduling API (`scheduler.postTask()` and `TaskController`) lets you schedule, reprioritize, and cancel work across priority levels so the main thread stays responsive to user input.

`scheduler.postTask()` controls when tasks *start* relative to each other, but a single callback running longer than 50ms still blocks the main thread once started. To split long-running work inside a task—while preserving its priority and `TaskSignal`—call `await scheduler.yield()` periodically inside the callback (see `break-up-long-tasks` (via `npx -y modern-web-guidance@latest retrieve "break-up-long-tasks"`)).

### Scheduling tasks by priority

Use `scheduler.postTask()` to schedule tasks with one of three priorities:
- `user-blocking`: Tasks that block user interaction (e.g., input handling, critical rendering).
- `user-visible`: Tasks visible to the user but not blocking (default).
- `background`: Tasks that are not time-critical (e.g., analytics, background indexing, prefetching).

```javascript
// Schedule a high-priority task that blocks user interaction
scheduler.postTask(() => {
  // DO: Handle critical updates that impact user interaction
  handleCriticalUpdate();
}, { priority: 'user-blocking' });

// Schedule a default priority task
scheduler.postTask(() => {
  // DO: Render non-critical content that is visible to the user
  renderSecondaryContent();
}); // Defaults to 'user-visible'

// Schedule a low-priority background task
scheduler.postTask(() => {
  // DO: Perform heavy background work that is not time-critical
  sendAnalytics();
}, { priority: 'background' });
```

### Aborting or reprioritizing tasks with `TaskController`

Optional: When queued work may become stale or change urgency (such as aborting background indexing on navigation or promoting a prefetched view when opened), create a `TaskController` and pass `controller.signal` to `scheduler.postTask()`:

```javascript
const controller = new TaskController({ priority: 'background' });

// Omit `priority` here—passing an explicit `priority` alongside `signal`
// overrides `controller.signal` and ignores `controller.setPriority()`.
const taskPromise = scheduler.postTask(async () => {
  await buildSearchIndex();
}, { signal: controller.signal });

// Promote if the user interacts immediately, or call controller.abort() to cancel
controller.setPriority('user-blocking');
```

### Fallback strategies

Browser support for Scheduler API: Limited availability.
Supported by: Chrome 129 (Sep 2024), Edge 129 (Sep 2024), and Firefox 142 (Aug 2025).
Unsupported in: Safari.

If your Baseline target does not support the Prioritized Task Scheduling API and your application relies on multi-tier priority ordering (`user-blocking`, `user-visible`, `background`) or `TaskController.setPriority()`, conditionally load `scheduler-polyfill` via dynamic `import()` so supported browsers pay zero bundle cost:

```javascript
// MANDATORY: Feature-detect scheduler.postTask and load the polyfill only when missing
if (!('scheduler' in window && 'postTask' in window.scheduler)) {
  await import('scheduler-polyfill');
}

// Safe to use scheduler.postTask and TaskController in all browsers
scheduler.postTask(() => {
  sendAnalytics();
}, { priority: 'background' });
```

If you only use `scheduler.postTask()` to push non-urgent background work off the current turn and do not need cross-task priority reordering or dynamic `setPriority()`, you can avoid an external dependency and degrade gracefully to `setTimeout(callback, 0)` when `scheduler.postTask` is unavailable (checking `signal?.aborted` before running if passing an `AbortSignal`).
