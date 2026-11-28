# Sorting High-Precision Timestamps with Temporal.Instant

Log viewers, audit timelines, and telemetry UIs often ingest events whose ISO 8601 timestamps were recorded with microsecond or nanosecond precision by a server, database, or native clock (for example, `2026-04-01T12:00:00.000123456Z`). Because the legacy `Date` object only stores milliseconds, parsing those strings with `new Date()` or `Date.parse()` silently truncates sub-millisecond digits, causing distinct events within the same millisecond to collide and sort in an unstable order.

`Temporal.Instant` represents an exact point on the UTC timeline with nanosecond precision and no attached time zone. When parsing pre-recorded high-precision timestamps with `Temporal.Instant.from()`, it preserves the full nanosecond value, sorts deterministically with `Temporal.Instant.compare()`, and computes exact `Temporal.Duration` intervals between events. Note that in browsers, `Temporal.Now.instant()` is deliberately clamped to millisecond or microsecond resolution for Spectre timing-attack mitigation—use `Temporal.Instant.from()` to preserve nanosecond timestamps produced by external clocks, and use `performance.now()` when measuring sub-millisecond intervals locally in the client.

## How to Implement

To parse, sort, and measure intervals between high-precision timestamps:

1. **Parse recorded timestamps as `Temporal.Instant`**: Use `Temporal.Instant.from(isoString)` on the timestamp string supplied by the server, database, or log line. Keep the timestamp the source recorded; do not replace it with `Temporal.Now.instant()` in the browser.
2. **Sort events chronologically**: Use `Temporal.Instant.compare(a, b)` as the comparator passed to `Array.prototype.sort()` or `Array.prototype.toSorted()`. It compares the full nanosecond value so sub-millisecond ordering is preserved.
3. **Calculate intervals**: Use `instant.since(previousInstant)` to get a `Temporal.Duration` between consecutive events. Use `a.equals(b)` to detect events with identical timestamps.
4. **Display intervals with `toLocaleString()`**: Format the `Temporal.Duration` for users with `duration.toLocaleString()`, which delegates to `Intl.DurationFormat`. Do not convert to a single `Number` of nanoseconds for display.
5. **Serialize for transmission**: Use `Temporal.Instant.prototype.toString()` to emit a standard ISO 8601 string (always in UTC with a `Z` suffix).

## Example Code: Sorting High-Precision Timestamps

```javascript
// Events received with nanosecond-precision ISO 8601 timestamps.
const rawEvents = [
  { nodeId: 'api-2', eventType: 'db.query', ts: '2026-04-01T12:00:00.000123456Z' },
  { nodeId: 'api-1', eventType: 'request.start', ts: '2026-04-01T12:00:00.000120000Z' },
  { nodeId: 'api-2', eventType: 'request.end', ts: '2026-04-01T12:00:00.000987654Z' },
];

// 1. Parse recorded timestamps as Temporal.Instant (never `new Date(ts)`,
// which drops everything below the millisecond).
const events = rawEvents.map(evt => ({
  ...evt,
  timestamp: Temporal.Instant.from(evt.ts),
}));

// 2. Sort chronologically with the static compare() method
function sequenceEvents(items) {
  // Instant.compare returns -1, 0, or 1, which is what sort() expects.
  return [...items].sort((a, b) => Temporal.Instant.compare(a.timestamp, b.timestamp));
}

// 3. Calculate and display the interval between consecutive events
function analyzeTrace(sortedEvents) {
  for (let i = 1; i < sortedEvents.length; i++) {
    const prev = sortedEvents[i - 1];
    const curr = sortedEvents[i];

    // since() returns a Temporal.Duration that retains nanosecond precision.
    const gap = curr.timestamp.since(prev.timestamp);

    // 4. toLocaleString() formats the duration for people (e.g., "3μs 456ns").
    // Avoid gap.total('nanoseconds'): spans over ~104 days exceed Number.MAX_SAFE_INTEGER.
    // 'en-US' is used here for deterministic output; pass undefined to use the user's locale.
    console.log(`${prev.eventType} → ${curr.eventType}: ${gap.toLocaleString('en-US', { style: 'narrow' })}`);
  }
}

analyzeTrace(sequenceEvents(events));
```

## Strategic Implementation & Best Practices

- **DO** use `Temporal.Instant.from()` for parsing high-precision timestamps recorded against a single clock (such as a server, database, or log pipeline) that need to be ordered or differenced. Unlike `Temporal.PlainDateTime`, `Temporal.Instant` represents an unambiguous point on the universal timeline.
- **DO** keep the timestamp recorded by the source. In browsers, `Temporal.Now.instant()` is clamped to millisecond/microsecond precision for Spectre timing-attack and fingerprinting mitigation; use `performance.now()` / `performance.mark()` for local sub-millisecond client intervals, and `Temporal.Instant.from()` for parsing nanosecond timestamps from server or native clocks.
- **DO** use `Temporal.Instant.compare()` for sorting and `a.equals(b)` for equality checks; do not check `Temporal.Instant.compare(a, b) === 0` or compare `.toString()` output.
- **DO NOT** parse high-precision timestamp strings with `new Date()` or `Date.parse()` for ordering, because they truncate to milliseconds and produce collisions.
- **DO NOT** collapse an interval to a single number for display. `duration.total('nanoseconds')` returns a `Number`, which exceeds `Number.MAX_SAFE_INTEGER` for spans longer than ~104 days and silently loses precision. Subtracting `epochNanoseconds` (a `BigInt`) is exact but discards unit structure; keep intervals as `Temporal.Duration` and format them with `.toLocaleString()`.
- **DO** convert an `Instant` to `Temporal.ZonedDateTime` with `instant.toZonedDateTimeISO(timeZone)` when you need to display the localized wall-clock time of an event to a user.

## Fallback Strategy

### Fallbacks & browser support for Temporal

Browser support for Temporal: Limited availability.
Supported by: Chrome 144 (Jan 2026), Edge 144 (Jan 2026), and Firefox 139 (May 2025).
Unsupported in: Safari.

For browsers that do not yet support the native `Temporal` API, use feature detection and dynamically load `temporal-polyfill` (~15 KB min+gz).

Note that importing `temporal-polyfill` does not automatically assign the `Temporal` object to the global scope. Assign it explicitly if your code relies on `globalThis.Temporal`.

```javascript
// Check if Temporal is supported natively
(async () => {
  if (typeof Temporal === 'undefined') {
    // Load the polyfill conditionally
    const module = await import('https://esm.sh/temporal-polyfill');
    globalThis.Temporal = module.Temporal;
    // Extend Date.prototype if needed
    Date.prototype.toTemporalInstant = module.toTemporalInstant;
  }
  initializeApp();
})();
```
