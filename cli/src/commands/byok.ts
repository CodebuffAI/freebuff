import { useChatStore } from '../state/chat-store'
import { getSystemMessage } from '../utils/message-history'
import { startNewChat } from '../project-files'
import { stopActiveRun } from '../utils/active-run'
import {
  describeByokConnection,
  getCliByokStore,
  closeByokSetup,
  isByokEnvironmentVariableName,
  isByokSetupOpen,
  openByokSetup,
  saveSelectedByokConnection,
  selectedByokConnection,
} from '../utils/byok'

import {
  BYOK_REASONING_EFFORTS,
  isByokReasoningEffort,
} from '@codebuff/common/constants/reasoning-effort'
import { loadSettings, saveSettings } from '../utils/settings'

import type {
  ByokConnection,
  ByokProvider,
  ByokValidationResult,
} from '@codebuff/sdk'
import type { RouterParams } from './command-registry'

export const BYOK_USAGE = [
  'BYOK uses your provider account directly. Keys are read from an environment variable and never stored in Freebuff.',
  'Use the environment-variable NAME only, for example OPENROUTER_API_KEY. Never paste an API key into this command.',
  'Usage:',
  '`/byok list`',
  '`/byok add <name> <openrouter|openai-compatible> <model> <ENV_VAR> [base-url] [--context-window=N] [--max-output-tokens=N]`',
  '`/byok update <name> <model> [base-url] [--context-window=N] [--max-output-tokens=N]`',
  '`/byok validate <name>`',
  '`/byok select <name>`',
  '`/byok effort <default|low|medium|high>`',
  '`/byok remove <name>`',
  '`/byok off`',
].join('\n')

/**
 * Entry from a Freebuff wall (Freebucks spent, daily cap reached). Those
 * screens have no input, so without this a user who ran out could never type
 * `/byok` — the one route that does not need Freebucks at all.
 */
export function enterByokSetup(): void {
  useChatStore
    .getState()
    .setMessages((messages) => [
      ...messages,
      getSystemMessage(
        [
          'Set up your own provider key (BYOK). BYOK runs never spend Freebucks.',
          '',
          BYOK_USAGE,
          '',
          'Add a connection, then `/byok select <name>` to start. `/byok off` returns to Freebuff.',
        ].join('\n'),
      ),
    ])
  openByokSetup()
}

function post(params: RouterParams, message: string): void {
  params.setMessages((messages) => [...messages, getSystemMessage(message)])
  const input = params.inputValue.trim()
  // A pasted key can have any vendor-specific shape. Setup arguments must not
  // enter command history even when credential heuristics don't recognize it.
  params.saveToHistory(
    looksLikeCredential(input)
      ? '/byok [redacted credential]'
      : /^\/byok\s+add(?:\s|$)/i.test(input)
        ? '/byok add [arguments omitted]'
        : input,
  )
  params.setInputValue({ text: '', cursorPosition: 0, lastEditDueToNav: false })
}

/** How many listed ids a message shows; the rest are counted. */
const AVAILABLE_MODELS_SHOWN = 20

function statusSuffix(validation: ByokValidationResult): string {
  return validation.statusCode ? ` (HTTP ${validation.statusCode})` : ''
}

/**
 * A reachable endpoint whose `/models` does not list the configured id: the
 * usual "model not found" on the first run. Named here, with what it does
 * list, rather than at the first failed turn. Not a refusal: a proxy may
 * route ids it does not list.
 */
function modelListNote(
  connection: Pick<ByokConnection, 'name' | 'model'>,
  validation: ByokValidationResult,
): string {
  if (!validation.ok || validation.modelListed !== false) return ''
  const available = validation.availableModels ?? []
  const shown = available.slice(0, AVAILABLE_MODELS_SHOWN)
  const more =
    available.length > shown.length
      ? ` and ${available.length - shown.length} more`
      : ''
  const listing = shown.length
    ? ` It lists: ${shown.map((id) => `\`${id}\``).join(', ')}${more}.`
    : ''
  return `\n\nWarning: \`${connection.model}\` is not in this endpoint's model list.${listing} Change it with \`/byok update ${connection.name} <model>\`, unless this proxy routes model ids it does not list.`
}

function connectionByName(connections: ByokConnection[], name: string): ByokConnection | undefined {
  return connections.find((connection) => connection.name === name)
}

function resetTranscriptForSourceChange(params: RouterParams): void {
  // A run state includes the provider's message-format history. Keeping it
  // across an inference-source change risks resuming an OpenRouter turn on a
  // different provider after the user intentionally switches credentials.
  stopActiveRun('session-transition')
  params.setMessages(() => [])
  params.clearMessages()
  startNewChat()
}

