/**
 * The two switches that gate turning legacy (vly-era) Convex usage into a
 * permanent pause, as checked-in constants. They used to be rows of the
 * platform-Convex `settings` table (`legacy_usage_enforcement_enabled`,
 * `legacy_usage_pause_enabled`), which is retired; they live here, rather than
 * in freebuff/web, so the Convex crons that read them today
 * (freebuff/web/convex/legacy_usage_enforcement.ts, usage_limits_reconcile.ts,
 * legacy_usage_pause.ts) and their graphile ports in packages/jobs read the
 * same value.
 *
 * Flipping one is a reviewed one-line diff and a deploy — never an env var.
 */

/**
 * Pause owners whose legacy Convex usage exhausts their allowance (the weekly
 * enforcement sweep and the 5-minute reconciler's over-usage path). ON, as
 * the prod `settings` row was at the cut-over (2026-10-06). Capping a
 * long-running app can stop it, and the pause is permanent until an admin
 * lifts it, so turning it off or on must be deliberate.
 */
export const LEGACY_USAGE_ENFORCEMENT_ENABLED: boolean = true

/**
 * The legacy usage pause sweep and the weekly fleet audit from Axiom. ON.
 */
export const LEGACY_USAGE_PAUSE_ENABLED: boolean = true
