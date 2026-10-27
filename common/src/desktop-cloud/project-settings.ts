import { z } from 'zod/v4'

export const CLOUD_SKILL_MAX_RESOURCE_FILES = 100

/**
 * What a skill may be called. Narrow on purpose: a name holds no user prose, so
 * a refusal may quote it back (see `invalidSkillsRefusal`) and a file written
 * under it cannot escape its directory.
 */
export const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/

export const cloudSkillSchema = z
  .object({
    name: z.string().regex(SKILL_NAME_PATTERN),
    description: z.string().trim().min(1).max(1000),
    instructions: z.string().trim().min(1).max(50000),
    enabled: z.boolean().optional(),
    files: z
      .array(
        z
          .object({
            path: z
              .string()
              .max(256)
              .refine(
                (path) =>
                  !!path &&
                  !path.startsWith('/') &&
                  !path.includes('\\') &&
                  path.toLowerCase() !== 'skill.md' &&
                  !/[<>:"|?*]/.test(path) &&
                  path
                    .split('/')
                    .every((part) => !!part && part !== '.' && part !== '..') &&
                  !/[\x00-\x1f]/.test(path),
                'Invalid skill resource path',
              ),
            contents: z.string().max(100000),
          })
          .strict(),
      )
      .max(
        CLOUD_SKILL_MAX_RESOURCE_FILES,
        `A skill can include at most ${CLOUD_SKILL_MAX_RESOURCE_FILES} supporting files.`,
      )
      .refine(
        (files) =>
          files.every((file, i) =>
            files.every(
              (other, j) =>
                i === j ||
                (file.path.toLowerCase() !== other.path.toLowerCase() &&
                  !file.path
                    .toLowerCase()
                    .startsWith(`${other.path.toLowerCase()}/`)),
            ),
          ),
        'Skill resources must have distinct file paths',
      )
      .optional(),
  })
  .strict()
export const cloudProjectSettingsSchema = z
  .object({
    startupScript: z.string().max(16000).default(''),
    skills: z.array(cloudSkillSchema).max(50).default([]),
  })
  .strict()
  .refine(
    (value) =>
      new TextEncoder().encode(JSON.stringify(value)).length <= 2_500_000,
    'Cloud project skills must total less than 2.5 MB',
  )
  .refine(
    (value) =>
      new Set(value.skills.map((s) => s.name)).size === value.skills.length,
    'Skill names must be unique',
  )
export type CloudProjectSettings = z.infer<typeof cloudProjectSettingsSchema>
export type CloudProjectSettingsSnapshot = {
  revision: number
  settings: CloudProjectSettings
}
export const cloudProjectSettingsUpdateSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    settings: cloudProjectSettingsSchema,
  })
  .strict()

/** Account-wide managed skills; startup scripts remain project scoped. */
export const accountSkillsSchema = z
  .object({ skills: z.array(cloudSkillSchema).max(50) })
  .strict()
  .refine(
    (value) =>
      new Set(value.skills.map((s) => s.name)).size === value.skills.length,
    'Skill names must be unique',
  )
  .refine(
    (value) =>
      new TextEncoder().encode(JSON.stringify(value)).length <= 2_500_000,
    'Skills must total less than 2.5 MB',
  )
export const accountSkillsUpdateSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    settings: accountSkillsSchema,
  })
  .strict()
export type AccountSkillsSnapshot = {
  revision: number
  settings: z.infer<typeof accountSkillsSchema>
}

/**
 * What `jsonb` refuses, which is not what `JSON.stringify` refuses.
 *
 * Both settings writes land as `${JSON.stringify(settings)}::jsonb`, and
 * Postgres rejects two things at that cast that are legal in a JS string and in
 * JSON text. `\u0000`, because a `jsonb` string is `text` and `text` has no NUL:
 * `unsupported Unicode escape sequence`, DETAIL `\u0000 cannot be converted to
 * text.`. And an unpaired surrogate, because well-formed `JSON.stringify`
 * (ES2019) emits it as a `\uD800`-style escape that `jsonb`'s lexer will not
 * decode: `invalid input syntax for type json`.
 *
 * Nothing above catches either — `description`, `instructions` and a resource
 * file's `contents` are bounded strings and nothing else — so a skill carrying
 * one reached the cast and came back as a 500, which the Desktop client
 * rendered as nothing at all. Over 2026-10-14..16 that was 243 `Cloud request
 * failed` rows on `route=skills`, every one of them a PUT and none a GET; the
 * one stable digest among them, `2418b4285e20`, is
 * `sha256('Error: Failed query: <the account-skills UPDATE>\nl: unsupported
 * Unicode escape sequence')`, i.e. exactly this cast refusing exactly this
 * character. (The rest of that count is the same fault under two older
 * spellings of the log: the digest did not exist before #7021 and still carried
 * drizzle's bound parameters before #7169, which gave one id per payload.)
 *
 * It sticks, which is the half users report: a save sends the whole library, so
 * one poisoned skill fails every later save of that library — including the
 * save that only deletes a *different* skill, which is why a deleted skill
 * "comes back". A reload never fails, because the stored row is the last one
 * that was clean.
 *
 * Refused rather than stripped. The text is the author's, and quietly editing
 * it would store a skill they did not write.
 */
