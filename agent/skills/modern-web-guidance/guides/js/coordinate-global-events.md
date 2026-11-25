# Coordinating Global Events with Temporal

Scheduling events across different time zones is notoriously difficult with the legacy `Date` object, especially around Daylight Saving Time (DST) transitions when hours can be skipped or repeated.

The `Temporal` API provides `Temporal.ZonedDateTime` to represent a date and time in a specific time zone, handling DST transitions automatically and predictably.

## How to Implement

To coordinate global events and handle potential DST conflicts:

1. **MANDATORY:** **Create a ZonedDateTime**: Use `Temporal.ZonedDateTime.from()` to create a time-zone-aware date-time object.
2. **MANDATORY:** **Handle Ambiguity**: Use the `disambiguation` option to control behavior when a time is ambiguous or does not exist (e.g., during clock changes).
3. **MANDATORY:** **Convert Time Zones**: Use `.withTimeZone()` to see the equivalent time in another location.

### Example: Scheduling and Conflict Detection

```javascript
// 1. Define the event time and target time zone
const date = "2025-03-09";
const time = "02:30"; // This time is skipped in New York during Spring Forward
const timeZone = "America/New_York";
const inputStr = `${date}T${time}[${timeZone}]`;

// 2. Detect conflicts using 'reject'
let hasConflict = false;
try {
  // 'reject' throws RangeError if the time is ambiguous or does not exist
  Temporal.ZonedDateTime.from(inputStr, { disambiguation: 'reject' });
} catch (e) {
  if (e instanceof RangeError) {
    hasConflict = true;
    console.log("This time falls in a DST transition gap or overlap.");
  }
}

// 3. Resolve the time safely using 'compatible' (default)
// 'compatible' will resolve to a valid time even if skipped or repeated
const hostTime = Temporal.ZonedDateTime.from(inputStr, { disambiguation: 'compatible' });
console.log(`Resolved time: ${hostTime.toString()}`);

// 4. Convert to another time zone (e.g., Tokyo)
const tokyoTime = hostTime.withTimeZone("Asia/Tokyo");
// Use toLocaleString() for user-facing display instead of manual hour/minute padding
console.log(`Tokyo time: ${tokyoTime.toLocaleString('en-US', { hour: 'numeric', minute: '2-digit' })}`);
```

## Strategic Implementation & Best Practices

-   **DO** use `Temporal.ZonedDateTime` for events that are bound to a specific geographical location (like a meeting in a specific city).
-   **DO** use `disambiguation: 'reject'` if you need to detect and warn users about scheduling conflicts during DST transitions.
-   **DO** use `disambiguation: 'compatible'` (the default) when you want the system to automatically pick a sensible time when conflicts occur.
-   **DO NOT** use `Temporal.PlainDateTime` for global events, as it does not carry time zone information and cannot account for DST changes.
-   **DO** use `.withTimeZone()` to calculate the equivalent time in other locations without mutating the original object (Temporal objects are immutable).
-   **DO** use native `.toLocaleString()` formatting (such as `{ hour: 'numeric', minute: '2-digit' }`) for user-facing time displays instead of manual time calculations and padding.

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