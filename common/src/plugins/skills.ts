import { readdirSync, statSync } from 'node:fs'
import path from 'node:path'

import { SKILL_FILE_NAME, SKILLS_DIR_NAME } from '../constants/skills'

import { resolvesWithinRoot } from './containment'

import type { SkillsMap } from '../types/skill'
import type { PluginReport } from './report'

/**
 * Loads the skills component of one plugin (spec §7.1) under the containment
 * rule of §4.1.1: the component's fixed location and every discovered
 * `SKILL.md` must resolve within the filesystem-resolved plugin root.
 *
 * The reading itself is delegated to `readSkillsDir` — the SDK's `loadSkills`
 * in production — so what makes a skill valid is decided in exactly one place.
 * This walk contributes only what the reader cannot: §4.1.1 containment, and
 * the reports for what it refuses. A location the reader finds silent
 * (absent, wrong kind, one refused document) stays silent here too; recording
 * those is a deferred duty (§7.1 SHOULD report), not this walk's.
 *
 * Spec: github.com/agentplugins/agent-plugins-spec/blob/main/spec/1.0.0.md
 */

/**
 * Either the skills the reader accepted with any §4.1.1 reports, or the
 * component type invalidated by an escaping location (§6.2). The plugin
 * itself stays loadable in both branches, so there is no fatal branch here.
 */
export type LoadSkillsResult =
  | { ok: true; skills: SkillsMap; reports: PluginReport[] }
  | { ok: false; reason: string; reports: PluginReport[] }

/**
 * Loads `<root>/skills` through `readSkillsDir`, refusing what §4.1.1
 * forbids: a component location resolving outside the root invalidates the
 * component type (§6.2), and a discovered `SKILL.md` resolving outside the
 * root skips that one skill (§7.1) while its siblings load.
 *
 * A refused skill is excluded from the reader's answer by directory name,
 * which is the key the reader itself uses: it pins a skill's name to its
 * directory, so a document whose name disagrees is refused by the reader
 * before it ever reaches this walk.
 */
export function loadPluginSkills(
  root: string,
  readSkillsDir: (skillsDir: string) => SkillsMap,
): LoadSkillsResult {
  const skillsDir = path.join(root, SKILLS_DIR_NAME)

  const location = resolveComponentLocation(root, skillsDir)
  if (!location.ok) {
    return { ok: false, reason: location.reason, reports: [location.report] }
  }

  const escaping = discoverSkillCandidates(location.skillsDir).filter(
    (candidate) => !resolvesWithin(root, candidate.skillFile),
  )

  const skills = readSkillsDir(location.skillsDir)
  const skipped = new Set(escaping.map(({ dir }) => path.basename(dir)))
  const surviving = Object.fromEntries(
    Object.entries(skills).filter(([name]) => !skipped.has(name)),
  )

  return {
    ok: true,
    skills: surviving,
    reports: escaping.map(({ dir }) => ({
      severity: 'warning',
      section: '§4.1.1',
      message: `skipped skill "${path.basename(dir)}": SKILL.md resolves outside the plugin root`,
    })),
  }
}

/**
 * The component location's §4.1.1 status: usable when it is absent (§6.2 —
 * a plugin may ship no skills, and the reader answers the absence with an
 * empty set) or present within the root, invalid when it escapes.
 */
function resolveComponentLocation(
  root: string,
  skillsDir: string,
):
  | { ok: true; skillsDir: string }
  | { ok: false; reason: string; report: PluginReport } {
  try {
    if (resolvesWithinRoot(root, skillsDir)) return { ok: true, skillsDir }
  } catch {
    return { ok: true, skillsDir }
  }
  return {
    ok: false,
    reason: 'skills/ resolves outside the plugin root (§4.1.1)',
    report: {
      severity: 'error',
      section: '§4.1.1',
      message: 'the skills directory resolves outside the plugin root',
    },
  }
}

/**
 * The `<skillsDir>/*` entries the reader would treat as skill candidates —
 * a directory holding a `SKILL.md` — as containment targets. Discovery here
 * never decides validity; a document the reader would refuse simply never
 * becomes a target, and an unreadable location yields none.
 */
function discoverSkillCandidates(
  skillsDir: string,
): { dir: string; skillFile: string }[] {
  let entries: string[]
  try {
    entries = readdirSync(skillsDir)
  } catch {
    return []
  }

  const candidates: { dir: string; skillFile: string }[] = []
  for (const entry of entries) {
    const dir = path.join(skillsDir, entry)
    const skillFile = path.join(dir, SKILL_FILE_NAME)
    try {
      // stat (not readdir's dirent) matches the reader: it follows reparse
      // points, so a linked skill directory is a candidate like any other.
      if (!statSync(dir).isDirectory()) continue
      statSync(skillFile)
    } catch {
      continue
    }
    candidates.push({ dir, skillFile })
  }
  return candidates
}

/**
 * §4.1.1 for one discovered file: inside the root, or not provably so (a
 * path that resolves nowhere cannot be shown to stay inside).
 */
function resolvesWithin(root: string, file: string): boolean {
  try {
    return resolvesWithinRoot(root, file)
  } catch {
    return false
  }
}
