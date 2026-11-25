# Calculating Event Differentials and Formatting Durations with Temporal

Calculating the time elapsed or remaining between events (such as trial expirations, subscription countdowns, or SLA windows) and presenting those spans in a localized, human-readable format has historically required manual math or external libraries. The legacy `Date` object only tracks epoch milliseconds, making calendar-month arithmetic, Daylight Saving Time (DST) transitions, and unit balancing error-prone.

The `Temporal` API pairs `Temporal.ZonedDateTime` with `Temporal.Duration` and `Intl.DurationFormat` to provide DST-safe time differentials, configurable unit balancing, calendar-aware duration comparisons, and localized formatting.

## How to Implement

1. **Obtain `Temporal.ZonedDateTime` endpoints**: Use `Temporal.Now.zonedDateTimeISO()` for the current time in the system time zone, or pass an explicit IANA time zone string—`Temporal.Now.zonedDateTimeISO(timeZone)`—when the target event's time zone differs from the user's system default.
2. **Calculate differentials with `.since()` and `.until()`**:
   - Use `now.since(start, options)` to compute time elapsed since a past event.
   - Use `now.until(end, options)` to compute time remaining until a future event.
   - Pass `largestUnit` (e.g., `'year'`, `'month'`, `'day'`, `'hour'`) and `smallestUnit` (e.g., `'minute'`) to balance and round the resulting `Temporal.Duration`.
3. **Balance or compare standalone `Temporal.Duration` objects**:
   - Create standalone durations with `Temporal.Duration.from({ minutes: 90 })` and rebalance units with `duration.round({ largestUnit: 'hour' })` (supplying `relativeTo` when balancing across calendar months, years, or DST transitions).
   - Compare two durations with `Temporal.Duration.compare(d1, d2, { relativeTo })`—passing a `PlainDate` or `ZonedDateTime` as `relativeTo` is required whenever either duration contains calendar units (`years`, `months`, `weeks`) or crosses DST boundaries.
4. **Format for humans vs. machines**:
   - Use `duration.toLocaleString(locale, options)` (which delegates to `Intl.DurationFormat`) for localized user-facing text.
   - Use `duration.toString()` only for machine-readable ISO 8601 duration strings (such as `P1M2DT4H`).

### Example: Trial Expiration Differential and Localized Formatting

```javascript
// 1. Get the current time in an explicit target IANA time zone (or omit the
// argument to use the system's current time zone).
const tz = 'America/New_York';
const now = Temporal.Now.zonedDateTimeISO(tz);

// 2. Combine separate date and time strings directly.
// Do not build an ISO string with template literals; chain Temporal methods instead.
const startDateStr = '2025-01-01';
const startTimeStr = '12:00:00';
const endDateStr = '2025-01-31';
const endTimeStr = '12:00:00';

const start = Temporal.PlainDate.from(startDateStr).toPlainDateTime(startTimeStr).toZonedDateTime(tz);
const end = Temporal.PlainDate.from(endDateStr).toPlainDateTime(endTimeStr).toZonedDateTime(tz);

// 3. Calculate differences using .since() and .until()
// ZonedDateTime differences default to largestUnit: 'hour' (days are not a fixed
// length across DST, so Temporal won't balance into days unless asked). Pass
// largestUnit: 'day' or a calendar unit ('week', 'month', 'year') when you want a
// human-scale breakdown instead of e.g. PT720H. smallestUnit rounds away
// seconds and sub-second noise so the formatted string stays readable.
const timeActive = now.since(start, { largestUnit: 'year', smallestUnit: 'minute' });
const timeRemaining = now.until(end, { largestUnit: 'year', smallestUnit: 'minute' });

// 4. Format durations for display with .toLocaleString() (Intl.DurationFormat)
// instead of manually concatenating unit numbers and suffixes. 'en-US' is used
// here for deterministic output; pass undefined to use the user's locale.
console.log(`Active: ${timeActive.toLocaleString('en-US', { style: 'narrow' })}`);
console.log(`Remaining: ${timeRemaining.toLocaleString('en-US', { style: 'long' })}`);

// Use .toString() for ISO 8601 serialization (e.g., API payloads or <time datetime="...">)
console.log(`ISO 8601: ${timeRemaining.toString()}`);

// 5. Check status via .sign, and compare durations with Temporal.Duration.compare()
const isExpired = timeRemaining.sign < 0;
// Pass relativeTo when comparing durations that may include calendar months/years or DST shifts
const isPastHalfway = Temporal.Duration.compare(timeActive, timeRemaining, { relativeTo: now }) > 0;
```

