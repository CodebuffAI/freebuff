# Capturing Location-Agnostic Data and Partial Dates with Temporal

Recording chronological data that should remain identical regardless of the viewer's location—such as birthdates, daily alarms, credit card expirations, or monthly billing cycles—has historically been error-prone with the legacy `Date` object. Because a `Date` always represents a specific instant in time and is displayed using the viewer's local time zone, saving a date like `"1990-01-01"` can result in users west of UTC seeing `"1989-12-31"`, while modeling partial dates (like a month-only card expiry) forces arbitrary placeholder days that cause overflow bugs.

The `Temporal` API provides a family of location-agnostic **"Plain" types** that carry no time zone offset and represent calendar dates and wall-clock times exactly as read off a calendar or clock:

| Type | What It Models | Typical Use Cases |
|---|---|---|
| `Temporal.PlainDate` | Full calendar date (`year`, `month`, `day`) | Birthdates, event dates, subscription billing dates |
| `Temporal.PlainTime` | Wall-clock time (`hour`, `minute`, `second`, ...) | Daily alarms (9:00 AM wherever the user is), store hours |
| `Temporal.PlainDateTime` | Calendar date + wall-clock time without a time zone | Floating local schedules, combining a `PlainDate` and `PlainTime` before attaching a zone |
| `Temporal.PlainMonthDay` | Month and day without a year | Recurring annual birthdays, anniversaries, fixed holidays |
| `Temporal.PlainYearMonth` | Year and month without a day | Credit card expirations (`2027-12`), monthly billing periods |

## How to Implement

1. **Choose the narrowest `Temporal.Plain*` type that matches your data**:
   - Use `Temporal.PlainDate.from()` for full calendar dates and `Temporal.PlainTime.from()` for wall-clock times.
   - Use `Temporal.PlainDateTime.from()` (or `plainDate.toPlainDateTime(plainTime)`) when combining a calendar date and wall-clock time without binding to a time zone.
   - Use `Temporal.PlainMonthDay.from()` for annual dates without a year, and convert to a `PlainDate` with `.toPlainDate({ year })` before performing date arithmetic.
   - Use `Temporal.PlainYearMonth.from()` for year-and-month values so arbitrary day numbers never leak into calculations.
2. **Note the `calendar` parameter when constructing Plain types**: ISO 8601 (`'iso8601'`) is the default calendar when parsing ISO strings or constructing with `PlainDate.from({ year, month, day })`. When constructing `PlainMonthDay` or `PlainYearMonth` from property bags—or when working with non-ISO calendars—pass `calendar` explicitly (e.g., `{ month: 10, day: 31, calendar: 'iso8601' }`).
3. **Use `.add()` with `overflow` options for recurring calendar intervals**: Calling `plainDate.add({ months: 1 })` defaults to `{ overflow: 'constrain' }`, clamping month-end dates like Jan 31 to Feb 28/29. Pass `{ overflow: 'reject' }` when invalid target dates should throw a `RangeError` instead of clamping.

### Example: Full Dates, Wall-Clock Times, and `PlainDateTime`

```javascript
// 1. Parse a calendar date and a wall-clock time from input strings
const birthdate = Temporal.PlainDate.from('1990-01-01');
const reminderTime = Temporal.PlainTime.from('09:00');

// Combine into a location-agnostic PlainDateTime without string interpolation
const localAppointment = birthdate.toPlainDateTime(reminderTime);

// 2. Display without time zone conversion; outputs the same date in any time zone
console.log(birthdate.toLocaleString('en-GB'));
console.log(localAppointment.toString()); // "1990-01-01T09:00:00"

// 3. Read calendar fields directly from the Plain type. A PlainDate already *is*
// a calendar date, so there is no need for the formatToParts() workaround that
// legacy Date code uses to recover year/month/day from an instant.
const { year, month, day } = birthdate;
```

### Example: Partial Dates (`PlainMonthDay` and `PlainYearMonth`)

```javascript
// Annual recurring event (no year component)
// Include explicit calendar when constructing from an object
const annualHoliday = Temporal.PlainMonthDay.from({
  month: 10,
  day: 31,
  calendar: 'iso8601',
});

const today = Temporal.Now.plainDateISO();
const isToday = annualHoliday.equals(today.toPlainMonthDay());

// Convert PlainMonthDay to a PlainDate with a specific year before doing arithmetic,
// because month lengths (such as February) depend on whether the year is a leap year.
const occurrenceThisYear = annualHoliday.toPlainDate({ year: today.year });

// Monthly expiration (no day component, preventing day-of-month overflow bugs)
const cardExpiry = Temporal.PlainYearMonth.from({
  year: 2027,
  month: 12,
  calendar: 'iso8601',
});
const currentMonth = today.toPlainYearMonth();
const isExpired = Temporal.PlainYearMonth.compare(cardExpiry, currentMonth) < 0;
```

