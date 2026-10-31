import {
  createSkillDefinition,
  SkillFrontmatterSchema,
  type SkillDefinition,
} from '../types/skill'
import matter from 'gray-matter'
import { parse as parseYaml } from 'yaml'

/**
 * Parse and validate one SKILL.md document without touching disk.
 *
 * This lives in `common`, not in the SDK where it was born, because callers
 * that only need to READ a skill document must not be forced to load the SDK
 * barrel with it. That barrel pulls in tree-sitter, whose `.wasm` is resolved
 * from disk at import time — fine in the CLI, fatal in a Convex action, where
 * it fails with "tree-sitter.wasm not found (looked at scriptDir=/var/task/…)"
 * before any skill code runs. Observed in a real Convex deployment on
 * 2026-08-18, not predicted: the same import succeeds under Bun locally,
 * because there the wasm is sitting in node_modules where the resolver expects.
 *
 * The SDK re-exports this, so `parseSkillFileContent` remains one function with
 * one implementation. That matters more than where it lives: the writer in
 * Freebuff Cloud validates a draft by running the READER over it, and a second
 * copy would make that check a lookalike instead of the real thing.
 */
export function parseSkillFileContent(
  content: string,
  options: { directoryName: string; filePath: string; verbose?: boolean },
): SkillDefinition | null {
  const { directoryName, filePath, verbose = false } = options

  const parsed = parseFrontmatter(content)
  if (!parsed) {
    if (verbose) {
      console.error(`Invalid frontmatter in skill file: ${filePath}`)
    }
    return null
  }

  const result = SkillFrontmatterSchema.safeParse(parsed.frontmatter)
  if (!result.success) {
    if (verbose) {
      console.error(
        `Invalid skill frontmatter in ${filePath}: ${result.error.message}`,
      )
    }
    return null
  }

  const frontmatter = result.data

  // The name has to match the directory, or the loader cannot address the
  // skill: it finds skills BY directory and keys them by frontmatter name.
  if (frontmatter.name !== directoryName) {
    if (verbose) {
      console.error(
        `Skill name '${frontmatter.name}' does not match directory name '${directoryName}' in ${filePath}`,
      )
    }
    return null
  }

  return createSkillDefinition({ frontmatter, content, filePath })
}

/**
 * Read one SKILL.md with no directory to hold its name to, saying which part
 * failed: an uploaded file has no directory, so its frontmatter is what names
 * it. The same frontmatter parser and schema as `parseSkillFileContent`, so an
 * upload this accepts is one the loader would accept under that name.
 */
export function readSkillDocument(
  content: string,
  filePath: string,
):
  | { skill: SkillDefinition; body: string }
  | { problem: 'frontmatter' | 'name' | 'description' } {
  const parsed = parseFrontmatter(content)
  if (!parsed) return { problem: 'frontmatter' }
  const result = SkillFrontmatterSchema.safeParse(parsed.frontmatter)
  if (!result.success)
    return {
      problem: result.error.issues.some((issue) => issue.path[0] === 'name')
        ? 'name'
        : 'description',
    }
  return {
    skill: createSkillDefinition({
      frontmatter: result.data,
      content,
      filePath,
    }),
    body: parsed.body,
  }
}

/**
 * The opening delimiter with nothing after it. gray-matter reads any text after
 * the first `---` as the frontmatter language, and `---js` selects its
 * JavaScript engine, which `eval()`s the block. SKILL.md files come from repos
 * and registries we do not control, and this parser runs in platform Convex,
 * the Cloud runner and `web` as well as on users' machines, so a language
 * suffix is refused outright rather than parsed.
 */
const PLAIN_FRONTMATTER_OPENER = /^\uFEFF?---[ \t]*\r?\n/

const refuseEngine = (): never => {
  throw new Error('SKILL.md frontmatter must be YAML')
}

// Passing options also keeps gray-matter from caching every parsed document
// in its module-level cache, which it does only when called without options.
const MATTER_OPTIONS = {
  language: 'yaml',
  engines: {
    javascript: refuseEngine,
    coffee: refuseEngine,
    // gray-matter's own YAML engine is js-yaml 3, whose merge-key handling
    // can pollute Object.prototype, and a skill's frontmatter is
    // user-controlled (AB827V0 #288). `yaml` parses YAML 1.2 with merge keys
    // off by default.
    yaml: (source: string) => parseYaml(source) as object,
  },
}

/**
 * YAML frontmatter between `---` markers at the very top, or `null`.
 *
 * Empty frontmatter is `null` rather than an empty object: a SKILL.md with no
 * `name` cannot be addressed, so there is nothing for a caller to do with it.
 */
function parseFrontmatter(content: string): {
  frontmatter: Record<string, unknown>
  body: string
} | null {
  if (!PLAIN_FRONTMATTER_OPENER.test(content)) return null
  try {
    const parsed = matter(content, MATTER_OPTIONS)
    if (!parsed.data || Object.keys(parsed.data).length === 0) {
      return null
    }
    return {
      frontmatter: parsed.data as Record<string, unknown>,
      body: parsed.content,
    }
  } catch {
    return null
  }
}
