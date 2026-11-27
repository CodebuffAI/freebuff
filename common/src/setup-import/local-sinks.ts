import { Database, SQLiteError } from 'bun:sqlite'
import { constants } from 'node:fs'
import { randomUUID } from 'node:crypto'
import {
  chmod,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { HOOKS_LIMIT } from '../desktop-cloud/hooks-host'
import { HOOK_FILE_BYTES } from '../desktop-cloud/hooks'
import { regularText } from './files'
import { mcpConfig, record } from './formats'
import {
  interpolateImportedMcp,
  listMcpVariables,
  resolveImportedMcp,
  sameImportedMcp,
  sealImportedMcp,
} from './mcp-secrets'
import type {
  SetupImportHook,
  SetupImportMcp,
  SetupImportOutcome,
} from './types'

/** Coordinates mutations of setup files, including Hooks Settings and Setup Import. */
export async function withSetupImportLock<T>(
  parent: string, update: () => Promise<T>,
): Promise<{ status: 'locked'; value: T } | { status: 'conflict' | 'failed' }> {
  await mkdir(parent, { recursive: true, mode: 0o700 })
  if ((await realpath(parent)) !== resolve(parent)) return { status: 'failed' }
  // SQLite holds an OS lock which is released if the importer is killed between commits.
  // No configuration or credentials are written to this private coordination file.
  const lockPath = join(parent, '.setup-import.lock')
  const handle = await open(
    lockPath,
    constants.O_CREAT | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0),
    0o600,
  )
  let regular = false
  try {
    regular = (await handle.stat()).isFile()
  } finally {
    await handle.close()
  }
  if (!regular) return { status: 'failed' }
  const lock = new Database(lockPath)
  try {
    lock.exec('BEGIN IMMEDIATE')
  } catch (error) {
    lock.close()
    if (error instanceof SQLiteError && error.code === 'SQLITE_BUSY')
      return { status: 'conflict' }
    throw error
  }
  try {
    return { status: 'locked', value: await update() }
  } finally {
    lock.close()
  }
}

// Detect edits made by other applications before replacing the file. Commit one item at a time
// so the result for each selection matches its actual state.
async function updateLocalFile(
  path: string,
  cap: number,
  edit: (document: Record<string, unknown>) => Promise<SetupImportOutcome>,
) {
  const result = await withSetupImportLock<SetupImportOutcome>(dirname(path), async () => {
    const temporary = path + '.' + randomUUID() + '.tmp'
    try {
      const original = await regularText(path, cap)
      const mode =
        original === undefined ? 0o600 : (await lstat(path)).mode & 0o600
      const doc = original === undefined ? {} : record(JSON.parse(original))
      const result = await edit(doc)
      if (result !== 'imported') return result
      const updated = JSON.stringify(doc, null, 2) + '\n'
      if (Buffer.byteLength(updated) > cap) return 'failed'
      await writeFile(temporary, updated, { mode, flag: 'wx' })
      await chmod(temporary, mode)
      if ((await regularText(path, cap)) !== original) return 'conflict'
      await rename(temporary, path)
      return 'imported'
    } finally {
      await unlink(temporary).catch(() => {})
    }
  })
  return result.status === 'locked' ? result.value : result.status
}

export async function importHookOff(
  home: string,
  hook: SetupImportHook,
): Promise<SetupImportOutcome> {
  return updateLocalFile(
    join(home, '.agents', 'hooks.json'),
    HOOK_FILE_BYTES,
    async (doc) => {
      const events = record(doc.hooks ?? {})
      let count = 0
      for (const [event, groups] of Object.entries(events)) {
        if (!Array.isArray(groups)) return 'failed'
        for (const raw of groups) {
          const group = record(raw)
          if (!Array.isArray(group.hooks)) return 'failed'
          for (const entry of group.hooks) {
            count++
            const item = record(entry)
            if (
              event === hook.event &&
              (group.matcher ?? '') === hook.matcher &&
              item.type === 'command' &&
              item.command === hook.command &&
              (item.timeout ?? null) === (hook.timeout ?? null)
            )
              return 'unchanged'
          }
        }
      }
      if (count >= HOOKS_LIMIT) return 'failed'
      const existing = events[hook.event]
      const group = {
        matcher: hook.matcher,
        hooks: [
          {
            type: 'command',
            command: hook.command,
            ...(hook.timeout === undefined ? {} : { timeout: hook.timeout }),
            freebuffImportId: randomUUID(),
          },
        ],
      }
      events[hook.event] = [...(Array.isArray(existing) ? existing : []), group]
      doc.hooks = events
      return 'imported'
    },
  )
}