### Example: Recurring Monthly Intervals (`overflow: 'constrain'` vs `'reject'`)

```javascript
const billingStart = Temporal.PlainDate.from('2024-01-31');

// Default overflow: 'constrain' clamps Jan 31 + 1 month to the last valid day of February
const nextBilling = billingStart.add({ months: 1 }, { overflow: 'constrain' });
console.log(nextBilling.toString()); // "2024-02-29" (2024 is a leap year)

// Use overflow: 'reject' to throw a RangeError when the target day does not exist
try {
  billingStart.add({ months: 1 }, { overflow: 'reject' });
} catch (err) {
  // RangeError: day 31 does not exist in February
}
```

### Example: Interoperating with Legacy `Date`

A legacy `Date` is a timestamp (an instant), not a calendar date. Storing `"1990-01-01"` as a `Date` forces you to pick *some* instant (typically midnight UTC), and reading it back in a time zone west of UTC yields `"31/12/1989"`. If a library or API still requires a `Date`, convert explicitly through `Temporal.Instant` rather than building ISO strings by hand:

```javascript
// PlainDate -> Date: attach a time zone (time of day defaults to the start of
// that day) to get an Instant, then hand the epoch milliseconds to Date.
// 'UTC' is a deliberate choice and must be documented; any zone would do,
// but the stored instant depends on it.
const instant = birthdate.toZonedDateTime('UTC').toInstant();
const legacyDate = new Date(instant.epochMilliseconds);

// Date -> PlainDate: go back through Instant (legacyDate.toTemporalInstant()
// is equivalent), then project into an explicit time zone. The result depends
// on the zone, which is exactly the drift risk.
const viewedDate = Temporal.Instant.fromEpochMilliseconds(legacyDate.getTime())
  .toZonedDateTimeISO('America/New_York')
  .toPlainDate();

// Compare Plain types with .equals() (or Temporal.PlainDate.compare), not strings.
console.log(viewedDate.equals(birthdate)); // false: the calendar date drifted to 1989-12-31
```

## Strategic Implementation & Best Practices

- **DO** use `Temporal.PlainDate` for full calendar dates, `Temporal.PlainTime` for wall-clock times, `Temporal.PlainDateTime` for local date-time pairs without a zone, `Temporal.PlainMonthDay` for recurring annual dates, and `Temporal.PlainYearMonth` for year-month expirations or billing periods.
- **DO NOT** perform arithmetic directly on `Temporal.PlainMonthDay`; convert it to a `Temporal.PlainDate` first via `.toPlainDate({ year })` because month lengths vary by year.
- **DO** use `.add()` on `Temporal.PlainDate` for recurring calendar intervals, relying on `overflow: 'constrain'` (the default) to clamp month-end dates or `overflow: 'reject'` to throw a `RangeError` on nonexistent dates.
- **DO** specify `calendar` (e.g., `calendar: 'iso8601'`) when constructing `PlainMonthDay` or non-ISO Plain types from objects.
- **DO NOT** use Plain types if you need to represent a specific moment in physical time (an instant). Use `Temporal.Instant` or `Temporal.ZonedDateTime` for logs, event timestamps, or cross-timezone scheduling.
- **DO NOT** construct `Date` objects from hand-built ISO strings (such as `` `${date}T00:00:00Z` ``). Produce a `Date` from the `epochMilliseconds` of a `Temporal.Instant` or `Temporal.ZonedDateTime`, and read one back with `Temporal.Instant.fromEpochMilliseconds(date.getTime())` or `date.toTemporalInstant()`, so the time zone assumption is explicit.
- **DO NOT** use `Intl.DateTimeFormat.prototype.formatToParts()` to extract or compare year, month, or day values. Read `.year`, `.month`, and `.day` directly from a Plain type, and compare with `.equals()`.
- **DO** identify time zones by IANA name (e.g., `America/New_York`) and never by a fixed UTC offset. Offsets change with daylight saving time and legislation, so labels like `"UTC-5"` become wrong for part of the year.
- **DO** remember that `Temporal` objects are **immutable**. Methods like `.add()`, `.subtract()`, or `.with()` always return a new instance with a new reference rather than mutating the original object in place, making them safe to store directly in reactive UI state.

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
