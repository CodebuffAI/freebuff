import { createHash } from 'node:crypto'
import { createInterface } from 'node:readline/promises'
import { Writable } from 'node:stream'
import { stdin, stdout } from 'node:process'
import { homedir } from 'node:os'
import { realpath } from 'node:fs/promises'
import {
  applyAgentSetup,
  scanAgentSetup,
  type CloudSkill,
  type SetupImportItem,
  type SetupImportResult,
  type SetupImportSinks,
} from '@codebuff/common/setup-import'
import {
  importHookOff,
  importLocalMcp,
} from '@codebuff/common/setup-import/local-sinks'
import { accountSkillsUpdateSchema } from '@codebuff/common/desktop-cloud/project-settings'
import {
  ACCOUNT_SKILLS_STATE_PATH,
  encodeAccountSkillsUpload,
} from '@codebuff/common/desktop-cloud/skills-transfer'
import { freebuffApiBaseUrl } from '../utils/freebuff-session-api'
import { getAuthToken, loadStoredAuthToken } from '../utils/auth'
import { withSuspendedRenderer } from '../utils/renderer-cleanup'
import { getSystemMessage } from '../utils/message-history'
import type { RouterParams } from './command-registry'

const sourceNames = { claude: 'Claude Code', codex: 'Codex', cursor: 'Cursor' }
const itemTypes = {
  skill: 'Skill',
  command: 'Command',
  instructions: 'Instructions',
  hook: 'Hook · starts off',
  mcp: 'MCP server · starts off',
}
const outcomeLabels: Record<SetupImportResult['status'], string> = {
  imported: 'Imported',
  unchanged: 'Already imported',
  declined: 'Skipped',
  conflict: 'Conflict · existing setup kept',
  failed: 'Couldn’t import',
  stale: 'Changed since review',
  unsupported: 'Unavailable',
}
const isAccountItem = (item: SetupImportItem) =>
  item.kind === 'skill' ||
  item.kind === 'command' ||
  item.kind === 'instructions'

export function accountImportSinks(
  token: string,
  base: string,
  request: typeof fetch = fetch,
): Pick<SetupImportSinks, 'skill' | 'instructions'> {
  const headers = {
    Authorization: 'Bearer ' + token,
    'Content-Type': 'application/json',
  }
  const query = (path: string, body?: unknown, method?: string) =>
    request(base + path, {
      method: method ?? (body === undefined ? 'GET' : 'PUT'),
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
    })
  return {
    async skill(skill: CloudSkill) {
      for (let attempt = 0; attempt < 3; attempt++) {
        const got = await query(ACCOUNT_SKILLS_STATE_PATH)
        if (!got.ok) return 'failed'
        const snapshot = accountSkillsUpdateSchema.parse(await got.json())
        const old = snapshot.settings.skills.find(
          (entry) => entry.name === skill.name,
        )
        if (old) {
          const same =
            old.instructions === skill.instructions &&
            old.description === skill.description &&
            JSON.stringify(old.files ?? []) ===
              JSON.stringify(skill.files ?? [])
          return same ? 'unchanged' : 'conflict'
        }
        const updated = encodeAccountSkillsUpload({
          ...snapshot,
          settings: { skills: [...snapshot.settings.skills, skill] },
        })
        const result = await query(ACCOUNT_SKILLS_STATE_PATH, updated)
        if (result.status !== 409) return result.ok ? 'imported' : 'failed'
      }
      return 'conflict'
    },
    async instructions(text, item) {
      const path = '/api/v1/cloud/account-instructions'
      const got = await query(path)
      if (!got.ok) return 'failed'
      const current = (await got.json()) as { accountId: string }
      if (typeof current.accountId !== 'string') return 'failed'
      const sourceKey = createHash('sha256')
        .update(JSON.stringify([item.source, item.kind, item.displayName]))
        .digest('hex')
      const applied = await query(
        path,
        { expectedAccountId: current.accountId, sourceKey, instructions: text },
        'POST',
      )
      if (applied.status === 409) return 'conflict'
      if (!applied.ok) return 'failed'
      const body = (await applied.json()) as { status?: string }
      return body.status === 'imported' ||
        body.status === 'unchanged' ||
        body.status === 'conflict'
        ? body.status
        : 'failed'
    },
  }
}

export async function handleSetupImport(params: RouterParams) {
  params.setInputValue({ text: '', cursorPosition: 0, lastEditDueToNav: false })
  const message = (text: string) =>
    params.setMessages((old) => [...old, getSystemMessage(text)])
  if (!stdin.isTTY || !stdout.isTTY) {
    message('Open an interactive terminal to review your setup.')
    return
  }
  if (
    params.isStreaming ||
    params.isChainInProgressRef.current ||
    params.streamMessageIdRef.current
  ) {
    message('Finish the current turn before importing settings.')
    return
  }
  try {
    message(await withSuspendedRenderer(runTerminalSetupImport))
  } catch {
    message(
      'Import was interrupted. Run /import again to check remaining items.',
    )
  }
}

