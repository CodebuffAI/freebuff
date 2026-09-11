import { getSystemMessage } from '../utils/message-history'
import { startNewChat } from '../project-files'
import { stopActiveRun } from '../utils/active-run'
import {
  describeByokConnection,
  getCliByokStore,
  isByokEnvironmentVariableName,
  saveSelectedByokConnection,
  selectedByokConnection,
} from '../utils/byok'

import type { ByokConnection, ByokProvider } from '@codebuff/sdk'
import type { RouterParams } from './command-registry'

const usage = [
  'BYOK uses your provider account directly. Keys are read from an environment variable and never stored in Freebuff.',
  'Use the environment-variable NAME only, for example OPENROUTER_API_KEY. Never paste an API key into this command.',
  'Usage:',
  '/byok list',
  '/byok add <name> <openrouter|openai-compatible> <model> <ENV_VAR> [base-url] [--context-window=N] [--max-output-tokens=N]',
  '/byok update <name> <model> [base-url] [--context-window=N] [--max-output-tokens=N]',
  '/byok validate <name>',
  '/byok select <name>',
  '/byok remove <name>',
  '/byok off',
].join('\n')

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

export async function handleByokCommand(
  params: RouterParams,
  rawArgs: string,
): Promise<void> {
  const parsedTokens = tokenizeByokArguments(rawArgs)
  if ('error' in parsedTokens) {
    post(params, parsedTokens.error)
    return
  }
  const tokens = parsedTokens.tokens
  const action = tokens.shift()
  const parsedArgs = splitLimitFlags(tokens)
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
      post(params, usage)
      return
    }
    if (parsedArgs.error) {
      post(params, parsedArgs.error)
      return
    }

    if (action === 'list') {
      const connections = await byokStore.list()
      const selected = selectedByokConnection()
      post(
        params,
        connections.length === 0
          ? 'No BYOK connections configured.\n\n' + usage
          : connections
              .map((connection) => `${selected?.id === connection.id && selected.revision === connection.revision ? '●' : '○'} ${describeByokConnection(connection)}`)
              .join('\n'),
      )
      return
    }

    if (action === 'add') {
      const [name, providerValue, model, environmentVariable, baseUrl] = args
      const provider = providerValue && parseProvider(providerValue)
      if (!name || !provider || !model || !environmentVariable) {
        post(params, usage)
        return
      }
      if (!isByokEnvironmentVariableName(environmentVariable)) {
        post(params, 'The key reference must be an environment-variable name such as OPENROUTER_API_KEY.')
        return
      }
      if (provider === 'openai-compatible' && !baseUrl) {
        post(params, 'An OpenAI-compatible connection requires a base URL.\n\n' + usage)
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
          post(params, 'The OpenAI-compatible base URL is invalid.')
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
            : `Saved ${describeByokConnection(connection)}. The endpoint is reachable; this model is unqualified until it completes a coding run. Select it with /byok select ${connection.name}.`
          : `Saved ${describeByokConnection(connection)}, but validation failed: ${validation.message}\nCheck that ${environmentVariable} is exported, then run /byok validate ${connection.name}.`,
      )
      return
    }

    if (action === 'update') {
      const [name, model, baseUrl] = args
      if (!name || !model) {
        post(params, usage)
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
          post(params, 'The OpenAI-compatible base URL is invalid.')
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
        post(params, usage)
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
            : `${describeByokConnection(connection)} is reachable. Its model remains unqualified until it completes a coding run.`
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
        post(params, `Using ${describeByokConnection(connection)} for new runs. Inference is direct, ad-free, and billed by your provider.`)
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

    if (action === 'off') {
      if (!selectedByokConnection()) {
        post(params, 'BYOK is already off.')
        return
      }
      saveSelectedByokConnection(undefined)
      resetTranscriptForSourceChange(params)
      post(params, 'BYOK is off. New runs use the Freebuff session you select.')
      return
    }

    post(params, usage)
  } catch (error) {
    post(params, error instanceof Error ? `BYOK error: ${error.message}` : 'BYOK error.')
  }
}