function looksLikeCredential(value: string): boolean {
  return /(?:\bsk-[A-Za-z0-9_-]{12,}\b|\brk-[A-Za-z0-9_-]{12,}\b|\bAIza[A-Za-z0-9_-]{20,}\b|\b[A-Za-z0-9_-]{40,}\b)/.test(value)
}

/** Parse CLI words with literal single/double quoted names; never evaluates shell syntax. */
function tokenizeByokArguments(value: string):
  | { tokens: string[] }
  | { error: string } {
  const tokens: string[] = []
  let token = ''
  let quote: '"' | "'" | undefined
  let escaping = false

  const pushToken = () => {
    if (token) tokens.push(token)
    token = ''
  }

  for (const character of value.trim()) {
    if (escaping) {
      token += character
      escaping = false
      continue
    }
    if (character === '\\') {
      escaping = true
      continue
    }
    if (quote) {
      if (character === quote) quote = undefined
      else token += character
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      continue
    }
    if (/\s/.test(character)) {
      pushToken()
      continue
    }
    token += character
  }

  if (quote || escaping) {
    return { error: 'BYOK command has an unmatched quote or escape.' }
  }
  pushToken()
  return { tokens }
}

function parseProvider(value: string): ByokProvider | undefined {
  return value === 'openrouter' || value === 'openai-compatible'
    ? value
    : undefined
}

function splitLimitFlags(args: string[]): {
  positional: string[]
  contextWindow?: number
  maxOutputTokens?: number
  error?: string
} {
  const result: { positional: string[]; contextWindow?: number; maxOutputTokens?: number } = {
    positional: [],
  }
  for (const arg of args) {
    const match = /^(--context-window|--max-output-tokens)=(\d+)$/.exec(arg)
    if (!match) {
      if (arg.startsWith('--')) return { positional: [], error: `Unknown BYOK option: ${arg}` }
      result.positional.push(arg)
      continue
    }
    const value = Number(match[2])
    if (!Number.isSafeInteger(value)) return { positional: [], error: `Invalid BYOK limit: ${arg}` }
    if (match[1] === '--context-window') result.contextWindow = value
    else result.maxOutputTokens = value
  }
  return result
}

type ParsedByokCommand = {
  action: string | undefined
  parsedArgs: ReturnType<typeof splitLimitFlags>
}

function parseByokCommand(rawArgs: string): ParsedByokCommand | { error: string } {
  const parsedTokens = tokenizeByokArguments(rawArgs)
  if ('error' in parsedTokens) return parsedTokens
  const tokens = parsedTokens.tokens
  const action = tokens.shift()
  return { action, parsedArgs: splitLimitFlags(tokens) }
}

/** Positional arguments an action accepts at most; undefined = a free-form name. */
function maxPositionalArguments(action: string | undefined, args: string[]): number | undefined {
  if (action === 'add') return args[1] === 'openrouter' ? 4 : 5
  if (action === 'update') return 3
  if (action === 'effort') return 1
  if (action === 'list' || action === 'off' || action === 'help') return 0
  return undefined
}

/**
 * A line break with no whitespace on either side: where a terminal or a
 * document wrapped a long command mid-word ("http://localhost:20128/⏎v1").
 * A break that replaced a space already tokenizes correctly.
 */
const BARE_LINE_BREAK = /(?<=\S)\r?\n(?=\S)/g

/**
 * The command with its pasted mid-word line breaks joined, when that is the
 * ONLY reading that fits: the command has more arguments than its action
 * takes, and there are exactly as many bare breaks as extra arguments, so
 * every one of them must be a split word. Anything
 * else (a break that may have been a space, too few breaks) stays as typed and
 * is reported, never guessed.
 */
function joinSplitPaste(rawArgs: string, parsed: ParsedByokCommand): ParsedByokCommand | undefined {
  const breaks = rawArgs.match(BARE_LINE_BREAK)?.length ?? 0
  if (breaks === 0) return undefined
  const joined = parseByokCommand(rawArgs.replace(BARE_LINE_BREAK, ''))
  if ('error' in joined || joined.parsedArgs.error) return undefined
  const max = maxPositionalArguments(joined.action, joined.parsedArgs.positional)
  const before = parsed.parsedArgs.positional.length
  const after = joined.parsedArgs.positional.length
  if (max === undefined || before <= max) return undefined
  return breaks === before - max && after === max ? joined : undefined
}

const PASTE_HINT =
  'If you pasted this command, a line break may have split it: paste it again as one line.'

