/**
 * Which store owns the UI preset library (Convex `ui_preset`; Postgres
 * `ui_preset`, migration 0342): the checked-in switch for moving it off
 * platform Convex (COD-742 Wave A2, light tier; runbook in
 * docs/convex-retirement-wave-a.md, "UI presets").
 *
 * - `convex`   (default): Convex is the writer and the reader, exactly as
 *              before the port. The registry entries answer
 *              `unknown_function`, and the library page subscribes to Convex.
 * - `postgres` the library page lists, creates, edits and deletes presets
 *              through the function registry, over Postgres. The Convex
 *              functions stay deployed as the rollback.
 *
 * Light tier: no shadow mode. A flip is a reviewed one-line diff here, never
 * an env var; the revert is the same diff while the Convex functions exist.
 */
export type UiPresetsBackend = 'convex' | 'postgres'

export const UI_PRESETS_BACKEND: UiPresetsBackend = 'convex'

/** Whether `backend` serves the UI preset library from Postgres. */
export function uiPresetsOnPostgres(
  backend: UiPresetsBackend = UI_PRESETS_BACKEND,
): boolean {
  return backend === 'postgres'
}
