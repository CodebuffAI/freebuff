import { createHmac, randomBytes } from 'node:crypto'
import { lstat, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { entries, regularText, skillResources } from './files'
import { hookValue, markdown, mcpConfig, record, skillValue } from './formats'
import type {
  LocalCandidate,
  SetupImportItem,
  SetupImportKind,
  SetupImportOptions,
  SetupImportResult,
  SetupImportSinks,
  SetupImportSource,
} from './types'
export type * from './types'

const fingerprintKey = randomBytes(32)
const safeName = /^[a-zA-Z0-9][A-Za-z0-9 _.-]{0,80}$/
const unreadable =
  'This file is unreadable, linked, too large, or has an unsupported format.'

type Visit = (item: SetupImportItem, candidate?: LocalCandidate) => void

async function inventory(options: SetupImportOptions, visit: Visit) {
  const home = await realpath(options.home ?? homedir())
  const sources: [SetupImportSource, string][] = [
    [
      'claude',
      options.claudeDir ??
        process.env.CLAUDE_CONFIG_DIR ??
        join(home, '.claude'),
    ],
    [
      'codex',
      options.codexDir ?? process.env.CODEX_HOME ?? join(home, '.codex'),
    ],
    ['cursor', options.cursorDir ?? join(home, '.cursor')],
  ]
  for (const [source, root] of sources) {
    function emit(
      kind: SetupImportKind,
      key: string,
      name: string,
      candidate?: LocalCandidate,
      reason = unreadable,
    ) {
      const id = createHmac('sha256', fingerprintKey)
        .update(JSON.stringify([source, root, kind, key, candidate ?? reason]))
        .digest('hex')
      visit(
        {
          id,
          source,
          kind,
          displayName: safeName.test(name) ? name : 'Unsupported name',
          status: candidate ? 'available' : 'unsupported',
          ...(candidate ? {} : { reason }),
        },
        candidate,
      )
    }
    async function fromFile(
      path: string,
      kind: SetupImportKind,
      name: string,
      read: (text: string) => void | Promise<void>,
      cap = 1_048_576,
    ) {
      try {
        const text = await regularText(path, cap)
        if (text !== undefined) await read(text)
      } catch {
        emit(kind, path, name)
      }
    }
    async function directory(
      dir: string,
      kind: SetupImportKind,
      each: (name: string) => Promise<void>,
    ) {
      try {
        for (const name of await entries(dir)) await each(name)
      } catch {
        emit(kind, dir, 'Unreadable ' + kind + ' folder')
      }
    }

    const skillDir = join(root, 'skills')
    await directory(skillDir, 'skill', async (name) => {
      const folder = join(skillDir, name)
      await fromFile(
        join(folder, 'SKILL.md'),
        'skill',
        name,
        async (text) => {
          const value = skillValue(name, text, await skillResources(folder))
          emit('skill', folder, name, { kind: 'skill', value })
        },
        50_000,
      )
    })
    // Codex also uses the shared ~/.agents/skills location, already migrated once by Desktop.
    if (source === 'codex') {
      const shared = join(home, '.agents', 'skills')
      await directory(shared, 'skill', async (name) => {
        const folder = join(shared, name)
        await fromFile(
          join(folder, 'SKILL.md'),
          'skill',
          name,
          async (text) => {
            emit('skill', folder, name, {
              kind: 'skill',
              value: skillValue(name, text, await skillResources(folder)),
            })
          },
          50_000,
        )
      })
    }
    const commandDir = join(root, source === 'codex' ? 'prompts' : 'commands')
    let commandCount = 0
    async function commandFolder(dir: string, prefix: string): Promise<void> {
      await directory(dir, 'command', async (file) => {
        if (++commandCount > 512 || prefix.length > 48)
          throw new Error('Too many commands')
        const location = join(dir, file)
        if ((await lstat(location)).isDirectory()) {
          await commandFolder(location, prefix + file + '-')
          return
        }
        if (!file.endsWith('.md')) return
        const name = prefix + file.slice(0, -3)
        await fromFile(
          location,
          'command',
          name,
          (text) => {
            emit('command', location, name, {
              kind: 'command',
              value: skillValue(name, text),
            })
          },
          50_000,
        )
      })
    }
    await commandFolder(commandDir, '')
    if (source === 'cursor') {
      const rules = join(root, 'rules')
      await directory(rules, 'instructions', async (file) => {
        if (!file.endsWith('.mdc') && !file.endsWith('.md')) return
        await fromFile(
          join(rules, file),
          'instructions',
          file,
          (text) => {
            const { meta, body } = markdown(text)
            if (
              (meta.globs &&
                (!Array.isArray(meta.globs) || meta.globs.length)) ||
              (file.endsWith('.mdc') && meta.alwaysApply !== true)
            )
              return emit(
                'instructions',
                file,
                file,
                undefined,
                'A conditional rule cannot become account-wide instructions.',
              )
            if (!body.trim() || body.trim().length > 16_000)
              throw new Error('Empty rule')
            emit('instructions', file, file, {
              kind: 'instructions',
              value: body.trim(),
            })
          },
          50_000,
        )
      })
    } else {
      const name = source === 'claude' ? 'CLAUDE.md' : 'AGENTS.md'
      const path = join(root, name)
      await fromFile(
        path,
        'instructions',
        name,
        (text) => {
          if (!text.trim() || text.trim().length > 16_000)
            throw new Error('Empty instructions')
          emit('instructions', path, name, {
            kind: 'instructions',
            value: text.trim(),
          })
        },
        50_000,
      )
    }

    function connectors(value: unknown) {
      if (value === undefined) return
      const servers = Object.entries(record(value))
      if (servers.length > 256) throw new Error('Too many servers')
      for (const [name, server] of servers) {
        try {
          if (!safeName.test(name)) throw new Error('Unsupported name')
          emit('mcp', name, name, {
            kind: 'mcp',
            name,
            value: mcpConfig(server, source),
          })
        } catch {
          emit(
            'mcp',
            name,
            name,
            undefined,
            'This server has settings Freebuff cannot preserve.',
          )
        }
      }
    }
    if (source === 'codex') {
      await fromFile(
        join(root, 'config.toml'),
        'mcp',
        'Codex servers',
        (text) => {
          connectors(record(Bun.TOML.parse(text)).mcp_servers)
        },
      )
    } else {
      const path =
        source === 'claude'
          ? join(home, '.claude.json')
          : join(root, 'mcp.json')
      await fromFile(
        path,
        'mcp',
        'Local servers',
        (text) => connectors(record(JSON.parse(text)).mcpServers),
        4_194_304,
      )
    }
    const hooks = join(
      root,
      source === 'claude' ? 'settings.json' : 'hooks.json',
    )
    await fromFile(hooks, 'hook', 'User hooks', (text) => {
      const config = record(JSON.parse(text))
      if (config.hooks === undefined) return
      for (const [event, groups] of Object.entries(record(config.hooks))) {
        const cursor = source === 'cursor'
        const translated = cursor
          ? (
              {
                preToolUse: 'PreToolUse',
                postToolUse: 'PostToolUse',
              } as Record<string, string>
            )[event]
          : event
        const title =
          translated === 'PreToolUse'
            ? 'Before a tool'
            : translated === 'PostToolUse'
              ? 'After a tool'
              : 'Unsupported hook event'
        if (
          !['PreToolUse', 'PostToolUse'].includes(translated) ||
          !Array.isArray(groups)
        ) {
          emit(
            'hook',
            event,
            title,
            undefined,
            'This hook event or format is unavailable in Freebuff.',
          )
          continue
        }
        for (const [g, entry] of groups.entries()) {
          const key = event + '/' + g
          try {
            const group = record(entry)
            if (
              !cursor &&
              Object.keys(group).some((k) => !['hooks', 'matcher'].includes(k))
            )
              throw new Error('Group options')
            const commands: unknown = cursor ? [entry] : group.hooks
            if (!Array.isArray(commands)) throw new Error('Unrecognized group')
            for (const [index, raw] of commands.entries()) {
              const location = key + '/' + index
              try {
                const value = hookValue(translated, group.matcher, raw, cursor)
                const label =
                  value.matcher && safeName.test(value.matcher)
                    ? title + ' - ' + value.matcher
                    : title
                emit('hook', location, label, { kind: 'hook', value })
              } catch {
                emit(
                  'hook',
                  location,
                  title,
                  undefined,
                  'This hook cannot be imported unchanged.',
                )
              }
            }
          } catch {
            emit('hook', key, title)
          }
        }
      }
    })
  }
}

export async function scanAgentSetup(
  options: SetupImportOptions = {},
): Promise<{ items: SetupImportItem[] }> {
  const items: SetupImportItem[] = []
  await inventory(options, (item) => items.push(item))
  return { items }
}

// A second inventory binds the local payload to the bytes the user selected. Neither a page
// nor a fresh edit can replace a command, connector or instruction between preview and apply.
export async function applyAgentSetup(
  options: SetupImportOptions,
  ids: string[],
  sinks: SetupImportSinks,
): Promise<{ results: SetupImportResult[] }> {
  const selected = new Set(ids)
  const current = new Map<
    string,
    { item: SetupImportItem; candidate?: LocalCandidate }
  >()
  await inventory(options, (item, candidate) => {
    if (selected.has(item.id)) current.set(item.id, { item, candidate })
  })
  const results: SetupImportResult[] = []
  for (const id of selected) {
    const match = current.get(id)
    if (!match) {
      results.push({
        id,
        status: 'stale',
        reason: 'The source changed. Scan again.',
      })
      continue
    }
    if (!match.candidate) {
      results.push({ id, status: 'unsupported', reason: match.item.reason })
      continue
    }
    const candidate = match.candidate
    try {
      let status
      switch (candidate.kind) {
        case 'skill':
        case 'command':
          status = await sinks.skill(candidate.value, match.item)
          break
        case 'instructions':
          status = await sinks.instructions(candidate.value, match.item)
          break
        case 'hook':
          status = await sinks.hook(candidate.value, match.item)
          break
        case 'mcp':
          status = await sinks.mcp(candidate.name, candidate.value, match.item)
          break
      }
      results.push({ id, status })
    } catch {
      // Sink errors can include a source command, token or full file path.
      results.push({
        id,
        status: 'failed',
        reason: 'Could not apply this item.',
      })
    }
  }
  return { results }
}
