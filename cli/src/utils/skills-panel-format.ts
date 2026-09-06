import type { SkillDefinition } from '@codebuff/common/types/skill'

/**
 * Panel display helpers, kept renderer-free so they are unit-testable —
 * the same split as skills-panel-actions.ts.
 */

/**
 * Rough context cost of a skill, in tokens (~4 chars/token). Matches the
 * order of magnitude of Claude Code's per-row estimates; the point is the
 * relative weight, not an exact count.
 */
export function estimateTokens(skill: SkillDefinition): number {
  const chars = skill.content.length + skill.description.length
  return Math.max(1, Math.round(chars / 4))
}

/** Compact right-aligned token readout: 1–3 digits, then `k` past 999. */
export function renderTokens(tokens: number): string {
  const short = tokens > 999 ? `${Math.round(tokens / 100) / 10}k` : `${tokens}`
  return `${short} tok`
}

/**
 * Case-insensitive substring match against name + description. Shared by the
 * panel and its tests so the filter semantics have exactly one definition.
 */
export function matchesSkillQuery(skill: SkillDefinition, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return (
    skill.name.toLowerCase().includes(q) ||
    skill.description.toLowerCase().includes(q)
  )
}
