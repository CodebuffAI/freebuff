/**
 * The `relevancy` we send Gravity on every ad request.
 *
 * Gravity reads it as a minimum match threshold (0-1), not as a signal from
 * us: an ad scoring below it is not returned. Higher means fewer, closer
 * matches (`@gravity-ai/api` README: "Lower = more ads"; SDK default 0.2).
 * It was 0 (take everything) until 2026-11; 0.1 trades a little fill for
 * fewer weak matches. Judge a change by Gravity clicks per request, not CTR
 * alone, since a no-fill hands the slot to first-party inventory.
 */
export const GRAVITY_RELEVANCY_THRESHOLD = 0.1