const JSONB_UNSTORABLE =
  /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

/**
 * Where the first character no settings column can hold sits, so the refusal
 * can tell its author what to edit rather than just that something is wrong.
 */
export function firstUnstorableChar(text: string) {
  const match = JSONB_UNSTORABLE.exec(text)
  if (!match) return undefined
  const code = match[0].charCodeAt(0)
  return {
    index: match.index,
    kind: code === 0 ? ('nul' as const) : ('surrogate' as const),
    label: `U+${code.toString(16).toUpperCase().padStart(4, '0')}`,
  }
}

function unstorableDescription(
  found: NonNullable<ReturnType<typeof firstUnstorableChar>>,
) {
  const what =
    found.kind === 'nul' ? 'a NUL character' : 'an unpaired surrogate'
  return `${what} (${found.label}) at position ${found.index}`
}

/**
 * The refusal for the first skill field `jsonb` will not take, naming the
 * skill, the field and the offset — or `undefined` when the library is
 * storable.
 *
 * Phrased for whoever pressed Save. Echoing the skill name back is safe:
 * `cloudSkillSchema` holds it to `[a-z0-9-]`, and this message is answered to
 * the account that sent it and is never logged (the Cloud route answers a
 * `CloudError` without a log line, unlike the catch-all below it).
 */
export function unstorableSkillsRefusal(
  skills: readonly z.infer<typeof cloudSkillSchema>[],
): string | undefined {
  for (const skill of skills) {
    for (const [field, value, verb] of [
      ['description', skill.description, 'contains'],
      ['instructions', skill.instructions, 'contain'],
    ] as const) {
      const found = firstUnstorableChar(value)
      if (found)
        return `Skill "${skill.name}" cannot be saved: its ${field} ${verb} ${unstorableDescription(found)}. Remove it and save again.`
    }
    for (const file of skill.files ?? []) {
      // The path first: a path this says nothing about is one the author cannot
      // find, and `cloudSkillSchema` only bars C0 control characters there.
      const inPath = firstUnstorableChar(file.path)
      if (inPath)
        return `Skill "${skill.name}" cannot be saved: a file path contains ${unstorableDescription(inPath)}. Rename the file and save again.`
      const found = firstUnstorableChar(file.contents)
      if (found)
        return `Skill "${skill.name}" cannot be saved: its file "${file.path}" contains ${unstorableDescription(found)}. Remove it and save again.`
    }
  }
  return undefined
}

/** As above, for a project's settings, whose startup script is stored the same way. */
export function unstorableProjectSettingsRefusal(
  settings: CloudProjectSettings,
): string | undefined {
  const found = firstUnstorableChar(settings.startupScript)
  if (found)
    return `The startup script cannot be saved: it contains ${unstorableDescription(found)}. Remove it and save again.`
  return unstorableSkillsRefusal(settings.skills)
}

/**
 * The 400 for a skills payload the schema refuses, naming where it was refused.
 *
 * The Cloud skills route answered every schema failure with the bare string
 * `'Invalid skills'`, which names nothing: a save of a whole library can be
 * refused for one field of one skill, and neither its author nor support could
 * tell which. That is the same gap `unstorableSkillsRefusal` above closed for
 * the characters `jsonb` cannot hold, for the step before it.
 *
 * What goes in the sentence is the failing issue's `path` and `code`, never any
 * value from the payload. zod's own `message` is deliberately not used: for
 * `unrecognized_keys` it quotes the client's key names, and a refusal that
 * echoes user-authored text back is the thing this must not become. The skill
 * name is the one exception, and only when the payload's own name still matches
 * `SKILL_NAME_PATTERN` — i.e. lowercase letters, digits and dashes — which is
 * also why naming it is safe. A `CloudError` is answered to the account that
 * sent it and is not logged, so nothing here reaches Axiom either way.
 *
 * zod v4 reports a failed union (the skills upload is one: a plain update or a
 * base64-encoded one) as a single `invalid_union` issue at the union's own path
 * whose `errors` hold each branch's issues, already carrying their full paths.
 * The branch reported is the one that complained least, i.e. the upload the
 * client was closest to sending; within it, the deepest path is the field the
 * payload got furthest into.
 */
