/**
 * The longest project name we store. A name is shown in invite mail, the
 * dashboard and the sandbox title, so a member must not be able to write an
 * essay into it (AB827V0 918: an unbounded name went into invite mail).
 */
export const MAX_PROJECT_NAME_LENGTH = 100

/** A user-chosen project name as stored: whitespace runs collapsed, trimmed,
 *  and cut to `MAX_PROJECT_NAME_LENGTH` code points (never mid-character).
 *  Both rename paths (Convex and the Postgres spine) store this, so they
 *  cannot disagree. */
export function normalizeProjectName(name: string): string {
  const collapsed = name.replace(/\s+/g, ' ').trim()
  const chars = Array.from(collapsed)
  return chars.length > MAX_PROJECT_NAME_LENGTH
    ? chars.slice(0, MAX_PROJECT_NAME_LENGTH).join('').trimEnd()
    : collapsed
}