export async function runTerminalSetupImport(): Promise<string> {
  if (!stdin.isTTY || !stdout.isTTY)
    return 'Open an interactive terminal to review your setup.'
  const home = await realpath(homedir())
  const { items } = await scanAgentSetup({ home })
  if (!items.length)
    return 'No Claude Code, Codex, or Cursor setup found on this computer.'
  let quiet = false
  const output = new Writable({
    write(chunk, _encoding, next) {
      if (!quiet) stdout.write(chunk)
      next()
    },
  })
  const readline = createInterface({
    input: stdin,
    output,
    terminal: true,
    historySize: 0,
  })
  const canceled = new AbortController()
  readline.on('SIGINT', () => canceled.abort())
  const ask = async (prompt: string, secret = false) => {
    if (canceled.signal.aborted) throw new Error('Canceled')
    stdout.write(prompt)
    quiet = secret
    try {
      return await readline.question('', { signal: canceled.signal })
    } finally {
      quiet = false
      if (secret) stdout.write('\n')
    }
  }
  try {
    stdout.write('\nImport setup\n')
    let source: SetupImportItem['source'] | undefined
    const choices = new Map<number, SetupImportItem>()
    for (const item of items) {
      if (item.source !== source) {
        source = item.source
        stdout.write('\n' + sourceNames[source] + '\n')
      }
      if (item.status !== 'available') {
        stdout.write(
          `  – ${item.displayName} · Unavailable\n    ${item.reason ?? 'Unsupported format.'}\n`,
        )
        continue
      }
      const number = choices.size + 1
      choices.set(number, item)
      stdout.write(
        `  ${number}. ${item.displayName} · ${itemTypes[item.kind]} · ${isAccountItem(item) ? 'Your account' : 'This computer'}\n`,
      )
    }
    if (!choices.size) return 'No items available to import.'
    stdout.write('\n')
    let selected: SetupImportItem[]
    for (;;) {
      const input = (
        await ask(
          'Choose item numbers, separated by spaces (Enter to cancel): ',
        )
      ).trim()
      if (!input) return 'Import canceled.'
      const numbers = new Set(
        input
          .split(/[ ,]+/)
          .map((value) => (/^\d+$/.test(value) ? Number(value) : NaN)),
      )
      if ([...numbers].every((number) => choices.has(number))) {
        selected = [...numbers].map((number) => choices.get(number)!)
        break
      }
      stdout.write('Choose a listed number for each item.\n')
    }
    const wantsAccount = selected.some(isAccountItem)
    if (wantsAccount) await loadStoredAuthToken()
    const token = wantsAccount ? getAuthToken() : undefined
    const account = token
      ? accountImportSinks(token, freebuffApiBaseUrl())
      : null
    const { results } = await applyAgentSetup(
      { home },
      selected
        .filter((item) => account || !isAccountItem(item))
        .map((item) => item.id),
      {
        skill: async (value, item) =>
          account ? account.skill(value, item) : 'failed',
        instructions: async (value, item) => {
          if (!account) return 'failed'
          if (
            (
              await ask(
                'Append the selected ' +
                  item.displayName +
                  ' to your account instructions? [y/N] ',
              )
            ).toLowerCase() !== 'y'
          )
            return 'declined'
          return account.instructions(value, item)
        },
        hook: (value) => importHookOff(home, value),
        mcp: async (name, config) => {
          const target =
            config.type === 'stdio'
              ? 'a local command'
              : new URL(config.url).hostname
          if (
            (
              await ask(
                'Add ' +
                  name +
                  ' (' +
                  target +
                  ') for use on this computer? [y/N] ',
              )
            ).toLowerCase() !== 'y'
          )
            return 'declined'
          return importLocalMcp(home, name, config, async (variable) => {
            const answer = await ask(
              'Local credential for ' + variable + ' (hidden, Enter to skip): ',
              true,
            )
            return answer || null
          })
        },
      },
    )
    const outcomes = new Map(results.map((result) => [result.id, result]))
    return [
      '\nImport results',
      ...selected.map((item) => {
        const result = outcomes.get(item.id)
        const outcome = result
          ? outcomeLabels[result.status]
          : 'Sign in required'
        return `  ${item.displayName} (${sourceNames[item.source]}) — ${outcome}${result?.reason ? ' · ' + result.reason : ''}`
      }),
      ...(wantsAccount && !token
        ? ['Sign in and run /import again to add the account items.']
        : []),
    ].join('\n')
  } finally {
    readline.close()
    output.destroy()
  }
}