/**
 * `~/.agents/<this>`: imported MCP servers the CLI must not start. Desktop keeps its own on/off
 * state, but the CLI starts every server in `mcp.json`, so an import lists the new name here
 * first and the CLI skips it (local-agent-registry.ts) until the user takes it off the list.
 */
export const IMPORTED_MCP_OFF_FILE = 'mcp-imported-off.json'

/** Names in the off list; a missing or unreadable file lists none. */
export async function importedMcpOff(home: string): Promise<string[]> {
  try {
    const raw = await regularText(join(home, '.agents', IMPORTED_MCP_OFF_FILE), 65_536)
    const names = raw === undefined ? [] : record(JSON.parse(raw)).servers
    return Array.isArray(names) ? names.filter((n): n is string => typeof n === 'string') : []
  } catch {
    return []
  }
}

async function setImportedMcpOff(home: string, name: string, off: boolean) {
  return updateLocalFile(join(home, '.agents', IMPORTED_MCP_OFF_FILE), 65_536, async (doc) => {
    const names = Array.isArray(doc.servers) ? doc.servers.filter((n) => typeof n === 'string') : []
    if (names.includes(name) === off) return 'unchanged'
    doc.servers = off ? [...names, name] : names.filter((n) => n !== name)
    return 'imported'
  })
}

export async function importLocalMcp(
  home: string,
  name: string,
  config: SetupImportMcp,
  prompt: (name: string) => Promise<string | null>,
): Promise<SetupImportOutcome> {
  // A name already in mcp.json is the user's own server: the import never replaces it, and it
  // must not be switched off. A new one goes on the off list before it can be written.
  let existing: unknown
  try {
    const raw = await regularText(join(home, '.agents', 'mcp.json'), 1_048_576)
    existing = raw === undefined ? undefined : record(record(JSON.parse(raw)).mcpServers ?? {})[name]
  } catch {
    return 'failed'
  }
  const listed = existing === undefined
  if (listed) {
    const off = await setImportedMcpOff(home, name, true)
    if (off !== 'imported' && off !== 'unchanged') return 'failed'
  }
  const result = await writeLocalMcp(home, name, config, prompt)
  if (listed && result !== 'imported') await setImportedMcpOff(home, name, false).catch(() => {})
  return result
}

async function writeLocalMcp(
  home: string,
  name: string,
  config: SetupImportMcp,
  prompt: (name: string) => Promise<string | null>,
): Promise<SetupImportOutcome> {
  let discard: (() => Promise<void>) | undefined
  try {
    const result = await updateLocalFile(
      join(home, '.agents', 'mcp.json'),
      1_048_576,
      async (doc) => {
        const servers = record(doc.mcpServers ?? {})
        if (Object.hasOwn(servers, name)) {
          let old: SetupImportMcp
          try {
            old = await resolveImportedMcp(
              name,
              mcpConfig(servers[name], 'claude'),
            )
          } catch {
            return 'conflict'
          }
          if (sameImportedMcp(old, config)) return 'unchanged'
          // References need the user's answer to compare. Never overwrite an existing server.
          const variableNames = listMcpVariables(config)
          if (!variableNames.length) return 'conflict'
          const answers = new Map<string, string>()
          for (const key of variableNames) {
            const value = await prompt(key)
            if (value === null) return 'declined'
            answers.set(key, value)
          }
          const candidate = interpolateImportedMcp(config, answers)
          return sameImportedMcp(old, candidate) ? 'unchanged' : 'conflict'
        }
        const sealed = await sealImportedMcp(name, config, prompt)
        if (!sealed) return 'declined'
        discard = sealed.discard
        doc.mcpServers = { ...servers, [name]: sealed.config }
        return 'imported'
      },
    )
    if (result === 'imported') discard = undefined
    return result
  } finally {
    if (discard) await discard()
  }
}