### Example: Balancing Standalone Durations (`round` and `Intl.DurationFormat`)

```javascript
// Convert a raw unit count (e.g., 90 minutes) into a balanced breakdown (1 hour, 30 minutes)
const rawDuration = Temporal.Duration.from({ minutes: 90 });
const balanced = rawDuration.round({ largestUnit: 'hour' });

// Format via duration.toLocaleString() or directly with Intl.DurationFormat
const formatter = new Intl.DurationFormat('en-US', { style: 'long' });
console.log(formatter.format(balanced)); // "1 hour, 30 minutes"
```

## Strategic Implementation & Best Practices

- **DO** use `Temporal.ZonedDateTime` for calculations involving real-world events that occur in specific time zones (like subscription renewals or event countdowns), and pass an explicit `timeZone` to `Temporal.Now.zonedDateTimeISO(timeZone)` when calculating against a zone other than the system default.
- **DO** combine separate date and time strings with Temporal methods, e.g. `Temporal.PlainDate.from(dateStr).toPlainDateTime(timeStr).toZonedDateTime(tz)` or `Temporal.PlainDate.from(dateStr).toZonedDateTime({ timeZone: tz, plainTime: timeStr })`, instead of interpolating an ISO string like `` `${dateStr}T${timeStr}` ``.
- **DO** pass `largestUnit` (e.g. `'day'`, `'month'`, `'year'`) in `.since()`, `.until()`, or `.round()` when you want durations balanced beyond hours; `ZonedDateTime` difference methods default to `'hour'`.
- **DO** use `Temporal.Duration.compare(d1, d2, { relativeTo })` when comparing two durations, providing a `relativeTo` anchor whenever either duration involves calendar units (`months`, `years`) or time-zone-aware days.
- **DO** format durations for user display using `duration.toLocaleString()` or `new Intl.DurationFormat(locale, { style })` (`'long'`, `'short'`, `'narrow'`, or `'digital'`) instead of manually interpolating `${duration.years}y ${duration.months}m...`.
- **DO** use `duration.toString()` for machine-readable ISO 8601 duration strings (e.g., `PT1H30M`), never as user-facing copy.
- **DO** render a `PlainTime` as `HH:MM` (e.g., for `<input type="time">`) using `.toPlainTime().toString({ smallestUnit: 'minute' })` rather than string `.slice(0, 5)`.
- **DO NOT** modify instances directly; `Temporal` objects are **immutable**. Operations like `.add()`, `.subtract()`, `.round()`, or `.with()` return a *new* instance.
- **DO NOT** fall back to `Date` / `.getTime()` arithmetic for the differential itself; `Date` has no time-zone-aware calendar math and only millisecond precision.
- **DO** use the native `.sign` property of the computed `Temporal.Duration` (or `Temporal.ZonedDateTime.compare()`) to check if a duration represents a past/expired time point (`sign < 0`) or a future pending start.

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

### Intl.DurationFormat

Baseline status for Intl.DurationFormat: Newly available. It's been Baseline since 2025-03-04.
Supported by: Chrome 129 (Sep 2024), Edge 129 (Sep 2024), Firefox 136 (Mar 2025), and Safari 16.4 (Mar 2023).
