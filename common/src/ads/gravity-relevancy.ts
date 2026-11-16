/**
 * The `relevancy` we send Gravity on every ad request.
 *
 * Gravity reads it as a minimum match threshold (0-1), not as a signal from
 * us: an ad scoring below it is not returned. Higher means fewer, closer
 * matches (`@gravity-ai/api` README: "Lower = more ads"; SDK default 0.2).
 *
 * History: 0 (take everything) until 2026-11-15; 0.1 from then (#11018) left
 * Gravity fill flat (55.4% -> 55.6%) and clicks flat once one 320-click
 * account was excluded, so 0.1 was below nearly every ad's score. 0.2 (the
 * SDK default, #11034, from 2026-11-15 18:07 PT) also left attempt-level fill
 * flat (80.2% -> 80.4%) and clicks per request within noise, so it was not
 * filtering either. 0.35 is the next step to find where the threshold bites.
 * Judge a change by Gravity fill and clicks per request, not CTR alone, since
 * a no-fill hands the slot to first-party inventory.
 */
export const GRAVITY_RELEVANCY_THRESHOLD = 0.35