function incompleteCommandMessage(usage: string, missing: string[]): string {
  // Placeholders go in code spans: the chat renders Markdown, where a bare
  // `<base-url>` reads as an HTML tag and disappears.
  return `\`${usage}\` is missing ${missing.map((item) => `\`${item}\``).join(', ')}.\n${PASTE_HINT}`
}

export async function handleByokCommand(
  params: RouterParams,
  rawArgs: string,
): Promise<void> {
  let parsed = parseByokCommand(rawArgs)
  if ('error' in parsed) {
    post(params, parsed.error)
    return
  }
  const repaired = joinSplitPaste(rawArgs, parsed)
  if (repaired) parsed = repaired
  const { action, parsedArgs } = parsed
  const args = parsedArgs.positional
  const byokStore = getCliByokStore()

  try {
    if (looksLikeCredential(rawArgs)) {
      post(
        params,
        'BYOK keys cannot be entered into the CLI. Export the key, then pass only its environment-variable name such as OPENROUTER_API_KEY.',
      )
      return
    }
    if (!action || action === 'help') {
      post(params, BYOK_USAGE)
      return
    }
    if (parsedArgs.error) {
      post(params, parsedArgs.error)
      return
    }
    const maxArgs = maxPositionalArguments(action, args)
    if (maxArgs !== undefined && args.length > maxArgs) {
      // Extra words used to be dropped silently: a URL split as
      // "http://localhost:20128/⏎v1" saved the endpoint without /v1.
      post(
        params,
        `Unexpected extra argument${args.length - maxArgs === 1 ? '' : 's'} for /byok ${action}: ${args.slice(maxArgs).join(' ')}\n${PASTE_HINT}`,
      )
      return
    }

    if (action === 'list') {
      const connections = await byokStore.list()
      const selected = selectedByokConnection()
      post(
        params,
        connections.length === 0
          ? 'No BYOK connections configured.\n\n' + BYOK_USAGE
          : connections
              .map((connection) => `${selected?.id === connection.id && selected.revision === connection.revision ? '●' : '○'} ${describeByokConnection(connection)}`)
              .join('\n'),
      )
      return
    }

    if (action === 'add') {
      const [name, providerValue, model, environmentVariable, baseUrl] = args
      const provider = providerValue && parseProvider(providerValue)
      if (providerValue && !provider) {
        post(params, `Unknown BYOK provider type: ${providerValue}. Use openrouter or openai-compatible.\n\n${BYOK_USAGE}`)
        return
      }
      if (!name || !provider || !model || !environmentVariable) {
        const missing = [
          !name && '<name>',
          !provider && '<openrouter|openai-compatible>',
          !model && '<model>',
          !environmentVariable && '<ENV_VAR>',
          provider === 'openai-compatible' && '<base-url>',
        ].filter((item): item is string => Boolean(item))
        post(params, incompleteCommandMessage('/byok add <name> <openrouter|openai-compatible> <model> <ENV_VAR> [base-url]', missing))
        return
      }
      if (!isByokEnvironmentVariableName(environmentVariable)) {
        post(params, 'The key reference must be an environment-variable name such as OPENROUTER_API_KEY.')
        return
      }
      if (provider === 'openai-compatible' && !baseUrl) {
        post(params, `An OpenAI-compatible connection requires a base URL, e.g. http://localhost:20128/v1.\n${PASTE_HINT}`)
        return
      }
      if (provider === 'openrouter' && baseUrl) {
        post(params, 'OpenRouter uses its canonical API endpoint; omit the base URL.')
        return
      }
      if (baseUrl) {
        try {
          new URL(baseUrl)
        } catch {
          post(params, `The OpenAI-compatible base URL is invalid: ${baseUrl}${/[\r\n]/.test(rawArgs) ? `\n${PASTE_HINT}` : ''}`)
          return
        }
      }
      const existing = connectionByName(await byokStore.list(), name)
      if (existing) {
        post(params, `A BYOK connection named ${name} already exists. Choose a different name.`)
        return
      }
      const connection = await byokStore.create({
        name,
        provider,
        model,
        ...(baseUrl ? { baseUrl } : {}),
        ...(parsedArgs.contextWindow !== undefined ? { contextWindow: parsedArgs.contextWindow } : {}),
        ...(parsedArgs.maxOutputTokens !== undefined ? { maxOutputTokens: parsedArgs.maxOutputTokens } : {}),
        credentialRef: `env:${environmentVariable}`,
      })
      const validation = await byokStore.validate(connection)
      post(
        params,
        validation.ok
          ? connection.provider === 'openrouter'
            ? `Saved and authenticated ${describeByokConnection(connection)}. Select it with /byok select ${connection.name}.`
            : `Saved ${describeByokConnection(connection)}. The endpoint is reachable${statusSuffix(validation)}; this model is unqualified until it completes a coding run. Select it with /byok select ${connection.name}.${modelListNote(connection, validation)}`
          : `Saved ${describeByokConnection(connection)}, but it could not be validated: ${validation.message}\nThen run /byok validate ${connection.name}.`,
      )
      return
    }

    if (action === 'update') {
      const [name, model, baseUrl] = args
      if (!name || !model) {
        post(params, incompleteCommandMessage('/byok update <name> <model> [base-url]', [!name && '<name>', '<model>'].filter((item): item is string => Boolean(item))))
        return
      }
      const connection = connectionByName(await byokStore.list(), name)
      if (!connection) {
        post(params, `No BYOK connection named ${name}. Run /byok list to see configured connections.`)
        return
      }
      if (connection.provider === 'openrouter' && baseUrl) {
        post(params, 'OpenRouter uses its canonical API endpoint; omit the base URL.')
        return
      }
      if (connection.provider === 'openai-compatible' && baseUrl) {
        try {
          new URL(baseUrl)
        } catch {
          post(params, `The OpenAI-compatible base URL is invalid: ${baseUrl}${/[\r\n]/.test(rawArgs) ? `\n${PASTE_HINT}` : ''}`)
          return
        }
      }
      const updated = await byokStore.update({
        id: connection.id,
        revision: connection.revision,
        patch: {
          model,
          ...(baseUrl ? { baseUrl } : {}),
          ...(parsedArgs.contextWindow !== undefined ? { contextWindow: parsedArgs.contextWindow } : {}),
          ...(parsedArgs.maxOutputTokens !== undefined ? { maxOutputTokens: parsedArgs.maxOutputTokens } : {}),
        },
      })
      if (selectedByokConnection()?.id === connection.id) {
        saveSelectedByokConnection(updated)
        resetTranscriptForSourceChange(params)
      }
      post(params, `Updated ${describeByokConnection(updated)}.`)
      return
    }

    if (action === 'validate' || action === 'select' || action === 'remove') {
      const name = args.join(' ')
      if (!name) {
        post(params, BYOK_USAGE)
        return
      }
      const connection = connectionByName(await byokStore.list(), name)
      if (!connection) {
        post(params, `No BYOK connection named ${name}. Run /byok list to see configured connections.`)
        return
      }
      if (action === 'validate') {
        const validation = await byokStore.validate(connection)
        post(params, validation.ok
          ? connection.provider === 'openrouter'
            ? `${describeByokConnection(connection)} has a verified credential. Model coding support remains unverified.`
            : `${describeByokConnection(connection)} is reachable${statusSuffix(validation)}. Its model remains unqualified until it completes a coding run.${modelListNote(connection, validation)}`
          : `${describeByokConnection(connection)} is unavailable: ${validation.message}`)
        return
      }
      if (action === 'select') {
        const validation = await byokStore.validate(connection)
        if (!validation.ok) {
          post(params, `${describeByokConnection(connection)} was not selected because it could not be validated: ${validation.message}`)
          return
        }
        saveSelectedByokConnection(connection)
        resetTranscriptForSourceChange(params)
        post(params, `Using ${describeByokConnection(connection)} for new runs. Inference is direct, ad-free, and billed by your provider.${modelListNote(connection, validation)}`)
        return
      }
      await byokStore.remove(connection)
      if (selectedByokConnection()?.id === connection.id) {
        saveSelectedByokConnection(undefined)
        resetTranscriptForSourceChange(params)
      }
      post(params, `Removed ${connection.name}.`)
      return
    }

    if (action === 'effort') {
      const [value] = args
      if (!value) {
        const current = loadSettings().byokReasoningEffort
        post(
          params,
          `BYOK reasoning effort: ${current ?? 'default (the provider decides)'}. Change it with /byok effort <default|${BYOK_REASONING_EFFORTS.join('|')}>.`,
        )
        return
      }
      if (value !== 'default' && !isByokReasoningEffort(value)) {
        post(params, `Unknown effort: ${value}. Use default, ${BYOK_REASONING_EFFORTS.join(', ')}.`)
        return
      }
      const effort = value === 'default' ? undefined : value
      saveSettings({ byokReasoningEffort: effort })
      post(
        params,
        effort
          ? `BYOK runs now ask for ${effort} reasoning effort. A provider that rejects it is retried without it.`
          : 'BYOK runs use the provider default reasoning effort.',
      )
      return
    }

    if (action === 'off') {
      if (!selectedByokConnection() && isByokSetupOpen()) {
        closeByokSetup()
        post(params, 'BYOK setup closed.')
        return
      }
      if (!selectedByokConnection()) {
        post(params, 'BYOK is already off.')
        return
      }
      saveSelectedByokConnection(undefined)
      resetTranscriptForSourceChange(params)
      post(params, 'BYOK is off. New runs use the Freebuff session you select.')
      return
    }

    post(params, BYOK_USAGE)
  } catch (error) {
    post(params, error instanceof Error ? `BYOK error: ${error.message}` : 'BYOK error.')
  }
}
