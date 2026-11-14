/**
 * Saving a connected credential where the user's app reads it.
 *
 * A sponsored run may not read or write `.env` files (the sandbox and the
 * write policy both refuse it), so a key the user connects reached the run's
 * terminal commands and nothing else: the feature the run built had no key
 * once the run ended. The ORCHESTRATOR writes it instead, as the user, into
 * the project's local env file. The model never sees the value, and the file
 * stays unreadable to the run.
 *
 * Refused, and reported as such, unless every one of these holds:
 * - the file is ignored by the project's own git rules, so a key can never
 *   be committed (a folder that is not a git repository is refused);
 * - the path is a plain file or absent, never a symlink out of the project,
 *   and the write replaces the directory entry instead of opening it, so a
 *   link swapped in after the check is replaced, not followed; a file that
 *   appears where none was is read and kept, never overwritten;
 * - the staging copy is as uncommittable as the target: in git's own
 *   directory, or beside the target only when git ignores that name too;
 * - the value can be written as one dotenv line that reads back unchanged.
 */

import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import {
  chmod,
  link,
  lstat,
  open,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'

export type SponsoredEnvFileOutcome =
  | { saved: true; file: string }
  | {
      saved: false
      reason: 'no_workspace' | 'not_ignored' | 'not_a_file' | 'value' | 'io'
    }

const BARE_VALUE = /^[A-Za-z0-9_\-./+=:@~%,]+$/

/**
 * `NAME=value` as one dotenv line. Single quotes are literal in dotenv and in
 * the `dotenv-expand` Next.js runs, so `$` and `#` survive; a value holding a
 * single quote has no safe spelling and is refused.
 */
export function sponsoredEnvLine(name: string, value: string): string | null {
  if (!value || /[\s\u0000-\u001f\u007f]/.test(value)) return null
  if (BARE_VALUE.test(value)) return `${name}=${value}`
  if (value.includes("'")) return null
  return `${name}='${value}'`
}

/** Replaces each name's existing line, or appends it; every other line is kept. */
export function upsertSponsoredEnvLines(
  text: string,
  lines: Readonly<Record<string, string>>,
): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const rows = text === '' ? [] : text.replace(/\r?\n$/, '').split(/\r?\n/)
  for (const [name, line] of Object.entries(lines)) {
    const own = new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=`)
    const at = rows.findIndex((row) => own.test(row))
    if (at === -1) rows.push(line)
    else {
      // One line per name: a duplicate further down would win in dotenv.
      for (let i = rows.length - 1; i > at; i--)
        if (own.test(rows[i]!)) rows.splice(i, 1)
      rows[at] = line
    }
  }
  return rows.join(eol) + eol
}

/**
 * The env file this project's server reads for local secrets: an existing
 * `.env.local`, else `.env.local` for Next.js and Vite, else `.env`.
 */
export async function sponsoredEnvFileFor(
  workspace: string,
): Promise<'.env.local' | '.env'> {
  if (await entry(join(workspace, '.env.local'))) return '.env.local'
  try {
    const pkg = JSON.parse(
      await readFile(join(workspace, 'package.json'), 'utf8'),
    ) as Record<string, Record<string, unknown> | undefined>
    const deps = { ...pkg.dependencies, ...pkg.devDependencies }
    if ('next' in deps || 'vite' in deps) return '.env.local'
  } catch {
    // No readable package.json: a plain Node project.
  }
  return '.env'
}

/** A regular file's text and mode, null when absent, refused when anything else. */
async function plainFile(
  path: string,
): Promise<{ text: string; mode: number } | null | 'not_a_file'> {
  // Windows has no O_NOFOLLOW, so a link is refused by name first there too.
  const seen = await entry(path)
  if (seen && !seen.isFile()) return 'not_a_file'
  let handle
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? null
      : 'not_a_file'
  }
  try {
    const stat = await handle.stat()
    if (!stat.isFile()) return 'not_a_file'
    return { text: await handle.readFile('utf8'), mode: stat.mode }
  } finally {
    await handle.close()
  }
}

/** lstat, not stat: a symlink is seen as itself, wherever it points. */
const entry = (path: string) => lstat(path).catch(() => null)

export async function saveSponsoredCredentialsToEnvFile(input: {
  workspace: string | undefined
  /** Declared names to validated values. */
  values: Readonly<Record<string, string>>
  /** The project's own git rules: true only when git says the path is ignored. */
  isIgnored: (workspace: string, relative: string) => Promise<boolean>
  /** Git's own directory for this checkout, where nothing can be staged for commit. */
  stagingDir?: (workspace: string) => Promise<string | null>
}): Promise<SponsoredEnvFileOutcome> {
  const { workspace, values } = input
  if (!workspace || !(await entry(workspace))?.isDirectory())
    return { saved: false, reason: 'no_workspace' }
  const lines: Record<string, string> = {}
  for (const [name, value] of Object.entries(values)) {
    const line = sponsoredEnvLine(name, value)
    if (!line) return { saved: false, reason: 'value' }
    lines[name] = line
  }
  if (Object.keys(lines).length === 0) return { saved: false, reason: 'value' }
  try {
    const file = await sponsoredEnvFileFor(workspace)
    const path = join(workspace, file)
    // Twice at most: a file another process creates while this one works is
    // read and kept, never overwritten.
    for (let attempt = 0; attempt < 2; attempt++) {
      // Read through one no-follow handle, before anything else is awaited: a
      // symlink or a directory is refused, and what is read is the file checked.
      const existing = await plainFile(path)
      if (existing === 'not_a_file')
        return { saved: false, reason: 'not_a_file' }
      if (!(await input.isIgnored(workspace, file)))
        return { saved: false, reason: 'not_ignored' }
      // The staging file holds the key in plain text, so it must be as
      // uncommittable as the target: inside git's own directory, or beside
      // the target only when git ignores that name too.
      const name = `${file}.${randomBytes(6).toString('hex')}.tmp`
      const gitDir = await input.stagingDir?.(workspace).catch(() => null)
      const staged =
        gitDir && (await entry(gitDir))?.isDirectory()
          ? join(gitDir, `freebuff-${name}`)
          : (await input.isIgnored(workspace, name))
            ? join(workspace, name)
            : null
      if (!staged) return { saved: false, reason: 'not_ignored' }
      const mode = existing ? existing.mode & 0o777 : 0o600
      try {
        await writeFile(
          staged,
          upsertSponsoredEnvLines(existing?.text ?? '', lines),
          { flag: 'wx', mode },
        )
        // The create mode passes through the umask; this one does not.
        await chmod(staged, mode)
        if (existing) {
          // A rename replaces the directory entry: a symlink swapped in since
          // the check is replaced, not followed, and a hard link elsewhere
          // keeps the old content.
          await rename(staged, path)
          return { saved: true, file }
        }
        // Nothing was there: publish without replacing. A link fails when a
        // file has appeared since the read, and the next attempt reads it.
        try {
          await link(staged, path)
          return { saved: true, file }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        }
      } finally {
        await rm(staged, { force: true }).catch(() => {})
      }
    }
    return { saved: false, reason: 'io' }
  } catch {
    return { saved: false, reason: 'io' }
  }
}

/** Private host check: only the names of connected credentials still saved in the
 * project's ignored env file escape. Never expose contents to the sponsored agent. */
export async function availableSponsoredProjectCredentials(input: {
  workspace: string
  values: Readonly<Record<string, string>>
  isIgnored: (workspace: string, relative: string) => Promise<boolean>
}): Promise<string[]> {
  try {
    const file = await sponsoredEnvFileFor(input.workspace)
    if (!(await input.isIgnored(input.workspace, file))) return []
    const saved = await plainFile(join(input.workspace, file))
    if (!saved || saved === 'not_a_file') return []
    const rows = saved.text.split(/\r?\n/)
    return Object.entries(input.values).flatMap(([name, value]) => {
      const expected = sponsoredEnvLine(name, value)
      const matches = rows.filter((row) =>
        new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=`).test(row),
      )
      return expected && matches.length === 1 && matches[0] === expected
        ? [name]
        : []
    })
  } catch {
    return []
  }
}