export function invalidSkillsRefusal(
  error: { readonly issues: readonly unknown[] },
  payload?: unknown,
): string {
  const issue = reportableIssue(error.issues)
  if (!issue)
    return 'Invalid skills: the request body is not a skills update. Please report this if it keeps happening.'
  // `custom` is one of our own `.refine()` messages ("Skill names must be
  // unique"), which says more than the code and contains nothing of the
  // payload; every other code is reported as the code alone.
  const because =
    issue.code === 'custom' && issue.message
      ? ` (${issue.message})`
      : issue.code
        ? ` (${issue.code})`
        : ''
  const [first, second, index, ...rest] = issue.path
  if (
    first === 'settings' &&
    second === 'skills' &&
    typeof index === 'number'
  ) {
    const name = skillNameAt(payload, index)
    const subject = name ? `Skill "${name}"` : `The skill at index ${index}`
    const field = renderIssuePath(rest)
    return field
      ? `${subject} cannot be saved: field "${field}" was rejected${because}. Fix it and save again.`
      : `${subject} cannot be saved: the skill itself was rejected${because}. Fix it and save again.`
  }
  const field = renderIssuePath(issue.path)
  return field
    ? `Invalid skills: field "${field}" was rejected${because}. Fix it and save again.`
    : `Invalid skills: the request body was rejected${because}. Please report this if it keeps happening.`
}

type RefusalIssue = {
  code: string | undefined
  message: string | undefined
  path: readonly PropertyKey[]
}

/**
 * The one issue worth reporting out of a list: the deepest path, since that is
 * the field the payload got furthest into, with a union replaced by the issue
 * of the branch it came closest to matching.
 */
function reportableIssue(issues: readonly unknown[]): RefusalIssue | undefined {
  let best: RefusalIssue | undefined
  for (const value of issues) {
    if (!value || typeof value !== 'object') continue
    const issue = value as {
      code?: unknown
      message?: unknown
      path?: unknown
      errors?: unknown
    }
    const candidate = Array.isArray(issue.errors)
      ? closestBranchIssue(issue.errors)
      : Array.isArray(issue.path)
        ? {
            code: typeof issue.code === 'string' ? issue.code : undefined,
            message:
              typeof issue.message === 'string' ? issue.message : undefined,
            path: issue.path as readonly PropertyKey[],
          }
        : undefined
    if (candidate && (!best || candidate.path.length > best.path.length))
      best = candidate
  }
  return best
}

/**
 * The branch that complained least, which is the one the payload was closest
 * to being. Without this an encoding fault in the base64 upload would be
 * reported as the missing `revision` of the plain upload it is not.
 */
function closestBranchIssue(branches: readonly unknown[]) {
  let closest: readonly unknown[] | undefined
  for (const branch of branches)
    if (Array.isArray(branch) && (!closest || branch.length < closest.length))
      closest = branch
  return closest ? reportableIssue(closest) : undefined
}

/**
 * `files[2].contents` for a path of schema keys and array indices. Every key
 * here comes from the schema, not from the payload: an issue's path points at
 * the offending value, and for an unrecognized key at the object holding it.
 */
function renderIssuePath(path: readonly PropertyKey[]): string {
  return path.reduce<string>(
    (rendered, key) =>
      typeof key === 'number'
        ? `${rendered}[${key}]`
        : rendered
          ? `${rendered}.${String(key)}`
          : String(key),
    '',
  )
}

/** The payload's own name for a skill, only when it is still a legal one. */
function skillNameAt(payload: unknown, index: number): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined
  const settings = (payload as { settings?: unknown }).settings
  if (!settings || typeof settings !== 'object') return undefined
  const skills = (settings as { skills?: unknown }).skills
  if (!Array.isArray(skills)) return undefined
  const skill = skills[index]
  if (!skill || typeof skill !== 'object') return undefined
  const name = (skill as { name?: unknown }).name
  return typeof name === 'string' && SKILL_NAME_PATTERN.test(name)
    ? name
    : undefined
}
